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
 * ── It ran on the wrong data for two days ─────────────────────────────────
 *
 * The numbers above are a BACKTEST, run as `postgres`. In production the router
 * reaches crm.ivr_lead_qualifies() through PostgREST as `service_role`, and the
 * db_bases postgres_fdw server has a user mapping for `postgres` only. The
 * function was SECURITY INVOKER, so every read of fed.sme_user_master raised,
 * the exception handler caught it, and the verdict came from the local extracts
 * instead -- silently, because "the master had no row" and "the master could not
 * be read" both produced the same output.
 *
 * First live day (07 Sep, 706 presses) measured 29.9% enriched against the
 * backtest's 99.9% -- and 26.2% is what the local extracts alone score. Fixed by
 * making the function SECURITY DEFINER with a pinned search_path, so it runs as
 * the owner, which holds the mapping. On a re-run of the same callers: enriched
 * 3/15 -> 15/15, qualifying 2/15 -> 12/15.
 *
 * Hence `source` and `baseOk` on every verdict, and the once-per-process warning
 * below. A degradation that leaves the verdicts looking like verdicts is the
 * kind that lasts.
 *
 * ── It costs about seven hundred milliseconds ─────────────────────────────
 *
 * ~720ms per verdict on a warm connection; the ~2.6s figure quoted earlier was
 * a COLD one, measured one call per session, and is what the first press after
 * an idle period still pays. Nearly all of it is the cross-project round trip
 * rather than the lookup, which hits a primary key. Affordable only because the
 * route never awaits the dispatch.
 *
 * The real fix remains a local materialised copy of the columns this reads,
 * refreshed on the master's daily cadence: sub-millisecond, and no cross-project
 * dependency -- nor a second role that needs its own FDW mapping -- in a
 * webhook. Not done yet.
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
let warnedDegraded = false;

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
  warnedDegraded = false;
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
 * @returns {Promise<{qualifies: boolean|null, enriched: boolean, baseOk: boolean,
 *                    source: string, reasons: string[], facts: object,
 *                    status: string}>}
 *   `qualifies` is null when we could not find out. `status` is one of
 *   "qualified", "not_qualified", "no_mobile10", "no_client", "lookup_failed".
 *
 *   `source` and `baseOk` are carried through UNCHANGED from the function and
 *   recorded with every decision. They are the difference between noticing a
 *   silent degradation and not: on 07 Sep the router had been answering from
 *   the local extracts for two days because it could not reach the base, and
 *   the recorded verdicts had no field that said so. source='user_master'
 *   means the 4.3M base answered; 'local_extract_degraded' or
 *   'base_unreachable' mean the link is down and the verdict is thin.
 */
export async function qualifyLead(mobile) {
  const unknown = (status) => ({
    qualifies: null,
    enriched: false,
    baseOk: false,
    source: status,
    reasons: [],
    facts: {},
    // Nobody looked it up, so nobody knows it. Never a placeholder: the caller
    // omits the name entirely rather than have the bot say something invented.
    name: null,
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
    const baseOk = Boolean(data.base_ok);

    // Once per process. A run of presses answered without the base is a real
    // outage of the rule's inputs, and it is otherwise completely silent --
    // the verdicts still look like verdicts.
    if (!baseOk && !warnedDegraded) {
      warnedDegraded = true;
      console.warn(
        `[IVR_QUALIFY] The enrichment base is unreachable — verdicts are being ` +
          `made from the local extracts, which cover a fraction of callers. ` +
          `Check the db_bases FDW user mapping for the connecting role.`
      );
    }

    return {
      qualifies,
      enriched: Boolean(data.enriched),
      baseOk,
      source: typeof data.source === "string" ? data.source : "unknown",
      reasons: Array.isArray(data.reasons) ? data.reasons : [],
      facts: data.facts && typeof data.facts === "object" ? data.facts : {},
      // The name the bot greets them by. crm.ivr_lead_qualifies reads it out of
      // the same master row the verdict is built from, so it costs no extra
      // round trip; null when no source knows it.
      name: typeof data.name === "string" && data.name.trim() ? data.name.trim() : null,
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
