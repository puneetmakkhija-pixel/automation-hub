import OriserveVoiceClient from "./oriserveVoiceClient.js";
import { recordVoiceDispatch } from "./voiceDispatchLog.js";
import {
  qualifyLead,
  decideFromVerdict,
  enforcing as qualifyEnforcing,
} from "./leadQualification.js";

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
 *                        "businessloans". Can only narrow DIALABLE_VARIANTS,
 *                        never widen it; "*" means every variant on that list.
 *   ORI_PRESS_DISPATCH=0 turns the bot off without a deploy.
 *   IVR_QUALIFY_ENFORCE=1 gate on crm.ivr_lead_qualifies() instead of on the
 *                        variant, admitting Hero and Poonawalla presses that
 *                        clear a bar. Default 0: the verdict is recorded and
 *                        ignored. See lib/leadQualification.js before setting
 *                        it — on 04-05 Sep data it RAISES dialling 67%, from
 *                        1,719 to 2,868, by admitting qualified Hero and
 *                        Poonawalla presses.
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

/**
 * The variants this bot is EVER allowed to dial. Not configurable.
 *
 * ORI_PRESS_VARIANTS used to be the only gate, and it could widen as easily as
 * narrow: setting it to "*" dialled every press-1 on the webhook, whatever the
 * product. On 04-05 Sep that would have been 3,614 Poonawalla presses
 * (s1.whistleloop.com, which send no variant at all) and 126 Hero presses
 * (loans.apps.herofincorp.com) on top of the 1,720 Business Loans ones — paid
 * calls into two books that have no CRM case for a bot to enrich, from a
 * one-word edit in a dashboard, with nothing in the code to stop it.
 *
 * So the env var now only ever SUBTRACTS. A variant must be named here to be
 * dialable at all; ORI_PRESS_VARIANTS picks a subset of this list, and "*"
 * means "all of this list" rather than "all presses". Adding a product to the
 * bot is a code change and a review — which is the point.
 */
const DIALABLE_VARIANTS = new Set(["businessloans"]);

/**
 * Who the qualification rule governs, once it is enforcing.
 *
 * From 05 Sep 2026 the bot is not scoped by which IVR someone pressed on but by
 * what enrichment says about them: a Poonawalla or Hero press that clears any
 * of the five bars in crm.ivr_lead_qualifies() is a business-loan lead. So when
 * IVR_QUALIFY_ENFORCE is on, all three IVRs are admitted HERE and the
 * qualification check downstream is what actually decides.
 *
 * Poonawalla presses arrive with no variant field at all -- 3,616 of the 5,462
 * press-1s on 04-05 Sep, all from s1.whistleloop.com -- so the empty variant is
 * an admitted source in its own right rather than a mistake to reject.
 *
 * While shadow (the default) this stays out of the way and only Business Loans
 * is dialled, exactly as before. That ordering matters: admitting all three
 * before the verdict can stop anyone would treble the call volume overnight,
 * which is the opposite of what shadow mode is for.
 */
const QUALIFY_GOVERNED_VARIANTS = new Set([
  "businessloans",
  "herofincorp",
  "poonawalla",
  "", // Poonawalla's IVR sends no variant
]);

function allowedVariants() {
  return qualifyEnforcing() ? QUALIFY_GOVERNED_VARIANTS : DIALABLE_VARIANTS;
}

/** Whatever ORI_PRESS_VARIANTS currently selects. Not yet checked for safety. */
function configuredVariants() {
  return (process.env.ORI_PRESS_VARIANTS ?? "businessloans")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
}

/** What the bot will actually dial: the selection, clamped to the allowlist. */
function dialledVariants() {
  const configured = configuredVariants();
  const allowed = allowedVariants();
  const selected = configured.includes("*") ? [...allowed] : configured;
  return selected.filter((v) => allowed.has(v));
}

function dials(variant) {
  const key = String(variant || "").trim().toLowerCase();

  // The hard gate, and the only one. Deliberately not duplicated inside
  // dialledVariants(): a second copy there is unreachable, so it would sit
  // untested and read as protection that no test could hold to account.
  if (!allowedVariants().has(key)) {
    warnUnconfigurable(key);
    return false;
  }

  // Once qualification is enforcing it IS the gate, and the variant is only a
  // label on the lead. ORI_PRESS_VARIANTS stops applying here on purpose: it
  // defaults to "businessloans", so leaving it in the path would reject every
  // Hero and Poonawalla press before the verdict was ever asked for — the whole
  // point of the change, silently undone by a variable nobody thought to edit.
  if (qualifyEnforcing()) return true;

  const configured = configuredVariants();
  return configured.includes("*") || configured.includes(key);
}

/**
 * Say so, once, when ORI_PRESS_VARIANTS names something the bot may not dial.
 *
 * This is config drift worth seeing: someone put a product on the bot and the
 * deploy quietly did not take. Keyed separately from the per-variant rejection
 * notice so a normal Hero press does not suppress it.
 */
