/**
 * The recordings we keep, and the one way keeping them could go wrong.
 *
 *   node test-recording-library.mjs
 *
 * A cache that misses costs money. A cache that returns the WRONG recording
 * costs a customer hearing the wrong thing, in the wrong voice, with nothing in
 * any log to say so. So most of what follows is the key: every input that
 * changes the audio has to change the key, and the checks below name them one
 * at a time because a key is exactly as good as its least-considered field.
 *
 * The rest guards the other silent failure: caching a generation that failed.
 * textToSpeech RESOLVES on failure, so a poisoned entry would be written once
 * and read back for ever.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getOrCreateRecording,
  loadManifest,
  lookupRecording,
  normaliseText,
  putRecording,
  recordingKey,
  slugFor,
  specFromHistoryItem,
} from "./lib/recordingLibrary.js";
import { IVR_MODEL_ID } from "./lib/flexiloansCampaignOrchestrator.js";

let failed = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
};

const tmp = () => mkdtempSync(join(tmpdir(), "rec-"));
const SPEC = {
  text: "नमस्ते, Buddy Loan से",
  voiceId: "voiceA",
  modelId: "eleven_flash_v2_5",
  stability: 0.3,
  similarityBoost: 0.9,
};
const ttsThat = (bytes, sink) => ({
  textToSpeech: async (o) => {
    sink?.push(o);
    return { success: true, audio: Buffer.from(bytes) };
  },
});

console.log("\nthe key is every input that changes the audio\n");

for (const [field, changed] of [
  ["text", { text: "something else entirely" }],
  ["voiceId", { voiceId: "voiceB" }],
  ["modelId", { modelId: "eleven_multilingual_v2" }],
  ["stability", { stability: 0.9 }],
  ["similarityBoost", { similarityBoost: 0.1 }],
]) {
  await check(`${field} changes the key`, () => {
    assert.notEqual(
      recordingKey(SPEC),
      recordingKey({ ...SPEC, ...changed }),
      `two recordings differing only in ${field} would collide and one would be served for the other`
    );
  });
}

await check("the same spec is the same key, across calls", () => {
  assert.equal(recordingKey(SPEC), recordingKey({ ...SPEC }));
});

await check("an omitted setting keys as the default it will be generated with", () => {
  // ElevenLabs applies 0.5/0.75 when we send nothing. If the key did not, the
  // same audio would be stored twice under two keys.
  assert.equal(
    recordingKey({ text: "hi", voiceId: "v", modelId: "m" }),
    recordingKey({ text: "hi", voiceId: "v", modelId: "m", stability: 0.5, similarityBoost: 0.75 })
  );
});

await check("surrounding whitespace is not a different prompt", () => {
  assert.equal(recordingKey(SPEC), recordingKey({ ...SPEC, text: `\n  ${SPEC.text}  \n` }));
  assert.equal(normaliseText("a   b\n c"), "a b c");
});

await check("case and punctuation ARE different prompts", () => {
  // They change how a line is spoken, so they must not be normalised away.
  assert.notEqual(recordingKey(SPEC), recordingKey({ ...SPEC, text: SPEC.text.toUpperCase() }));
  assert.notEqual(recordingKey(SPEC), recordingKey({ ...SPEC, text: SPEC.text + "?" }));
});

await check("the filename stays readable, and unique per key", () => {
  assert.match(slugFor("Press 1 for a business loan!"), /^press-1-for-a-business-loan$/);
  assert.equal(slugFor("   "), "recording");
});

console.log("\nhit, miss, and never a wrong hit\n");

await check("a miss generates once; the next call reads from disk", async () => {
  const dir = tmp();
  const seen = [];
  const first = await getOrCreateRecording(SPEC, { dir, persist: true, tts: ttsThat("ID3aaa", seen) });
  assert.equal(first.cached, false);
  assert.equal(seen.length, 1, "the first call must generate");

  const second = await getOrCreateRecording(SPEC, { dir, persist: true, tts: ttsThat("ID3zzz", seen) });
  assert.equal(second.cached, true, "the second call must not generate");
  assert.equal(seen.length, 1, "ElevenLabs must not be called again");
  assert.equal(second.audio.toString(), "ID3aaa", "and must return the ORIGINAL bytes");
  rmSync(dir, { recursive: true, force: true });
});

await check("a different voice does not read back the first voice's file", async () => {
  const dir = tmp();
  await getOrCreateRecording(SPEC, { dir, persist: true, tts: ttsThat("VOICE-A") });
  const other = await getOrCreateRecording(
    { ...SPEC, voiceId: "voiceB" },
    { dir, persist: true, tts: ttsThat("VOICE-B") }
  );
  assert.equal(other.cached, false);
  assert.equal(other.audio.toString(), "VOICE-B", "serving voiceA here is the failure this exists to stop");
  rmSync(dir, { recursive: true, force: true });
});

await check("a manifest entry whose file is gone is a miss, not a hit", async () => {
  const dir = tmp();
  const made = await getOrCreateRecording(SPEC, { dir, persist: true, tts: ttsThat("ID3aaa") });
  rmSync(join(dir, made.file));
  assert.equal(lookupRecording(SPEC, { dir }), null, "an index must not promise a file it cannot produce");
  rmSync(dir, { recursive: true, force: true });
});

await check("a corrupt manifest is empty, not fatal", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "manifest.json"), "{not json");
  assert.deepEqual(loadManifest(dir).recordings, {});
  rmSync(dir, { recursive: true, force: true });
});

console.log("\na failed generation is never kept\n");

await check("a resolved-but-failed TTS is not written to the library", async () => {
  const dir = tmp();
  const tts = { textToSpeech: async () => ({ success: false, error: "quota exceeded" }) };
  await assert.rejects(() => getOrCreateRecording(SPEC, { dir, persist: true, tts }), /TTS failed/);
  assert.deepEqual(loadManifest(dir).recordings, {}, "a failure cached is silence played for ever");
  rmSync(dir, { recursive: true, force: true });
});

await check("zero bytes is not a recording", async () => {
  const dir = tmp();
  const tts = { textToSpeech: async () => ({ success: true, audio: Buffer.alloc(0) }) };
  await assert.rejects(() => getOrCreateRecording(SPEC, { dir, persist: true, tts }), /no audio bytes/);
  assert.deepEqual(loadManifest(dir).recordings, {});
  rmSync(dir, { recursive: true, force: true });
});

console.log("\nwhat a running server may do\n");

await check("without persist it serves the audio but saves nothing", async () => {
  const dir = tmp();
  const out = await getOrCreateRecording(SPEC, { dir, tts: ttsThat("ID3aaa") });
  assert.equal(out.audio.toString(), "ID3aaa", "the campaign must still run");
  assert.equal(out.persisted, false);
  assert.deepEqual(loadManifest(dir).recordings, {}, "Railway's disk does not survive a deploy");
  rmSync(dir, { recursive: true, force: true });
});

await check("the manifest records the settings the audio was made with", async () => {
  const dir = tmp();
  const made = await getOrCreateRecording(SPEC, { dir, persist: true, tts: ttsThat("ID3aaa") });
  const entry = loadManifest(dir).recordings[made.key];
  assert.equal(entry.voiceId, "voiceA");
  assert.equal(entry.modelId, "eleven_flash_v2_5");
  assert.equal(entry.stability, 0.3);
  assert.equal(entry.similarityBoost, 0.9);
  assert.equal(entry.bytes, 6);
  assert.ok(entry.sha256, "the bytes are fingerprinted so a swapped file is detectable");
  rmSync(dir, { recursive: true, force: true });
});

await check("the voice settings reach ElevenLabs, not just the key", async () => {
  const dir = tmp();
  const seen = [];
  await getOrCreateRecording(SPEC, { dir, persist: true, tts: ttsThat("ID3aaa", seen) });
  assert.equal(seen[0].stability, 0.3, "keying on a setting we never send is a lie");
  assert.equal(seen[0].similarityBoost, 0.9);
  rmSync(dir, { recursive: true, force: true });
});

console.log("\nimporting what ElevenLabs already generated\n");

/** A history item as /v1/history returns it. */
const HISTORY_ITEM = {
  history_item_id: "hist_1",
  text: "नमस्ते, Buddy Loan से",
  voice_id: "voiceA",
  model_id: "eleven_flash_v2_5",
  settings: { stability: 0.3, similarity_boost: 0.9 },
  date_unix: 1787000000,
  state: "created",
  source: "TTS",
};

