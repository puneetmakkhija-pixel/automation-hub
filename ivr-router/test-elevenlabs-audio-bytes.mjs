import test from "node:test";
import assert from "node:assert/strict";
import ElevenLabsClient from "./lib/elevenLabsClient.js";

// The root cause: makeRequest's audio branch required method === 'GET'.
// Text-to-speech is a POST, so audio/mpeg fell through to the TEXT branch and
// the MP3 was decoded as UTF-8 — which does not round-trip binary.

const MP3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0xff, 0xfb, 0x90, 0x00, 0x80]);

function stubFetch(contentType, bytes) {
  return async () => ({
    ok: true,
    status: 200,
    headers: { get: (h) => (h.toLowerCase() === "content-type" ? contentType : null) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    text: async () => bytes.toString("utf8"),
    json: async () => ({}),
  });
}

test("a POST that returns audio gives back the exact bytes", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = stubFetch("audio/mpeg", MP3);
  try {
    const client = new ElevenLabsClient("test-key");
    const res = await client.textToSpeech({ text: "नमस्ते", voiceId: "v1" });
    assert.equal(res.success, true);
    assert.ok(Buffer.isBuffer(res.audio), "audio should be a Buffer");
    // Byte-for-byte. Reading this as text mangles 0xff/0xfb into U+FFFD.
    assert.deepEqual(Buffer.from(res.audio), MP3);
    assert.equal(res.audio.length, 10);
  } finally {
    globalThis.fetch = original;
  }
});

test("binary really would be destroyed by the text path", () => {
  // Proves the bug was real rather than theoretical: the old code produced this.
  const viaText = Buffer.from(MP3.toString("utf8"), "utf8");
  assert.notDeepEqual(viaText, MP3);
});

test("JSON responses are still parsed as JSON", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    headers: { get: () => "application/json" },
    json: async () => ({ voices: [{ voice_id: "v1" }] }),
    text: async () => "{}",
  });
  try {
    const client = new ElevenLabsClient("test-key");
    const res = await client.listVoices();
    assert.equal(res.success, true);
    assert.equal(res.count, 1);
  } finally {
    globalThis.fetch = original;
  }
});
