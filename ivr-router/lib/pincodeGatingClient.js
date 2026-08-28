import { createClient } from "@supabase/supabase-js";
import axios from "axios";

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
        .eq("pincode", pincode)
        .eq("lender_type", lenderType)
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

    if (lenderType === "poonawala") {
      return this._checkPoonawalaEligibility(customerData, checks);
    } else if (lenderType === "herofincorp") {
      return this._checkHeroFincorpEligibility(customerData, checks);
    }

    throw new Error(`Unsupported lender type: ${lenderType}`);
  }

  async _checkPoonawalaEligibility(customer, checks) {
    const { pincode, age, income, cibilScore, hunterScore, dpdData, bureauVintage, derogFlags, currentOverdue, liveLoans, enquiriesCount, mfiStatus, mobileInBureau, panInBureau, dualPan } = customer;

    if (!pincode) return { ...checks, reason: "Pincode not provided" };

    const pincodeValidation = await this.validatePincode(pincode, "poonawala");
    checks.pincode = pincodeValidation.valid;
    if (!checks.pincode) {
      checks.hardRejects.push("Pincode not in serviceable list");
      return { ...checks, eligible: false, reason: "Pincode not serviceable" };
    }

    if (!age || age < 24 || age > 55) {
      checks.age = false;
      checks.hardRejects.push("Age not in range 24-55");
    } else {
      checks.age = true;
    }

    if (!income || income < 300000) {
      checks.income = false;
      checks.hardRejects.push("Annual income < 3 lakh");
    } else {
      checks.income = true;
    }

    if (cibilScore !== undefined && cibilScore < 720) {
      checks.cibilScore = false;
      checks.hardRejects.push("CIBIL Score < 720");
    } else {
      checks.cibilScore = true;
    }

    if (hunterScore !== undefined && hunterScore < 850) {
      checks.hunterScore = false;
      checks.hardRejects.push("Hunter Score < 850");
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

    if (bureauVintage && bureauVintage < 12) {
      checks.hardRejects.push("Bureau vintage < 12 months");
    }

    if (derogFlags && derogFlags.length > 0) {
      checks.hardRejects.push(`Derog flags present: ${derogFlags.join(", ")}`);
    }

    if (liveLoans && liveLoans > 3) {
      checks.hardRejects.push("Live unsecured loans > 3");
    }

    if (enquiriesCount && enquiriesCount >= 3) {
      checks.hardRejects.push("Unsecured enquiries in last 1 day >= 3");
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

    if (bureauVintage && bureauVintage <= 24) {
      checks.softRejects.push("Bureau vintage <= 24 months (soft negative)");
    }

    checks.eligible = checks.hardRejects.length === 0 && checks.age && checks.income && checks.pincode && checks.cibilScore && checks.hunterScore;

    return checks;
  }

  async _checkHeroFincorpEligibility(customer, checks) {
    checks.eligible = false;
    checks.reason = "HeroFincorp eligibility engine not yet implemented";
    return checks;
  }

  async bulkUploadPincodes(pincodes, lenderType = "poonawala") {
    try {
      const records = pincodes.map((pincode) => ({
        pincode: String(pincode).padStart(6, "0"),
        lender_type: lenderType,
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
        .eq("lender_type", lenderType);

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
        lender_type: lenderType,
        eligible: eligibilityResult.eligible,
        checks_passed: {
          pincode: eligibilityResult.pincode,
          age: eligibilityResult.age,
          income: eligibilityResult.income,
          cibilScore: eligibilityResult.cibilScore,
          hunterScore: eligibilityResult.hunterScore,
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

export default PincodeGatingClient;
