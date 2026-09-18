#!/usr/bin/env node
/**
 * Put a recording in the library, once, so nothing generates it again.
 *
 *   ELEVEN_LABS_API_KEY=... node scripts/add-recording.mjs \
 *     --text "नमस्ते, Buddy Loan से..." \
 *     --voice dVTC43Yewy5fAIcmsISI
 *
 * --model defaults to the model the campaign actually renders with. Passing a
 * different one files the recording under a key the campaign never looks up:
 * the run still misses, and still pays.
 *
 *   # or take the script from a file, which is easier for long Hindi text
 *   node scripts/add-recording.mjs --text-file ./script.txt --voice <id>
 *
 * Writes recordings/<slug>-<key>.mp3 and updates recordings/manifest.json.
 * BOTH are meant to be committed — that is the whole point of the library, and
 * it is also the moment somebody plays the file before a customer does.
 *
 * Run with --dry-run to see the key and filename without spending a generation.
 */
import { readFileSync } from "node:fs";
import ElevenLabsClient from "../lib/elevenLabsClient.js";
import { IVR_MODEL_ID } from "../lib/flexiloansCampaignOrchestrator.js";
import {
  RECORDINGS_DIR,
  getOrCreateRecording,
  lookupRecording,
  recordingKey,
  slugFor,
} from "../lib/recordingLibrary.js";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const textFile = arg("text-file");
const text = textFile ? readFileSync(textFile, "utf8") : arg("text");
const voiceId = arg("voice");
// The DEFAULT IS THE CAMPAIGN'S, taken from the campaign rather than repeated
// here. It was eleven_flash_v2_5 while the campaign renders with IVR_MODEL_ID
// (eleven_multilingual_v2), so a recording added exactly as the README
// documented was keyed under a model nothing ever looks up -- the library
// filled up and every run still generated and still paid, which is the one
// thing it exists to stop.
const modelId = arg("model", IVR_MODEL_ID);
const stability = arg("stability") != null ? Number(arg("stability")) : undefined;
const similarityBoost = arg("similarity") != null ? Number(arg("similarity")) : undefined;

if (!text || !voiceId) {
  console.error(
    "usage: add-recording.mjs --text <text> | --text-file <path>  --voice <voiceId>\n" +
      `       [--model <modelId>, default ${IVR_MODEL_ID}] [--stability <n>] ` +
      "[--similarity <n>] [--dry-run]"
  );
  process.exit(2);
}

const spec = { text, voiceId, modelId, stability, similarityBoost };
const key = recordingKey(spec);

const existing = lookupRecording(spec);
if (existing) {
  console.log(`already in the library: ${existing.entry.file} (${existing.entry.bytes} bytes)`);
  console.log("nothing generated, nothing billed.");
  process.exit(0);
}

if (flag("dry-run")) {
  console.log(`would generate ${slugFor(text)}-${key}.mp3 in ${RECORDINGS_DIR}`);
  process.exit(0);
}

const apiKey = process.env.ELEVEN_LABS_API_KEY;
if (!apiKey) {
  console.error("ELEVEN_LABS_API_KEY is not set — nothing to generate with.");
  process.exit(1);
}

const result = await getOrCreateRecording(spec, {
  tts: new ElevenLabsClient(apiKey),
  persist: true,
});

console.log(`wrote recordings/${result.file} (${result.audio.length} bytes), key ${result.key}`);
console.log("Play it, then commit recordings/ — the library is the repository.");
