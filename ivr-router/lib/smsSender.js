/**
 * The second pipe for a press-1 link.
 *
 * WhatsApp is one vendor, one template, and one Meta quality score away from
 * silence. On 16 Sep Meta paused the press-1 template for low quality and 724
 * people who pressed 1 got nothing for a day and a half -- the calls were paid
 * for, the intent was real, and the only thing missing was a way to deliver a
 * URL. It was the fifth pause of that message type; the standby list in #108
 * shortens an outage but still needs a template Meta will accept.
 *
 * SMS has no template quality score to lose and no Meta in the path. It is a
 * worse channel for click-through and a far better one for arriving.
 *
 * MSG91 because the CRM already sends through it (dsa-business-crm
 * lib/sms/send.ts) -- same account, same sender id, no new vendor.
 *
 * NOT the OTP endpoint that file uses. /api/v5/otp only carries a code; a link
 * needs the flow API and a DLT-registered template, which Indian transactional
 * SMS requires by law. Without that template id this sends nothing and says so,
 * rather than failing per caller.
 */

const MSG91_FLOW_URL = process.env.MSG91_FLOW_URL || "https://control.msg91.com/api/v5/flow/";

/**
 * "always" | "fallback" | "off".
 *
 * Defaults to "fallback": SMS goes only when WhatsApp did not, which is the
 * cheap reading of "both". "always" sends both every time -- more reliable,
 * and it doubles the per-lead messaging cost, so it is a decision an operator
 * makes rather than one this file makes for them.
 */
export function smsMode() {
  const raw = String(process.env.IVR_SMS_MODE || "fallback").trim().toLowerCase();
  return ["always", "fallback", "off"].includes(raw) ? raw : "fallback";
}

export function smsConfigured() {
  return Boolean(
    (process.env.MSG91_AUTH_KEY || "").trim() &&
      (process.env.MSG91_PRESS1_TEMPLATE_ID || "").trim()
  );
}

/**
 * Should SMS go, given what WhatsApp did?
 *
 * Separated from the sending so the decision is testable without a network,
 * and so the route reads as one line.
 */
export function shouldSendSms(whatsappSent) {
  if (!smsConfigured()) return false;
  const mode = smsMode();
  if (mode === "off") return false;
  if (mode === "always") return true;
  return whatsappSent !== true;
}

/**
 * Send the press-1 link by SMS.
 *
 * Never throws. The webhook's job is to answer the IVR panel; a failed second
 * channel must not turn a delivered WhatsApp into an error, and must not fail
 * the request when it was the only channel either.
 */
export async function sendPressSms({ mobile10, link, fetchImpl = fetch } = {}) {
  const authKey = (process.env.MSG91_AUTH_KEY || "").trim();
  const templateId = (process.env.MSG91_PRESS1_TEMPLATE_ID || "").trim();
  if (!authKey || !templateId) {
    return { ok: false, skipped: "not_configured" };
  }

  const mobile = String(mobile10 || "").replace(/\D/g, "").slice(-10);
  if (mobile.length !== 10) return { ok: false, skipped: "bad_mobile" };
  if (!link) return { ok: false, skipped: "no_link" };

  // The DLT template's variable. MSG91 matches recipient keys to the template's
  // ##VAR## names case-insensitively; LINK is the one this template declares.
  const body = {
    template_id: templateId,
    short_url: String(process.env.MSG91_SHORT_URL || "1"),
    recipients: [{ mobiles: `91${mobile}`, LINK: link }],
  };
  const sender = (process.env.MSG91_SENDER_ID || "").trim();
  if (sender) body.sender = sender;

  try {
    const res = await fetchImpl(MSG91_FLOW_URL, {
      method: "POST",
      headers: { authkey: authKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      // Shorter than the WhatsApp call: this runs beside it, and the IVR panel
      // is waiting on the response to both.
      signal: AbortSignal.timeout(6000),
    });

    const text = await res.text().catch(() => "");
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // MSG91 answers HTML on some errors. Keep the bytes; do not throw on them.
    }

    // MSG91 returns HTTP 200 with {"type":"error"} on a rejected send, which is
    // the same trap the OBD client hit: a 2xx is necessary and not sufficient.
    const said = parsed?.type === "error" || parsed?.message === "error";
    if (!res.ok || said) {
      return {
        ok: false,
        error: `HTTP ${res.status}${text ? ` — ${text.slice(0, 200)}` : ""}`,
      };
    }

    return { ok: true, messageId: parsed?.request_id ?? parsed?.message ?? null };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
}

export default sendPressSms;
