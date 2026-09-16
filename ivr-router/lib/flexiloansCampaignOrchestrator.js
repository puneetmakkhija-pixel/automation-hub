import OBDApiClient from "./obdApiClient.js";
import ElevenLabsClient from "./elevenLabsClient.js";
import { findPromptId } from "./obdApiClient.js";

/**
 * The Flexiloans (Epimoney) press-1 broadcast, end to end.
 *
 *   base -> voice prompt -> contact upload -> DTMF campaign -> press 1
 *
 * Press 1 is where this stops. From there the existing pipeline takes over
 * untouched: the keypress webhook hands the caller to the ORI voice bot
 * (lib/oriVoiceDispatch.js), which qualifies them and sends the apply link, and
 * the chatbot at crmbusinessloans.com/apply collects the documents. Nothing in
 * this file knows about any of that, and it should stay that way — this is a
 * dialler, not a journey.
 *
 * ── THE SWITCH ──────────────────────────────────────────────────────────────
 *
 * FLEXI_CAMPAIGN_ENABLED gates the one irreversible step, composeCampaign,
 * which is the call that starts ringing real phones. Absent is off, the same
 * reading crm.journey_tick() takes of its own flags: the safe meaning of "we do
 * not know" is "do not dial".
 *
 * Everything before that step is preparation and runs either way — pulling the
 * base, rendering the prompt, uploading both to OBD. That is deliberate. It
 * means the whole pipeline can be exercised, and the voice file listened to in
 * the OBD console, before anybody has committed to a call.
 *
 * ── THE CAP ─────────────────────────────────────────────────────────────────
 *
 * FLEXI_CAMPAIGN_CAP bounds one run. The base is a third of the recommendation
 * book and the first page alone kept 1,638 people; a flag flipped by someone
 * who has not measured that is not an instruction to dial all of them. The cap
 * defaults to 500 and has to be raised on purpose.
 */

const LENDER = "Flexiloans (Epimoney)";

/** Off unless explicitly on. Absent, blank and anything unrecognised are off. */
export function campaignEnabled(env = process.env) {
  return String(env.FLEXI_CAMPAIGN_ENABLED ?? "").trim().toLowerCase() === "on";
}

export function campaignCap(env = process.env) {
  const raw = String(env.FLEXI_CAMPAIGN_CAP ?? "").trim();
  if (raw === "") return 500;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 500;
}

/**
 * How many people ONE request may dial.
 *
 * A cap in a request body may only ever narrow the env cap, never widen it.
 * If a body could raise it, the cap would protect nobody — the whole point is
 * that enlarging a run is a deliberate environment change someone makes on
 * purpose, not a number typed into a curl.
 */
export function resolveRunCap(asked, envCap) {
  const n = Number(asked);
  if (!Number.isFinite(n) || n < 1) return envCap;
  return Math.min(Math.floor(n), envCap);
}

/**
 * The script the prompt is rendered from.
 *
 * Numerals are spelled out in Devanagari on purpose. A multilingual TTS model
 * reading "18 लाख" may well say "eighteen", and "1 दबाइए" is the single most
 * important word in a DTMF prompt — if the caller does not hear "एक" clearly
 * there is no campaign. Written as words, there is nothing to get wrong.
 *
 * "अप्रूव हो सकता है", never "अप्रूव है": the bot must not promise a sanction.
 * The eighteen lakh figure is this lender's real max_amount in the
 * recommendation base, not a marketing number.
 */
export const IVR_SCRIPT =
  "नमस्ते। मैं Buddy Loan से बोल रही हूँ।\n\n" +
  "आपके बिज़नेस के लिए अठारह लाख रुपये तक का बिज़नेस लोन अप्रूव हो सकता है — " +
  "बिना किसी गारंटी के।\n\n" +
  "अगर आप जानना चाहते हैं, तो अभी एक दबाइए। हमारी टीम आपको तुरंत कॉल करेगी।";

/** Aarohi — native Hindi female, and her profile lists IVR as a use case. */
export const IVR_VOICE_ID = "rqIg3iVrlZOAkxCMdelQ";

/**
 * The model the script is rendered with, and it must be a MULTILINGUAL one.
 *
 * elevenLabsClient defaults to eleven_monolingual_v1, which is English-only.
 * Handed the Devanagari above it answers HTTP 400 and no prompt is ever made —
 * which is exactly what the first live run hit. The voice was never the
 * problem; the model was. Since the orchestrator is the only caller that knows
 * the script is Hindi, it is the caller's job to say so rather than lean on a
 * default written for a different language.
 *
 * v2 over flash: this renders one file once, ahead of the calls, so latency
 * buys nothing here and the better Hindi pronunciation is worth having.
 */
