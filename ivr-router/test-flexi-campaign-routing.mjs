/**
 * The Flexiloans campaign's own press-1 routing.
 *
 *   node test-flexi-campaign-routing.mjs
 *
 * No framework, same as test-obd-guard.mjs: plain node, plain asserts,
 * self-contained, no credentials and no network.
 *
 * What this holds, in one sentence: a press-1 from the Flexiloans campaign
 * always reaches the Flexi agent or gets retried later -- never Oriserve,
 * and never silently falls back to Priya's regular cap/split -- while every
 * other campaign's press-1 keeps behaving exactly as it did before this
 * file existed.
 */
import assert from "node:assert/strict";
import {
  isFlexiCampaignPress,
  withinFlexiCallingHours,
  routePress,
  dispatchPressToOurBot,
} from "./lib/ourVoiceBotDispatch.js";

const envOn = { OUR_BOT_PRESS_ENABLED: "on" };

// ── Campaign matching ───────────────────────────────────────────────────────

assert.equal(isFlexiCampaignPress("Flexiloans_Oct2026_FullBase"), true);
assert.equal(isFlexiCampaignPress("1_LAKH_FLEXI_B1_2026100516"), true);
assert.equal(isFlexiCampaignPress("flexiloans_oct2026_fullbase"), true, "case-insensitive");
assert.equal(isFlexiCampaignPress("6OCT_B1_2026100618"), false, "no flexi substring");
assert.equal(isFlexiCampaignPress("businessloans"), false);
assert.equal(isFlexiCampaignPress(null), false);
assert.equal(isFlexiCampaignPress(""), false);
assert.equal(
  isFlexiCampaignPress("Some_Other_Campaign", { OUR_BOT_FLEXI_CAMPAIGN_MATCH: "Some_Other" }),
  true,
  "configurable match string"
);
console.log("ok  campaign matching");

// ── Calling hours (10:00-20:00 IST, start inclusive, end exclusive) ────────

/** A UTC instant whose IST wall-clock reading is `hour:minute`. */
const atIst = (hour, minute = 0) => {
  const utcMs = Date.UTC(2026, 9, 6, hour, minute) - 5.5 * 60 * 60000;
  return new Date(utcMs);
};

assert.equal(withinFlexiCallingHours(atIst(9, 59)), false, "9:59 IST is before the window");
assert.equal(withinFlexiCallingHours(atIst(10, 0)), true, "10:00 IST is the start, inclusive");
assert.equal(withinFlexiCallingHours(atIst(19, 59)), true, "19:59 IST is still inside");
assert.equal(withinFlexiCallingHours(atIst(20, 0)), false, "20:00 IST is the end, exclusive");
assert.equal(withinFlexiCallingHours(atIst(2, 0)), false, "2am IST is well outside");
console.log("ok  Flexi calling-hours window");

// ── routePress: voiceBot is independent of the flag/split answer ──────────

assert.equal(
  routePress({ variant: "businessloans", digit: "1", campaignName: "Flexiloans_Oct2026_FullBase" }, envOn)
    .voiceBot,
  "flexi"
);
assert.equal(
  routePress({ variant: "businessloans", digit: "1", campaignName: "6OCT_B1_2026100618" }, envOn).voiceBot,
  null,
  "a different campaign on the same variant must not be routed to Flexi"
);
assert.equal(
  routePress({ variant: "businessloans", digit: "1" }, envOn).voiceBot,
  null,
  "no campaign_name at all must not match"
);
console.log("ok  routePress carries voiceBot independently of ours/arm");

// ── dispatchPressToOurBot: Flexi never reaches Oriserve ────────────────────

function fakeSb({ claimResult = true } = {}) {
  const calls = { rpc: [], from: [] };
  return {
    calls,
    rpc(name, args) {
      calls.rpc.push({ name, args });
      return Promise.resolve({ data: claimResult, error: null });
    },
    from(table) {
      calls.from.push(table);
      return {
        select() {
          return {
            in() {
              return Promise.resolve({
                data: [
                  { key: "journey_fn_url", value: "https://example.test/journey-run" },
                  { key: "sync_secret", value: "s3cr3t" },
                ],
                error: null,
              });
            },
          };
        },
      };
    },
  };
}

function fakeFetch(body = { voice: { ok: true } }) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}

