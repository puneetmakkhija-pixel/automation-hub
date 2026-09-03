/**
 * The mobile alias, and the spreadsheet formula that has to agree with it.
 *
 *   node test-alias.mjs
 *
 * No framework, same as test-press-forward.mjs and test-obd-guard.mjs: plain
 * node, plain asserts, no credentials, no network.
 *
 * The last check is the one that matters. The recon formula lives in a
 * spreadsheet, far from this code, and nothing would notice if the two ever
 * stopped agreeing — so the formula is reimplemented here and asserted against
 * the real encoder over fifty thousand numbers.
 */
import assert from "node:assert/strict";
import { aliasFor, ALIAS_MOD } from "./lib/mobileAlias.js";
import AnantaWhatsAppService from "./lib/services/anantaWhatsAppService.js";

// Deliberately NOT the production key. The whole point of the alias is that
// whistleloop's logs cannot be turned back into phone numbers by whoever reads
// them, and a key committed here hands that back to anyone with repo access.
// Every property below holds for any key, so the test has no reason to know
// the real one.
const KEY = "1234509876";

/** =TEXT(MOD(DECIMAL(UPPER(RIGHT(A2,7)),36)-$B$1,10^10),"0000000000") */
const excelDecode = (alias, key) =>
  String(((parseInt(alias, 36) - Number(key)) % ALIAS_MOD + ALIAS_MOD) % ALIAS_MOD)
    .padStart(10, "0");

const mobiles = (n) =>
  Array.from({ length: n }, () =>
    String(6 + Math.floor(Math.random() * 4)) +
    String(Math.floor(Math.random() * 1e9)).padStart(9, "0"));

let failed = 0;
const check = (name, fn) => {
  process.env.IVR_ALIAS_KEY = KEY;
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};

console.log("\nmobile alias\n");

check("a mobile round-trips through the alias", () => {
  for (const m of ["9310300800", "7088190290", "6390561331", "9999999999", "6000000000"]) {
    assert.equal(excelDecode(aliasFor(m), KEY), m);
  }
});

check("every alias is exactly seven characters", () => {
  for (const m of mobiles(20000)) assert.equal(aliasFor(m).length, 7);
});

check("no two mobiles share an alias", () => {
  const seen = new Map();
  for (const m of mobiles(50000)) {
    const a = aliasFor(m);
    if (seen.has(a)) assert.equal(seen.get(a), m, `alias ${a} collided`);
    seen.set(a, m);
  }
});

check("aliases that start with 0 still decode", () => {
  // ~1 in 5 does. If a spreadsheet reads the column as a number it eats that
  // zero and returns the WRONG mobile — hence the alias_ prefix in the URL and
  // Text formatting in the MIS.
  const leading = mobiles(20000).map(aliasFor).filter((a) => a.startsWith("0"));
  assert.ok(leading.length > 0, "expected some leading-zero aliases in 20k");
  for (const m of mobiles(20000)) {
    const a = aliasFor(m);
    if (a.startsWith("0")) assert.equal(excelDecode(a, KEY), m);
  }
});

check("a country code makes no difference", () => {
  assert.equal(aliasFor("+919310300800"), aliasFor("9310300800"));
  assert.equal(aliasFor("919310300800"), aliasFor("9310300800"));
});

check("anything that is not a ten-digit mobile is refused", () => {
  for (const bad of ["", null, undefined, "12345", "abcdefghij"]) {
    assert.equal(aliasFor(bad), "");
  }
});

check("an unset key still round-trips", () => {
  delete process.env.IVR_ALIAS_KEY;
  assert.equal(excelDecode(aliasFor("9310300800"), "0"), "9310300800");
});

check("a key pasted with whitespace is the same key", () => {
  const clean = aliasFor("9310300800");
  process.env.IVR_ALIAS_KEY = ` ${KEY}\n`;
  assert.equal(aliasFor("9310300800"), clean);
});

check("a nonsense key falls back to zero rather than NaN", () => {
  process.env.IVR_ALIAS_KEY = "not-a-number";
  const a = aliasFor("9310300800");
  assert.equal(a.length, 7);
  assert.equal(excelDecode(a, "0"), "9310300800");
});

check("the Excel formula agrees with the encoder, at scale", () => {
  for (const m of mobiles(50000)) assert.equal(excelDecode(aliasFor(m), KEY), m);
});

// The FlexiLoans template used to interpolate lead.phone straight into sub_id1
// of an affiliate URL. It is unreferenced today, which is exactly why nothing
// would have caught it: the leak would ship the first time someone wired it up.
check("the FlexiLoans link carries an alias, never the mobile", () => {
  const phone = "9310300800";
  const msg = AnantaWhatsAppService.formatFlexiLoansMessage({ phone, name: "A" }, "camp1");

  assert.ok(!msg.includes(phone), "the raw mobile is in the affiliate link");
  assert.ok(!msg.includes(phone.slice(-8)), "part of the mobile is in the affiliate link");

  const alias = msg.match(/sub_id1=alias_([0-9a-z]{7})&/)?.[1];
  assert.ok(alias, "no seven-character alias in sub_id1");
  assert.equal(excelDecode(alias, KEY), phone);
});

// An empty alias is what 5,707 sends went out with on 01 Sep, and it is
// unreconcilable: every one of them came back looking identical. If aliasFor
// ever returns "" the link must not be built as if nothing happened.
check("an unusable mobile is refused rather than sent with an empty alias", () => {
  for (const phone of ["12345", "", null, undefined, "not-a-phone"]) {
    assert.throws(
      () => AnantaWhatsAppService.formatFlexiLoansMessage({ phone, name: "A" }, "camp1"),
      /cannot be reconciled/,
      `sent a link for ${JSON.stringify(phone)}`,
    );
  }
});

console.log(failed ? `\n${failed} failed\n` : "\nall passed\n");
process.exit(failed ? 1 : 0);
