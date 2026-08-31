import axios from "axios";

/**
 * A pre-verified application link for one mobile number.
 *
 * The CRM mints these at POST /api/portal/sso-link and the customer lands on
 * /apply?t=<token> already past OTP. That endpoint exists for exactly this —
 * its own documentation says "for WhatsApp nudge campaigns (e.g. Ananta) where
 * the recipient's mobile is already known" — and it does not require the number
 * to be a lead yet: the lead lookup inside it only supplies a greeting name and
 * is explicitly never fatal.
 *
 * THE TOKEN IS A BEARER CREDENTIAL. Whoever holds the URL is that customer for
 * as long as it lives, so the CRM clamps every token to 30 minutes and no
 * caller can ask for longer. That suits this flow better than most: the message
 * goes out seconds after the caller pressed 1, while they are still engaged. A
 * customer who opens it late gets an "expired" screen with a resend button
 * rather than a dead end (/api/apply/resend-link takes the expired token as the
 * credential for asking).
 *
 * Config:
 *   CRM_BASE_URL    default https://crmbusinessloans.com
 *   CRM_SSO_SECRET  the CRM's CRON_SECRET or SYNC_SECRET
 */

let warnedNoSecret = false;

export function applyBaseUrl() {
  return (process.env.CRM_BASE_URL || "https://crmbusinessloans.com").replace(/\/+$/, "");
}

/** Where a customer goes when we could not mint a token: the ordinary form. */
export function plainApplyUrl() {
  return `${applyBaseUrl()}/apply`;
}

/**
 * Has this number ever completed an OTP?
 *
 * The gate on pre-verification. A first-time caller must do the OTP: it is what
 * creates the consent record the bureau pull reads, and an "existing_user"
 * session for someone with no case is a confusing place to land. createSsoToken
 * does not check this — it mints for any valid 10-digit mobile — so the check
 * belongs here, at the only caller that reaches brand-new numbers.
 *
 * Conservative on failure: anything other than a confirmed prior verification
 * means no SSO link. Sending a known customer through OTP again is friction;
 * sending an unknown one past it is the mistake that matters.
 */
async function hasVerifiedBefore(dbClient, mobile) {
  if (!dbClient) return false;
  try {
    const { data, error } = await dbClient
      .from("portal_otp_sessions")
      .select("id")
      .eq("mobile", mobile)
      .not("verified_at", "is", null)
      .limit(1);

    if (error) {
      console.error(`[IVR_WA] OTP-history lookup failed: ${error.message} — no SSO link`);
      return false;
    }
    return Array.isArray(data) && data.length > 0;
  } catch (error) {
    console.error(`[IVR_WA] OTP-history lookup threw: ${error.message} — no SSO link`);
    return false;
  }
}

/**
 * @param {string} rawMobile
 * @param {object|null} dbClient supabase-js client, for the pre-verification check
 * @returns {Promise<{url: string, minted: boolean, expiresAt: string|null, reason: string}>}
 *
 * ALWAYS resolves to a usable URL. Every failure — no secret, a timeout, a 401,
 * a malformed reply, a first-time caller — falls back to the plain /apply link,
 * which still works, just with an OTP step. A customer sent to the form is a
 * worse experience; a customer sent nothing because the CRM was slow is a lost
 * lead. The WhatsApp send must never depend on this call succeeding.
 */
export async function resolveSsoLink(rawMobile, dbClient = null) {
  const fallback = (reason) => ({
    url: plainApplyUrl(),
    minted: false,
    expiresAt: null,
    reason,
  });

  const secret = (process.env.CRM_SSO_SECRET || "").trim();
  if (!secret) {
    if (!warnedNoSecret) {
      console.warn(
        "[IVR_WA] CRM_SSO_SECRET is not set — sending the plain /apply link, so " +
          "customers will be asked for an OTP. Set it to the CRM's CRON_SECRET " +
          "or SYNC_SECRET to send pre-verified links."
      );
      warnedNoSecret = true;
    }
    return fallback("no_secret");
  }

  const mobile = String(rawMobile || "").replace(/\D/g, "").slice(-10);
  if (mobile.length !== 10) return fallback("bad_mobile");

  // First-time caller: send them to the form so they complete the OTP.
  if (!(await hasVerifiedBefore(dbClient, mobile))) {
    return fallback("never_verified");
  }

  try {
    // Short timeout: this sits in front of the Ananta call on the webhook's
    // critical path, and the IVR panel is waiting on the response.
    const r = await axios.post(
      `${applyBaseUrl()}/api/portal/sso-link`,
      { mobile, source: "ivr_keypress", created_by: "ivr-router" },
      {
        headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
        timeout: 4000,
      }
    );

    if (r.data?.ok && typeof r.data.url === "string" && r.data.url) {
      return {
        url: r.data.url,
        minted: true,
        expiresAt: r.data.expires_at ?? null,
        reason: "minted",
      };
    }
    console.error(
      `[IVR_WA] SSO mint refused for ${mobile}: ${r.data?.error ?? "no url in reply"} — ` +
        "sending the plain apply link"
    );
    return fallback("refused");
  } catch (error) {
    const detail = error.response?.data?.error ?? error.message;
    console.error(
      `[IVR_WA] SSO mint failed for ${mobile} (${detail}) — sending the plain apply link`
    );
    return fallback("error");
  }
}

export default resolveSsoLink;
