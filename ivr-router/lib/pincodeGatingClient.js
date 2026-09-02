import { createClient } from "@supabase/supabase-js";
import axios from "axios";

// The codebase spells the lender both ways ("poonawala" here and in
// lenderRoutingRoutes, "poonawalla" in breShortlistingRoutes), and lender
// webhooks send their own casing. serviceable_pincodes is keyed on the spelling
// below, so normalise before every lookup rather than missing the row.
const LENDER_TYPE_ALIASES = {
  poonawalla: "poonawala",
  poonawalafincorp: "poonawala",
  poonawallafincorp: "poonawala",
  hero: "herofincorp",
  herofincorp: "herofincorp",
  hero_fincorp: "herofincorp",
};

function normalizeLenderType(lenderType = "poonawala") {
  const key = String(lenderType).trim().toLowerCase();
  return LENDER_TYPE_ALIASES[key] || key;
}

// Each lender's criteria, and the ordered rules that read them.
//
// A rule returns a reject reason, or null to pass, or undefined when the input
// it needs is absent — undefined is recorded in checksSkipped rather than
// treated as a pass or a failure, because a lead screened on eight of thirteen
// rules is not the same as a lead that cleared thirteen.

// ── Poonawalla Fincorp — STPL ────────────────────────────────────────────────
// Issued by their InstaPL partnership team, mail of 02 Feb 2026, reproduced in
// POONAWALA_GATING_GUIDE.md.
const POONAWALA_CRITERIA = {
  minAge: 24,
  maxAge: 55,
  minAnnualIncome: 300000,
  minCibilScore: 720,
  minHunterScore: 850,
  minBureauVintageMonths: 12,
  softBureauVintageMonths: 24,
  maxLiveUnsecuredLoans: 3,
  maxEnquiriesLast1Day: 3,
};

// Reject strings are load-bearing: they reach the applicant and are stored in
// gating_logs, so they are reproduced here exactly as the original per-lender
// implementation emitted them. test-gating-criteria.mjs pins them.
const POONAWALA_RULES = [
  { id: "age", flag: "age", severity: "HARD",
    run: (c, k) => (!c.age || c.age < k.minAge || c.age > k.maxAge)
      ? `Age not in range ${k.minAge}-${k.maxAge}` : null },
  { id: "income", flag: "income", severity: "HARD",
    run: (c, k) => (!c.income || c.income < k.minAnnualIncome)
      ? `Annual income < ${k.minAnnualIncome / 100000} lakh` : null },
  { id: "cibil", flag: "cibilScore", severity: "HARD",
    run: (c, k) => (c.cibilScore !== undefined && c.cibilScore < k.minCibilScore)
      ? `CIBIL Score < ${k.minCibilScore}` : null },
  { id: "hunter", flag: "hunterScore", severity: "HARD",
    run: (c, k) => (c.hunterScore !== undefined && c.hunterScore < k.minHunterScore)
      ? `Hunter Score < ${k.minHunterScore}` : null },
  { id: "overdue", severity: "HARD",
    run: (c) => c.currentOverdue ? "Current overdue present - automatic reject" : null },
  { id: "dpd6m", severity: "HARD",
    run: (c) => c.dpdData && c.dpdData.dpdLatest6m > 0 ? "0+ DPD in Latest 6 Months" : null },
  { id: "dpd12m", severity: "HARD",
    run: (c) => c.dpdData && c.dpdData.dpdLatest12m >= 30
      ? "30+ DPD in Latest 12 Months (Bureau)" : null },
  { id: "vintage", severity: "HARD",
    run: (c, k) => (c.bureauVintage && c.bureauVintage < k.minBureauVintageMonths)
      ? `Bureau vintage < ${k.minBureauVintageMonths} months` : null },
  { id: "derog", severity: "HARD",
    run: (c) => (c.derogFlags && c.derogFlags.length > 0)
      ? `Derog flags present: ${c.derogFlags.join(", ")}` : null },
  { id: "liveLoans", severity: "HARD",
    run: (c, k) => (c.liveLoans && c.liveLoans > k.maxLiveUnsecuredLoans)
      ? `Live unsecured loans > ${k.maxLiveUnsecuredLoans}` : null },
  { id: "enquiries1d", severity: "HARD",
    run: (c, k) => (c.enquiriesCount && c.enquiriesCount >= k.maxEnquiriesLast1Day)
      ? `Unsecured enquiries in last 1 day >= ${k.maxEnquiriesLast1Day}` : null },
  { id: "mfi", severity: "HARD",
    run: (c) => (c.mfiStatus === "active" || c.mfiStatus === "closed_recent")
      ? "Active or recent MFI tradeline" : null },
  { id: "identity", severity: "HARD",
    run: (c) => (!c.mobileInBureau || !c.panInBureau)
      ? "Mobile number or PAN not available in bureau" : null },
  { id: "dualPan", severity: "HARD",
    run: (c) => c.dualPan ? "Dual PAN not allowed" : null },
  { id: "vintageSoft", severity: "SOFT",
    run: (c, k) => (c.bureauVintage && c.bureauVintage <= k.softBureauVintageMonths)
      ? `Bureau vintage <= ${k.softBureauVintageMonths} months (soft negative)` : null },
];

