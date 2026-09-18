/**
 * Reading ElevenLabs call outcomes without being told.
 *
 *   node test-voice-outcome-poll.mjs
 *
 * Two failures here are expensive and one is merely untidy.
 *
 * The expensive ones: filing a call that is STILL RINGING as one that failed
 * (the row is never revisited, so a live lead looks dead), and scoring a call
 * nobody picked up as "answered" (a retry becomes a conversation that never
 * happened). Both are ordering mistakes, both are cheap to make, and the
 * fixtures below are the real payloads that exposed them.
 *
 * The untidy one: overwriting a disposition the webhook already wrote.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { outcomeOf, mobile10Of, pollVoiceOutcomes } from "./lib/voiceOutcomePoll.js";

let failed = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
};

/** Verbatim shapes from three real conversations, read 17 Sep 2026. */
const RANG_NOT_PICKED_UP = {
  status: "failed",
  metadata: {
    call_duration_secs: 0,
    error: { code: 1011, reason: "request timed out", error_type: "no_answer" },
  },
};
const NEVER_RANG = {
  status: "failed",
  metadata: {
    call_duration_secs: 0,
    error: {
      code: 1011,
      reason: "transaction failed to complete (0 intermediate responses)",
      error_type: "call_initialization_error",
    },
  },
};
const SPOKE = { status: "done", metadata: { call_duration_secs: 74 } };

console.log("\na call that is not over is not an outcome\n");

await check("a call still being set up is never written", () => {
  for (const status of ["initiated", "processing", "in-progress", "queued"]) {
    const out = outcomeOf({ status, metadata: {} });
    assert.equal(out.terminal, false, `${status} must not be terminal`);
    assert.equal(out.disposition, null, `${status} must produce no disposition`);
  }
});

await check("a conversation with no status at all is not written", () => {
  assert.equal(outcomeOf({}).terminal, false);
  assert.equal(outcomeOf({ metadata: {} }).terminal, false);
  assert.equal(outcomeOf(null).terminal, false);
});

await check("an unknown status is left alone rather than guessed", () => {
  // Strictly non-terminal: a status we have never seen might mean "ringing".
  // Guessing "failed" here would bury the row forever.
  assert.equal(outcomeOf({ status: "something_new" }).terminal, false);
});

console.log("\nno answer is not an answer\n");

await check("a call that rang and was not picked up is no_answer, not failed", () => {
  const out = outcomeOf(RANG_NOT_PICKED_UP);
  assert.equal(out.terminal, true);
  assert.equal(out.disposition, "no_answer");
});

await check("a call that rang and was not picked up is never answered", () => {
  assert.notEqual(outcomeOf(RANG_NOT_PICKED_UP).disposition, "answered");
});

await check("a call that never rang is failed, and distinguishable from no_answer", () => {
  const out = outcomeOf(NEVER_RANG);
  assert.equal(out.terminal, true);
  assert.equal(out.disposition, "failed");
  assert.notEqual(
    out.disposition,
    outcomeOf(RANG_NOT_PICKED_UP).disposition,
    "a fault and a missed call must not collapse into one disposition"
  );
});

await check("a completed conversation is answered, with its duration", () => {
  const out = outcomeOf(SPOKE);
  assert.equal(out.terminal, true);
  assert.equal(out.disposition, "answered");
  assert.equal(out.durationSec, 74);
});

await check("an unrecognised error_type is failed, and says so", () => {
  const out = outcomeOf({
    status: "failed",
    metadata: { error: { error_type: "some_future_thing" } },
  });
  assert.equal(out.disposition, "failed");
  assert.equal(out.unmappedErrorType, true, "an unmapped type must be reported, not absorbed");
});

await check("a known error_type is not reported as unmapped", () => {
  assert.equal(outcomeOf(NEVER_RANG).unmappedErrorType, false);
  assert.equal(outcomeOf(RANG_NOT_PICKED_UP).unmappedErrorType, false);
});

console.log("\nmobile10\n");

await check("ten digits, or nothing", () => {
  assert.equal(mobile10Of("+919310300800"), "9310300800");
  assert.equal(mobile10Of("9310300800"), "9310300800");
  assert.equal(mobile10Of("93103"), null);
  assert.equal(mobile10Of(null), null);
});

console.log("\nthe poll itself\n");

