import axios from "axios";
import { applyBaseUrl } from "./crmSsoLink.js";

/**
 * The press, forwarded to the CRM, alongside the WhatsApp send.
 *
 * This webhook's original job is one hop: keypress in, WhatsApp out. Nothing
 * about the press was ever recorded outside this service's own send log, so
 * the CRM — which holds the funnel — could not see that a customer had asked
 * for a callback at all. public.ivr_campaign_events was built for exactly
 * that, with a dtmf_input column, and carried zero rows.
 *
 * POST /api/ivr/press on the CRM closes it. In one transaction it resolves the
 * campaign, logs EVERY press to ivr_campaign_events (not only a 1), and mints
 * or returns a public.bdl_leads row with source='ivr', enriched from the
 * 458,903-row dialling base. That lead is what lib/bdl-bridge/sync.ts promotes
 * into the cockpit funnel, so a press reaches a caller's screen.
 *
 * ── This must never cost a send ───────────────────────────────────────────
 *
 * The forward is fire-and-forget and is not awaited. The IVR panel is waiting
 * on this webhook's response, and the message to the customer is the part that
 * matters in the seconds after they pressed 1; a slow or down CRM must not
 * delay it, fail it, or turn this webhook non-2xx (which is how a panel starts
 * retrying, or disables the hook). So every failure here is a log line and
 * nothing more, and nothing in this module is allowed to reject: an unhandled
 * rejection from an un-awaited call would take the process down.
 *
 * ── It does not send a second message ─────────────────────────────────────
 *
 * /api/ivr/press can itself WhatsApp the apply link, which would duplicate the
 * one this route just sent. It cannot today: that send is gated on the CRM's
 * crm.app_config 'campaign_nudge_enabled', which is 'off' and fails closed, by
 * the decision that the IVR sends the link and the CRM keeps the record.
 * Turning that switch on without turning the digit's template off here is what
 * would put two identical messages on one customer's phone.
 *
 * Config:
 *   CRM_BASE_URL      default https://crmbusinessloans.com (shared with the
 *                     SSO link, so one variable moves both)
 *   CRM_PRESS_PATH    default /api/ivr/press
 *   CRM_SYNC_SECRET   the CRM's sync secret (crm.app_config 'sync_secret'),
 *                     falling back to CRM_SSO_SECRET when the two are the same
 *                     value. Re-checked inside public.ivr_press_lead, so a
 *                     wrong one writes nothing rather than writing badly.
 *   CRM_PRESS_FORWARD=0 turns the forward off without a deploy.
 */

let warnedNoSecret = false;

function pressUrl() {
  const path = process.env.CRM_PRESS_PATH || "/api/ivr/press";
  return `${applyBaseUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * @param {object} body the webhook body as received
 * @param {{digit?: string, variant?: string}} context what the route resolved
 * @returns {Promise<{forwarded: boolean, reason?: string}>} always resolves
 *
 * Not awaited by the route. Returned so a test can wait for it.
 */
export function forwardPressToCrm(body, context = {}) {
  try {
    return postPress(body || {}, context).catch((error) => {
      // Belt and braces: postPress already catches. This is here so that a
      // throw from somewhere new inside it can never become an unhandled
      // rejection on a floating promise.
      console.error(`[IVR_PRESS] Forward threw: ${error?.message ?? error}`);
      return { forwarded: false, reason: "threw" };
    });
  } catch (error) {
    console.error(`[IVR_PRESS] Forward threw synchronously: ${error?.message ?? error}`);
    return Promise.resolve({ forwarded: false, reason: "threw" });
  }
}

async function postPress(body, { digit, variant } = {}) {
  if (String(process.env.CRM_PRESS_FORWARD || "1").trim() === "0") {
    return { forwarded: false, reason: "disabled" };
  }

  // Trimmed for the same reason the Ananta key is: a value pasted into the
  // Railway editor with a trailing newline is a 401 that looks like a wrong
  // secret.
  const secret = (process.env.CRM_SYNC_SECRET || process.env.CRM_SSO_SECRET || "").trim();
  if (!secret) {
    if (!warnedNoSecret) {
      console.warn(
        "[IVR_PRESS] CRM_SYNC_SECRET is not set — presses are not being recorded in " +
          "the CRM. Set it to the CRM's sync secret to log them to " +
          "ivr_campaign_events and create the bdl_leads row."
      );
      warnedNoSecret = true;
    }
    return { forwarded: false, reason: "no_secret" };
  }

  // The CRM's reader is deliberately tolerant about field names, but it has
  // never heard of two of this gateway's:
  //
  //   dtmf_sequence — a caller who pressed through a menu arrives with only a
  //     sequence and no `dtmf`, and the reader would record a press with no
  //     digit and never make a lead. So the digit this route already resolved
  //     is sent as `dtmf`.
  //   unique_id — this gateway's call identifier, and what the send log dedupes
  //     on. Sent as `call_id` so the press and the message can be tied to the
  //     same call afterwards. Never over a call_id the body already carries.
  //
  // Everything else goes through untouched: the reader keeps what it does not
  // claim as metadata on the event row, which is how a field nobody has been
  // taught about is still answerable later.
  const payload = {
    ...body,
    ...(digit ? { dtmf: digit } : {}),
    ...(body.call_id ? {} : body.unique_id ? { call_id: body.unique_id } : {}),
    ...(variant ? { ivr_variant: variant } : {}),
    forwarded_by: "ivr-router",
  };

  try {
    const r = await axios.post(pressUrl(), payload, {
      headers: { "x-sync-secret": secret, "Content-Type": "application/json" },
      timeout: 8000,
    });

    const data = r.data ?? {};
    console.log(
      `[IVR_PRESS] Recorded digit=${digit || "-"} variant=${variant || "-"} ` +
        `created=${data.created === true} lead_ref=${data.lead_ref || "-"} ` +
        `known=${data.known_to_lookup === true}`
    );
    return { forwarded: true, created: data.created === true, leadRef: data.lead_ref ?? null };
  } catch (error) {
    const status = error.response?.status;
    const detail = error.response?.data?.error ?? error.response?.data ?? error.message;

    // 401 is the one failure that will repeat identically on every press until
    // somebody changes a variable, so it says what to change.
    if (status === 401) {
      console.error(
        `[IVR_PRESS] The CRM rejected the secret (${secret.length} chars). CRM_SYNC_SECRET ` +
          "must be the CRM's sync secret — crm.app_config 'sync_secret' — which is not " +
          "necessarily the same value as CRM_SSO_SECRET."
      );
    } else {
      console.error(`[IVR_PRESS] Forward failed (${status ?? "no response"}):`, detail);
    }
    return { forwarded: false, reason: `http_${status ?? "error"}` };
  }
}

export default forwardPressToCrm;