export const IVR_MODEL_ID = "eleven_multilingual_v2";

/**
 * The dialler's contact file.
 *
 * Pure so the shape is testable without an upload. One mobile per line with a
 * header, which is what OBD's base upload takes; the name rides along because
 * the press-1 leg can use it and, as the ORI bot found out the expensive way, a
 * name the pipeline never carries is a name the bot cannot say.
 */
export function buildBaseCsv(rows) {
  const header = "mobile,name";
  const lines = (rows ?? [])
    .map((r) => {
      const mobile = String(r?.mobile10 ?? "").replace(/\D/g, "").slice(-10);
      if (mobile.length !== 10) return null;
      // A comma in a customer name would shift every column after it.
      const name = String(r?.customer_name ?? "").replace(/[",\r\n]/g, " ").trim();
      return `${mobile},${name}`;
    })
    .filter(Boolean);
  return [header, ...lines].join("\n");
}

/**
 * Who to call: best-scoring first, suppression already applied, capped.
 *
 * Through crm.lender_campaign_batch rather than the view directly, because the
 * view cannot be read at this size over PostgREST. Measured on production
 * 16 Sep: 500 rows takes 345 ms, 50,000 takes 13,192 ms, and the `authenticator`
 * role PostgREST connects as carries statement_timeout=8s. So a 50,000-row
 * fetch does not come back short -- it raises, and nobody is dialled.
 *
 * The function owns a 120s timeout of its own, which is the right place for it:
 * a once-a-day batch is not the interactive query the 8s ceiling protects
 * against, and raising that ceiling would have loosened it for every other
 * caller.
 */
export async function selectBase(sb, { limit, lender = LENDER } = {}) {
  // The _json form, because PostgREST caps EVERY result at db-max-rows = 1000
  // and says nothing. The table-returning function is correct — it gives 50,000
  // from SQL — but over the API it came back as exactly 1000, and run 8 reported
  // {"step":"base","people":1000} against a cap of 50,000.
  //
  // The cap counts ROWS, so one jsonb row carrying the whole array is not
  // subject to it. See the migration for why raising db-max-rows globally was
  // not the trade to make.
  const { data, error } = await sb.rpc("lender_campaign_batch_json", {
    p_lender: lender,
    p_limit: limit,
  });
  if (error) throw new Error(`base select failed: ${error.message}`);

  const rows = Array.isArray(data) ? data : [];

  // Belt and braces. If this ever comes back at exactly the row cap while more
  // was asked for, that is the truncation signature and it must be loud —
  // quietly dialling 2% of the base is the failure mode this whole change
  // exists to end.
  if (limit > 1000 && rows.length === 1000) {
    throw new Error(
      `base select returned exactly 1000 rows for a limit of ${limit} — ` +
        `that is PostgREST's db-max-rows cap, not the real base size`
    );
  }
  return rows;
}

/**
 * How many people a run WOULD take, without fetching them.
 *
 * /status asks this. Counting the base table with the suppression anti-join is
 * a cheap index scan; fetching the rows to count them would make a readiness
 * check take the same thirteen seconds as the run it is reporting on.
 */
export async function countDialable(sb, { lender = LENDER } = {}) {
  const { count, error } = await sb
    .from("lender_campaign_base")
    .select("mobile10", { count: "exact", head: true })
    .eq("lender", lender);
  if (error) throw new Error(`base count failed: ${error.message}`);
  return count ?? 0;
}

/**
 * Run the pipeline. Dependencies are injected so every step can be checked
 * without an OBD account, an ElevenLabs key or a database.
 */
export async function runFlexiloansCampaign(deps, opts = {}) {
  const { sb, obd, tts, env = process.env } = deps;
  const cap = opts.cap ?? campaignCap(env);
  const enabled = opts.enabled ?? campaignEnabled(env);
  const stamp = opts.stamp ?? new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const name = `FLEXI_BL_${stamp}`;

  const steps = [];

  // Every failure so far has been diagnosed from one error string, because the
  // steps collected before the throw never leave this function. They do now:
  // which step ran, what the dialler returned, and how far the run got is the
  // context that turns the next 400 into one round trip instead of two.
  try {
    return await runPipeline();
  } catch (error) {
    error.steps = steps;
    throw error;
  }

  async function runPipeline() {

  const rows = await selectBase(sb, { limit: cap });
  steps.push({ step: "base", people: rows.length });
  if (rows.length === 0) {
    return { ok: false, dialled: false, reason: "nobody to call", name, steps };
  }

  // textToSpeech returns a WRAPPER — { success, audio, ... } — not the bytes,
  // and it resolves rather than throws when ElevenLabs fails. Passing the
  // wrapper straight to the uploader sent the dialler "[object Object]", and a
  // TTS failure sailed through as if it had worked.
  const spoken = await tts.textToSpeech({
    text: opts.script ?? IVR_SCRIPT,
    voiceId: opts.voiceId ?? IVR_VOICE_ID,
    modelId: opts.modelId ?? IVR_MODEL_ID,
  });
  if (spoken && spoken.success === false) {
    throw new Error(`TTS failed: ${spoken.error ?? "no reason given"}`);
  }
  // Accepts the wrapper or a bare buffer, because obdRoutes and the tests hand
  // over raw bytes and both shapes are legitimate input.
  const audio = spoken?.audio ?? spoken;
  const audioBytes = audio?.byteLength ?? audio?.length ?? 0;
  // The check that would have caught all of this: a prompt with no bytes is not
  // a prompt, and uploading it wastes a round trip to fail vaguely.
  if (!audioBytes) {
    throw new Error("TTS returned no audio bytes");
  }
  steps.push({ step: "tts", bytes: audioBytes });

  // mp3 is what ElevenLabs returns; the OBD upload takes the type as a field
  // rather than sniffing it, so saying "wav" here would be a lie the dialler
  // acts on.
  const prompt = await obd.uploadVoiceFile(audio, `${name}.mp3`, "campaign", "mp3");
  // The upload replies {message} and no id — run 8 established that — so the
  // id comes from the list endpoint, which does carry one.
  let promptId = prompt?.promptId ?? prompt?.id ?? null;
  if (promptId === null && typeof obd.getVoiceFiles === "function") {
    promptId = findPromptId(await obd.getVoiceFiles(), name);
  }
  steps.push({
    step: "prompt",
    id: promptId,
    // The keys, not the values: enough to see which field an id was read from,
    // without pasting a vendor payload into an HTTP response.
    returned: Object.keys(prompt ?? {}),
  });

  const base = await obd.uploadBaseFile(buildBaseCsv(rows), name);
  const baseId = base?.baseId ?? base?.id ?? null;
  steps.push({
    step: "contacts",
    id: baseId,
    returned: Object.keys(base ?? {}),
    // The MESSAGE this time, not just the key. baseupload has no list endpoint
    // to fall back on and nothing in the repo documents one, so what the
    // dialler actually says is the only lead we have on where its id lives.
    said: typeof base?.message === "string" ? base.message.slice(0, 200) : null,
  });

  if (!enabled) {
    // Everything is staged and inspectable in the OBD console; the one call
    // that rings a phone is the one not made.
    return {
      ok: true,
      dialled: false,
      reason: "FLEXI_CAMPAIGN_ENABLED is not 'on' — prepared but not broadcast",
      name,
      people: rows.length,
      steps,
    };
  }

  // Composing with a null id is a guaranteed 400 from the dialler, and its 400
  // says nothing — run 7 spent a full cycle on "Compose campaign failed: HTTP
  // 400" with an empty body. If the id was never read out of the upload
  // response, that is knowable HERE, and it names the field it looked in.
  if (promptId === null || baseId === null) {
    throw new Error(
      `Cannot compose: promptId=${promptId} baseId=${baseId}. ` +
        `The upload replied with keys [${Object.keys(prompt ?? {})}] and ` +
        `[${Object.keys(base ?? {})}]; the id is read from promptId/id and baseId/id.`
    );
  }

  const campaign = await obd.composeCampaign({
    campaignName: name,
    campaignType: "DTMF",
    promptId,
    baseId,
    // The whole point of the broadcast: 1 is intent, and it is the only key
    // that does anything.
    dtmfKeys: [{ key: "1", action: "webhook" }],
  });
  steps.push({ step: "campaign", id: campaign?.campaignId ?? campaign?.id ?? null });

  return {
    ok: true,
    dialled: true,
    name,
    people: rows.length,
    campaignId: campaign?.campaignId ?? campaign?.id ?? null,
    steps,
  };
  }
}

/** The real thing, wired from the environment. */
export function liveDeps(sb) {
  return {
    sb,
    obd: new OBDApiClient(
      process.env.OBD_BASE_URL,
      process.env.OBD_USERNAME,
      process.env.OBD_PASSWORD
    ),
    tts: new ElevenLabsClient(process.env.ELEVEN_LABS_API_KEY),
  };
}

export default runFlexiloansCampaign;
