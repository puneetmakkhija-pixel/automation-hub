/**
 * The ElevenLabs credits probe: the reading it writes, and that it never throws.
 *
 *   node test-eleven-credits-probe.mjs
 */
import assert from "node:assert/strict";
import { probeElevenCredits } from "./lib/elevenCreditsProbe.js";

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};

const fakeSb = (written, { error = null } = {}) => ({
  from: (table) => ({
    upsert: async (row, opts) => { written.push({ table, row, opts }); return { error }; },
  }),
});
const sub = (o) => async () => ({ ok: true, status: 200, text: async () => JSON.stringify(o) });
const NOW = Date.UTC(2026, 9, 7, 6, 0, 0);

await check("writes credits left, the reset date and the overage flag", async () => {
  const written = [];
  const out = await probeElevenCredits({
    apiKey: "k", sb: fakeSb(written), now: () => NOW,
    fetch: sub({ tier: "pro", character_count: 912_000, character_limit: 1_000_000, next_character_count_reset_unix: 1794000000, allowed_to_extend_character_limit: false, status: "active" }),
  });
  assert.equal(out.ok, true);
  assert.equal(written.length, 1);
  assert.equal(written[0].table, "service_probe");
  assert.equal(written[0].row.key, "elevenlabs_credits");
  assert.deepEqual(written[0].row.body, { tier: "pro", used: 912000, limit: 1000000, remaining: 88000, pct_left: 8.8, reset_unix: 1794000000, can_extend: false, status: "active" });
  assert.equal(written[0].row.updated_at, new Date(NOW).toISOString());
  assert.deepEqual(written[0].opts, { onConflict: "key" });
});

await check("usage-based billing on is recorded as can_extend", async () => {
  const written = [];
  await probeElevenCredits({ apiKey: "k", sb: fakeSb(written), fetch: sub({ character_count: 1, character_limit: 100, allowed_to_extend_character_limit: true }) });
  assert.equal(written[0].row.body.can_extend, true);
});

await check("over the limit reads as zero left, not negative", async () => {
  const written = [];
  await probeElevenCredits({ apiKey: "k", sb: fakeSb(written), fetch: sub({ character_count: 1200, character_limit: 1000 }) });
  assert.equal(written[0].row.body.remaining, 0);
  assert.equal(written[0].row.body.pct_left, 0);
});

await check("a refused key is written as an error, so the dashboard says so instead of going stale", async () => {
  const written = [];
  const out = await probeElevenCredits({
    apiKey: "k", sb: fakeSb(written),
    fetch: async () => ({ ok: false, status: 401, text: async () => '{"detail":{"status":"missing_permissions"}}' }),
  });
  assert.equal(out.ok, false);
  assert.match(written[0].row.body.error, /^HTTP 401/);
});

await check("an answer with no numbers is an error, not a zero balance", async () => {
  const written = [];
  await probeElevenCredits({ apiKey: "k", sb: fakeSb(written), fetch: sub({ tier: "pro" }) });
  assert.match(written[0].row.body.error, /no usable/);
});

await check("never throws: network error, database error, no key", async () => {
  const written = [];
  const a = await probeElevenCredits({ apiKey: "k", sb: fakeSb(written), fetch: async () => { throw new Error("boom"); } });
  assert.equal(a.ok, false);
  assert.match(written[0].row.body.error, /boom/);
  const b = await probeElevenCredits({ apiKey: "k", sb: fakeSb([], { error: { message: "denied" } }), fetch: sub({ character_count: 1, character_limit: 2 }) });
  assert.equal(b.ok, false);
  assert.match(b.reason, /write failed/);
  const c = await probeElevenCredits({ apiKey: "" });
  assert.equal(c.reason, "not_configured");
});

console.log(failed ? `\n${failed} failed\n` : "\nall passed\n");
process.exit(failed ? 1 : 0);
