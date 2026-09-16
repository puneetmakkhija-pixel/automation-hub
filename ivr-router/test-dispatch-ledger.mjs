import test from "node:test";
import assert from "node:assert/strict";
import { recordDispatch, runFlexiloansCampaign } from "./lib/flexiloansCampaignOrchestrator.js";

// Nothing recorded who had been dialled, so two lots of 25,000 would have been
// the SAME 25,000 — and the daily cron would re-dial the top N every day
// instead of working through 2,137,956 over 43 days. It never showed up
// because no run had ever reached the compose step.

function sb(capture = {}, result = { data: null, error: null }) {
  return {
    rpc: async (fn, args) => {
      if (fn === "record_campaign_dispatch") {
        capture.fn = fn;
        capture.args = args;
        return result;
      }
      return { data: [{ mobile10: "9990001112" }, { mobile10: "9990001113" }], error: null };
    },
  };
}

test("the ledger gets the numbers that were dialled", async () => {
  const cap = {};
  const n = await recordDispatch(sb(cap, { data: 2, error: null }), {
    campaign: "FLEXI_BL_20260916",
    rows: [{ mobile10: "9990001112" }, { mobile10: "9990001113" }],
  });
  assert.equal(n, 2);
  assert.deepEqual(cap.args.p_mobiles, ["9990001112", "9990001113"]);
  assert.equal(cap.args.p_campaign, "FLEXI_BL_20260916");
});

test("only ten-digit numbers reach the ledger", async () => {
  const cap = {};
  await recordDispatch(sb(cap, { data: 1, error: null }), {
    campaign: "c",
    rows: [{ mobile10: "12345" }, { mobile10: "919990001112" }, { mobile10: "9990001113" }],
  });
  // A malformed number in the ledger suppresses nobody while looking like it has.
  assert.deepEqual(cap.args.p_mobiles, ["9990001112", "9990001113"]);
});

test("an empty list does not call the database at all", async () => {
  const cap = {};
  assert.equal(await recordDispatch(sb(cap), { campaign: "c", rows: [] }), 0);
  assert.equal(cap.fn, undefined);
});

test("a failed ledger write is an error, not a silent zero", async () => {
  await assert.rejects(
    () => recordDispatch(sb({}, { data: null, error: { message: "permission denied" } }),
      { campaign: "c", rows: [{ mobile10: "9990001112" }] }),
    /dispatch ledger write failed: permission denied/
  );
});

// ── ordering, which is the part that matters ─────────────────────────────────

function deps(obdOverrides = {}, rpcResult = { data: 2, error: null }) {
  const order = [];
  return {
    order,
    sb: {
      rpc: async (fn, args) => {
        if (fn === "record_campaign_dispatch") {
          order.push("record");
          return rpcResult;
        }
        return { data: [{ mobile10: "9990001112" }, { mobile10: "9990001113" }], error: null };
      },
    },
    tts: { textToSpeech: async () => ({ success: true, audio: Buffer.from("ID3") }) },
    obd: {
      uploadVoiceFile: async () => ({ promptId: "p1" }),
      uploadBaseFile: async () => ({ baseId: "b1" }),
      composeCampaign: async () => { order.push("compose"); return { campaignId: "c1" }; },
      ...obdOverrides,
    },
    env: { FLEXI_CAMPAIGN_ENABLED: "on" },
  };
}

test("the ledger is written AFTER the compose, never before", async () => {
  const d = deps();
  const out = await runFlexiloansCampaign(d, { cap: 2, stamp: "20260916" });
  assert.deepEqual(d.order, ["compose", "record"],
    "recording first would sit people out 90 days for a run that never dialled");
  assert.equal(out.dispatch_recorded, true);
});

test("a compose that fails writes nothing to the ledger", async () => {
  const d = deps({ composeCampaign: async () => { throw new Error("Compose campaign failed: HTTP 400"); } });
  await runFlexiloansCampaign(d, { cap: 2 }).catch(() => {});
  assert.ok(!d.order.includes("record"), "people who were never called must stay dialable");
});

test("a dialled run whose ledger write failed says so loudly", async () => {
  // The dangerous case: the calls went out, the ledger did not. The next lot
  // would re-dial these people and nothing would look wrong.
  const d = deps({}, { data: null, error: { message: "deadlock detected" } });
  const out = await runFlexiloansCampaign(d, { cap: 2 });
  assert.equal(out.ok, true, "it did dial — reporting failure would be a lie");
  assert.equal(out.dialled, true);
  assert.equal(out.dispatch_recorded, false);
  assert.match(out.warning, /dispatch ledger was not written: .*deadlock/);
});

test("a short ledger write is not reported as a clean one", async () => {
  // Two dialled, one recorded: the other is still dialable and nobody said so.
  const d = deps({}, { data: 1, error: null });
  const out = await runFlexiloansCampaign(d, { cap: 2 });
  assert.equal(out.dispatch_recorded, false);
});

test("a prepared-but-not-dialled run writes nothing", async () => {
  const d = deps();
  d.env = {};
  const out = await runFlexiloansCampaign(d, { cap: 2 });
  assert.equal(out.dialled, false);
  assert.ok(!d.order.includes("record"));
});
