/**
 * The alias, carried on the apply link we send a press-1 caller.
 *
 * ── Why ───────────────────────────────────────────────────────────────────
 *
 * A press-1 lead that lands in a lender's own journey leaves our systems
 * entirely. The only way it comes back is if the lender echoes something we
 * put on the link into the MIS file they send us. On 10 Sep 2026 that reached
 * 111 of 15,003 press-1 leads — 0.74%:
 *
 *   poonawalla    8,754 press-1    63 matched   (sub_id1=alias_… on the link)
 *   herofincorp   6,249 press-1    48 matched   (their own cuid, not ours)
 *
 * The 63 are the whole proof that this works: every one of them was matched by
 * decoding an alias out of Poonawalla's MIS. They stop at 63 only because the
 * links carrying it went out on 03-04 Sep and not since.
 *
 * The other two destinations carry nothing:
 *
 *   businessloans   https://crmbusinessloans.com/apply      (bare, no query at all)
 *   herofincorp     https://loans.apps.herofincorp.com/...  (AppsFlyer, no alias)
 *
 * This puts the alias on every outgoing link instead of relying on whoever
 * edits IVR_LINK_* to remember it. The Oriserve callback token is configured
 * the same way and for the same reason — see oriserveVoiceClient.callbackUrl:
 * two settings that had to agree by hand is how that one broke for 951 calls.
 *
 * ── One parameter name per destination ────────────────────────────────────
 *
 * A single hardcoded name would work for at most one lender, because each
 * destination passes through a different one:
 *
 *   whistleloop   sub_id1   the affiliate sub-ID. PROVEN: this is the one the
 *                           63 matched Poonawalla leads came back on.
 *   AppsFlyer     af_sub1   OneLink's pass-through slot. Hero's link is an
 *                           AppsFlyer OneLink (af_xp, af_android_url, pid).
 *                           An unknown parameter on one of those is dropped
 *                           before the advertiser ever sees it, so sub_id1
 *                           there would be silently useless.
 *   ours          alias     crmbusinessloans.com is our own apply page.
 *
 * WHETHER THE LENDER ECHOES IT BACK IS THEIR BEHAVIOUR, NOT OURS. sub_id1 is
 * demonstrated. af_sub1 is the documented AppsFlyer slot and the best available
 * guess for Hero — it is NOT yet demonstrated end to end, and will only be once
 * a Hero MIS row comes back carrying one. Until then Hero attribution still
 * rests on their cuid.
 *
 * ── Deliberately conservative ─────────────────────────────────────────────
 *
 * The value of this is measurement. The cost of getting it wrong is a customer
 * handed a link their phone will not open, or a lender journey that refuses a
 * parameter it did not expect. So it only ever ADDS a parameter to a URL it
 * could parse, never rewrites one, never touches a link that already carries an
 * alias, and returns the input unchanged on anything it does not understand.
 */

/** The literal prefix crm.mis_alias() scans for: alias_([0-9a-zA-Z]{7}). */
const ALIAS_PREFIX = "alias_";

/** Hosts whose links are AppsFlyer OneLinks, which only pass af_sub1..af_sub5. */
const APPSFLYER_MARKERS = ["af_xp", "af_android_url", "af_ios_url", "af_reengagement_window"];

/**
 * Which query parameter this destination will carry through.
 *
 * IVR_ALIAS_PARAM forces one name everywhere, for a destination that wants
 * something else and cannot wait for a deploy.
 */
export function aliasParamFor(url) {
  const forced = (process.env.IVR_ALIAS_PARAM || "").trim();
  if (forced) return forced;

  const host = url.hostname.toLowerCase();
  if (host === "whistleloop.com" || host.endsWith(".whistleloop.com")) return "sub_id1";

  // Detected by the AppsFlyer parameters already on the URL rather than by
  // hostname: OneLinks are served from the advertiser's own domain (Hero's is
  // loans.apps.herofincorp.com), so there is no appsflyer.com to match on.
  const query = url.search.toLowerCase();
  if (APPSFLYER_MARKERS.some((marker) => query.includes(marker))) return "af_sub1";

  return "alias";
}

/**
 * Put the alias on one URL. Never throws.
 *
 * @param {string} link  the URL as configured
 * @param {string} alias 7-char alias from aliasFor(), or "" when unavailable
 * @returns {string} the URL with the alias, or the input unchanged
 */
export function withAlias(link, alias) {
  const raw = String(link ?? "");
  const tag = String(alias ?? "").trim();

  // aliasFor() returns "" for anything that is not a ten-digit mobile. Sending
  // "alias_" with nothing after it would be worse than sending nothing: it
  // matches no decode and looks like a lost value rather than an absent one.
  if (!tag) return raw;

  // Already carries one — the whistleloop links have done so since 03 Sep.
  // A second alias on the same URL is how you get two different answers for
  // one lead.
  if (raw.includes(ALIAS_PREFIX)) return raw;

  let url;
  try {
    url = new URL(raw);
  } catch {
    // Not a URL. Placeholders carry names and amounts too; those are not links
    // and are none of this function's business.
    return raw;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return raw;

  try {
    const param = aliasParamFor(url);

    // Someone who already put a value there meant it. Do not second-guess —
    // same rule as an existing ?token= on the Oriserve callback URL.
    if (url.searchParams.has(param) && url.searchParams.get(param)) return raw;

    url.searchParams.set(param, `${ALIAS_PREFIX}${tag}`);
    return url.toString();
  } catch (error) {
    console.warn(`[IVR_WA] Could not put the alias on a link: ${error?.message ?? error}`);
    return raw;
  }
}

/**
 * Apply withAlias to every http(s) URL in a placeholder list.
 *
 * Every element, not just the last: rawPlaceholders() puts the link last only
 * when it came from IVR_LINK_*, and the other two configuration paths can put
 * it anywhere in the template. Non-URL placeholders come back untouched.
 */
export function addAliasToLinks(placeholders, alias) {
  if (!Array.isArray(placeholders)) return placeholders;
  return placeholders.map((value) => withAlias(value, alias));
}

export default withAlias;
