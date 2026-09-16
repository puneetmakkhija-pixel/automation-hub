/**
 * The press-1 caller should not meet an OTP screen.
 *
 *   node test-otp-free-apply.mjs
 *
 * Plain node, plain asserts, no credentials and no network.
 *
 * WHY THIS EXISTS
 *
 * The SSO machinery shipped in August and worked. It had minted exactly ONE
 * token for a press-1 caller by 16 Sep, because two separate conditions had to
 * be true and neither was: the caller had to have completed an OTP BEFORE
 * (press-1 callers are first-time by definition), and the configured template
 * had to contain {{sso_link}} (the Business Loans template is a bare URL).
 *
 * Measured over September: 9,063 press-1 -> 8,813 links sent -> 380 typed a
 * mobile -> 289 verified an OTP -> 38 got past the greeting. The OTP screen is
 * where 93% of the funnel ends.
 */
import assert from "node:assert/strict";
import { isPlainApplyLink, upgradeApplyLinks, resolveSsoLink } from "./lib/crmSsoLink.js";

const MINTED = "https://crmbusinessloans.com/apply?t=tok_abc123";

let failed = 0;
let n = 0;
const check = (name, fn) => {
  n++;
  delete process.env.CRM_BASE_URL;
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
};

console.log("\nit recognises our own OTP-gated apply link\n");

check("the real production link is recognised", () => {
  // The exact value of IVR_LINK_BUSINESSLOANS, 7,574 sends.
  assert.equal(isPlainApplyLink("https://crmbusinessloans.com/apply"), true);
});

check("and still is once the alias is on it", () => {
  assert.equal(
    isPlainApplyLink("https://crmbusinessloans.com/apply?alias=alias_0a1b2c3"),
    true
  );
});

check("a trailing slash does not hide it", () => {
  assert.equal(isPlainApplyLink("https://crmbusinessloans.com/apply/"), true);
});

check("an already-minted link is NOT plain", () => {
  // Upgrading a minted link would mean two tokens for one send.
  assert.equal(isPlainApplyLink(MINTED), false);
});

check("a lender's own link is never touched", () => {
  for (const link of [
    "https://s1.whistleloop.com/?linkid=52680&sub_id1=alias_9z8y7x6",
    "https://loans.apps.herofincorp.com/en/personal-loan?af_xp=custom",
  ]) {
    assert.equal(isPlainApplyLink(link), false);
  }
});

check("another page on our own host is not the apply page", () => {
  for (const link of [
    "https://crmbusinessloans.com/",
    "https://crmbusinessloans.com/leads",
    "https://crmbusinessloans.com/apply-status",
  ]) {
    assert.equal(isPlainApplyLink(link), false);
  }
});

check("a name or an amount is not a link", () => {
  for (const v of ["Rahul", "50,000", "", " ", null, undefined, 42, {}]) {
    assert.equal(isPlainApplyLink(v), false);
  }
});

check("CRM_BASE_URL moves what counts as ours", () => {
  process.env.CRM_BASE_URL = "https://staging.example.com";
  assert.equal(isPlainApplyLink("https://staging.example.com/apply"), true);
  assert.equal(isPlainApplyLink("https://crmbusinessloans.com/apply"), false);
});

console.log("\nit swaps the bare link for the pre-verified one\n");

check("the plain link becomes the minted one", () => {
  const out = upgradeApplyLinks(["Rahul", "https://crmbusinessloans.com/apply"], MINTED);
  assert.equal(out[0], "Rahul");
  assert.equal(new URL(out[1]).searchParams.get("t"), "tok_abc123");
});

check("the configured query string survives the swap", () => {
  // utm tags somebody set are not this function's to drop.
  const out = upgradeApplyLinks(
    ["https://crmbusinessloans.com/apply?utm_source=ivr&utm_medium=wa"],
    MINTED
  );
  const url = new URL(out[0]);
  assert.equal(url.searchParams.get("t"), "tok_abc123");
  assert.equal(url.searchParams.get("utm_source"), "ivr");
  assert.equal(url.searchParams.get("utm_medium"), "wa");
});

