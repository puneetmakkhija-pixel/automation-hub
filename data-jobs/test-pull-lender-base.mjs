/**
 * The paging loop, without a database.
 *
 *   node data-jobs/test-pull-lender-base.mjs
 *
 * The loop is the whole risk in this job. It walks a foreign table that times
 * out on any scan, so the two ways it can fail are both expensive: stopping
 * early leaves a base half-built and nobody notices because it still has rows,
 * and never stopping hammers a remote database for as long as the process
 * lives. Both stop conditions are checked here, plus the one that caused the
 * bug they are written against — an empty string is a VALID starting key, so
 * "done" has to be null and not falsy.
 */
import assert from "node:assert/strict";
import { parseArgs, pullBase } from "./pull-lender-base.js";

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

/** A fake base: pages of `size` until `total` is exhausted. */
const fakeRpc = (total, size, seen = []) => {
  let cursor = 0;
  return async (params) => {
    seen.push(params);
    if (cursor >= total) return { last_key: null, rows_scanned: 0, rows_kept: 0 };
    const n = Math.min(size, total - cursor);
    cursor += n;
    return {
      last_key: cursor >= total && n < size ? null : String(cursor).padStart(10, "0"),
      rows_scanned: n,
      rows_kept: Math.floor(n / 3),
    };
  };
};

console.log("\nflags\n");

await check("defaults are the Flexiloans base at the owner's cutoff", () => {
  const o = parseArgs([]);
  assert.equal(o.lender, "Flexiloans (Epimoney)");
  assert.equal(o.minScore, 60);
  assert.equal(o.pageSize, 5000);
  assert.equal(o.dryRun, false);
});

await check("every default can be overridden", () => {
  const o = parseArgs(["--lender", "Indifi", "--min-score", "75", "--limit", "100", "--dry-run"]);
  assert.equal(o.lender, "Indifi");
  assert.equal(o.minScore, 75);
  assert.equal(o.pageSize, 100);
  assert.equal(o.dryRun, true);
});

await check("a non-numeric score falls back rather than sending NaN", () => {
  // NaN would reach the database as null and quietly widen the base to every
  // score, which is the opposite of what a typo should do.
  assert.equal(parseArgs(["--min-score", "abc"]).minScore, 60);
});

await check("a blank or zero page size is not a page", () => {
  // Number("") is 0 and 0 is finite, so a blank --limit used to pass straight
  // through. The function floors the page at 1, so the job would have kept
  // working — at one person per ~4s remote round trip.
  assert.equal(parseArgs(["--limit", ""]).pageSize, 5000);
  assert.equal(parseArgs(["--limit", "0"]).pageSize, 5000);
  assert.equal(parseArgs(["--limit", "-5"]).pageSize, 5000);
  assert.equal(parseArgs(["--limit", "250"]).pageSize, 250);
});

await check("score zero is a real instruction, not a blank", () => {
  // Unlike a page size, "any score" is a thing someone may mean.
  assert.equal(parseArgs(["--min-score", "0"]).minScore, 0);
});

console.log("\nthe walk\n");

await check("it walks the whole base and totals what it kept", async () => {
  const out = await pullBase(fakeRpc(25000, 5000), parseArgs([]));
  assert.equal(out.scanned, 25000);
  assert.equal(out.kept, Math.floor(5000 / 3) * 5);
  assert.equal(out.pages, 6, "five full pages plus the empty one that says stop");
});

await check("a null last_key stops it, an empty string does not", async () => {
  // '' is a legal starting key. If `done` were tested for falsiness this loop
  // would restart from the beginning of the base, forever.
  let calls = 0;
  const rpc = async () => {
    calls++;
    if (calls === 1) return { last_key: "", rows_scanned: 10, rows_kept: 1 };
    return { last_key: null, rows_scanned: 0, rows_kept: 0 };
  };
  const out = await pullBase(rpc, parseArgs([]));
  assert.equal(out.pages, 2);
  assert.equal(calls, 2);
});

await check("--max-pages caps the run and reports where to resume", async () => {
  const seen = [];
  const out = await pullBase(fakeRpc(1000000, 5000, seen), parseArgs(["--max-pages", "3"]));
  assert.equal(out.pages, 3);
  assert.equal(out.scanned, 15000);
  assert.ok(out.lastKey, "must hand back a key to resume from");
  assert.equal(seen[0].p_after, "", "the first page starts at the beginning");
  assert.equal(seen[1].p_after, seen[0].p_after === "" ? "0000005000" : seen[1].p_after);
});

await check("--resume starts where the last run stopped", async () => {
  const seen = [];
  await pullBase(fakeRpc(5000, 5000, seen), parseArgs(["--resume", "6003486502"]));
  assert.equal(seen[0].p_after, "6003486502");
});

await check("dry run is carried all the way to the database", async () => {
  const seen = [];
  await pullBase(fakeRpc(5000, 5000, seen), parseArgs(["--dry-run"]));
  assert.equal(seen[0].p_dry_run, true, "the function is what refuses to write, so it must be told");
});

console.log(failed ? `\n${failed} failed\n` : "\nall passed\n");
process.exit(failed ? 1 : 0);