// ── Hero FinCorp — bureau-based PL ───────────────────────────────────────────
// From Hero's "Revised Policy Cuts - Hero" sheet, which gives Currently Live
// and Revised Cuts side by side. The operator's decision is REVISED where a
// revised cut is given, Currently Live where the revised cell is blank, so both
// values are carried below and `effective` says which one is in force.
//
// Salary is MONTHLY here. Poonawalla's income cut is annual household income;
// reading one as the other would be a 12x error in either direction, so the
// field is deliberately named differently from Poonawalla's.
const HERO_CRITERIA = {
  minAge: 21,                       // revised, was 18
  maxAge: 58,                       // revised, was 55
  minMonthlySalary: 15000,          // revised, was 20000
  minCibilScore: 725,               // revised, was 730
  allowNewToCredit: false,
  maxActivePlForHighDecile: 5,      // revised: >5 active PL at decile 3+ rejects
  highDecileFrom: 3,
  maxUnsecTradelines1m: 4,          // currently live
  maxUnsecTradelines3m: 1,          // currently live
  maxStpl3m: 3,                     // currently live
  maxDpd3m: 29,                     // currently live
  maxDpd12m: 59,
  maxDpd24m: 89,
  foirBands: [                      // currently live, banded on monthly income
    { belowIncome: 20000, maxFoirPct: 45 },
    { belowIncome: 30000, maxFoirPct: 55 },
    { belowIncome: Infinity, maxFoirPct: 70 },
  ],
  maxOverdueOverall: 5000,          // currently live, strict <
  maxOverdueCreditCard: 10000,
  maxEnquiries3mTotal: 2,           // currently live
  maxEnquiries3mUnsecured: 2,
  enquiry6mScoreBelow: 750,         // revised: >4 unsecured >50k enquiries when score < 750
  maxEnquiries6mAbove50k: 4,
  noIncredPlWithinYears: 3,         // revised
};

