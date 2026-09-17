import OBDApiClient from "./obdApiClient.js";
import ElevenLabsClient from "./elevenLabsClient.js";
import { findPromptId } from "./obdApiClient.js";
import { createDtmfCampaign } from "./campaignTemplates.js";
import { getOrCreateRecording } from "./recordingLibrary.js";

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
 * The numbers a TEST run dials, and nobody else.
 *
 * Eleven runs have gone at the whole base without one person ever hearing the
 * prompt. Dialling 25,000 people to find out what the recording sounds like is
 * the wrong order, and there was no other order available.
 *
 * Returns [] for anything that is not a real ten-digit mobile, and the caller
 * treats [] as "this is not a test run" — so a typo can never silently become
 * a broadcast to the entire base. That is the only failure mode that matters
 * here.
 */
export function resolveTestMobiles(raw) {
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  const cleaned = list
    .map((m) => String(m ?? "").replace(/\D/g, "").slice(-10))
    .filter((m) => m.length === 10);
  // Bounded hard. A "test" is a handful of people you know, and anything
  // longer is a campaign wearing a test's clothes.
  return [...new Set(cleaned)].slice(0, 10);
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
export function buildBaseCsv(rows, format = "numbers") {
  const mobiles = (rows ?? [])
    .map((r) => ({
      mobile: String(r?.mobile10 ?? "").replace(/\D/g, "").slice(-10),
      // A comma in a customer name would shift every column after it.
      name: String(r?.customer_name ?? "").replace(/[",\r\n]/g, " ").trim(),
    }))
    .filter((r) => r.mobile.length === 10);

  // "numbers" is the default now, and the reason is worth writing down.
  //
  // The dialler answers the base upload with 200 {"message":"File Upload
  // Failed"} for every contactList value tried, and 400 when contactList is
  // absent entirely. Present-but-any-value gets the request accepted and the
  // FILE rejected — so the file is what it does not like, not the field.
  //
  // The header was never verified. The comment here used to assert that
  // "mobile,name" with a header "is what OBD's base upload takes", and nothing
  // ever checked it. A dialler reading that first line sees the word "mobile"
  // where a phone number should be.
  //
  // So: bare numbers, one per line, nothing else. The other shapes stay
  // reachable by name so the right one can be found in seconds rather than a
  // deploy per guess.
  if (format === "csv-header") return ["mobile,name", ...mobiles.map((r) => `${r.mobile},${r.name}`)].join("\n");
  if (format === "csv") return mobiles.map((r) => `${r.mobile},${r.name}`).join("\n");
  return mobiles.map((r) => r.mobile).join("\n");
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
 * Write the dial list into the ledger the view reads.
 *
 * One RPC rather than 25,000 inserts through PostgREST, and it returns the
 * count it actually wrote so the caller can check that against what it dialled
 * instead of assuming.
 */
export async function recordDispatch(sb, { lender = LENDER, campaign, rows } = {}) {
  const mobiles = (rows ?? [])
    .map((r) => String(r?.mobile10 ?? "").replace(/\D/g, "").slice(-10))
    .filter((m) => m.length === 10);
  if (mobiles.length === 0) return 0;

  const { data, error } = await sb.rpc("record_campaign_dispatch", {
    p_lender: lender,
    p_campaign: campaign,
    p_mobiles: mobiles,
  });
  if (error) throw new Error(`dispatch ledger write failed: ${error.message}`);
  return typeof data === "number" ? data : Number(data ?? 0);
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
  // Named apart, and with the clock in it to the SECOND.
  //
  // It was hhmm, and two probes a few seconds apart got:
  //
  //   "Voice file name already exists, Please choose another name"
  //   "Base file name already exists, Please choose another name"
  //
  // Minutes are not granular enough for back-to-back tests, which is exactly
  // how a test gets used. Seconds are.
  const testStamp = new Date().toISOString().slice(11, 19).replace(/:/g, "");

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

  // A test run dials exactly the numbers it was handed and never touches the
  // base. The selectBase call is not merely skipped — it is not reached — so
  // there is no path where a malformed test number falls through to 25,000
  // strangers.
  const askedForTest = opts.testMobiles !== undefined || opts.testMobile !== undefined;
  const testMobiles = resolveTestMobiles(opts.testMobiles ?? opts.testMobile);
  const isTest = testMobiles.length > 0;

  // The dangerous case, and it is not hypothetical: a caller types a test
  // number wrong, nothing valid survives, isTest is false — and the run
  // quietly falls through to the base and dials 25,000 strangers instead of
  // the one person who was meant to hear it. Asking for a test and getting a
  // broadcast is the worst outcome this file can produce, so a test that
  // resolves to nobody is refused rather than widened.
  if (askedForTest && !isTest) {
    throw new Error(
      `Test run asked for, but no valid ten-digit mobile in ` +
        `${JSON.stringify(opts.testMobiles ?? opts.testMobile)} — refusing rather ` +
        `than falling through to the base`
    );
  }

  const name = isTest ? `FLEXI_TEST_${stamp}_${testStamp}` : `FLEXI_BL_${stamp}`;

  const rows = isTest
    ? testMobiles.map((mobile10) => ({ mobile10, customer_name: null }))
    : await selectBase(sb, { limit: cap });
  steps.push({ step: "base", people: rows.length, test: isTest || undefined });
  if (rows.length === 0) {
    return { ok: false, dialled: false, reason: "nobody to call", name, steps };
  }

  // textToSpeech returns a WRAPPER — { success, audio, ... } — not the bytes,
  // and it resolves rather than throws when ElevenLabs fails. Passing the
  // wrapper straight to the uploader sent the dialler "[object Object]", and a
  // TTS failure sailed through as if it had worked.
  // The library first. This script does not change between runs, so neither
  // does its audio, and regenerating it billed a fresh generation and made
  // every run wait for ElevenLabs before a single number could be dialled.
  // lib/recordingLibrary.js has why a miss still generates rather than failing,
  // and why the server does not try to save what it generates.
  //
  // getOrCreateRecording keeps both checks this block was built around -- a
  // resolved-but-failed TTS, and zero bytes -- because caching either would
  // turn one bad generation into silence played at customers for ever.
  const spec = {
    text: opts.script ?? IVR_SCRIPT,
    voiceId: opts.voiceId ?? IVR_VOICE_ID,
    modelId: opts.modelId ?? IVR_MODEL_ID,
  };
  const recording = await getOrCreateRecording(spec, { tts });
  const audio = recording.audio;
  const audioBytes = audio?.byteLength ?? audio?.length ?? 0;
  if (!audioBytes) {
    throw new Error("TTS returned no audio bytes");
  }
  steps.push({ step: "tts", bytes: audioBytes, cached: recording.cached });

  // mp3 is what ElevenLabs returns; the OBD upload takes the type as a field
  // rather than sniffing it, so saying "wav" here would be a lie the dialler
  // acts on.
  // "menu", not "campaign". Run 10: `Invalid Voice Category.` — "campaign" is
  // not a category OBD has, and the account's own 376 prompts say what is:
  // menu 218, welcome 143, thanks 12, noagent 2, wronginput 1.
  //
  // menu rather than welcome because this prompt asks for a keypress, and that
  // is the team's own precedent on this very campaign: BL_FLEXI_PRESS1_2.wav
  // and BL_FLEXI_2.wav are both "menu", as is the generic DTMF.wav.
  const prompt = await obd.uploadVoiceFile(audio, `${name}.mp3`, "menu", "mp3");
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
    // ...except the message, which is where OBD hides "File Upload Failed"
    // behind a 200. Run 9 captured this for the base step and not for this one,
    // so half of what the dialler said was thrown away and the prompt's null id
    // looked like a lookup problem rather than a failed upload.
    said: typeof prompt?.message === "string" ? prompt.message.slice(0, 200) : null,
  });

  // opts.contactList rides through from the request body so the value can be
  // probed without a deploy per attempt. Absent means an empty field.
  const base = await obd.uploadBaseFile(
    buildBaseCsv(rows, opts.baseFormat ?? "numbers"),
    name,
    opts.contactList ?? "",
    opts.baseExt ?? "csv"
  );
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

  // Through createDtmfCampaign, which is OBD's ACTUAL compose contract and has
  // been sitting in campaignTemplates.js — used by /api/obd/campaigns/dtmf —
  // the whole time. What this function used to hand-build shared no field with
  // it:
  //
  //   sent                              wanted
  //   campaignType: "DTMF"   (string)   templateId: 1        (number)
  //   promptId                          menuPId
  //   dtmfKeys: [{key, action}]         dtmf: "1"
  //   -                                 ~20 more required fields
  //
  // An unrecognised payload is exactly what answers with a 400 and an empty
  // body, which is what every compose attempt got.
  //
  // menuPId is also why the prompt category had to be "menu": this is the menu
  // prompt, the one that asks for the keypress.
  const campaign = await obd.composeCampaign(
    createDtmfCampaign({
      campaignName: name,
      baseId,
      menuPromptId: promptId,
      // 1 is intent, and the only key that does anything.
      dtmf: opts.dtmf ?? "1",
      // Left to the template's defaults unless a caller says otherwise: these
      // are the dialler's own field names and guessing values for them is what
      // produced the payload above.
      ...(opts.campaignConfig ?? {}),
    })
  );
  const campaignId = campaign?.campaignId ?? campaign?.id ?? null;
  steps.push({
    step: "campaign",
    id: campaignId,
    returned: Object.keys(campaign ?? {}),
    said: typeof campaign?.message === "string" ? campaign.message.slice(0, 200) : null,
  });

  // A compose with no id is not a campaign.
  //
  // The run reported ok:true, dialled:true and campaignId:null -- it had asked
  // the dialler to broadcast and had nothing to show that it had. That is the
  // worst thing this function can say, because at 25,000 it is the difference
  // between "everyone was called" and "nobody was" with no way to tell them
  // apart afterwards, and the ledger writes either way.
  if (campaignId === null) {
    throw new Error(
      `Compose returned no campaign id. The dialler replied with keys ` +
        `[${Object.keys(campaign ?? {})}]` +
        (typeof campaign?.message === "string" ? ` and said "${campaign.message}"` : "") +
        ` — refusing to report a broadcast that cannot be pointed at`
    );
  }

  // AFTER the compose, never before.
  //
  // Recording first and composing second would exclude people who were never
  // called, and they would sit out the whole 90-day window for a run that
  // failed. Recording second risks the opposite — a compose that worked and a
  // ledger write that did not — so that case is reported loudly rather than
  // swallowed: the next lot would re-dial these people, and somebody has to
  // know that before firing it.
  let recorded = null;
  let recordError = null;
  if (isTest) {
    // Not written. The ledger exists so consecutive lots draw different people
    // from the base, and a test number was never drawn from it — recording one
    // would suppress a real customer for 90 days on the strength of a test.
    steps.push({ step: "recorded", people: null, skipped: "test run" });
  } else {
    try {
      recorded = await recordDispatch(sb, { lender: LENDER, campaign: name, rows });
    } catch (error) {
      recordError = error?.message ?? String(error);
    }
    steps.push({ step: "recorded", people: recorded, error: recordError });
  }

  return {
    ok: true,
    dialled: true,
    name,
    people: rows.length,
    campaignId,
    // Loud, and at the top level rather than buried in steps: a false here
    // means the next lot will call these people again.
    test: isTest || undefined,
    dispatch_recorded: isTest ? undefined : recordError === null && recorded === rows.length,
    ...(recordError ? { warning: `dialled, but the dispatch ledger was not written: ${recordError}` } : {}),
    steps,
  };
  }
}

/** The real thing, wired from the environment. */
/**
 * Just the dialler, for the calls that only talk to the dialler.
 *
 * liveDeps builds an ElevenLabsClient too, and that constructor THROWS without
 * ELEVEN_LABS_API_KEY. So a read-only OBD lookup -- list the webhooks, list the
 * prompts -- failed with "Missing ELEVEN_LABS_API_KEY", naming a credential it
 * has no use for and would never have called. A route that reads the dialler
 * should need the dialler's credentials and nothing else.
 */
/**
 * The OBD hosts this service is allowed to send its credentials to.
 *
 * obdClient takes a baseUrl so compose can be tested against the host the
 * vendor's own panel uses. That parameter is an EXFILTRATION VECTOR if it is
 * taken on trust: the client logs in before every call, so a caller who could
 * name any host could have this server post OBD_USERNAME and OBD_PASSWORD
 * wherever they liked. CONSOLE_SECRET guards the route, but a secret that has
 * been pasted into a chat transcript -- as this one has -- is not the only
 * thing that should stand between a credential and the open internet.
 *
 * So: an allowlist, matched on host, not a substring of the URL.
 * "obdapi2.ivrsms.com.evil.test" contains the string and is a different
 * machine.
 */
export const OBD_ALLOWED_HOSTS = Object.freeze([
  'obdapi2.ivrsms.com',
  'obd3api.expressivr.com',
]);

export function assertAllowedObdHost(baseUrl) {
  let host;
  try {
    host = new URL(baseUrl).host;
  } catch {
    throw new Error(`Not a valid OBD base URL: ${JSON.stringify(baseUrl)}`);
  }
  if (!OBD_ALLOWED_HOSTS.includes(host)) {
    throw new Error(
      `Refusing to send OBD credentials to ${host}. Allowed: ${OBD_ALLOWED_HOSTS.join(', ')}`
    );
  }
  return baseUrl;
}

/**
 * @param baseUrl overrides OBD_BASE_URL, for testing compose against the host
 *   the vendor's panel actually uses. Checked against OBD_ALLOWED_HOSTS.
 */
export function obdClient(baseUrl) {
  return new OBDApiClient(
    baseUrl === undefined ? process.env.OBD_BASE_URL : assertAllowedObdHost(baseUrl),
    process.env.OBD_USERNAME,
    process.env.OBD_PASSWORD
  );
}

export function liveDeps(sb) {
  return {
    sb,
    obd: obdClient(),
    tts: new ElevenLabsClient(process.env.ELEVEN_LABS_API_KEY),
  };
}

export default runFlexiloansCampaign;
