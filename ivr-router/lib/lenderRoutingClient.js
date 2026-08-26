import { createClient } from "@supabase/supabase-js";

/**
 * Lender Routing Client
 * Phase 2: Multi-Lender Eligibility & Routing
 *
 * Manages:
 * - Lender configuration (rate cards, eligibility criteria, loan limits)
 * - Multi-lender eligibility checking
 * - Intelligent routing to best lender based on approval probability / rates
 * - Lender-specific application preparation
 */
class LenderRoutingClient {
  constructor() {
    this.supabaseUrl = process.env.SUPABASE_URL;
    this.supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!this.supabaseUrl || !this.supabaseServiceRoleKey) {
      console.warn("Supabase credentials not configured. Lender routing disabled.");
      this.supabase = null;
      return;
    }

    this.supabase = createClient(this.supabaseUrl, this.supabaseServiceRoleKey);

    // In-memory lender config (can be moved to Supabase table later)
    this.lenderConfig = {
      poonawala: {
        name: "Poonawala Fincorp",
        minAge: 24,
        maxAge: 55,
        minIncome: 300000,
        minCibil: 720,
        minHunterScore: 850,
        minLoanAmount: 100000,
        maxLoanAmount: 2500000,
        tenor: [12, 24, 36, 48, 60],
        interestRateMin: 12,
        interestRateMax: 18,
        approvalProbability: 0.75,
        processingFee: 0.01,
        active: true,
      },
      hdfc_jumbo: {
        name: "HDFC Bank - Jumbo Loan",
        minAge: 25,
        maxAge: 60,
        minIncome: 500000,
        minCibil: 750,
        minHunterScore: 875,
        minLoanAmount: 500000,
        maxLoanAmount: 5000000,
        tenor: [24, 36, 48, 60],
        interestRateMin: 10,
        interestRateMax: 15,
        approvalProbability: 0.65,
        processingFee: 0.015,
        active: true,
      },
      hero_fincorp_stpl: {
        name: "Hero FinCorp - STPL",
        minAge: 23,
        maxAge: 50,
        minIncome: 250000,
        minCibil: 700,
        minHunterScore: 820,
        minLoanAmount: 50000,
        maxLoanAmount: 2000000,
        tenor: [12, 24, 36, 48],
        interestRateMin: 13,
        interestRateMax: 20,
        approvalProbability: 0.8,
        processingFee: 0.012,
        active: true,
      },
      bajaj_finserv: {
        name: "Bajaj Finserv",
        minAge: 24,
        maxAge: 58,
        minIncome: 350000,
        minCibil: 730,
        minHunterScore: 860,
        minLoanAmount: 100000,
        maxLoanAmount: 3000000,
        tenor: [12, 24, 36, 48, 60],
        interestRateMin: 11,
        interestRateMax: 17,
        approvalProbability: 0.7,
        processingFee: 0.011,
        active: true,
      },
    };
  }

  /**
   * Get eligible lenders for an application
   * Returns array of lenders sorted by approval probability (best first)
   */
  async getEligibleLenders(applicationData) {
    try {
      if (!this.supabase) {
        throw new Error("Supabase not configured");
      }

      const {
        phone,
        age,
        income,
        cibilScore,
        hunterScore,
        loanAmount = 500000,
        loanTenor = 36,
      } = applicationData;

      if (!age || !income || !cibilScore) {
        throw new Error("age, income, and cibilScore are required");
      }

      const eligibleLenders = [];

      // Check each lender
      for (const [lenderId, lender] of Object.entries(this.lenderConfig)) {
        if (!lender.active) continue;

        const eligibility = this._checkLenderEligibility(
          applicationData,
          lenderId,
          lender
        );

        if (eligibility.eligible) {
          eligibleLenders.push({
            lenderId,
            lenderName: lender.name,
            eligible: true,
            approvalProbability: lender.approvalProbability,
            interestRateMin: lender.interestRateMin,
            interestRateMax: lender.interestRateMax,
            estimatedEmi: this._calculateEmi(loanAmount, lender.interestRateMax, loanTenor),
            processingFee: Math.round(loanAmount * lender.processingFee),
          });
        }
      }

      // Sort by approval probability (descending), then by interest rate (ascending)
      eligibleLenders.sort((a, b) => {
        if (b.approvalProbability !== a.approvalProbability) {
          return b.approvalProbability - a.approvalProbability;
        }
        return a.interestRateMin - b.interestRateMin;
      });

      // Log routing decision
      if (eligibleLenders.length > 0) {
        await this._logRoutingDecision(phone, eligibleLenders[0].lenderId, "routed");
      } else {
        await this._logRoutingDecision(phone, null, "no_eligible_lenders");
      }

      return {
        success: true,
        phone,
        totalEligible: eligibleLenders.length,
        primaryLender: eligibleLenders[0] || null,
        allEligibleLenders: eligibleLenders,
        loanAmount,
        loanTenor,
      };
    } catch (error) {
      console.error(`Get eligible lenders failed for ${applicationData?.phone}:`, error);
      return {
        success: false,
        error: error.message,
        phone: applicationData?.phone,
      };
    }
  }

  /**
   * Internal: Check if applicant is eligible for a specific lender
   */
  _checkLenderEligibility(applicationData, lenderId, lender) {
    const {
      age,
      income,
      cibilScore,
      hunterScore,
      loanAmount = 500000,
      currentOverdue = false,
      dpdData = {},
      liveLoans = 0,
      enquiriesCount = 0,
    } = applicationData;

    const checks = {
      age: age >= lender.minAge && age <= lender.maxAge,
      income: income >= lender.minIncome,
      cibilScore: cibilScore >= lender.minCibil,
      hunterScore: hunterScore >= lender.minHunterScore,
      loanAmount:
        loanAmount >= lender.minLoanAmount && loanAmount <= lender.maxLoanAmount,
      noCurrentOverdue: !currentOverdue,
      noDpdIssues: !dpdData?.dpdLatest6m || dpdData.dpdLatest6m === 0,
      reasonableLiveLoans: liveLoans <= 3,
      reasonableEnquiries: enquiriesCount < 3,
    };

    const allChecksPassed = Object.values(checks).every((v) => v);

    return {
      eligible: allChecksPassed,
      checks,
      reasons: Object.entries(checks)
        .filter(([, value]) => !value)
        .map(([key]) => key),
    };
  }

  /**
   * Internal: Calculate EMI (Equated Monthly Installment)
   * Using standard formula: EMI = P * r * (1+r)^n / ((1+r)^n - 1)
   * where P = principal, r = monthly rate, n = number of months
   */
  _calculateEmi(principal, annualRate, months) {
    const monthlyRate = annualRate / 100 / 12;
    if (monthlyRate === 0) return Math.round(principal / months);

    const numerator = principal * monthlyRate * Math.pow(1 + monthlyRate, months);
    const denominator = Math.pow(1 + monthlyRate, months) - 1;
    return Math.round(numerator / denominator);
  }

  /**
   * Internal: Log routing decision to audit trail
   */
  async _logRoutingDecision(phone, routedLenderId, status) {
    try {
      if (!this.supabase) return;

      await this.supabase.from("routing_logs").insert({
        phone,
        routed_lender_id: routedLenderId,
        status, // routed, no_eligible_lenders, error
        logged_at: new Date().toISOString(),
      });
    } catch (error) {
      console.error("Error logging routing decision:", error);
    }
  }

  /**
   * Get lender details and requirements
   */
  async getLenderDetails(lenderId) {
    try {
      const lender = this.lenderConfig[lenderId];
      if (!lender) {
        throw new Error(`Lender ${lenderId} not found`);
      }

      return {
        success: true,
        lenderId,
        lender: {
          name: lender.name,
          minAge: lender.minAge,
          maxAge: lender.maxAge,
          minIncome: lender.minIncome,
          minCibil: lender.minCibil,
          minHunterScore: lender.minHunterScore,
          minLoanAmount: lender.minLoanAmount,
          maxLoanAmount: lender.maxLoanAmount,
          tenor: lender.tenor,
          interestRateMin: lender.interestRateMin,
          interestRateMax: lender.interestRateMax,
          processingFeePercent: lender.processingFee * 100,
          approvalProbability: Math.round(lender.approvalProbability * 100),
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * List all active lenders
   */
  async listActiveLenders() {
    try {
      const lenders = Object.entries(this.lenderConfig)
        .filter(([, lender]) => lender.active)
        .map(([lenderId, lender]) => ({
          lenderId,
          name: lender.name,
          minLoanAmount: lender.minLoanAmount,
          maxLoanAmount: lender.maxLoanAmount,
          interestRateMin: lender.interestRateMin,
          interestRateMax: lender.interestRateMax,
          approvalProbability: Math.round(lender.approvalProbability * 100),
        }));

      return {
        success: true,
        totalLenders: lenders.length,
        lenders,
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Health check
   */
  async healthCheck() {
    try {
      if (!this.supabase) {
        return {
          success: false,
          status: "not_configured",
          message: "Supabase not configured",
        };
      }

      const activeLenders = Object.values(this.lenderConfig).filter(
        (l) => l.active
      ).length;
      return {
        success: true,
        status: "connected",
        message: "Lender routing service connected",
        activeLenders,
      };
    } catch (error) {
      return {
        success: false,
        status: "error",
        message: error.message,
      };
    }
  }
}

export default LenderRoutingClient;
