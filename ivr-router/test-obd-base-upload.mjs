import test from "node:test";
import assert from "node:assert/strict";
import OBDApiClient, { obdFailure } from "./lib/obdApiClient.js";

// Run 6 cleared the voice upload — the first run ever to — and died on the
// next step with:
//
//   {"ok":false,"error":"Base upload failed: "}
//
// Naming nothing, because response.statusText is empty over HTTP/2. #83 fixed
// exactly that, for uploadVoiceFile only, and left the same defect in its 23
// siblings. uploadBaseFile also still had the raw-string-into-FormData bug
// that #83 found next door.

function client() {
  const c = new OBDApiClient();
  c.token = "t";
  c.userId = "u";
  c.ensureToken = async () => {};
  return c;
}

async function captureBase(csv, baseName) {
  const original = globalThis.fetch;
  let form = null;
  globalThis.fetch = async (_url, init) => {
    form = init.body;
    return { ok: true, status: 200, json: async () => ({ baseId: 1 }), text: async () => "" };
  };
  try {
    await client().uploadBaseFile(csv, baseName);
  } finally {
    globalThis.fetch = original;
  }
  return form;
}

const CSV = "mobile,name\n9990001112,Test\n";

test("the CSV goes as a FILE, not as a text field", async () => {
  const form = await captureBase(CSV, "FLEXI_BL_20260916");
  const part = form.get("baseFile");
  // The exact failure shape: a string here is an ordinary form field.
  assert.notEqual(typeof part, "string", "a bare string is not an uploaded file");
  assert.ok(part && typeof part.arrayBuffer === "function", "baseFile should be Blob-like");
  assert.equal(await part.text(), CSV);
});

test("the base file keeps its extension and the baseName field does not", async () => {
  const form = await captureBase(CSV, "FLEXI_BL_20260916");
  assert.equal(form.get("baseFile").name, "FLEXI_BL_20260916.csv");
  assert.equal(form.get("baseName"), "FLEXI_BL_20260916");
  assert.doesNotMatch(form.get("baseName"), /\./);
});

test("a dotted base name is cleaned the same way the prompt name is", async () => {
  const form = await captureBase(CSV, "FLEXI_BL_20260916.csv");
  assert.equal(form.get("baseName"), "FLEXI_BL_20260916");
  assert.equal(form.get("baseFile").name, "FLEXI_BL_20260916.csv");
});

// ── the error has to name the reason ─────────────────────────────────────────

test("a failed base upload names the status and the body", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false, status: 400,
    text: async () => '{"message":"Base name already exists"}',
    json: async () => ({}),
  });
  try {
    await assert.rejects(
      () => client().uploadBaseFile(CSV, "FLEXI_BL_20260916"),
      /Base upload failed: HTTP 400 — .*Base name already exists/
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("obdFailure never produces the bare message that cost run 6", async () => {
  const err = await obdFailure("Base upload", {
    status: 500, statusText: "", text: async () => "",
  });
  // "Base upload failed: " with nothing after the colon is the bug itself.
  assert.notEqual(err.message, "Base upload failed: ");
  assert.match(err.message, /HTTP 500/);
});

test("obdFailure survives a body it cannot read", async () => {
  const err = await obdFailure("Compose campaign", {
    status: 502, text: async () => { throw new Error("stream closed"); },
  });
  assert.match(err.message, /Compose campaign failed: HTTP 502/);
});

test("obdFailure bounds the body, because it reaches an HTTP response", async () => {
  const err = await obdFailure("Get report", { status: 400, text: async () => "x".repeat(5000) });
  assert.ok(err.message.length < 400, `unbounded: ${err.message.length}`);
});