await check("a history item keys identically to generating the same thing", () => {
  const { spec, settingsKnown } = specFromHistoryItem(HISTORY_ITEM);
  assert.equal(settingsKnown, true);
  assert.equal(
    recordingKey(spec),
    recordingKey(SPEC),
    "an import that keys differently is never found again, and the next run pays to regenerate it"
  );
});

await check("a history item with no settings falls back to the library's own defaults", () => {
  const { spec, settingsKnown } = specFromHistoryItem({ ...HISTORY_ITEM, settings: null });
  assert.equal(settingsKnown, false, "the caller must be able to warn");
  assert.equal(spec.stability, 0.5);
  assert.equal(spec.similarityBoost, 0.75);
  assert.equal(
    recordingKey(spec),
    recordingKey({ ...SPEC, stability: 0.5, similarityBoost: 0.75 }),
    "the two halves must agree on the default, or the import is unfindable"
  );
});

await check("a partially reported settings object is treated as unknown", () => {
  const { settingsKnown } = specFromHistoryItem({ ...HISTORY_ITEM, settings: { stability: 0.3 } });
  assert.equal(settingsKnown, false, "half the settings is not the settings");
});

await check("imported audio lands under the key the campaign will look up", async () => {
  const dir = tmp();
  const { spec } = specFromHistoryItem(HISTORY_ITEM);
  putRecording(spec, Buffer.from("IMPORTED"), { dir, source: { from: "elevenlabs_history" } });

  const hit = await getOrCreateRecording(SPEC, { dir, tts: ttsThat("SHOULD-NOT-GENERATE") });
  assert.equal(hit.cached, true, "the campaign must find the imported file");
  assert.equal(hit.audio.toString(), "IMPORTED");
  rmSync(dir, { recursive: true, force: true });
});

