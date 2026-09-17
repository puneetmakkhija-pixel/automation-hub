/**
 * The press queue, and the early acknowledgement in front of it.
 *
 * Every check here is confirmed to fail under a targeted mutation — the note
 * on each one says which mutation, so a check that has quietly stopped testing
 * anything can be caught by re-applying it.
 */
import assert from "node:assert/strict";
import {
  runQueued,
  queueStats,
  resetQueue,
  maxInFlight,
  maxWaiting,
} from "./lib/pressQueue.js";

let passed = 0;
let failed = 0;
const results = [];

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    results.push(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    results.push(`  FAIL ${name}\n         ${error.message}`);
  }
}

/** A promise you resolve by hand, so a test can hold work open on purpose. */
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const originalEnv = { ...process.env };

/**
 * Awaited, not just called. An earlier version returned fn() and restored the
 * environment in a `finally` — which, for an async fn, runs the moment the
 * promise is created and so cleared every variable before the test body had
 * read one. Two checks passed for that reason rather than on their merits.
 */
async function withEnv(vars, fn) {
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(vars)) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }
}

console.log("\nPress queue\n");

// ── The cap ────────────────────────────────────────────────────────────────

// Mutation that breaks this: run jobs immediately instead of counting them
// against maxInFlight(). Was 4 concurrent; the whole point is that it is 2.
await check("never runs more than maxInFlight at once", async () => {
  resetQueue();
  await withEnv({ IVR_PRESS_CONCURRENCY: "2" }, async () => {
    const gates = [deferred(), deferred(), deferred(), deferred()];
    let started = 0;
    let peak = 0;

    const runs = gates.map((gate) =>
      runQueued(async () => {
        started += 1;
        peak = Math.max(peak, started);
        await gate.promise;
        started -= 1;
      })
    );

    // Let the queue pump before anything is released.
    await new Promise((r) => setImmediate(r));
    assert.equal(peak, 2, `expected 2 in flight, saw ${peak}`);
    assert.equal(queueStats().waiting, 2, "the other two should be waiting");

    gates.forEach((g) => g.resolve());
    await Promise.all(runs);
    assert.equal(peak, 2, `peak concurrency rose to ${peak} after draining`);
  });
});

// Mutation that breaks this: drop the `.finally(pump)`, so finishing a job
// never starts the next one. The queue then stalls with two jobs unrun.
await check("a finished job releases the next one", async () => {
  resetQueue();
  await withEnv({ IVR_PRESS_CONCURRENCY: "1" }, async () => {
    const order = [];
    const first = deferred();

    const a = runQueued(async () => {
      order.push("a-start");
      await first.promise;
      order.push("a-end");
    });
    const b = runQueued(async () => {
      order.push("b-start");
    });

    await new Promise((r) => setImmediate(r));
    assert.deepEqual(order, ["a-start"], "b must not start while a holds the slot");

    first.resolve();
    await Promise.all([a, b]);
    assert.deepEqual(order, ["a-start", "a-end", "b-start"]);
  });
});

// ── Failure containment ────────────────────────────────────────────────────

// Mutation that breaks this: let the job's rejection propagate out of
// runQueued. The await then throws and the assertion below is never reached —
// which in production is an unhandled rejection that kills the process.
await check("a throwing job resolves rather than rejecting", async () => {
  resetQueue();
  const outcome = await runQueued(async () => {
    throw new Error("supabase said 522");
  });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error.message, /522/);
});

// Mutation that breaks this: remove the `.finally` decrement, so a failed job
// keeps its slot forever. The second job then never runs and this times out.
await check("a throwing job still frees its slot", async () => {
  resetQueue();
  await withEnv({ IVR_PRESS_CONCURRENCY: "1" }, async () => {
    await runQueued(async () => {
      throw new Error("boom");
    });
    let ran = false;
    await runQueued(async () => {
      ran = true;
    });
    assert.equal(ran, true, "the slot was not released by the failure");
    assert.equal(queueStats().running, 0);
  });
});

// ── The ceiling ────────────────────────────────────────────────────────────

// Mutation that breaks this: drop the maxWaiting() check, so the backlog grows
// without limit. The third job is then queued and eventually runs, and `ok`
// comes back true.
await check("refuses work past the queue ceiling instead of growing", async () => {
  resetQueue();
  await withEnv({ IVR_PRESS_CONCURRENCY: "1", IVR_PRESS_QUEUE_LIMIT: "1" }, async () => {
    const gate = deferred();
    let refusedRan = false;

    const inFlight = runQueued(() => gate.promise);
    const queued = runQueued(async () => {});
    await new Promise((r) => setImmediate(r));

    // Raced against a timer rather than awaited outright. A refusal settles
    // immediately; if the ceiling is gone the work is queued behind a job this
    // test is deliberately holding open, and a bare await would deadlock —
    // turning a failing check into a hung run that reports nothing at all.
    const refused = await Promise.race([
      runQueued(async () => {
        refusedRan = true;
      }),
      new Promise((r) => setTimeout(() => r({ ok: "never settled" }), 50)),
    ]);

    assert.equal(refused.ok, false);
    assert.equal(refused.reason, "queue full");
    assert.equal(refusedRan, false, "refused work must not run");

    gate.resolve();
    await Promise.all([inFlight, queued]);
  });
});