check("the minted token wins over a stale t= in the config", () => {
  const out = upgradeApplyLinks(["https://crmbusinessloans.com/apply?x=1"], MINTED);
  assert.equal(new URL(out[0]).searchParams.get("t"), "tok_abc123");
});

check("no token minted means the link goes out untouched", () => {
  // resolveSsoLink never throws; on any failure it reports minted=false and the
  // route passes "". The customer then gets the ordinary form, which works.
  const list = ["https://crmbusinessloans.com/apply"];
  for (const empty of ["", null, undefined, "   "]) {
    assert.deepEqual(upgradeApplyLinks(list, empty), list);
  }
});

check("a lender link is left alone even when a token exists", () => {
  const list = ["https://s1.whistleloop.com/?linkid=52680"];
  assert.deepEqual(upgradeApplyLinks(list, MINTED), list);
});

check("a non-array comes back as-is rather than throwing", () => {
  assert.equal(upgradeApplyLinks(null, MINTED), null);
  assert.equal(upgradeApplyLinks("not a list", MINTED), "not a list");
});

check("nothing throws, whatever it is handed", () => {
  for (const bad of [null, undefined, 42, {}, [], NaN]) {
    assert.doesNotThrow(() => upgradeApplyLinks([bad], MINTED));
    assert.doesNotThrow(() => upgradeApplyLinks(["https://crmbusinessloans.com/apply"], bad));
  }
});

console.log("\na first-time caller is no longer sent to the OTP form\n");

/**
 * A database that says "this number has never verified an OTP" — which is what
 * every genuine press-1 caller looks like.
 */
const neverVerified = {
  from() {
    return {
      select() { return this; },
      eq() { return this; },
      not() { return this; },
      limit: async () => ({ data: [], error: null }),
    };
  },
};

/**
 * Pointed at a closed port, so "it tried to mint" and "it refused to try" are
 * distinguishable without a network: reason 'error' means the request was
 * actually attempted, 'never_verified' means the gate stopped it first.
 */
async function resolveAgainstClosedPort() {
  process.env.CRM_SSO_SECRET = "test-secret";
  process.env.CRM_BASE_URL = "http://127.0.0.1:1";
  return resolveSsoLink("9811100007", neverVerified);
}

const asyncCheck = async (name, fn) => {
  n++;
  delete process.env.IVR_SSO_REQUIRE_PRIOR_OTP;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${name}\n       ${error.message}`);
  } finally {
    delete process.env.CRM_SSO_SECRET;
    delete process.env.CRM_BASE_URL;
    delete process.env.IVR_SSO_REQUIRE_PRIOR_OTP;
  }
};

await asyncCheck("a never-verified caller IS taken to the mint", async () => {
  // The whole change. Before this, the gate returned 'never_verified' without
  // ever calling the CRM, so every press-1 caller met an OTP screen.
  const r = await resolveAgainstClosedPort();
  assert.notEqual(r.reason, "never_verified",
    "the first-time gate is still refusing press-1 callers");
  assert.equal(r.reason, "error", `expected a mint attempt, got ${r.reason}`);
});

await asyncCheck("IVR_SSO_REQUIRE_PRIOR_OTP=1 puts the gate back", async () => {
  process.env.IVR_SSO_REQUIRE_PRIOR_OTP = "1";
  const r = await resolveAgainstClosedPort();
  assert.equal(r.reason, "never_verified");
});

await asyncCheck("a failed mint still returns a working link", async () => {
  // Never a dead end: the customer gets the ordinary form, which works.
  const r = await resolveAgainstClosedPort();
  assert.equal(r.minted, false);
  assert.equal(r.url, "http://127.0.0.1:1/apply");
});


console.log(`\n${failed === 0 ? `all ${n} checks passed` : `${failed} of ${n} FAILED`}\n`);
process.exit(failed === 0 ? 0 : 1);
