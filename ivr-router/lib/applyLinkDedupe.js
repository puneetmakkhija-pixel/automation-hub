import { applyBaseUrl } from "./crmSsoLink.js";

/**
 * One /apply link per caller per window, not one per press.
 *
 * A caller who presses 1 on Monday's campaign and again on Monday evening's got
 * the same application link twice, minutes or hours apart, from the same
 * sender — plus whatever the CRM's own follow-ups send. The second copy adds
 * nothing they can act on, costs a paid template, and a stream of identical
 * links is what gets a sender reported. So a press-1 whose link would be our
 * /apply is not sent when public.whatsapp_messages already shows one sent (or
 * delivered) to that mobile inside APPLY_LINK_DEDUPE_HOURS.
 *
 * The PRESS is still written down. The BL leads page and crm.v_ivr_lead count
 * presses from whatsapp_messages rows with metadata.digit = '1', whatever their
 * status, so the route writes a row for the skipped press with status
 * 'skipped_duplicate'. Leaving it out would make a repeat press vanish from the
 * funnel exactly as if the customer had not pressed at all.
 *
 * Scoped to OUR /apply links on purpose. A Hero or Poonawalla press sends that
 * lender's journey URL, which is a different message, and a customer who got
 * our link yesterday has not thereby got theirs.
 *
 * Fails OPEN, like sentPreviously(): an unreadable send log means the message
 * goes. A rare duplicate beats a caller who pressed 1 and got nothing.
 */

const DEFAULT_HOURS = 24;

/** Hours to look back. 0 turns the dedupe off; anything unparseable is the default. */
export function applyDedupeHours(env = process.env) {
  const raw = String(env.APPLY_LINK_DEDUPE_HOURS ?? "").trim();
  if (!raw) return DEFAULT_HOURS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_HOURS;
}

/** Our /apply, minted (?t=) or plain, on the CRM's host. */
export function isApplyLink(value) {
  let url;
  let base;
  try {
    url = new URL(String(value ?? ""));
    base = new URL(applyBaseUrl());
  } catch {
    return false;
  }
  return (
    url.hostname.toLowerCase() === base.hostname.toLowerCase() &&
    url.pathname.replace(/\/+$/, "") === "/apply"
  );
}

/**
 * The most recent /apply link this mobile was sent inside the window, or null.
 *
 * @param {object|null} client a supabase-js client on the public schema
 * @param {string} mobile the phone as the send log stores it (ten digits, or
 *   +91 when ANANTA_PHONE_FORMAT=e164) — all three shapes are matched
 * @returns {Promise<{id: any, link: string, at: string}|null>} never rejects
 */
export async function recentApplyLink(client, mobile, { hours = applyDedupeHours(), now = Date.now() } = {}) {
  if (!client || !(hours > 0)) return null;
  const digits = String(mobile ?? "").replace(/\D/g, "");
  const ten = digits.slice(-10);
  if (ten.length !== 10) return null;

  try {
    const { data, error } = await client
      .from("whatsapp_messages")
      .select("id, created_at, metadata")
      .eq("direction", "outbound")
      .in("phone_number", [ten, `+91${ten}`, `91${ten}`])
      .eq("metadata->>digit", "1")
      .in("metadata->>status", ["sent", "delivered"])
      .gte("created_at", new Date(now - hours * 3600 * 1000).toISOString())
      .order("created_at", { ascending: false })
      .limit(20);

    if (error) {
      console.error(`[IVR_WA] Apply-link dedupe lookup failed, sending anyway: ${error.message}`);
      return null;
    }
    // The link filter is here rather than in SQL: "our /apply on the CRM's
    // host" is a URL comparison, and a LIKE would also match a lender URL that
    // happens to carry /apply in its own path.
    const hit = (data ?? []).find((r) => isApplyLink(r.metadata?.link));
    return hit ? { id: hit.id ?? null, link: hit.metadata.link, at: hit.created_at } : null;
  } catch (error) {
    console.error(`[IVR_WA] Apply-link dedupe lookup threw, sending anyway: ${error?.message ?? error}`);
    return null;
  }
}