// ── Configuration ──────────────────────────────────────────────────────────

// Mutation that breaks this: read the env var with a bare Number() and no
// guard. "" becomes 0 and "banana" becomes NaN, either of which would set the
// cap to zero and stop the service dead.
await check("a missing or junk concurrency setting falls back to 8", async () => {
  await withEnv({ IVR_PRESS_CONCURRENCY: "" }, () => assert.equal(maxInFlight(), 8));
  await withEnv({ IVR_PRESS_CONCURRENCY: "banana" }, () => assert.equal(maxInFlight(), 8));
  await withEnv({ IVR_PRESS_CONCURRENCY: "0" }, () => assert.equal(maxInFlight(), 8));
  await withEnv({ IVR_PRESS_CONCURRENCY: "-3" }, () => assert.equal(maxInFlight(), 8));
  await withEnv({ IVR_PRESS_CONCURRENCY: "16" }, () => assert.equal(maxInFlight(), 16));
});

// Mutation that breaks this: treat 0 as junk and fall back to 500. Setting the
// limit to 0 is the one way to refuse all queueing, and it must be honoured.
await check("a queue limit of 0 is honoured, not treated as unset", async () => {
  await withEnv({ IVR_PRESS_QUEUE_LIMIT: "0" }, () => assert.equal(maxWaiting(), 0));
  await withEnv({ IVR_PRESS_QUEUE_LIMIT: "" }, () => assert.equal(maxWaiting(), 500));
  await withEnv({ IVR_PRESS_QUEUE_LIMIT: "nonsense" }, () => assert.equal(maxWaiting(), 500));
});

// ── The early acknowledgement ──────────────────────────────────────────────

console.log(results.join("\n"));
results.length = 0;
console.log("\nEarly acknowledgement\n");

// Imported after the queue tests so the module's own env reads are not caught
// mid-withEnv.
const { acknowledgeThenHandle } = await import("./lib/routes/ivrWhatsAppRoutes.js");

/** A `res` that records what the panel was told and when. */
function spyResponse() {
  const seen = { json: null, at: null };
  return {
    seen,
    status() {
      return this;
    },
    json(body) {
      seen.json = body;
      seen.at = process.hrtime.bigint();
      return this;
    },
  };
}

// Mutation that breaks this: await the queued work before res.json(). The
// acknowledgement then lands after the slow work, which is the behaviour that
// took Supabase down.
await check("answers the panel before the work runs", async () => {
  resetQueue();
  const res = spyResponse();
  // No template mapped for this digit, so handleKeypress returns immediately —
  // what is being timed is the ORDER, not the work.
  const req = { params: {}, body: { mobile: "9999999999", dtmf: "7" } };

  const finished = acknowledgeThenHandle(req, res);
  assert.notEqual(res.seen.json, null, "the panel was not answered synchronously");
  assert.deepEqual(res.seen.json, { success: true, queued: true });
  await finished;
});

// Mutation that breaks this: return a non-2xx, or omit `queued`. The panel
// treats a non-2xx as "retry me", and on 17 Sep that turned 724 callers into
// 2,151 paid calls.
await check("the acknowledgement is always a success", async () => {
  resetQueue();
  const res = spyResponse();
  await acknowledgeThenHandle({ params: {}, body: {} }, res);
  assert.equal(res.seen.json.success, true);
  assert.equal(res.seen.json.queued, true);
});

// Mutation that breaks this: drop the try/catch inside runQueued's job wrapper,
// or let acknowledgeThenHandle await a rejecting promise. Either way this call
// rejects and the assertion never runs. In production that is a dead process.
await check("a handler that throws does not reject the acknowledgement", async () => {
  resetQueue();
  const res = spyResponse();
  // `params` missing entirely makes handleKeypress throw on req.params.variant.
  const outcome = await acknowledgeThenHandle({ body: { mobile: "9999999999" } }, res);
  assert.equal(res.seen.json.queued, true, "the panel should still have been answered");
  assert.ok(outcome, "acknowledgeThenHandle should resolve, not reject");
});

console.log(results.join("\n"));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
