import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The recordings we have already paid ElevenLabs to say.
 *
 * Every campaign run called textToSpeech with the same script, the same voice
 * and the same model, and got back the same mp3 — generated again, billed
 * again, and waited for again before a single number could be dialled. The
 * audio for a fixed IVR prompt does not change between runs; only our copy of
 * it was missing.
 *
 * So: keep them. `recordings/` holds the mp3 files and a manifest, both in the
 * repository, so a prompt is generated once by a person who listens to it and
 * is read from disk for ever after.
 *
 * ── The key is every input that changes the audio ─────────────────────────
 *
 * text, voice, model AND the two voice settings. Leave any of them out of the
 * key and the library returns a recording made with different settings while
 * reporting a hit — the one failure here that is worse than no cache at all,
 * because it is silent and it speaks to customers. `recordingKey` is pure and
 * `test-recording-library.mjs` holds it to that.
 *
 * ── Hearing it before customers do ────────────────────────────────────────
 *
 * A generated prompt is committed, which means somebody opens the mp3 first.
 * That is the point rather than a chore: on 26 Aug a campaign uploaded
 * "[object Object]" to the dialler and the failure was only visible as a vague
 * rejection (see the comment in flexiloansCampaignOrchestrator.js). A file in
 * the tree gets played.
 *
 * ── What a running server can and cannot do ───────────────────────────────
 *
 * Railway's filesystem is ephemeral: a file this module writes at runtime
 * survives until the next deploy and reaches no other instance. So a runtime
 * miss GENERATES and serves the audio — nothing breaks — but it does not
 * pretend to have saved it, and it says so loudly. Putting a recording in the
 * library for good is `scripts/add-recording.mjs`, run by a person, committed
 * like any other file.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** Where the mp3s and the manifest live. Overridable so tests never touch it. */
export const RECORDINGS_DIR = join(HERE, "..", "recordings");
export const MANIFEST_NAME = "manifest.json";

/** ElevenLabs' own defaults, repeated here so an omitted setting still keys. */
const DEFAULT_STABILITY = 0.5;
const DEFAULT_SIMILARITY = 0.75;

/**
 * Whitespace is not speech.
 *
 * A script pasted with a trailing newline is the same prompt as one without,
 * and treating them as different buys a second identical mp3. Collapsing runs
 * of whitespace is safe for the same reason — the synthesiser does not read
 * two spaces differently. Nothing else is normalised: case and punctuation both
 * change how a line is spoken.
 */
export function normaliseText(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Everything that changes the audio, and nothing that does not.
 *
 * Pure and stable: the same spec gives the same key across processes and
 * machines, which is what makes the manifest shareable through git.
 */
export function recordingKey(spec = {}) {
  const canonical = {
    text: normaliseText(spec.text),
    voiceId: String(spec.voiceId ?? "").trim(),
    modelId: String(spec.modelId ?? "").trim(),
    stability: Number(spec.stability ?? DEFAULT_STABILITY),
    similarityBoost: Number(spec.similarityBoost ?? DEFAULT_SIMILARITY),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 16);
}

/** A readable filename stem, so the directory can be browsed by a human. */
export function slugFor(text, max = 40) {
  const slug = normaliseText(text)
    .toLowerCase()
    .replace(/[^a-z0-9ऀ-ॿ]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max);
  return slug || "recording";
}

/**
 * An ElevenLabs history item, read into the spec that keys it.
 *
 * Pure, and exported so it can be tested without the API, because getting it
 * wrong is not visible at import time: a recording filed under the wrong key is
 * simply never found again, and the next run pays to generate what we already
 * had. `settings` is where that happens — history items carry the voice
 * settings in a nested object, and a missing one has to fall back to the SAME
 * defaults the library keys with or the two halves disagree.
 *
 * `settingsKnown` is false when the item did not report them. The importer
 * warns rather than guessing quietly: the audio is real, but if it was made
 * with settings the API does not tell us, the key is our default's, not its.
 */
export function specFromHistoryItem(item = {}) {
  const settings = item.settings ?? null;
  const stability = settings?.stability;
  const similarity = settings?.similarity_boost;
  return {
    spec: {
      text: item.text ?? "",
      voiceId: item.voice_id ?? "",
      modelId: item.model_id ?? "",
      stability: stability == null ? DEFAULT_STABILITY : Number(stability),
      similarityBoost: similarity == null ? DEFAULT_SIMILARITY : Number(similarity),
    },
    settingsKnown: stability != null && similarity != null,
  };
}

/** The manifest, or an empty one. A missing or corrupt file is not an error. */
export function loadManifest(dir = RECORDINGS_DIR) {
  const path = join(dir, MANIFEST_NAME);
  if (!existsSync(path)) return { version: 1, recordings: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return { version: parsed.version ?? 1, recordings: parsed.recordings ?? {} };
  } catch (error) {
    console.warn(`[RECORDINGS] manifest unreadable (${error.message}) — treating as empty`);
    return { version: 1, recordings: {} };
  }
}

export function saveManifest(manifest, dir = RECORDINGS_DIR) {
  mkdirSync(dir, { recursive: true });
  const ordered = {};
  for (const k of Object.keys(manifest.recordings).sort()) ordered[k] = manifest.recordings[k];
  writeFileSync(
    join(dir, MANIFEST_NAME),
    JSON.stringify({ version: manifest.version ?? 1, recordings: ordered }, null, 2) + "\n"
  );
}

/**
 * Is this one already on disk? Returns the entry and its bytes, or null.
 *
 * A manifest entry whose file is missing counts as a MISS, not a hit: the
 * manifest is an index, and an index that promises a file it cannot produce is
 * how a campaign uploads nothing and says it uploaded something.
 */
export function lookupRecording(spec, { dir = RECORDINGS_DIR } = {}) {
  const key = recordingKey(spec);
  const entry = loadManifest(dir).recordings[key];
  if (!entry) return null;
  const path = join(dir, entry.file);
  if (!existsSync(path)) {
    console.warn(`[RECORDINGS] manifest lists ${entry.file} but it is not on disk — regenerating`);
    return null;
  }
  return { key, entry, path, audio: readFileSync(path) };
}

/**
 * Put audio we already have into the library.
 *
 * The import path: the bytes exist (ElevenLabs generated them weeks ago and
 * kept them), so there is nothing to generate and nothing to bill. Everything
 * else is the same as a generated recording, including the refusal to file
 * empty audio — an import that writes a 0-byte mp3 poisons the key just as
 * thoroughly as a failed generation does, and is likelier, because a download
 * can be truncated where a failure is at least loud.
 *
 * @param {object} spec   the same shape recordingKey takes
 * @param {Buffer} audio  the bytes
 * @param {object} opts   { dir, source } — source is recorded as provenance
 * @returns {{key: string, file: string, bytes: number, replaced: boolean}}
 */
export function putRecording(spec, audio, { dir = RECORDINGS_DIR, source = null } = {}) {
  const bytes = audio?.byteLength ?? audio?.length ?? 0;
  if (!bytes) throw new Error("refusing to file a recording with no audio bytes");

  const key = recordingKey(spec);
  const manifest = loadManifest(dir);
  const replaced = Boolean(manifest.recordings[key]);

  const file = `${slugFor(spec.text)}-${key}.mp3`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), audio);

  manifest.recordings[key] = {
    file,
    text: normaliseText(spec.text),
    voiceId: spec.voiceId ?? null,
    modelId: spec.modelId ?? null,
    stability: spec.stability ?? DEFAULT_STABILITY,
    similarityBoost: spec.similarityBoost ?? DEFAULT_SIMILARITY,
    bytes,
    sha256: createHash("sha256").update(audio).digest("hex"),
    createdAt: new Date().toISOString(),
    ...(source ? { source } : {}),
  };
  saveManifest(manifest, dir);

  return { key, file, bytes, replaced };
}

