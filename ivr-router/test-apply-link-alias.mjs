/**
 * The alias has to survive the trip, or the lead is unattributable.
 *
 *   node test-apply-link-alias.mjs
 *
 * Plain node, plain asserts, no credentials and no network.
 *
 * The three link fixtures below are the REAL shapes sent in production on
 * 01-10 Sep 2026, copied from whatsapp_messages.metadata->>'link' with the
 * alias masked. That matters: the Business Loans link turned out to be a BARE
 * URL with no query string at all, which is the case a link I invented would
 * not have had.
 */
import assert from "node:assert/strict";
import { withAlias, aliasParamFor, addAliasToLinks } from "./lib/applyLinkAlias.js";

/** The exact pattern crm.mis_alias() scans a lender's MIS row for. */
const MIS_ALIAS_RE = /alias_([0-9a-zA-Z]{7})([^0-9a-zA-Z]|$)/;

const ALIAS = "0a1b2c3";

const LINKS = {
  // Bare. No query string whatsoever — 7,574 of these went out.
  businessloans: "https://crmbusinessloans.com/apply",
  // AppsFlyer OneLink on the advertiser's own domain. 6,269 sent.
  herofincorp:
    "https://loans.apps.herofincorp.com/en/personal-loan?af_xp=custom&source_caller=ui" +
    "&pid=Buddyloan&utm_medium=4636&utm_campaignid=IVR&is_retargeting=true" +
    "&af_android_url=https://loans.apps.herofincorp.com/en/personal-loan",
  // Already carries one. 9,445 sent, and the 63 matched Poonawalla leads came
  // back on exactly this.
  poonawalla:
    "https://s1.whistleloop.com/?linkid=52680&offerid=1351&publisher_id=4773" +
    "&parentid=1309&pub_name=Nisha&sub_id1=alias_9z8y7x6&loop_id=1vqpdsm",
};

let failed = 0;
let n = 0;
const check = (name, fn) => {
  n++;
  delete process.env.IVR_ALIAS_PARAM;
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
};

console.log("\nthe alias reaches the link, and the MIS decoder finds it\n");

check("a bare apply link gets one", () => {
  // The whole point. crmbusinessloans.com/apply had no query string at all, so
  // there was nothing for a lender or our own apply page to echo back.
  const out = withAlias(LINKS.businessloans, ALIAS);
  const url = new URL(out);
  assert.equal(url.origin + url.pathname, "https://crmbusinessloans.com/apply");
  assert.equal(url.searchParams.get("alias"), `alias_${ALIAS}`);
});

check("and the MIS decoder's own regex pulls it back out", () => {
  // End to end, both halves: what we put on the link has to match the pattern
  // crm.mis_alias() runs against the lender's file. Asserting we "added a
  // parameter" would pass while the value was shaped wrong.
  for (const link of [LINKS.businessloans, LINKS.herofincorp]) {
    const match = MIS_ALIAS_RE.exec(withAlias(link, ALIAS));
    assert.ok(match, `no alias found in ${link}`);
    assert.equal(match[1], ALIAS);
  }
});

check("a seven-character alias starting with 0 survives intact", () => {
  // About 1 in 5 aliases starts with "0" and the leading zero is load-bearing —
  // lose it and it decodes to a different mobile.
  const match = MIS_ALIAS_RE.exec(withAlias(LINKS.businessloans, "0000abc"));
  assert.equal(match[1], "0000abc");
});

console.log("\neach destination gets the parameter it will actually pass through\n");

check("whistleloop gets sub_id1 — the one that is proven to come back", () => {
  assert.equal(aliasParamFor(new URL("https://s1.whistleloop.com/?linkid=1")), "sub_id1");
});

check("an AppsFlyer OneLink gets af_sub1, matched on its parameters not its host", () => {
  // Hero's OneLink is served from loans.apps.herofincorp.com — there is no
  // appsflyer.com to match on, and an unknown parameter is dropped before the
  // advertiser sees it.
  assert.equal(aliasParamFor(new URL(LINKS.herofincorp)), "af_sub1");
  assert.equal(new URL(withAlias(LINKS.herofincorp, ALIAS)).searchParams.get("af_sub1"),
    `alias_${ALIAS}`);
});

check("our own apply page gets the plain name", () => {
  assert.equal(aliasParamFor(new URL(LINKS.businessloans)), "alias");
});

check("IVR_ALIAS_PARAM overrides all of them", () => {
  process.env.IVR_ALIAS_PARAM = "custom_ref";
  assert.equal(new URL(withAlias(LINKS.businessloans, ALIAS)).searchParams.get("custom_ref"),
    `alias_${ALIAS}`);
});

