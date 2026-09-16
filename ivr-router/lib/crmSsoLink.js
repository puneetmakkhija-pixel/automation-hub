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
 * Should a first-time caller still be sent through the OTP form?
 *
 * Default NO. This is the one switch that turns the press-1 apply link back
 * into an OTP-gated one; it exists so the change can be reverted from the
 * Railway dashboard rather than by a deploy.
 */
function requirePriorOtp() {
  return String(process.env.IVR_SSO_REQUIRE_PRIOR_OTP || "0").trim() === "1";
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

  // A first-time caller used to be sent to the form to complete an OTP. That
  // rule is what emptied this funnel: in September 8,433 of 9,063 press-1
  // callers never got past the number-entry screen, and only 380 ever typed a
  // mobile at all.
  //
  // It was also protecting the wrong thing. The comment on hasVerifiedBefore
  // said this OTP "creates the consent record the bureau pull reads". It does
  // not. The bureau pull is gated on a SEPARATE OTP with purpose
  // 'bureau_consent', taken later in the chat and re-checked inside
  // /api/digitap/enrich before Experian is called. Skipping the login OTP
  // weakens no consent record.
  //
  // What the login OTP proved was possession of the number. A token delivered
  // by WhatsApp TO that number, seconds after a call FROM it, proves the same
  // thing by the same means — and the token still expires in 30 minutes, which
  // an OTP-verified session does not.
  //
  // IVR_SSO_REQUIRE_PRIOR_OTP=1 restores the old behaviour without a deploy.
  if (requirePriorOtp() && !(await hasVerifiedBefore(dbClient, mobile))) {
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

/**
 * Is this placeholder our own plain /apply link — the one that asks for an OTP?
 *
 * Matched on host and path, not on an exact string, because the configured
 * value carries query parameters (utm, and since 11 Sep the alias) and a
 * trailing slash is optional. A link that already carries ?t= is a minted one
 * and is left alone.
 */
export function isPlainApplyLink(value) {
  let url;
  try {
    url = new URL(String(value ?? ""));
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;

  let base;
  try {
    base = new URL(applyBaseUrl());
  } catch {
    return false;
  }
  if (url.hostname.toLowerCase() !== base.hostname.toLowerCase()) return false;
  if (url.pathname.replace(/\/+$/, "") !== "/apply") return false;
  return !url.searchParams.get("t");
}

/**
 * Swap every plain /apply link in a placeholder list for the pre-verified one.
 *
 * Why this is in code rather than left to IVR_LINK_*: the SSO machinery has
 * been deployed and working since August and had minted exactly ONE token for a
 * press-1 caller, because the route only asked for a link when the configured
 * template happened to contain {{sso_link}} — and the Business Loans template
 * contains a bare URL. A capability nobody has wired up is the same as one that
 * does not exist. This is the identical failure the alias had, and the same
 * remedy: decide it here, once, for every send.
 *
 * The configured link's own query string is preserved — the alias is added to
 * these placeholders immediately afterwards, and a utm tag somebody set is not
 * this function's to drop.
 */
export function upgradeApplyLinks(placeholders, ssoUrl) {
  if (!Array.isArray(placeholders)) return placeholders;
  const minted = String(ssoUrl ?? "").trim();
  if (!minted) return placeholders;

  return placeholders.map((value) => {
    if (!isPlainApplyLink(value)) return value;
    try {
      const from = new URL(String(value));
      const to = new URL(minted);
      for (const [k, v] of from.searchParams) {
        if (!to.searchParams.has(k)) to.searchParams.set(k, v);
      }
      return to.toString();
    } catch (error) {
      console.warn(`[IVR_WA] Could not upgrade an apply link: ${error?.message ?? error}`);
      return value;
    }
  });
}

export default resolveSsoLink;
