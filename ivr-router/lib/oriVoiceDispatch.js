import OriserveVoiceClient from "./oriserveVoiceClient.js";

/**
 * A press of 1, handed to the ORI voice bot.
 *
 * The decision this implements: every Business Loans press-1 gets an AI voice
 * call, and the WhatsApp template becomes enrichment rather than the whole
 * response. A person who pressed 1 asked to be called; the bot qualifies them
 * so the human agent picks up a lead that already has answers on it.
 *
 * The call is placed against BuddyLoan's own Oriserve tenant. The campaign is
 * ORISERVE_CAMPAIGN_ID and the outcome comes back on /webhooks/oriserve, which
 * writes crm.voice_call_events — see ORI_VOICE_BOT_CAMPAIGN.md.
 *
 * ── This must never cost a send ───────────────────────────────────────────
 *
 * Same rule as lib/crmPressForward.js, for the same reason: the IVR panel is
 * waiting on the webhook's response and the WhatsApp message is what the
 * customer is about to see. So this is fire-and-forget, never awaited, and
 * nothing in it is allowed to reject — an unhandled rejection on a floating
 * promise takes the process down.
 *
 * ── Business Loans only, and press 1 only ─────────────────────────────────
 *
 * This webhook carries several lenders. On 02 Sep it took 692 presses on
 * businessloans and 6,047 on herofincorp; Hero and Poonawalla presses go into
 * those lenders' own DIY journeys and have no CRM case for a bot to enrich, so
 * dialling them would be roughly 6,000 paid calls a day into a book nobody
 * works. Scoped by variant, defaulting to businessloans alone.
 *
 * Press 1 only, unlike the CRM forward which records every digit. A 2 is not a
 * request to be called, and this is the one thing here that spends money per
 * press.
 *
 * ── Every call is a real phone ringing ────────────────────────────────────
 *
 * So the dedupe is not an optimisation. The IVR panel retries, and a caller can
 * press 1 twice; either would ring the same person again. Keyed on unique_id
 * when the panel sends one — that identifies a call rather than a caller — and
 * on variant+mobile otherwise.
 *
 * The set is deliberately NOT shared with the WhatsApp dedupe in
 * routes/ivrWhatsAppRoutes.js. That one releases its key when a send fails so
 * the message can be retried; releasing this one would place a second call for
 * a WhatsApp failure that has nothing to do with the bot.
 *
 * In memory, so it resets on restart and is not shared across replicas — the
 * same tradeoff the send-log dedupe documents, and the same answer: the durable
 * version belongs in Postgres, and matters more here than there.
 *
 * Config:
 *   ORI_PRESS_VARIANTS   comma-separated variants to dial, default
 *                        "businessloans". "*" dials every press-1.
 *   ORI_PRESS_DISPATCH=0 turns the bot off without a deploy.
 *   ORISERVE_API_KEY     required; without it the client cannot be built and
 *                        this stays inert and says so once.
 *   ORISERVE_CAMPAIGN_ID the BuddyLoan campaign the call runs.
 *   ORISERVE_BASE_URL / ORISERVE_WEBHOOK_URL  tenant and callback.
 */

let client = null;
let clientUnavailable = false;
let warnedVariants = new Set();

/** Built lazily: the constructor throws without a key, and that must not throw here. */
function voiceClient() {
  if (client) return client;
  if (clientUnavailable) return null;
  try {
    client = new OriserveVoiceClient();
    return client;
  } catch (error) {
    console.warn(
      `[ORI_PRESS] Voice bot unavailable (${error.message}) — presses are being ` +
        "recorded and messaged as usual, but no call is being placed."
    );
    clientUnavailable = true;
    return null;
  }
}

/** Variants whose press-1 gets a bot call. */
function dialledVariants() {
  return (process.env.ORI_PRESS_VARIANTS ?? "businessloans")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
}

function dials(variant) {
  const allowed = dialledVariants();
  if (allowed.includes("*")) return true;
  return allowed.includes(String(variant || "").trim().toLowerCase());
}

/** Oriserve wants +91XXXXXXXXXX; the panel sends whatever it sends. */
export function toE164(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  const ten = digits.length > 10 ? digits.slice(-10) : digits;
  if (ten.length !== 10 || !/^[6-9]/.test(ten)) return null;
  return `+91${ten}`;
}

const dialled = new Set();
const DIALLED_MAX = 5000;

export function dialKey(body, variant) {
  const uid = String(body.unique_id || body.call_id || "").trim();
  if (uid) return `uid:${uid}`;
  const scope = String(variant || body.campaign_id || "-").trim().toLowerCase();
  const mobile = String(body.mobile || "-").replace(/\D/g, "").slice(-10) || "-";
  return `cm:${scope}:${mobile}`;
}

