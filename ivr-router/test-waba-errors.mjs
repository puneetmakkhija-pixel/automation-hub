/**
 * A refusal that no retry changes must not be retried.
 *
 *   node test-waba-errors.mjs
 *
 * Plain node, plain asserts, no credentials and no network.
 *
 * WHY THIS EXISTS
 *
 * Meta paused the press-1 template on 16 Sep 2026. The failure handler treated
 * it like a timeout — dropped the dedupe key, answered 502 — and 502 is the IVR
 * panel's cue to retry. It retried twice more, every time, for two days:
 *
 *   17 Sep   2,151 attempts   724 people   0 delivered
 *
 * The trap is that Ananta does NOT return Meta's code as its own. Every Meta
 * rejection is Ananta code 1353, retryable or not, with the real code buried in
 * the message as "(#132015)". Anything keying off the envelope sees one code
 * for all of them and cannot tell a paused template from a rate limit.
 */
import assert from "node:assert/strict";
import {
  isPermanentFailure,
  isTemplateFailure,
  metaErrorCode,
  templateCandidates,
} from "./lib/wabaErrors.js";

let checks = 0;
const check = (name, fn) => {
  fn();
  checks++;
  console.log(`  ok  ${name}`);
};

/** Exactly what Ananta returned on 16 and 17 Sep. */
const PAUSED = {
  code: "1353",
  status: "false",
  message:
    "(#132015) Template is temporarily unavailable to use because it was paused due to low quality.",
};
const NO_TRANSLATION = {
  code: "1353",
  status: "false",
  message: "(#132001) Template name does not exist in the translation",
};
const UNKNOWN_META = { code: "1353", status: "false", message: "Unknown Meta API error" };

console.log("\nmetaErrorCode — the code that matters is inside the parentheses");

check("digs 132015 out of the message, not the 1353 envelope", () => {
  assert.equal(metaErrorCode(PAUSED), "132015");
  assert.notEqual(metaErrorCode(PAUSED), PAUSED.code);
});

check("reads 132001 the same way", () => {
  assert.equal(metaErrorCode(NO_TRANSLATION), "132001");
});

check("a message with no (#code) yields null, not a guess", () => {
  assert.equal(metaErrorCode(UNKNOWN_META), null);
  assert.equal(metaErrorCode({ code: "1353" }), null);
});

check("survives the shapes axios actually hands back", () => {
  assert.equal(metaErrorCode(null), null);
  assert.equal(metaErrorCode(undefined), null);
  assert.equal(metaErrorCode("timeout of 10000ms exceeded"), null);
  // A bare string body is a real axios outcome, not a hypothetical.
  assert.equal(metaErrorCode("(#132015) paused"), "132015");
});

console.log("\nisPermanentFailure — the 16 Sep bug, in one assertion");

check("a paused template is permanent", () => {
  assert.equal(isPermanentFailure(PAUSED), true);
});

check("a template that does not exist is permanent", () => {
  assert.equal(isPermanentFailure(NO_TRANSLATION), true);
});

check("every template-level Meta code is permanent", () => {
  for (const code of ["132000", "132001", "132005", "132007", "132012", "132015", "132016"]) {
    assert.equal(
      isPermanentFailure({ code: "1353", message: `(#${code}) whatever` }),
      true,
      `#${code} should not be retried`
    );
  }
});

check("Ananta's own config refusals are permanent", () => {
  // 1310 already had a log line saying every retry fails the same way. The code
  // then went on to invite that retry anyway.
  for (const code of ["1301", "1304", "1310", "1324"]) {
    assert.equal(isPermanentFailure({ code }), true, `${code} should not be retried`);
  }
});

check("a timeout is STILL retryable — the fix must not swallow real blips", () => {
  assert.equal(isPermanentFailure("timeout of 10000ms exceeded"), false);
  assert.equal(isPermanentFailure({ code: "500" }), false);
  assert.equal(isPermanentFailure(null), false);
});

check("an unrecognised failure stays retryable, which is the safe default", () => {
  // Getting this wrong in the permanent direction silently drops a customer who
  // could have been reached, so anything not on the list keeps the old
  // behaviour rather than inheriting the new one.
  assert.equal(isPermanentFailure(UNKNOWN_META), false);
  assert.equal(isPermanentFailure({ code: "1353", message: "(#131048) spam rate limit" }), false);
  assert.equal(isPermanentFailure({ code: "1314" }), false);
});

console.log("\nisTemplateFailure — only a template problem may advance the list");

check("template rejections are template failures", () => {
  assert.equal(isTemplateFailure(PAUSED), true);
  assert.equal(isTemplateFailure(NO_TRANSLATION), true);
  assert.equal(isTemplateFailure({ code: "1324" }), true);
});

check("a bad API key is NOT — it must not burn one call per template", () => {
  assert.equal(isTemplateFailure({ code: "1310" }), false);
  assert.equal(isTemplateFailure({ code: "1304" }), false);
  // Still permanent, just not a reason to try the standby.
  assert.equal(isPermanentFailure({ code: "1310" }), true);
});

console.log("\ntemplateCandidates — a single id must keep behaving like one");

check("the existing {\"1\":\"<id>\"} shape is unchanged", () => {
  assert.deepEqual(templateCandidates("1076547811421124"), ["1076547811421124"]);
});

check("a list gives primary then standbys, in order", () => {
  assert.deepEqual(templateCandidates(["a", "b", "c"]), ["a", "b", "c"]);
  assert.deepEqual(templateCandidates("a,b,c"), ["a", "b", "c"]);
});

check("whitespace from a pasted variable does not become a template id", () => {
  assert.deepEqual(templateCandidates(" a , b "), ["a", "b"]);
  assert.deepEqual(templateCandidates("a,,b"), ["a", "b"]);
});

check("a duplicate is dropped — it would spend a paid call on a known answer", () => {
  assert.deepEqual(templateCandidates("a,b,a"), ["a", "b"]);
});

check("nothing configured yields nothing to send, not a phantom template", () => {
  assert.deepEqual(templateCandidates(undefined), []);
  assert.deepEqual(templateCandidates(""), []);
  assert.deepEqual(templateCandidates(null), []);
});

console.log("\nthe route wiring — where the retry storm actually came from");

const { readFileSync } = await import("node:fs");
const src = readFileSync(new URL("./lib/routes/ivrWhatsAppRoutes.js", import.meta.url), "utf8");

check("a permanent failure answers 200, because 502 is the panel's cue to retry", () => {
  const branch = src.slice(src.indexOf("if (isPermanentFailure(detail))"));
  const ok = branch.indexOf("res.status(200)");
  const retryable = branch.indexOf("res.status(502)");
  assert.ok(ok > -1, "the permanent branch must answer 200");
  assert.ok(ok < retryable, "it must answer 200 before reaching the 502 path");
});

check("the permanent branch does NOT release the dedupe key", () => {
  // Releasing it is what let the panel's next retry through. The 502 path still
  // releases it, and must: a timeout deserves another go.
  const start = src.indexOf("if (isPermanentFailure(detail))");
  const branch = src.slice(start, src.indexOf("res.status(200)", start));
  assert.ok(
    !branch.includes("sent.delete(key)"),
    "a permanent failure must not re-arm the caller for another identical attempt"
  );
  assert.ok(src.includes("sent.delete(key)"), "the transient path must still re-arm");
});

check("only a template failure advances the candidate list", () => {
  assert.ok(
    src.includes("isTemplateFailure(detail) && i < candidates.length - 1"),
    "falling back on any failure would spend one paid call per configured template"
  );
});

console.log(`\n${checks} checks passed\n`);
