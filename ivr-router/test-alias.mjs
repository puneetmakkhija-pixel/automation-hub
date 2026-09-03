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

const KEY = "4729183465";

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

console.log(failed ? `\n${failed} failed\n` : "\nall passed\n");
process.exit(failed ? 1 : 0);
