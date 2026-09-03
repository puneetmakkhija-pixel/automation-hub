import SupabaseClient from "./supabaseClient.js";

/**
 * The voice-bot dispatch decision, written down.
 *
 * oriVoiceDispatch.js decides, per press, whether to hand the caller to the ORI
 * voice bot — and until now that decision existed only as a log line. The CRM
 * could see crm.voice_call_events, which the PROVIDER writes when a call has
 * happened, and nothing else. So the IVR leads screen showed "Voice bot called:
 * 0" and could not distinguish:
 *
 *   the dispatch never ran (ORI_PRESS_DISPATCH=0)
 *   it ran and Oriserve refused
 *   it ran, Oriserve accepted, and the callback has not arrived
 *
 * Three different problems, one blank cell. This writes the first half of the
 * pair into crm.voice_dispatch so the screen can tell them apart.
 *
 * ── The same rule as everything else on this path ─────────────────────────
 *
 * The IVR panel is waiting on the webhook response and the customer is about to
 * get a WhatsApp. So this is fire-and-forget, is never awaited by the route,
 * and nothing in it may reject: an unhandled rejection on a floating promise
 * takes the process down for every lender on this webhook. Every failure is a
 * log line and nothing more — a dispatch that rang a real phone must not be
 * undone because a database write failed.
 *
 * ── Only what it was actually asked to dial ───────────────────────────────
 *
 * oriVoiceDispatch rejects most presses on variant or digit before doing
 * anything: 6,047 herofincorp presses against 692 businessloans on 02 Sep.
 * Recording those would be ~6,000 rows a day saying "not a Business Loans
 * press-1", which is what the IVR leads book already means by existing. So the
 * caller records only presses that reached the dispatch decision proper, and
 * `reason` says what stopped it from there.
 *
 * Environment: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, the same pair the
 * rest of this service uses. They resolve to the smecircle project, which is
 * the CRM database — not the one a Railway project called "Automation Hub"
 * suggests. See lib/supabaseClient.js.
 */

let client = null;
let unavailable = false;
let warnedUnavailable = false;

/** Built lazily: the constructor throws without credentials, and that must not throw here. */
function db() {
  if (client) return client;
  if (unavailable) return null;
  try {
    client = new SupabaseClient();
    return client;
  } catch (error) {
    unavailable = true;
    if (!warnedUnavailable) {
      warnedUnavailable = true;
      console.warn(
        `[ORI_PRESS] Cannot record dispatch decisions (${error.message}) — calls are ` +
          "still being placed, but the CRM's IVR leads screen will show them as " +
          '"no dispatch record". Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.'
      );
    }
    return null;
  }
}

/** Test seam: the client and the once-per-process warning are module state. */
export function _resetDispatchLog() {
  client = null;
  unavailable = false;
  warnedUnavailable = false;
}

/** Ten digits, or null. crm.voice_dispatch.mobile10 has a CHECK that says so. */
export function mobile10Of(raw) {
  const digits = String(raw ?? "").replace(/\D/g, "");
  const ten = digits.length > 10 ? digits.slice(-10) : digits;
  return ten.length === 10 ? ten : null;
}

/**
 * Record one dispatch decision. Never throws, never rejects.
 *
 * @param {object} args
 * @param {string} args.mobile      the caller, in whatever shape the panel sent
 * @param {boolean} args.dispatched did the provider accept the call
 * @param {string|null} [args.reason] why not, when it did not. Required by the
 *   table when dispatched is false, so a missing one is filled in rather than
 *   sent as null and rejected by the CHECK constraint.
 * @param {string|null} [args.variant]
 * @param {string|null} [args.digit]
 * @param {string|null} [args.providerCampaignId]
 * @param {string|null} [args.uniqueId]
 * @param {object} [args.raw]
 * @returns {Promise<{recorded: boolean, reason?: string}>} always resolves.
 */
export async function recordVoiceDispatch({
  mobile,
  dispatched,
  reason = null,
  variant = null,
  digit = null,
  providerCampaignId = null,
  uniqueId = null,
  raw = {},
} = {}) {
  try {
    const mobile10 = mobile10Of(mobile);
    if (!mobile10) {
      // Deliberately not an error. A dispatch can legitimately be refused FOR
      // an unusable number — reason 'bad_mobile' — and there is no ten-digit
      // key to file that under. The log line is the record in that case.
      return { recorded: false, reason: "no_mobile10" };
    }

    const sb = db();
    if (!sb) return { recorded: false, reason: "no_client" };

    const { error } = await sb.client
      .schema("crm")
      .from("voice_dispatch")
      .insert({
        mobile10,
        provider: "oriserve",
        variant: variant ?? null,
        digit: digit == null ? null : String(digit),
        dispatched: Boolean(dispatched),
        // The CHECK constraint refuses a not-dispatched row with no reason, and
        // a row that fails to insert is worse than one that says "unspecified":
        // the screen would read "no dispatch record", which means something
        // else entirely.
        reason: dispatched ? null : reason || "unspecified",
        provider_campaign_id: providerCampaignId ?? null,
        unique_id: uniqueId ?? null,
        raw: raw ?? {},
      });

    if (error) throw new Error(error.message);
    return { recorded: true };
  } catch (error) {
    console.error(`[ORI_PRESS] Could not record dispatch: ${error?.message ?? error}`);
    return { recorded: false, reason: "write_failed" };
  }
}

export default recordVoiceDispatch;