/** A Supabase stub that records what it was asked, with a chainable query. */
function stubSb(rows, sink = {}) {
  sink.filters = [];
  sink.updates = [];
  sink.inserts = [];
  sink.order = [];
  // What the UPDATE ... .select("id") hands back. [] is the webhook having
  // filled the row between our select and our write.
  sink.claims = sink.claims ?? [{ id: "row-1" }];
  const query = {
    select: () => query,
    eq: (col, val) => (sink.filters.push(`eq:${col}=${val}`), query),
    is: (col, val) => (sink.filters.push(`is:${col}=${val}`), query),
    not: (col, op) => (sink.filters.push(`not:${col}:${op}`), query),
    lt: (col) => (sink.filters.push(`lt:${col}`), query),
    gt: (col) => (sink.filters.push(`gt:${col}`), query),
    order: (col, opts) => (sink.order.push(`${col}:${opts?.ascending ? "asc" : "desc"}`), query),
    limit: () => Promise.resolve({ data: rows, error: null }),
    then: (resolve) => resolve({ data: rows, error: null }),
  };
  return {
    sink,
    from: (table) => ({
      ...query,
      update: (patch) => {
        const u = { table, patch, guards: [] };
        sink.updates.push(u);
        const chain = {
          eq: () => chain,
          is: (col, val) => (u.guards.push(`is:${col}=${val}`), chain),
          select: (cols) => {
            u.selected = cols;
            return Promise.resolve({ data: sink.claims, error: null });
          },
        };
        return chain;
      },
      insert: (row) => (sink.inserts.push({ table, row }), Promise.resolve({ error: null })),
    }),
  };
}

const ROW = {
  id: "row-1",
  mobile: "9310300800",
  voice_provider_call_id: "conv_test",
  created_at: "2026-09-17T09:43:46Z",
};
const okFetch = (body) => async () => ({ ok: true, status: 200, json: async () => body });

await check("a terminal call is written, with its disposition", async () => {
  const sb = stubSb([ROW]);
  const out = await pollVoiceOutcomes({}, { sb, apiKey: "k", fetch: okFetch(NEVER_RANG) });
  assert.equal(out.updated, 1);
  assert.equal(sb.sink.updates.length, 1);
  assert.equal(sb.sink.updates[0].patch.voice_disposition, "failed");
});

await check("a call still ringing is polled but never written", async () => {
  const sb = stubSb([ROW]);
  const out = await pollVoiceOutcomes(
    {},
    { sb, apiKey: "k", fetch: okFetch({ status: "processing", metadata: {} }) }
  );
  assert.equal(out.polled, 1);
  assert.equal(out.skipped, 1);
  assert.equal(out.updated, 0);
  assert.equal(sb.sink.updates.length, 0, "a ringing call must leave the row untouched");
});

await check("only rows with no disposition are selected", async () => {
  const sb = stubSb([]);
  await pollVoiceOutcomes({}, { sb, apiKey: "k", fetch: okFetch(SPOKE) });
  assert.ok(
    sb.sink.filters.includes("is:voice_disposition=null"),
    "without this the poll overwrites whatever the webhook wrote"
  );
});

await check("the write re-checks that the disposition is still null", async () => {
  const sb = stubSb([ROW]);
  await pollVoiceOutcomes({}, { sb, apiKey: "k", fetch: okFetch(SPOKE) });
  assert.deepEqual(
    sb.sink.updates[0].guards,
    ["is:voice_disposition=null"],
    "a webhook landing mid-poll must win, not lose to the slower writer"
  );
});

await check("it asks only about our own bot's calls", async () => {
  const sb = stubSb([]);
  await pollVoiceOutcomes({}, { sb, apiKey: "k", fetch: okFetch(SPOKE) });
  assert.ok(sb.sink.filters.includes("eq:voice_provider=elevenlabs"));
});

await check("a missing API key does nothing at all, and says why", async () => {
  const sb = stubSb([ROW]);
  const out = await pollVoiceOutcomes({}, { sb, apiKey: null, fetch: okFetch(SPOKE) });
  assert.equal(out.reason, "not_configured");
  assert.equal(out.updated, 0);
  assert.equal(sb.sink.updates.length, 0);
});