await check("an import keeps where it came from", () => {
  const dir = tmp();
  const { spec } = specFromHistoryItem(HISTORY_ITEM);
  const out = putRecording(spec, Buffer.from("IMPORTED"), {
    dir,
    source: { from: "elevenlabs_history", history_item_id: "hist_1" },
  });
  const entry = loadManifest(dir).recordings[out.key];
  assert.equal(entry.source.history_item_id, "hist_1");
  assert.equal(entry.stability, 0.3, "the settings it was MADE with, not the defaults");
  rmSync(dir, { recursive: true, force: true });
});

await check("an empty download is never filed", () => {
  const dir = tmp();
  const { spec } = specFromHistoryItem(HISTORY_ITEM);
  assert.throws(() => putRecording(spec, Buffer.alloc(0), { dir }), /no audio bytes/);
  assert.deepEqual(loadManifest(dir).recordings, {}, "a truncated download is silence, kept for ever");
  rmSync(dir, { recursive: true, force: true });
});

console.log("\nthe campaign uses it\n");

const orchSrc = readFileSync(new URL("./lib/flexiloansCampaignOrchestrator.js", import.meta.url), "utf8");

await check("the campaign asks the library, not ElevenLabs directly", () => {
  assert.match(orchSrc, /getOrCreateRecording\(/);
  assert.doesNotMatch(
    orchSrc,
    /await\s+tts\.textToSpeech\(/,
    "a direct call bypasses the library and pays for the same audio again"
  );
});


console.log("\nthe key the campaign will actually look up\n");

await check("the CLI's default model is the campaign's, end to end", () => {
  // THE DEFECT THIS FILE EXISTS TO CATCH NOW. add-recording defaulted --model
  // to eleven_flash_v2_5 while the campaign renders with IVR_MODEL_ID
  // (eleven_multilingual_v2), so a recording added exactly as the README
  // documented was filed under a key nothing ever looks up: the library filled
  // up and every run still generated, and still paid.
  //
  // Spawned rather than source-matched, because what matters is the key the
  // CLI really produces. --dry-run prints it and exits before needing a key.
  const text = "Press 1 for a business loan";
  const voiceId = "voiceA";
  const out = execFileSync(
    process.execPath,
    ["scripts/add-recording.mjs", "--text", text, "--voice", voiceId, "--dry-run"],
    { cwd: new URL(".", import.meta.url).pathname, encoding: "utf8" }
  );
  const printed = /-([0-9a-f]{16})\.mp3/.exec(out);
  assert.ok(printed, `no key in CLI output: ${out}`);
  assert.equal(
    printed[1],
    recordingKey({ text, voiceId, modelId: IVR_MODEL_ID }),
    "the CLI must file recordings under the key the campaign looks up"
  );
});

console.log("\nthe three settings the key was blind to\n");

for (const [field, changed] of [
  ["style", { style: 0.6 }],
  ["useSpeakerBoost", { useSpeakerBoost: false }],
  ["speed", { speed: 1.15 }],
]) {
  await check(`${field} changes the key`, () => {
    assert.notEqual(
      recordingKey(SPEC),
      recordingKey({ ...SPEC, ...changed }),
      `two recordings differing only in ${field} would collide and one be served for the other`
    );
  });
}

await check("a styled web-UI generation does not import onto the campaign's key", () => {
  // The one path that can actually produce these: our textToSpeech never sends
  // style/speed, but a generation made in the ElevenLabs UI carries them, and
  // it is a different recording of the same words.
  const styled = specFromHistoryItem({
    ...HISTORY_ITEM,
    settings: { stability: 0.3, similarity_boost: 0.9, style: 0.7, speed: 1.2 },
  });
  assert.equal(styled.spec.style, 0.7);
  assert.equal(styled.spec.speed, 1.2);
  assert.notEqual(
    recordingKey(styled.spec),
    recordingKey(SPEC),
    "a styled import landing on the plain key is served back as a confident wrong hit"
  );
});

await check("an item reporting no style still keys as the plain default", () => {
  const { spec } = specFromHistoryItem(HISTORY_ITEM);
  assert.equal(recordingKey(spec), recordingKey(SPEC), "our own generations must still match");
});

console.log("\na blank line is a pause, not whitespace\n");

await check("a paragraph break is not the same prompt as a space", () => {
  // IVR_SCRIPT uses \n\n as a deliberate pause cue and the RAW text -- newlines
  // intact -- is what goes to ElevenLabs. Collapsing every run of whitespace
  // made the same words re-typed as one paragraph collide with it.
  const broken = { ...SPEC, text: "Namaste ji.\n\nAapka business hai na?" };
  const flat = { ...SPEC, text: "Namaste ji. Aapka business hai na?" };
  assert.notEqual(recordingKey(broken), recordingKey(flat));
});

await check("a wrapped line is still just a space", () => {
  assert.equal(normaliseText("a   b\n c"), "a b c");
  assert.equal(normaliseText("one\ntwo"), "one two");
});

await check("blank lines survive normalisation, extra ones collapse", () => {
  assert.equal(normaliseText("one\n\ntwo"), "one\n\ntwo");
  assert.equal(normaliseText("one\n\n\n\ntwo"), "one\n\ntwo");
  assert.equal(normaliseText("\n\n  one\n\ntwo  \n\n"), "one\n\ntwo");
});

console.log("\none write path, not two\n");

await check("a persisted generation records that it was generated", () => {
  // The persist branch used to re-implement putRecording and had already
  // drifted: no provenance, and -- the one that matters -- no zero-byte
  // refusal, the guard that stops silence being filed under a good key.
  const dir = tmp();
  return getOrCreateRecording(SPEC, { dir, persist: true, tts: ttsThat("ID3aaa") }).then((made) => {
    const entry = loadManifest(dir).recordings[made.key];
    assert.equal(entry.source?.from, "generated");
    assert.equal(entry.style, SPEC.style ?? 0, "the manifest records every field it was keyed on");
    rmSync(dir, { recursive: true, force: true });
  });
});

console.log("\na cap that is not a cap\n");

await check("a non-numeric --limit is refused, not silently unbounded", () => {
  // Number("all") is NaN and `imported >= NaN` is false for ever, so a typo
  // removed the ceiling on a script that downloads files and commits them.
  const r = spawnSync(
    process.execPath,
    ["scripts/import-history.mjs", "--limit", "all", "--dry-run"],
    {
      cwd: new URL(".", import.meta.url).pathname,
      encoding: "utf8",
      env: { ...process.env, ELEVEN_LABS_API_KEY: "not-used-before-the-check" },
    }
  );
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}: ${r.stderr}`);
  assert.match(r.stderr, /--limit must be a positive whole number/);
});


console.log(failed ? `\n${failed} failed\n` : "\nall passed\n");
process.exit(failed ? 1 : 0);
