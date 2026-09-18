#!/usr/bin/env node
/**
 * Import the recordings already sitting in ElevenLabs history into the library.
 *
 *   ELEVEN_LABS_API_KEY=... node scripts/import-history.mjs --dry-run
 *   ELEVEN_LABS_API_KEY=... node scripts/import-history.mjs --voice dVTC43Yewy5fAIcmsISI
 *
 * ElevenLabs keeps every generation and the audio that came out of it. Those
 * are already paid for, so importing them is the cheapest possible way to fill
 * recordings/ -- nothing is generated and nothing is billed.
 *
 * ALWAYS --dry-run FIRST. It lists what would be imported, with the text and
 * the key, and downloads nothing. History can be long and most of it is
 * probably experiments rather than the prompts you want committed; the filters
 * below are how you narrow it.
 *
 *   --voice <id>       only this voice
 *   --model <id>       only this model
 *   --contains <text>  only items whose text contains this (case-insensitive)
 *   --since <date>     only items generated on or after this (YYYY-MM-DD)
 *   --limit <n>        stop after n imports (default 50)
 *   --max-pages <n>    how far back to page through history (default 10)
 *   --dry-run          list, do not download
 *
 * Re-running is safe: anything already in the manifest is skipped, so an
 * interrupted import continues where it stopped.
 *
 * Afterwards: PLAY the files, then commit recordings/.
 */
import {
  RECORDINGS_DIR,
  loadManifest,
  putRecording,
  recordingKey,
  specFromHistoryItem,
} from "../lib/recordingLibrary.js";

const BASE = process.env.ELEVEN_LABS_BASE_URL ?? "https://api.elevenlabs.io/v1";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const apiKey = process.env.ELEVEN_LABS_API_KEY;
if (!apiKey) {
  console.error("ELEVEN_LABS_API_KEY is not set.");
  process.exit(1);
}

/**
 * A cap that silently is not one is worse than no cap. Number("all") is NaN,
 * and `imported >= NaN` is false for ever, so a typo here removes the ceiling
 * on a script that downloads files and commits them. --since is validated;
 * these were not.
 */
function positiveInt(raw, flagName) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    console.error(`${flagName} must be a positive whole number, got ${JSON.stringify(raw)}`);
    process.exit(2);
  }
  return n;
}

const wantVoice = arg("voice");
const wantModel = arg("model");
const contains = (arg("contains") ?? "").toLowerCase();
const sinceUnix = arg("since") ? Math.floor(new Date(arg("since")).getTime() / 1000) : null;
const limit = positiveInt(arg("limit", "50"), "--limit");
const maxPages = positiveInt(arg("max-pages", "10"), "--max-pages");
const dryRun = flag("dry-run");


if (arg("since") && !Number.isFinite(sinceUnix)) {
  console.error(`--since ${arg("since")} is not a date I can read; use YYYY-MM-DD`);
  process.exit(2);
}

const headers = { "xi-api-key": apiKey, accept: "application/json" };

async function getJson(url) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status} ${await res.text().catch(() => "")}`);
  return res.json();
}

async function getAudio(id) {
  const res = await fetch(`${BASE}/history/${encodeURIComponent(id)}/audio`, {
    headers: { "xi-api-key": apiKey },
  });
  if (!res.ok) throw new Error(`audio for ${id} -> HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Everything the filters keep, oldest page first. Paging is by last id seen. */
async function* historyItems() {
  let after = null;
  for (let page = 0; page < maxPages; page++) {
    const url = new URL(`${BASE}/history`);
    url.searchParams.set("page_size", "100");
    if (after) url.searchParams.set("start_after_history_item_id", after);
    const body = await getJson(url.toString());
    const items = body.history ?? [];
    if (items.length === 0) return;
    for (const item of items) yield item;
    if (!body.has_more) return;
    after = items[items.length - 1]?.history_item_id;
    if (!after) return;
  }
  console.warn(`[IMPORT] stopped after ${maxPages} pages — raise --max-pages to go further back`);
}

const manifest = loadManifest();
let seen = 0;
let skippedExisting = 0;
let skippedFiltered = 0;
let imported = 0;
const noSettings = [];

console.log(dryRun ? "DRY RUN — nothing will be downloaded\n" : `importing into ${RECORDINGS_DIR}\n`);

for await (const item of historyItems()) {
  seen++;

  // Only finished text-to-speech. A failed or still-processing generation has
  // no audio worth keeping, and speech-to-speech items are not prompts.
  if (item.state && item.state !== "created") { skippedFiltered++; continue; }
  if (item.source && String(item.source).toUpperCase() !== "TTS") { skippedFiltered++; continue; }

  if (wantVoice && item.voice_id !== wantVoice) { skippedFiltered++; continue; }
  if (wantModel && item.model_id !== wantModel) { skippedFiltered++; continue; }
  if (contains && !String(item.text ?? "").toLowerCase().includes(contains)) {
    skippedFiltered++; continue;
  }
  if (sinceUnix && Number(item.date_unix ?? 0) < sinceUnix) { skippedFiltered++; continue; }

  const { spec, settingsKnown } = specFromHistoryItem(item);
  const key = recordingKey(spec);

  if (manifest.recordings[key]) { skippedExisting++; continue; }

  const preview = String(spec.text).replace(/\s+/g, " ").slice(0, 70);
  const when = item.date_unix ? new Date(item.date_unix * 1000).toISOString().slice(0, 10) : "?";

  if (!settingsKnown) {
    noSettings.push(key);
  }

  if (dryRun) {
    console.log(`  ${key}  ${when}  ${item.voice_name ?? item.voice_id}  "${preview}"`);
    imported++;
    if (imported >= limit) break;
    continue;
  }

  try {
    const audio = await getAudio(item.history_item_id);
    const out = putRecording(spec, audio, {
      source: {
        from: "elevenlabs_history",
        history_item_id: item.history_item_id,
        date_unix: item.date_unix ?? null,
        // Recorded per entry, not just counted in a closing summary: a key
        // built from guessed settings is indistinguishable from a known one
        // once it is in the manifest, and that is exactly when somebody needs
        // to know which of the two they are looking at.
        settingsKnown,
      },
    });
    manifest.recordings[out.key] = { file: out.file }; // keep the in-memory index in step
    imported++;
    console.log(`  + ${out.file} (${out.bytes} bytes)  "${preview}"`);
  } catch (error) {
    console.error(`  ! ${item.history_item_id}: ${error.message}`);
  }

  if (imported >= limit) break;
}

console.log(
  `\nscanned ${seen} | imported ${imported} | already had ${skippedExisting} | filtered out ${skippedFiltered}`
);

if (noSettings.length) {
  console.warn(
    `\n${noSettings.length} item(s) did not report their voice settings. They are keyed with the\n` +
      "library defaults (stability 0.5, similarity 0.75). If they were generated with\n" +
      "something else, the key is our default's rather than theirs — regenerate those\n" +
      "with scripts/add-recording.mjs if a run still misses them."
  );
}

if (!dryRun && imported > 0) {
  console.log("\nPlay them, then commit recordings/.");
}
if (imported >= limit) {
  console.log(`(stopped at --limit ${limit}; re-run to continue — imports already done are skipped)`);
}