await check("one unreachable conversation does not lose the others", async () => {
  const rows = [ROW, { ...ROW, id: "row-2", voice_provider_call_id: "conv_bad" }];
  const sb = stubSb(rows);
  let call = 0;
  const flaky = async () => {
    call++;
    if (call === 1) throw new Error("socket hang up");
    return { ok: true, status: 200, json: async () => SPOKE };
  };
  const out = await pollVoiceOutcomes({}, { sb, apiKey: "k", fetch: flaky });
  assert.equal(out.updated, 1, "the second conversation must still be written");
  assert.equal(out.errors.length, 1);
});

await check("it never rejects, whatever the database does", async () => {
  const exploding = { from: () => { throw new Error("db gone"); } };
  const out = await pollVoiceOutcomes({}, { sb: exploding, apiKey: "k", fetch: okFetch(SPOKE) });
  assert.ok(Array.isArray(out.errors) && out.errors.length > 0);
  assert.equal(out.updated, 0);
});

await check("an outcome is also filed alongside Oriserve's, under our own name", async () => {
  const sb = stubSb([ROW]);
  await pollVoiceOutcomes({}, { sb, apiKey: "k", fetch: okFetch(SPOKE) });
  const event = sb.sink.inserts.find((i) => i.table === "voice_call_events");
  assert.ok(event, "voice_call_events must get the row too");
  assert.equal(event.row.provider, "elevenlabs", "not 'oriserve', and not left to default");
});

console.log("\nwhich agent took the call\n");

await check("the agent is read off the conversation", () => {
  assert.equal(outcomeOf({ ...SPOKE, agent_id: "agent_A" }).agentId, "agent_A");
  assert.equal(outcomeOf(SPOKE).agentId, null, "absent is null, never guessed");
});

await check("the outcome records which agent produced it", async () => {
  const sb = stubSb([ROW]);
  await pollVoiceOutcomes(
    {},
    { sb, apiKey: "k", fetch: okFetch({ ...SPOKE, agent_id: "agent_A" }) }
  );
  const event = sb.sink.inserts.find((i) => i.table === "voice_call_events");
  assert.equal(
    event.row.raw.agent_id,
    "agent_A",
    "without this, two agents' outcomes are indistinguishable and no comparison is possible"
  );
});

await check("two agents' outcomes stay distinguishable", async () => {
  const seen = [];
  for (const id of ["agent_A", "agent_B"]) {
    const sb = stubSb([ROW]);
    await pollVoiceOutcomes({}, { sb, apiKey: "k", fetch: okFetch({ ...SPOKE, agent_id: id }) });
    seen.push(sb.sink.inserts.find((i) => i.table === "voice_call_events").row.raw.agent_id);
  }
  assert.deepEqual(seen, ["agent_A", "agent_B"]);
});

console.log("\nthe route wiring\n");

const indexSrc = readFileSync(new URL("./index.js", import.meta.url), "utf8");