const HERO_RULES = [
  { id: "age", flag: "age", severity: "HARD",
    run: (c, k) => c.age === undefined ? undefined
      : (c.age < k.minAge || c.age > k.maxAge) ? `Age not in range ${k.minAge}-${k.maxAge}` : null },
  { id: "employment", severity: "HARD",
    run: (c) => c.employmentType === undefined ? undefined
      : ["salaried", "professional", "professionals"].includes(String(c.employmentType).trim().toLowerCase())
        ? null : "Employment type not Salaried or Professional" },
  { id: "salary", flag: "income", severity: "HARD",
    run: (c, k) => c.monthlySalary === undefined ? undefined
      : c.monthlySalary < k.minMonthlySalary ? `Monthly salary < ${k.minMonthlySalary}` : null },
  { id: "cibil", flag: "cibilScore", severity: "HARD",
    run: (c, k) => c.cibilScore === undefined ? undefined
      : c.cibilScore < k.minCibilScore ? `CIBIL Score < ${k.minCibilScore}` : null },
  { id: "ntc", severity: "HARD",
    run: (c, k) => c.newToCredit === undefined ? undefined
      : (c.newToCredit && !k.allowNewToCredit) ? "New to credit not allowed" : null },
  { id: "activePlDecile", severity: "HARD",
    run: (c, k) => (c.activeUnsecuredPl === undefined || c.decile === undefined) ? undefined
      : (c.decile >= k.highDecileFrom && c.activeUnsecuredPl > k.maxActivePlForHighDecile)
        ? `> ${k.maxActivePlForHighDecile} active PL at decile ${k.highDecileFrom}+` : null },
  { id: "unsecTradelines1m", severity: "HARD",
    run: (c, k) => c.unsecTradelines1m === undefined ? undefined
      : c.unsecTradelines1m > k.maxUnsecTradelines1m
        ? `Unsecured tradelines in last 1m > ${k.maxUnsecTradelines1m}` : null },
  { id: "unsecTradelines3m", severity: "HARD",
    run: (c, k) => c.unsecTradelines3m === undefined ? undefined
      : c.unsecTradelines3m > k.maxUnsecTradelines3m
        ? `Unsecured tradelines in last 3m > ${k.maxUnsecTradelines3m}` : null },
  { id: "stpl3m", severity: "HARD",
    run: (c, k) => c.stpl3m === undefined ? undefined
      : c.stpl3m > k.maxStpl3m ? `STPL in last 3m > ${k.maxStpl3m}` : null },
  { id: "dpd", severity: "HARD",
    run: (c, k) => {
      const d = c.dpdData;
      if (!d) return undefined;
      if (d.maxDpd3m !== undefined && d.maxDpd3m > k.maxDpd3m) return `Max DPD in last 3m > ${k.maxDpd3m}`;
      if (d.maxDpd12m !== undefined && d.maxDpd12m > k.maxDpd12m) return `Max DPD in last 12m > ${k.maxDpd12m}`;
      if (d.maxDpd24m !== undefined && d.maxDpd24m > k.maxDpd24m) return `Max DPD in last 24m > ${k.maxDpd24m}`;
      return (d.maxDpd3m === undefined && d.maxDpd12m === undefined && d.maxDpd24m === undefined)
        ? undefined : null;
    } },
  { id: "derog", severity: "HARD",
    run: (c) => c.derogFlags === undefined ? undefined
      : (c.derogFlags && c.derogFlags.length > 0)
        ? `Suit-filed / written-off / settled / wilful default present: ${c.derogFlags.join(", ")}` : null },
  { id: "foir", severity: "HARD",
    run: (c, k) => (c.foirPct === undefined || c.monthlySalary === undefined) ? undefined
      : (() => {
          const band = k.foirBands.find((b) => c.monthlySalary < b.belowIncome);
          return c.foirPct > band.maxFoirPct
            ? `FOIR ${c.foirPct}% over ${band.maxFoirPct}% for this income band` : null;
        })() },
  { id: "overdueOverall", severity: "HARD",
    run: (c, k) => c.maxOverdueOverall === undefined ? undefined
      : c.maxOverdueOverall >= k.maxOverdueOverall
        ? `Max overdue overall >= ${k.maxOverdueOverall}` : null },
  { id: "overdueCard", severity: "HARD",
    run: (c, k) => c.maxOverdueCreditCard === undefined ? undefined
      : c.maxOverdueCreditCard >= k.maxOverdueCreditCard
        ? `Max credit-card overdue >= ${k.maxOverdueCreditCard}` : null },
  { id: "enquiries6m", severity: "HARD",
    run: (c, k) => (c.unsecEnquiries6mAbove50k === undefined || c.cibilScore === undefined) ? undefined
      : (c.cibilScore < k.enquiry6mScoreBelow && c.unsecEnquiries6mAbove50k > k.maxEnquiries6mAbove50k)
        ? `> ${k.maxEnquiries6mAbove50k} unsecured enquiries over 50k in 6m with score < ${k.enquiry6mScoreBelow}` : null },
  { id: "enquiries3mTotal", severity: "HARD",
    run: (c, k) => c.enquiries3mTotal === undefined ? undefined
      : c.enquiries3mTotal > k.maxEnquiries3mTotal
        ? `Enquiries in last 3m > ${k.maxEnquiries3mTotal}` : null },
  { id: "enquiries3mUnsec", severity: "HARD",
    run: (c, k) => c.enquiries3mUnsecured === undefined ? undefined
      : c.enquiries3mUnsecured > k.maxEnquiries3mUnsecured
        ? `Unsecured enquiries in last 3m > ${k.maxEnquiries3mUnsecured}` : null },
  { id: "incredPl", severity: "HARD",
    run: (c, k) => c.incredPlWithinYears === undefined ? undefined
      : c.incredPlWithinYears <= k.noIncredPlWithinYears
        ? `InCred PL opened within last ${k.noIncredPlWithinYears} years` : null },
];

const LENDER_CRITERIA = {
  poonawala: {
    criteria: POONAWALA_CRITERIA,
    rules: POONAWALA_RULES,
    source: "Poonawalla InstaPL partnership mail, 02 Feb 2026",
  },
  herofincorp: {
    criteria: HERO_CRITERIA,
    rules: HERO_RULES,
    source: "Hero 'Revised Policy Cuts - Hero' — revised cuts, falling back to currently live",
  },
};

class PincodeGatingClient {
  constructor() {
    this.supabaseUrl = process.env.SUPABASE_URL;
    this.supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!this.supabaseUrl || !this.supabaseServiceRoleKey) {
      throw new Error("Supabase credentials not found in environment");
    }

