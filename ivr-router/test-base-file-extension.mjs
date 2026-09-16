import test from "node:test";
import assert from "node:assert/strict";
import OBDApiClient from "./lib/obdApiClient.js";
import { runFlexiloansCampaign } from "./lib/flexiloansCampaignOrchestrator.js";

// Everything tried so far gets the same answer from the base upload:
//
//   header + name column   -> 200 File Upload Failed
//   bare numbers           -> 200 File Upload Failed
//   contactList "" / "null"-> 200 File Upload Failed  (absent -> 400)
//
// So it is not the content and not that field. The voice upload turned out to
// care about the EXTENSION — "Only accepts .wav or .mp3 file ext" — and nothing
// has ever established what this endpoint accepts. .csv is the incumbent guess,
// never a known answer.

function capture() {
  const c = new OBDApiClient();
  c.token = "t"; c.userId = "u"; c.ensureToken = async () => {};
  const original = globalThis.fetch;
  const seen = {};
  globalThis.fetch = async (_u, init) => {
    seen.form = init.body;
    return { ok: true, status: 200, json: async () => ({ baseId: 1 }), text: async () => "" };
  };
  return { c, seen, restore: () => { globalThis.fetch = original; } };
}

test("csv is still the default, since nothing has disproved it", async () => {
  const { c, seen, restore } = capture();
  try {
    await c.uploadBaseFile("9355333379", "B");
    assert.equal(seen.form.get("baseFile").name, "B.csv");
    assert.equal(seen.form.get("baseFile").type, "text/csv");
  } finally { restore(); }
});

test("txt changes the extension AND the mime together", async () => {
  const { c, seen, restore } = capture();
  try {
    await c.uploadBaseFile("9355333379", "B", "", "txt");
    assert.equal(seen.form.get("baseFile").name, "B.txt");
    // The pair matters: a .txt named file served as text/csv is a mixed signal.
    assert.equal(seen.form.get("baseFile").type, "text/plain");
  } finally { restore(); }
});

test("an unknown extension still produces a usable request", async () => {
  const { c, seen, restore } = capture();
  try {
    await c.uploadBaseFile("9355333379", "B", "", "dat");
    assert.equal(seen.form.get("baseFile").name, "B.dat");
    assert.equal(seen.form.get("baseFile").type, "application/octet-stream");
  } finally { restore(); }
});

test("a hostile extension cannot escape the filename", async () => {
  const { c, seen, restore } = capture();
  try {
    await c.uploadBaseFile("9355333379", "B", "", "../../etc/passwd");
    const name = seen.form.get("baseFile").name;
    assert.equal(name, "B.etcpasswd");
    // What matters: no path separators survive, and exactly one dot — the one
    // separating the extension.
    assert.doesNotMatch(name, /[/\\]/, "no path separator may survive");
    assert.equal(name.split(".").length, 2, "exactly one dot, the extension's");
  } finally { restore(); }
});

test("an empty or missing extension falls back to csv, never to a bare name", async () => {
  for (const ext of ["", null, undefined, "!!!"]) {
    const { c, seen, restore } = capture();
    try {
      await c.uploadBaseFile("9355333379", "B", "", ext);
      assert.equal(seen.form.get("baseFile").name, "B.csv", `ext ${JSON.stringify(ext)}`);
    } finally { restore(); }
  }
});

test("the baseName field still carries no extension", async () => {
  const { c, seen, restore } = capture();
  try {
    await c.uploadBaseFile("9355333379", "B", "", "txt");
    // Runs 4 and 5 established the two rules; changing the extension must not
    // quietly undo them.
    assert.equal(seen.form.get("baseName"), "B");
    assert.doesNotMatch(seen.form.get("baseName"), /\./);
  } finally { restore(); }
});

test("the campaign passes the extension straight through", async () => {
  const seen = {};
  const deps = {
    sb: { rpc: async (fn) => fn === "record_campaign_dispatch"
            ? { data: 1, error: null } : { data: [{ mobile10: "9990001112" }], error: null } },
    tts: { textToSpeech: async () => ({ success: true, audio: Buffer.from("ID3") }) },
    obd: {
      uploadVoiceFile: async () => ({ promptId: "p1" }),
      getVoiceFiles: async () => [],
      uploadBaseFile: async (_f, _n, _cl, ext) => (seen.ext = ext, { baseId: "b1" }),
      composeCampaign: async () => ({ campaignId: "c1" }),
    },
    env: { FLEXI_CAMPAIGN_ENABLED: "on" },
  };
  await runFlexiloansCampaign(deps, { testMobile: "9355333379", baseExt: "txt" });
  assert.equal(seen.ext, "txt");
  await runFlexiloansCampaign(deps, { testMobile: "9355333379" });
  assert.equal(seen.ext, "csv");
});
