import SupabaseClient from "./supabaseClient.js";

/**
 * Does this caller qualify for the business-loan voice bot?
 *
 * The policy, decided 05 Sep 2026: stop deciding by which IVR someone pressed
 * on, and decide by what enrichment says about them. Enrich first, then dial
 * anyone meeting ANY ONE of five conditions -- ABB over 50,000, bureau over
 * 720, banking turnover over 75 lakh, GST turnover at or above 40 lakh, or a
 * running business loan over 10 lakh. A Poonawalla personal-loan press that
 * clears any of those bars is a business-loan lead and gets the call.
 *
 * The rule itself lives in crm.ivr_lead_qualifies() -- six tables across two
 * schemas, and thresholds that are credit policy rather than plumbing. This
 * module is only the caller.
 *
 * ── Read this before turning enforcement on ───────────────────────────────
 *
 * Measured against 5,459 real press-1s from 04-05 Sep 2026:
 *
 *              press-1   in any enrichment source   qualifies
 *   businessloans 1,719          451 (26%)            398
 *   poonawalla    3,614          125 (3.5%)            98
 *   herofincorp     126            9 (7%)               8
 *
 * Only 10.7% of callers exist in ANY enrichment source. Among those that do,
 * 88% qualify. So this gate is mostly a coverage test wearing a credit test's
 * clothes: it does not separate good leads from bad, it separates leads we have
 * data on from leads we do not.
 *
 * Enforcing it drops dialling from 1,719 to 504 across those two days -- a 71%
 * cut, and 77% on Business Loans alone. That is why IVR_QUALIFY_ENFORCE exists
 * and defaults to OFF: shadow mode records the verdict for every press and
 * changes nothing, so the real rate can be watched for a day before anyone
 * loses a call. Flip it only once those numbers are understood.
 *
 * ── Same rule as everything else on this path ─────────────────────────────
 *
 * Never throws, never rejects. A press is a customer waiting on a WhatsApp, and
 * an enrichment lookup that fails must not take the process down or silently
 * cancel a call. On any failure this returns `unknown`, and an unknown is
 * treated as a PASS -- a database blip must not become a day of missed calls.
 *
 * Environment:
 *   IVR_QUALIFY_ENFORCE=1  actually gate on the verdict. Default 0 (shadow).
 *   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY  as everywhere else here.
 */

let client = null;
let unavailable = false;
let warnedUnavailable = false;

/** Built lazily: the constructor throws without credentials, which must not throw here. */
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
        `[IVR_QUALIFY] Cannot reach enrichment (${error.message}) — every press ` +
          "will be treated as unknown, which passes. Set SUPABASE_URL and " +
          "SUPABASE_SERVICE_ROLE_KEY."
      );
    }
    return null;
  }
}

/**
 * The enrichment lookup itself, behind a swappable reference.
 *
 * A test has to be able to say "this caller qualifies" without a database, and
 * the gate is the part worth testing. Only _setLookup replaces it.
 */
async function rpcLookup(mobile10) {
  const sb = db();
  if (!sb) return { error: "no_client" };
  const { data, error } = await sb.client
    .schema("crm")
    .rpc("ivr_lead_qualifies", { p_mobile10: mobile10 });
  if (error) throw new Error(error.message);
  return { data };
}

let lookup = rpcLookup;

/** Test seam: swap the enrichment lookup. Pass nothing to restore the real one. */
export function _setLookup(fn) {
  lookup = fn || rpcLookup;
}

/** Test seam: the client and the once-per-process warning are module state. */
export function _resetQualification() {
  client = null;
  unavailable = false;
  warnedUnavailable = false;
  lookup = rpcLookup;
}

/** Is the verdict allowed to stop a call, or only to be recorded? */
export function enforcing() {
  return String(process.env.IVR_QUALIFY_ENFORCE || "0").trim() === "1";
}

/** Ten digits, or null — the only shape crm.ivr_lead_qualifies can answer for. */
function mobile10Of(raw) {
  const digits = String(raw ?? "").replace(/\D/g, "");
  const ten = digits.length > 10 ? digits.slice(-10) : digits;
  return ten.length === 10 ? ten : null;
}

/**
 * Ask enrichment about one caller. Never throws, never rejects.
 *
 * @param {string} mobile the caller, in whatever shape the panel sent
 * @returns {Promise<{qualifies: boolean|null, enriched: boolean, reasons: string[],
 *                    facts: object, status: string}>}
 *   `qualifies` is null when we could not find out. `status` is one of
 *   "qualified", "not_qualified", "no_mobile10", "no_client", "lookup_failed".
 */
export async function qualifyLead(mobile) {
  const unknown = (status) => ({
    qualifies: null,
    enriched: false,
    reasons: [],
    facts: {},
    status,
  });

  try {
    const mobile10 = mobile10Of(mobile);
    if (!mobile10) return unknown("no_mobile10");

    const { data, error } = await lookup(mobile10);
    if (error === "no_client") return unknown("no_client");
    if (error) throw new Error(String(error));
    if (!data || typeof data !== "object") return unknown("lookup_failed");

    const qualifies = Boolean(data.qualifies);
    return {
      qualifies,
      enriched: Boolean(data.enriched),
      reasons: Array.isArray(data.reasons) ? data.reasons : [],
      facts: data.facts && typeof data.facts === "object" ? data.facts : {},
      status: qualifies ? "qualified" : "not_qualified",
    };
  } catch (error) {
    console.error(`[IVR_QUALIFY] Lookup failed: ${error?.message ?? error}`);
    return unknown("lookup_failed");
  }
}

/**
 * Turn a verdict into a decision.
 *
 * An unknown passes. Enrichment being unreachable is our problem, not the
 * caller's, and the cost of wrongly dialling someone is one call while the cost
 * of wrongly refusing is a lead nobody ever rings.
 *
 * @returns {{dial: boolean, reason: string|null}}
 */
export function decideFromVerdict(verdict) {
  if (!enforcing()) return { dial: true, reason: null };
  if (verdict?.qualifies === true) return { dial: true, reason: null };
  if (verdict?.qualifies === false) return { dial: false, reason: "not_qualified" };
  return { dial: true, reason: null };
}

export default qualifyLead;