{
  // Flexi, outside calling hours: refused, never handed to Oriserve, never
  // even reaches the pacer or the daily-cap claim.
  const sb = fakeSb();
  let oriCalled = false;
  const hasRoomCalls = [];
  const out = await dispatchPressToOurBot(
    { mobile: "9812345678", campaign_name: "Flexiloans_Oct2026_FullBase" },
    { digit: "1", variant: "businessloans" },
    {
      route: () => ({ ours: true, arm: null, voiceVariant: null, voiceBot: "flexi" }),
      withinFlexiHours: () => false,
      hasRoom: () => {
        hasRoomCalls.push(1);
        return true;
      },
      sb,
      dispatchToOri: () => {
        oriCalled = true;
      },
    }
  );
  assert.equal(out.dialled, false);
  assert.equal(out.handedToOriserve, false, "Flexi must never fall back to Oriserve");
  assert.equal(oriCalled, false);
  assert.equal(hasRoomCalls.length, 0, "calling-hours is checked before the pacer");
  assert.equal(sb.calls.rpc.length, 0, "no daily-cap slot claimed for a refusal this early");
}
console.log("ok  Flexi outside calling hours: refused, not Oriserve, pacer never consulted");

{
  // Flexi, pacer full: refused, not Oriserve, and the daily cap is never
  // claimed either -- Flexi does not compete with Priya's cap counter.
  const sb = fakeSb();
  let oriCalled = false;
  const out = await dispatchPressToOurBot(
    { mobile: "9812345678", campaign_name: "Flexiloans_Oct2026_FullBase" },
    { digit: "1", variant: "businessloans" },
    {
      route: () => ({ ours: true, arm: null, voiceVariant: null, voiceBot: "flexi" }),
      withinFlexiHours: () => true,
      hasRoom: () => false,
      sb,
      dispatchToOri: () => {
        oriCalled = true;
      },
    }
  );
  assert.equal(out.dialled, false);
  assert.equal(out.handedToOriserve, false);
  assert.equal(oriCalled, false);
  assert.equal(sb.calls.rpc.length, 0, "the daily cap is never claimed for Flexi");
}
console.log("ok  Flexi at the pacer ceiling: refused, not Oriserve, cap untouched");

{
  // Flexi, everything clear: dials, skips claimDailySlot, sends voice_bot:"flexi".
  const sb = fakeSb();
  const fetchFn = fakeFetch();
  const out = await dispatchPressToOurBot(
    { mobile: "9812345678", campaign_name: "Flexiloans_Oct2026_FullBase" },
    { digit: "1", variant: "businessloans" },
    {
      route: () => ({ ours: true, arm: null, voiceVariant: null, voiceBot: "flexi" }),
      withinFlexiHours: () => true,
      hasRoom: () => true,
      sb,
      fetch: fetchFn,
      pace: (fn) => fn(),
    }
  );
  assert.equal(out.dialled, true);
  assert.equal(sb.calls.rpc.length, 0, "no daily-cap slot claimed when Flexi actually dials");
  assert.equal(fetchFn.calls.length, 1);
  const sent = JSON.parse(fetchFn.calls[0].init.body);
  assert.equal(sent.voice_bot, "flexi");
}
console.log("ok  Flexi dials cleanly, uncapped, with voice_bot:\"flexi\" on the journey-run body");

{
  // Regression: a non-Flexi businessloans press still overflows to Oriserve
  // on a spent daily cap, exactly as before this file existed.
  const sb = fakeSb({ claimResult: false });
  let oriArgs = null;
  const out = await dispatchPressToOurBot(
    { mobile: "9812345678" },
    { digit: "1", variant: "businessloans" },
    {
      route: () => ({ ours: true, arm: null, voiceVariant: null, voiceBot: null }),
      hasRoom: () => true,
      sb,
      dispatchToOri: (body, ctx) => {
        oriArgs = ctx;
      },
    }
  );
  assert.equal(out.dialled, false);
  assert.equal(out.handedToOriserve, true);
  assert.equal(oriArgs.fallbackReason, "daily_cap");
  assert.equal(sb.calls.rpc.length, 1, "the daily cap IS claimed for a non-Flexi press");
}
console.log("ok  non-Flexi businessloans press still overflows to Oriserve on a spent cap (regression)");

console.log("\nAll Flexi campaign routing checks passed.");
