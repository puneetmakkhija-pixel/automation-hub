import test from "node:test";
import assert from "node:assert/strict";
import OBDApiClient, { obdBodySaysFailure } from "./lib/obdApiClient.js";
import { runFlexiloansCampaign } from "./lib/flexiloansCampaignOrchestrator.js";

// Run 9:
//   {"step":"contacts","id":null,"returned":["message"],"said":"File Upload Failed"}
//
// HTTP 200, and the body says it failed. Every caller here checked
// response.ok and nothing else, so three runs were spent believing the dial
// list had been uploaded when nothing had ever reached the dialler.

test("a message that says it failed is a failure", () => {
  assert.equal(obdBodySaysFailure({ message: "File Upload Failed" }), "File Upload Failed");
  assert.equal(obdBodySaysFailure({ message: "Invalid base file" }), "Invalid base file");
  assert.equal(obdBodySaysFailure({ message: "Unable to process" }), "Unable to process");
  assert.equal(obdBodySaysFailure({ message: "Base not found" }), "Base not found");
});

test("a message that reports success is not", () => {
  assert.equal(obdBodySaysFailure({ message: "File Uploaded Successfully" }), null);
  assert.equal(obdBodySaysFailure({ message: "Prompt uploaded" }), null);
  assert.equal(obdBodySaysFailure({ message: "OK" }), null);
});

test("a word that merely contains a failure word does not trip it", () => {
  // "failover" and "errorless" are not failures; the boundary is what keeps a
  // working upload from being thrown away.
  assert.equal(obdBodySaysFailure({ message: "Queued on failover node" }), null);
  assert.equal(obdBodySaysFailure({ message: "Terrorem" }), null);
});

test("a body with no message at all is not a failure", () => {
  assert.equal(obdBodySaysFailure({}), null);
  assert.equal(obdBodySaysFailure(null), null);
  assert.equal(obdBodySaysFailure({ baseId: 5 }), null);
  assert.equal(obdBodySaysFailure({ message: 42 }), null);
});

function clientWith(body) {
  const c = new OBDApiClient();
  c.token = "t"; c.userId = "u"; c.ensureToken = async () => {};
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => body, text: async () => "" });
  return { c, restore: () => { globalThis.fetch = original; } };
}

test("the base upload refuses a 200 that says File Upload Failed", async () => {
  const { c, restore } = clientWith({ message: "File Upload Failed" });
  try {
    await assert.rejects(
      () => c.uploadBaseFile("mobile,name\n9990001112,X\n", "FLEXI_BL_20260916"),
      /Base upload failed: HTTP 200 — File Upload Failed/
    );
  } finally { restore(); }
});

test("the voice upload refuses one too", async () => {
  const { c, restore } = clientWith({ message: "File Upload Failed" });
  try {
    await assert.rejects(
      () => c.uploadVoiceFile(Buffer.from("ID3"), "FLEXI_BL_20260916.mp3", "menu", "mp3"),
      /Voice upload failed: HTTP 200 — File Upload Failed/
    );
  } finally { restore(); }
});

test("a genuine success still comes back", async () => {
  const { c, restore } = clientWith({ message: "Uploaded successfully", baseId: 8123 });
  try {
    const out = await c.uploadBaseFile("mobile,name\n9990001112,X\n", "FLEXI_BL_20260916");
    assert.equal(out.baseId, 8123);
  } finally { restore(); }
});

test("contactList is no longer sent as the string 'null'", async () => {
  const c = new OBDApiClient();
  c.token = "t"; c.userId = "u"; c.ensureToken = async () => {};
  const original = globalThis.fetch;
  let form = null;
  globalThis.fetch = async (_u, init) => {
    form = init.body;
    return { ok: true, status: 200, json: async () => ({ baseId: 1 }), text: async () => "" };
  };
  try {
    await c.uploadBaseFile("mobile,name\n9990001112,X\n", "B");
    assert.notEqual(form.get("contactList"), "null",
      "FormData stringifies null to the word 'null', which is not a value any API wants");
  } finally { globalThis.fetch = original; }
});

test("the prompt step reports what the dialler said, like the base step does", async () => {
  const deps = {
    sb: { rpc: async () => ({ data: [{ mobile10: "9990001112" }], error: null }) },
    tts: { textToSpeech: async () => ({ success: true, audio: Buffer.from("ID3") }) },
    obd: {
      uploadVoiceFile: async () => ({ message: "Prompt stored" }),
      getVoiceFiles: async () => [],
      uploadBaseFile: async () => ({ message: "Base stored" }),
      composeCampaign: async () => ({ campaignId: "c1" }),
    },
    env: { FLEXI_CAMPAIGN_ENABLED: "on" },
  };
  const err = await runFlexiloansCampaign(deps, { cap: 1, stamp: "20260916" }).then(() => null, (e) => e);
  assert.ok(err);
  // Run 9 captured this for contacts and not for prompt, so the prompt's null
  // id looked like a lookup problem rather than a failed upload.
  assert.equal(err.steps.find((s) => s.step === "prompt").said, "Prompt stored");
});