await check("the poller is behind CONSOLE_SECRET, not open", () => {
  assert.match(
    indexSrc,
    /app\.use\(\s*['"]\/api\/voice-poll['"]\s*,\s*consoleAuth\(/,
    "/run writes customer rows and spends money"
  );
});

console.log("\nthe guard that stops a double write\n");

await check("a row the webhook already filled is claimed, not written twice", async () => {
  // PostgREST matches zero rows and still returns error: null, so without
  // asking for the ids back this reads exactly like a successful write -- and
  // files a SECOND voice_call_events row for a call somebody else already
  // recorded. This is the check that fails if .select("id") is dropped.
  const sb = stubSb([ROW], { claims: [] });
  const out = await pollVoiceOutcomes({}, { sb, apiKey: "k", fetch: okFetch(NEVER_RANG) });
  assert.equal(out.updated, 0, "nothing of ours was written");
  assert.equal(out.claimed, 1, "and the row is accounted for, not silently dropped");
  assert.equal(sb.sink.inserts.length, 0, "a duplicate event row is the bug this exists to stop");
});

await check("the update asks for the ids back", async () => {
  const sb = stubSb([ROW]);
  await pollVoiceOutcomes({}, { sb, apiKey: "k", fetch: okFetch(NEVER_RANG) });
  assert.equal(sb.sink.updates[0].selected, "id", "without a select the guard is unobservable");
});

await check("a row we did win is written exactly once", async () => {
  const sb = stubSb([ROW]);
  const out = await pollVoiceOutcomes({}, { sb, apiKey: "k", fetch: okFetch(NEVER_RANG) });
  assert.equal(out.updated, 1);
  assert.equal(out.claimed, 0);
  assert.equal(sb.sink.inserts.length, 1);
});

console.log("\nwhat lands in the shared events table\n");

await check("event_status carries the disposition, not the transport status", async () => {
  // crm.voice_call_events is shared with Oriserve, whose rows put dispositions
  // in this column (RNR, VOICEMAIL, QUALIFIED_LEAD). Writing "failed" here
  // collapses no_answer, busy and cancelled into one value -- the distinction
  // this whole module exists to recover.
  const sb = stubSb([ROW]);
  await pollVoiceOutcomes({}, { sb, apiKey: "k", fetch: okFetch(RANG_NOT_PICKED_UP) });
  const row = sb.sink.inserts[0].row;
  assert.equal(row.event_status, "no_answer");
  assert.notEqual(row.event_status, "failed", "status and disposition are not the same fact");
  assert.equal(row.raw.status, "failed", "the raw status is still kept");
});

console.log("\nthe backlog drains from the oldest end\n");

await check("rows are polled oldest first", async () => {
  // Newest-first plus a batch ceiling re-polls the same newest rows every run
  // and never reaches the oldest, which then age out under MAX_AGE_DAYS
  // unresolved -- invisibly, because they just stop being selected.
  const sb = stubSb([ROW]);
  await pollVoiceOutcomes({}, { sb, apiKey: "k", fetch: okFetch(NEVER_RANG) });
  assert.ok(
    sb.sink.order.includes("created_at:asc"),
    `expected created_at ascending, got ${JSON.stringify(sb.sink.order)}`
  );
});

console.log("\nwhen the call ended, not when we asked\n");

await check("voice_ended_at comes from the conversation", async () => {
  const started = 1789600000;
  const sb = stubSb([ROW]);
  const body = {
    ...NEVER_RANG,
    metadata: { ...NEVER_RANG.metadata, start_time_unix_secs: started, call_duration_secs: 42 },
  };
  await pollVoiceOutcomes(
    {},
    { sb, apiKey: "k", fetch: okFetch(body), now: () => 1789999999000 }
  );
  assert.equal(
    sb.sink.updates[0].patch.voice_ended_at,
    new Date((started + 42) * 1000).toISOString(),
    "recording the poll time back-dates nothing and mis-dates everything on a backlog"
  );
});

await check("with no start time it falls back to now", async () => {
  const sb = stubSb([ROW]);
  const now = 1789999999000;
  await pollVoiceOutcomes({}, { sb, apiKey: "k", fetch: okFetch(NEVER_RANG), now: () => now });
  assert.equal(sb.sink.updates[0].patch.voice_ended_at, new Date(now).toISOString());
});

console.log("\nan error_type is data, not a property name\n");

await check("an error_type that names an Object member is not trusted", () => {
  // ERROR_TYPE_DISPOSITION["constructor"] is a function, and Object.freeze
  // does not stop the lookup reaching the prototype. Without Object.hasOwn
  // that function is what goes into voice_disposition.
  for (const evil of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
    const out = outcomeOf({
      status: "failed",
      metadata: { error: { error_type: evil } },
    });
    assert.equal(out.disposition, "failed", `${evil} must map to the coarse failure`);
    assert.equal(typeof out.disposition, "string");
    assert.equal(out.unmappedErrorType, true, `${evil} is not a known error_type`);
  }
});

console.log("\nthe not-configured reply keeps its explanation\n");

const routeSrc = readFileSync(new URL("./lib/routes/voicePollRoutes.js", import.meta.url), "utf8");

await check("the spread cannot overwrite the reason", () => {
  // result carries reason:"not_configured"; spreading it after the sentence
  // replaces the one thing the reply exists to say.
  const spreadAt = routeSrc.indexOf("...result,");
  const reasonAt = routeSrc.indexOf('reason: "ELEVEN_LABS_API_KEY');
  assert.ok(spreadAt !== -1 && reasonAt !== -1);
  assert.ok(spreadAt < reasonAt, "the spread must come before the reason it would clobber");
});

await check("/status pages past the PostgREST row cap", () => {
  assert.match(routeSrc, /\.range\(/, "a bare select stops at max-rows and reports it as the total");
});

console.log(failed ? `\n${failed} failed\n` : "\nall passed\n");
process.exit(failed ? 1 : 0);