/**
 * The bytes for this prompt: from the library if we have it, from ElevenLabs
 * if we do not.
 *
 * @param {object} spec  { text, voiceId, modelId, stability, similarityBoost }
 * @param {object} deps  { tts, dir, persist }
 *   tts     — anything with textToSpeech(), i.e. ElevenLabsClient
 *   persist — write the generated file and manifest entry. The CLI passes true;
 *             the server does not, because its disk does not survive a deploy.
 * @returns {Promise<{audio: Buffer, key: string, cached: boolean, file: string|null,
 *                    persisted: boolean}>}
 */
export async function getOrCreateRecording(spec, deps = {}) {
  const dir = deps.dir ?? RECORDINGS_DIR;
  const key = recordingKey(spec);

  const hit = lookupRecording(spec, { dir });
  if (hit) {
    return { audio: hit.audio, key, cached: true, file: hit.entry.file, persisted: true };
  }

  if (!deps.tts) throw new Error("no recording in the library and no TTS client to make one");

  const spoken = await deps.tts.textToSpeech({
    text: spec.text,
    voiceId: spec.voiceId,
    modelId: spec.modelId,
    ...(spec.stability != null ? { stability: spec.stability } : {}),
    ...(spec.similarityBoost != null ? { similarityBoost: spec.similarityBoost } : {}),
  });

  // textToSpeech RESOLVES on failure rather than throwing. Both checks below
  // exist because caching either shape would poison the library permanently:
  // every later run would read back a file that is an error, or empty, and the
  // dialler would play silence at customers.
  if (spoken && spoken.success === false) {
    throw new Error(`TTS failed: ${spoken.error ?? "no reason given"}`);
  }
  const audio = spoken?.audio ?? spoken;
  const bytes = audio?.byteLength ?? audio?.length ?? 0;
  if (!bytes) throw new Error("TTS returned no audio bytes");

  if (!deps.persist) {
    console.warn(
      `[RECORDINGS] miss for ${key} — generated on the fly and NOT saved. ` +
        "Add it with scripts/add-recording.mjs and commit it, or it is paid for again next run."
    );
    return { audio, key, cached: false, file: null, persisted: false };
  }

  const file = `${slugFor(spec.text)}-${key}.mp3`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), audio);

  const manifest = loadManifest(dir);
  manifest.recordings[key] = {
    file,
    text: normaliseText(spec.text),
    voiceId: spec.voiceId ?? null,
    modelId: spec.modelId ?? null,
    stability: spec.stability ?? DEFAULT_STABILITY,
    similarityBoost: spec.similarityBoost ?? DEFAULT_SIMILARITY,
    bytes,
    sha256: createHash("sha256").update(audio).digest("hex"),
    createdAt: new Date().toISOString(),
  };
  saveManifest(manifest, dir);

  return { audio, key, cached: false, file, persisted: true };
}

export default getOrCreateRecording;