function warnUnconfigurable(key) {
  if (!configuredVariants().includes(key)) return;
  if (warnedVariants.has(`cfg:${key}`)) return;
  warnedVariants.add(`cfg:${key}`);
  console.warn(
    `[ORI_PRESS] ORI_PRESS_VARIANTS names "${key}", which the bot is not ` +
      `permitted to dial — ignoring it. Allowed: ${[...DIALABLE_VARIANTS].join(", ")}. ` +
      `Adding one is a code change in lib/oriVoiceDispatch.js, not a variable.`
  );
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

/**
 * The two gates that are not about this caller.
 *
 * Every press on this webhook passes through here — 6,047 herofincorp against
 * 692 businessloans on 02 Sep — and these two reject most of them for reasons
 * that are the same every time. They are deliberately checked BEFORE the kill
 * switch and are the only outcomes not written to crm.voice_dispatch: a row per
 * Hero press saying "not a Business Loans press-1" would be ~6,000 a day of a
 * fact the IVR leads book already states by existing.
 *
 * The kill switch used to be first. Moving it below these two is what makes a
 * recorded decision mean something: "disabled" now says a press we WOULD have
 * dialled was stopped by the switch, which is the number the screen needs.
 * It also means a mis-pointed panel still logs its variant warning while the
 * dispatch is off, instead of going silent for two separate reasons at once.
 */
async function placeCall(body, { digit, variant } = {}) {
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

  // From here on this IS a Business Loans press-1, so every outcome is a fact
  // about a lead on the IVR leads screen and gets written down.
  const outcome = await decideAndDial(body, { digit, variant });

  // Awaited, not floated. Nothing user-facing is waiting: the route never
  // awaits dispatchPressToVoiceBot, so the customer's WhatsApp has already
  // gone. Awaiting here instead makes the write ordered and testable, and
  // recordVoiceDispatch is contractually unable to reject — a database that is
  // down must not undo a call that already rang a real phone.
  await recordVoiceDispatch({
    mobile: body.mobile,
    dispatched: outcome.dialled,
    reason: outcome.dialled ? null : outcome.reason,
    variant: variant ?? null,
    digit: digit ?? null,
    providerCampaignId: outcome.campaignId ?? null,
    uniqueId: body.unique_id || body.call_id || null,
    raw: {
      ivr_campaign_id: body.campaign_id ?? null,
      ivr_campaign_name: body.campaign_name ?? null,
      // The qualification verdict, recorded whether or not it was allowed to
      // act. In shadow mode this is the ONLY trace of it, and the whole point:
      // it is what the enforced rate can be measured from before anyone flips
      // IVR_QUALIFY_ENFORCE and loses calls.
      qualify_enforced: qualifyEnforcing(),
      qualification: outcome.verdict ?? null,
    },
  });

  return outcome;
}

async function decideAndDial(body, { variant } = {}) {
  if (String(process.env.ORI_PRESS_DISPATCH || "1").trim() === "0") {
    return { dialled: false, reason: "disabled" };
  }

  const mobile = toE164(body.mobile);
  if (!mobile) {
    console.warn(`[ORI_PRESS] Not a dialable number: "${body.mobile}" — no call placed`);
    return { dialled: false, reason: "bad_mobile" };
  }

  // Enrichment, before the dedupe: the verdict is wanted on every press, and a
  // repeat press must not come back "unknown" just because the first one used
  // up the key. Never throws; an unreachable lookup returns unknown and passes.
  const verdict = await qualifyLead(body.mobile);
  const { dial, reason: refusal } = decideFromVerdict(verdict);
  if (!dial) {
    console.log(
      `[ORI_PRESS] ${mobile} does not qualify (enriched=${verdict.enriched}) — no call placed`
    );
    return { dialled: false, reason: refusal, verdict };
  }

  const key = dialKey(body, variant);
  if (alreadyDialled(key)) {
    console.log(`[ORI_PRESS] Already dialled (${key}) — not calling again`);
    return { dialled: false, reason: "duplicate", verdict };
  }

  const ori = voiceClient();
  if (!ori) return { dialled: false, reason: "no_client", verdict };

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
      return { dialled: false, reason: "refused", verdict };
    }

    console.log(
      `[ORI_PRESS] Voice bot dialled ${mobile} variant=${variant || "-"} ` +
        `campaign=${result.campaign_id || "-"} key=${key}`
    );
    return { dialled: true, campaignId: result.campaign_id ?? null, verdict };
  } catch (error) {
    console.error(`[ORI_PRESS] Call failed for ${mobile}: ${error?.message ?? error}`);
    dialled.delete(key);
    return { dialled: false, reason: "error", verdict };
  }
}

export default dispatchPressToVoiceBot;
