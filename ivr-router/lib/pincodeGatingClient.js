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

// Poonawalla Fincorp's STPL gating criteria, as issued by their InstaPL
// partnership team (mail of 02 Feb 2026, reproduced in POONAWALA_GATING_GUIDE.md).
const STPL_GATING_CRITERIA = {
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

// Which criteria each lender is gated on.
//
// Hero FinCorp has not issued its own. Rather than leave its engine returning
// "not yet implemented" — which rejected every applicant regardless of the
// 15,227 pincodes they sent on 28 Jul 2026 — it runs on Poonawalla's numbers as
// a deliberate stand-in, per the operator's instruction.
//
// These are NOT Hero's underwriting rules, and `borrowedFrom` says so in every
// result and every gating_logs row, so a pass here is never mistaken for Hero
// having approved the criteria. Hero still underwrites independently on the
// leads it receives, so the risk of the stand-in is commercial, not compliance:
// where Poonawalla is stricter than Hero we withhold leads Hero would have
// taken. Replace with Hero's own criteria as soon as their team sends them.
const LENDER_CRITERIA = {
  poonawala: { criteria: STPL_GATING_CRITERIA, borrowedFrom: null },
  herofincorp: { criteria: STPL_GATING_CRITERIA, borrowedFrom: "poonawala" },
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
    const { criteria, borrowedFrom } = config;
    const {
      pincode, age, income, cibilScore, hunterScore, dpdData, bureauVintage,
      derogFlags, currentOverdue, liveLoans, enquiriesCount, mfiStatus,
      mobileInBureau, panInBureau, dualPan,
    } = customer;

    // Surfaced on every result and written to gating_logs, so an eligible=true
    // for a lender on borrowed criteria is never read as that lender's own call.
    checks.criteriaSource = borrowedFrom ?? lenderType;
    checks.criteriaBorrowed = borrowedFrom !== null;

    if (!pincode) return { ...checks, reason: "Pincode not provided" };

    const pincodeValidation = await this.validatePincode(pincode, lenderType);
    checks.pincode = pincodeValidation.valid;
    if (!checks.pincode) {
      checks.hardRejects.push("Pincode not in serviceable list");
      return { ...checks, eligible: false, reason: "Pincode not serviceable" };
    }

    if (!age || age < criteria.minAge || age > criteria.maxAge) {
      checks.age = false;
      checks.hardRejects.push(`Age not in range ${criteria.minAge}-${criteria.maxAge}`);
    } else {
      checks.age = true;
    }

    if (!income || income < criteria.minAnnualIncome) {
      checks.income = false;
      checks.hardRejects.push(`Annual income < ${criteria.minAnnualIncome / 100000} lakh`);
    } else {
      checks.income = true;
    }

    if (cibilScore !== undefined && cibilScore < criteria.minCibilScore) {
      checks.cibilScore = false;
      checks.hardRejects.push(`CIBIL Score < ${criteria.minCibilScore}`);
    } else {
      checks.cibilScore = true;
    }

    if (hunterScore !== undefined && hunterScore < criteria.minHunterScore) {
      checks.hunterScore = false;
      checks.hardRejects.push(`Hunter Score < ${criteria.minHunterScore}`);
    } else {
      checks.hunterScore = true;
    }

    if (currentOverdue) {
      checks.hardRejects.push("Current overdue present - automatic reject");
    }

    if (dpdData) {
      const { dpdLatest6m, dpdLatest12m } = dpdData;
      if (dpdLatest6m > 0) {
        checks.hardRejects.push("0+ DPD in Latest 6 Months");
      }
      if (dpdLatest12m >= 30) {
        checks.hardRejects.push("30+ DPD in Latest 12 Months (Bureau)");
      }
    }

    if (bureauVintage && bureauVintage < criteria.minBureauVintageMonths) {
      checks.hardRejects.push(`Bureau vintage < ${criteria.minBureauVintageMonths} months`);
    }

    if (derogFlags && derogFlags.length > 0) {
      checks.hardRejects.push(`Derog flags present: ${derogFlags.join(", ")}`);
    }

    if (liveLoans && liveLoans > criteria.maxLiveUnsecuredLoans) {
      checks.hardRejects.push(`Live unsecured loans > ${criteria.maxLiveUnsecuredLoans}`);
    }

    if (enquiriesCount && enquiriesCount >= criteria.maxEnquiriesLast1Day) {
      checks.hardRejects.push(`Unsecured enquiries in last 1 day >= ${criteria.maxEnquiriesLast1Day}`);
    }

    if (mfiStatus === "active" || mfiStatus === "closed_recent") {
      checks.hardRejects.push("Active or recent MFI tradeline");
    }

    if (!mobileInBureau || !panInBureau) {
      checks.hardRejects.push("Mobile number or PAN not available in bureau");
    }

    if (dualPan) {
      checks.hardRejects.push("Dual PAN not allowed");
    }

    if (bureauVintage && bureauVintage <= criteria.softBureauVintageMonths) {
      checks.softRejects.push(`Bureau vintage <= ${criteria.softBureauVintageMonths} months (soft negative)`);
    }

    checks.eligible = checks.hardRejects.length === 0 && checks.age && checks.income && checks.pincode && checks.cibilScore && checks.hunterScore;

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
          criteriaBorrowed: eligibilityResult.criteriaBorrowed,
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
