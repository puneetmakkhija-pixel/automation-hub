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
 * Measured against 5,459 real press-1s from 04-05 Sep 2026, resolved against
 * fed.sme_user_master (4,312,739 rows, one per mobile, regenerated daily) over
 * the db_bases postgres_fdw link:
 *
 *                 press-1   covered         qualifies
 *   businessloans   1,719   1,718 (99.9%)   1,350 (79%)
 *   poonawalla      3,614   2,226 (61.6%)   1,412 (39%)
 *   herofincorp       126     125 (99.2%)     106 (84%)
 *   total           5,459   4,069 (74.5%)   2,868
 *
 * Enforcing does NOT cut dialling. It takes it from 1,719 to 2,868: it keeps
 * 79% of Business Loans and adds 1,518 qualified Hero and Poonawalla leads
 * nobody is calling today. Enforcement still defaults to OFF, because a 67%
 * rise in paid outbound calls is not something to switch on without somebody
 * deciding to -- shadow records a verdict per press and changes nothing.
 *
 * Two earlier readings of this were wrong, both because of where they looked:
 * the first measured 10.7% coverage and predicted a 71% CUT, having read the
 * small local extracts (exp_se_report, 131,925 rows) instead of the real base
 * in the other Supabase project. The second read fed.se_base beside the master;
 * se_base turns out to be a strict subset -- 19,953 of 19,953 sampled mobiles
 * are in the master, and 0 press-1s were in se_base but not the master -- and
 * it cannot answer condition 5 at all, because tradeline_details lives only on
 * the master.
 *
 * ── It costs about two and a half seconds ─────────────────────────────────
 *
 * ~2.6s per verdict, essentially all of it FDW connection setup rather than the
 * lookup, which hits a primary key. Dropping the second table took it from
 * ~2.9s to ~2.6s and no further: the cost is per CONNECTION, not per table, so
 * reading fewer tables barely helps. That is affordable only because this path
 * is fire-and-forget -- the route never awaits the dispatch, so the customer's
 * WhatsApp has already gone.
 *
 * The real fix is a local materialised copy of the six columns, refreshed on
 * the same daily cadence the master is rebuilt on. That makes it
 * sub-millisecond and takes a cross-project dependency out of a webhook. Not
 * done yet.
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
