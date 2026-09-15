import OBDApiClient from "./obdApiClient.js";
import ElevenLabsClient from "./elevenLabsClient.js";

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

/** Who to call: the dialable view, best-scoring first, capped. */
export async function selectBase(sb, { limit, lender = LENDER } = {}) {
  const { data, error } = await sb
    .from("v_lender_campaign_dialable")
    .select("mobile10,customer_name,best_score,best_rank")
    .eq("lender", lender)
    .order("best_score", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`base select failed: ${error.message}`);
  return data ?? [];
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

  const rows = await selectBase(sb, { limit: cap });
  steps.push({ step: "base", people: rows.length });
  if (rows.length === 0) {
    return { ok: false, dialled: false, reason: "nobody to call", name, steps };
  }

  const audio = await tts.textToSpeech({
    text: opts.script ?? IVR_SCRIPT,
    voiceId: opts.voiceId ?? IVR_VOICE_ID,
  });
  steps.push({ step: "tts", bytes: audio?.byteLength ?? audio?.length ?? null });

  // mp3 is what ElevenLabs returns; the OBD upload takes the type as a field
  // rather than sniffing it, so saying "wav" here would be a lie the dialler
  // acts on.
  const prompt = await obd.uploadVoiceFile(audio, `${name}.mp3`, "campaign", "mp3");
  steps.push({ step: "prompt", id: prompt?.promptId ?? prompt?.id ?? null });

  const base = await obd.uploadBaseFile(buildBaseCsv(rows), name);
  steps.push({ step: "contacts", id: base?.baseId ?? base?.id ?? null });

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

  const campaign = await obd.composeCampaign({
    campaignName: name,
    campaignType: "DTMF",
    promptId: prompt?.promptId ?? prompt?.id ?? null,
    baseId: base?.baseId ?? base?.id ?? null,
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