console.log("\nit never tags a link twice\n");

check("a link that already carries an alias is left exactly alone", () => {
  // Two aliases on one URL is two different answers for one lead.
  assert.equal(withAlias(LINKS.poonawalla, ALIAS), LINKS.poonawalla);
  assert.equal(MIS_ALIAS_RE.exec(withAlias(LINKS.poonawalla, ALIAS))[1], "9z8y7x6");
});

check("an alias in some OTHER parameter still counts as already tagged", () => {
  // The check that distinguishes the two guards. In the whistleloop fixture the
  // existing alias sits in sub_id1, which is also the parameter we would pick —
  // so the don't-overwrite rule covers it and the don't-tag-twice rule could be
  // deleted without any check noticing. Here the alias is somewhere we would
  // NOT have looked, and only the second rule prevents a second one being added.
  const link = "https://crmbusinessloans.com/apply?ref=alias_9z8y7x6";
  assert.equal(withAlias(link, ALIAS), link);

  const all = [...withAlias(link, ALIAS).matchAll(/alias_[0-9a-zA-Z]{7}/g)];
  assert.equal(all.length, 1, "a second alias was added alongside the first");
});

check("an existing value in the chosen parameter is not overwritten", () => {
  const link = "https://crmbusinessloans.com/apply?alias=chosen_by_hand";
  assert.equal(withAlias(link, ALIAS), link);
});

check("an empty parameter IS filled in", () => {
  const out = withAlias("https://crmbusinessloans.com/apply?alias=", ALIAS);
  assert.equal(new URL(out).searchParams.get("alias"), `alias_${ALIAS}`);
});

console.log("\nand it never mangles anything it does not understand\n");

check("no alias means the link goes out unchanged", () => {
  // aliasFor() returns "" for anything that is not a ten-digit mobile. An
  // "alias_" with nothing after it decodes to nobody and reads like a lost
  // value rather than an absent one.
  for (const bad of ["", null, undefined, "   "]) {
    assert.equal(withAlias(LINKS.businessloans, bad), LINKS.businessloans);
  }
});

check("a placeholder that is not a link is untouched", () => {
  // Templates carry names and amounts in the same array.
  for (const value of ["Rahul", "50,000", " ", "", "ivr_keypress_webhook", "not a url"]) {
    assert.equal(withAlias(value, ALIAS), value);
  }
});

check("a non-http scheme is refused", () => {
  for (const link of ["ftp://example.com/x", "javascript:alert(1)", "mailto:a@b.com"]) {
    assert.equal(withAlias(link, ALIAS), link);
  }
});

check("the query string it already had is preserved in full", () => {
  const out = new URL(withAlias(LINKS.herofincorp, ALIAS));
  assert.equal(out.searchParams.get("pid"), "Buddyloan");
  assert.equal(out.searchParams.get("utm_campaignid"), "IVR");
  assert.equal(out.searchParams.get("af_xp"), "custom");
  assert.equal(out.hostname, "loans.apps.herofincorp.com");
});

check("nothing throws, whatever it is handed", () => {
  for (const bad of [null, undefined, 42, {}, [], NaN]) {
    assert.doesNotThrow(() => withAlias(bad, ALIAS));
    assert.doesNotThrow(() => withAlias(LINKS.businessloans, bad));
  }
});

console.log("\nthe whole placeholder list, the way the route uses it\n");

check("every link in the list is tagged, wherever it sits", () => {
  // rawPlaceholders() puts the link last only when it came from IVR_LINK_*;
  // the other two configuration paths can put it anywhere in the template.
  const out = addAliasToLinks(["Rahul", LINKS.businessloans, "50,000"], ALIAS);
  assert.equal(out[0], "Rahul");
  assert.equal(new URL(out[1]).searchParams.get("alias"), `alias_${ALIAS}`);
  assert.equal(out[2], "50,000");
});

check("a list with no links comes back identical", () => {
  const list = ["Rahul", "50,000", " "];
  assert.deepEqual(addAliasToLinks(list, ALIAS), list);
});

check("a non-array is returned as-is rather than throwing", () => {
  assert.equal(addAliasToLinks(null, ALIAS), null);
  assert.equal(addAliasToLinks("not a list", ALIAS), "not a list");
});

console.log(`\n${failed === 0 ? `all ${n} checks passed` : `${failed} of ${n} FAILED`}\n`);
process.exit(failed === 0 ? 0 : 1);