function alreadyDialled(key) {
  if (dialled.has(key)) return true;
  if (dialled.size >= DIALLED_MAX) dialled.clear();
  dialled.add(key);
  return false;
}

/** Test seam: the dedupe set is process-wide and would leak between cases. */
export function _resetDialled() {
  dialled.clear();
  warnedVariants = new Set();
}

/**
 * @param {object} body the webhook body as received
 * @param {{digit?: string, variant?: string}} context
 * @returns {Promise<{dialled: boolean, reason?: string, campaignId?: string}>}
 *   always resolves. Not awaited by the route; returned so a test can wait.
 */
export function dispatchPressToVoiceBot(body, context = {}) {
  try {
    return placeCall(body || {}, context).catch((error) => {
      // Belt and braces: placeCall already catches. This is here so a throw
      // from somewhere new inside it cannot become an unhandled rejection.
      console.error(`[ORI_PRESS] Dispatch threw: ${error?.message ?? error}`);
      return { dialled: false, reason: "threw" };
    });
  } catch (error) {
    console.error(`[ORI_PRESS] Dispatch threw synchronously: ${error?.message ?? error}`);
    return Promise.resolve({ dialled: false, reason: "threw" });
  }
}

async function placeCall(body, { digit, variant } = {}) {
  if (String(process.env.ORI_PRESS_DISPATCH || "1").trim() === "0") {
    return { dialled: false, reason: "disabled" };
  }

  if (String(digit || "").trim() !== "1") {
    return { dialled: false, reason: "not_press_1" };
  }

  if (!dials(variant)) {
    // Once per variant per process. Every press would be thousands of lines a
    // day for a decision that is the same every time, and none at all would
    // make a mis-pointed panel look identical to a quiet one.
    const key = String(variant || "").trim().toLowerCase() || "(unnamed)";
    if (!warnedVariants.has(key)) {
      warnedVariants.add(key);
      console.log(
        `[ORI_PRESS] Not dialling presses from variant=${key} — ` +
          `ORI_PRESS_VARIANTS is "${dialledVariants().join(",")}".`
      );
    }
    return { dialled: false, reason: "variant_not_dialled" };
  }

  const mobile = toE164(body.mobile);
  if (!mobile) {
    console.warn(`[ORI_PRESS] Not a dialable number: "${body.mobile}" — no call placed`);
    return { dialled: false, reason: "bad_mobile" };
  }

  const key = dialKey(body, variant);
  if (alreadyDialled(key)) {
    console.log(`[ORI_PRESS] Already dialled (${key}) — not calling again`);
    return { dialled: false, reason: "duplicate" };
  }

  const ori = voiceClient();
  if (!ori) return { dialled: false, reason: "no_client" };

  try {
    // campaign_id is deliberately omitted: body.campaign_id is OUR dialler's
    // campaign, not Oriserve's. The client falls back to ORISERVE_CAMPAIGN_ID.
    // Ours travels in metadata, where the callback can read it back.
    const result = await ori.triggerCampaign({
      mobile,
      metadata: {
        customer_name: String(body.name || body.customer_name || "").trim() || undefined,
        purpose: "press1_qualification",
        source: "ivr_keypress_webhook",
        ivr_variant: variant || null,
        ivr_campaign_id: body.campaign_id || null,
        ivr_campaign_name: body.campaign_name || null,
        unique_id: body.unique_id || body.call_id || null,
      },
    });

    // triggerCampaign RETURNS { success: false } on an API error rather than
    // throwing — only bad input throws — so a refusal has to be read, not
    // caught. Without this a refused call would log as a placed one.
    if (!result.success) {
      console.error(
        `[ORI_PRESS] Oriserve refused the call for ${mobile}: ${result.error} ` +
          `(status ${result.statusCode ?? "-"})`
      );
      // Nothing rang, so release the key: the next press may still get through.
      dialled.delete(key);
      return { dialled: false, reason: "refused" };
    }

    console.log(
      `[ORI_PRESS] Voice bot dialled ${mobile} variant=${variant || "-"} ` +
        `campaign=${result.campaign_id || "-"} key=${key}`
    );
    return { dialled: true, campaignId: result.campaign_id ?? null };
  } catch (error) {
    console.error(`[ORI_PRESS] Call failed for ${mobile}: ${error?.message ?? error}`);
    dialled.delete(key);
    return { dialled: false, reason: "error" };
  }
}

export default dispatchPressToVoiceBot;