    this.supabase = createClient(this.supabaseUrl, this.supabaseServiceRoleKey);
  }

  async validatePincode(pincode, lenderType = "poonawala") {
    try {
      const { data, error } = await this.supabase
        .from("serviceable_pincodes")
        .select("*")
        .eq("pincode", String(pincode).trim().padStart(6, "0"))
        .eq("lender_type", normalizeLenderType(lenderType))
        .single();

      if (error) return { valid: false, reason: "Pincode not serviceable" };
      return { valid: true, data };
    } catch (error) {
      throw new Error(`Pincode validation error: ${error.message}`);
    }
  }

  async checkEligibility(customerData, lenderType = "poonawala") {
    const checks = {
      pincode: false,
      age: false,
      income: false,
      cibilScore: false,
      hunterScore: false,
      hardRejects: [],
      softRejects: [],
      eligible: false,
    };

    if (!customerData) throw new Error("Customer data is required");

    const lender = normalizeLenderType(lenderType);
    const config = LENDER_CRITERIA[lender];

    if (!config) throw new Error(`Unsupported lender type: ${lenderType}`);

    return this._evaluate(customerData, checks, lender, config);
  }

  /**
   * Evaluate one applicant against a lender's gating criteria.
   *
   * One implementation for every lender, driven by LENDER_CRITERIA, so a
   * lender running on borrowed criteria cannot drift away from the criteria it
   * borrowed. Thresholds are interpolated into the reject reasons rather than
   * written out, so a reason can never contradict the number that produced it.
   */
  async _evaluate(customer, checks, lenderType, config) {
    const { criteria, rules, source } = config;

    checks.criteriaSource = source;
    checks.checksSkipped = [];

    if (!customer.pincode) return { ...checks, reason: "Pincode not provided" };

    const pincodeValidation = await this.validatePincode(customer.pincode, lenderType);
    checks.pincode = pincodeValidation.valid;
    if (!checks.pincode) {
      checks.hardRejects.push("Pincode not in serviceable list");
      return { ...checks, eligible: false, reason: "Pincode not serviceable" };
    }

    for (const rule of rules) {
      const reason = rule.run(customer, criteria);

      // undefined means the input the rule needs was absent. Recorded, never
      // scored: counting it as a pass would report a lead as having cleared a
      // rule nobody ran, and counting it as a failure would decline everyone
      // whose file simply lacks that bureau field.
      if (reason === undefined) {
        checks.checksSkipped.push(rule.id);
        continue;
      }

      if (rule.flag) checks[rule.flag] = !reason;
      if (reason) {
        (rule.severity === "HARD" ? checks.hardRejects : checks.softRejects).push(reason);
      }
    }

    checks.eligible = checks.hardRejects.length === 0 && checks.pincode;

    return checks;
  }

  async bulkUploadPincodes(pincodes, lenderType = "poonawala") {
    try {
      const records = pincodes.map((pincode) => ({
        pincode: String(pincode).padStart(6, "0"),
        lender_type: normalizeLenderType(lenderType),
        created_at: new Date().toISOString(),
      }));

      const { error } = await this.supabase.from("serviceable_pincodes").insert(records);

      if (error) throw error;

      return { success: true, count: records.length, message: `${records.length} pincodes uploaded for ${lenderType}` };
    } catch (error) {
      throw new Error(`Bulk pincode upload failed: ${error.message}`);
    }
  }

  async getPincodeStats(lenderType = "poonawala") {
    try {
      const { data, error } = await this.supabase
        .from("serviceable_pincodes")
        .select("count(*) as total", { count: "exact" })
        .eq("lender_type", normalizeLenderType(lenderType));

      if (error) throw error;

      return { lenderType, count: data[0]?.total || 0 };
    } catch (error) {
      throw new Error(`Failed to get pincode stats: ${error.message}`);
    }
  }

  async createGatingLog(phone, eligibilityResult, lenderType = "poonawala") {
    try {
      const { error } = await this.supabase.from("gating_logs").insert({
        phone,
        lender_type: normalizeLenderType(lenderType),
        eligible: eligibilityResult.eligible,
        checks_passed: {
          pincode: eligibilityResult.pincode,
          age: eligibilityResult.age,
          income: eligibilityResult.income,
          cibilScore: eligibilityResult.cibilScore,
          hunterScore: eligibilityResult.hunterScore,
          // Whose criteria produced this verdict. Kept in the log so a lender
          // running on borrowed criteria is auditable after the fact, not only
          // while the borrowing lasts.
          criteriaSource: eligibilityResult.criteriaSource,
          checksSkipped: eligibilityResult.checksSkipped,
        },
        hard_rejects: eligibilityResult.hardRejects,
        soft_rejects: eligibilityResult.softRejects,
        logged_at: new Date().toISOString(),
      });

      if (error) throw error;
      return { success: true };
    } catch (error) {
      console.error("Error logging gating check:", error);
      return { success: false, error: error.message };
    }
  }

  async healthCheck() {
    try {
      const { data } = await this.supabase.from("serviceable_pincodes").select("count(*)", { count: "exact" }).limit(1);

      return { success: true, status: "connected", message: "Pincode gating database connected" };
    } catch (error) {
      throw new Error(`Health check failed: ${error.message}`);
    }
  }
}

export { normalizeLenderType };
export default PincodeGatingClient;
