import express from "express";
import LenderRoutingClient from "./lenderRoutingClient.js";
import PincodeGatingClient from "./pincodeGatingClient.js";

const router = express.Router();
let lenderClient = null;
let gatingClient = null;

try {
  lenderClient = new LenderRoutingClient();
} catch (error) {
  console.warn('⚠️ Lender Routing Client initialization failed:', error.message);
  console.warn('   Lender routing features will be unavailable until configuration is complete');
}

try {
  gatingClient = new PincodeGatingClient();
} catch (error) {
  console.warn('⚠️ Pincode Gating Client initialization failed:', error.message);
}

// Guard: Check if clients are available
router.use((req, res, next) => {
  if (!lenderClient || !gatingClient) {
    return res.status(503).json({
      success: false,
      error: 'Lender Routing dependencies not initialized - Supabase configuration required',
    });
  }
  next();
});

/**
 * Lender Routing Routes
 * Phase 2: Multi-Lender Eligibility & Routing
 * Endpoint: /api/routing/*
 */

// ==================== Health Check ====================

/**
 * GET /api/routing/health
 * Check lender routing service connectivity
 */
router.get("/health", async (_req, res) => {
  try {
    const health = await lenderClient.healthCheck();
    res.status(health.success ? 200 : 503).json(health);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== Lender Information ====================

/**
 * GET /api/routing/lenders
 * List all active lenders with basic info
 */
router.get("/lenders", async (_req, res) => {
  try {
    const result = await lenderClient.listActiveLenders();
    res.json(result);
  } catch (error) {
    console.error("List lenders error:", error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/routing/lenders/:lenderId
 * Get detailed lender configuration and requirements
 */
router.get("/lenders/:lenderId", async (req, res) => {
  try {
    const { lenderId } = req.params;

    if (!lenderId) {
      return res.status(400).json({
        success: false,
        error: "lenderId is required",
      });
    }

    const result = await lenderClient.getLenderDetails(lenderId);
    res.status(result.success ? 200 : 404).json(result);
  } catch (error) {
    console.error("Get lender details error:", error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ==================== Eligibility & Routing ====================

/**
 * POST /api/routing/check-eligibility
 * PHASE 2 CORE ENDPOINT
 * Check multi-lender eligibility and route to best lender
 * Called after: Lead intake (Phase 1) + CIBIL/Hunter score fetch
 *
 * Request body:
 * {
 *   phone: "919876543210",
 *   age: 32,
 *   income: 500000,
 *   cibilScore: 750,
 *   hunterScore: 880,
 *   loanAmount: 500000,
 *   loanTenor: 36,
 *   pincode: "400001",
 *   liveLoans: 1,
 *   enquiriesCount: 0,
 *   currentOverdue: false,
 *   dpdData: { dpdLatest6m: 0, dpdLatest12m: 0 }
 * }
 *
 * Response:
 * {
 *   success: true,
 *   phone: "919876543210",
 *   totalEligible: 3,
 *   primaryLender: {
 *     lenderId: "poonawala",
 *     lenderName: "Poonawala Fincorp",
 *     approvalProbability: 0.75,
 *     estimatedEmi: 15500,
 *     processingFee: 5000
 *   },
 *   allEligibleLenders: [...]
 * }
 */
router.post("/check-eligibility", async (req, res) => {
  try {
    const {
      phone,
      age,
      income,
      cibilScore,
      hunterScore,
      pincode,
      loanAmount = 500000,
      loanTenor = 36,
      liveLoans,
      enquiriesCount,
      currentOverdue,
      dpdData,
      derogFlags,
      mfiStatus,
      bureauVintage,
    } = req.body;

    // Validate required fields
    if (!phone || !age || !income || !cibilScore) {
      return res.status(400).json({
        success: false,
        error: "phone, age, income, and cibilScore are required",
      });
    }

    console.log(
      `[Phase 2] Eligibility check for ${phone}: age=${age}, income=${income}, CIBIL=${cibilScore}`
    );

    // Step 1: Validate pincode if provided
    let pincodeValid = true;
    if (pincode) {
      try {
        const pincodeResult = await gatingClient.validatePincode(
          pincode,
          "poonawala"
        );
        pincodeValid = pincodeResult.valid;
      } catch (error) {
        console.warn(`Pincode validation warning: ${error.message}`);
        pincodeValid = false;
      }
    }

    // Step 2: Get eligible lenders
    const applicationData = {
      phone,
      age,
      income,
      cibilScore,
      hunterScore: hunterScore || 0,
      pincode,
      loanAmount,
      loanTenor,
      liveLoans: liveLoans || 0,
      enquiriesCount: enquiriesCount || 0,
      currentOverdue: currentOverdue || false,
      dpdData: dpdData || {},
      derogFlags: derogFlags || [],
      mfiStatus: mfiStatus || null,
      bureauVintage: bureauVintage || null,
    };

    const routingResult = await lenderClient.getEligibleLenders(applicationData);

    // Step 3: Enrich response with pincode validation
    routingResult.pincodeValid = pincodeValid;

    // If no eligible lenders, return 400
    const statusCode =
      routingResult.success && routingResult.totalEligible > 0 ? 200 : 400;
    res.status(statusCode).json(routingResult);
  } catch (error) {
    console.error("Check eligibility error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/routing/application/:applicationId/assign-lender
 * Assign a specific lender to an application
 * Called during final routing decision
 *
 * Request body:
 * {
 *   lenderId: "poonawala",
 *   loanAmount: 500000,
 *   loanTenor: 36
 * }
 */
router.post("/application/:applicationId/assign-lender", async (req, res) => {
  try {
    const { applicationId } = req.params;
    const { lenderId, loanAmount, loanTenor } = req.body;

    if (!applicationId || !lenderId) {
      return res.status(400).json({
        success: false,
        error: "applicationId and lenderId are required",
      });
    }

    console.log(
      `[Phase 2] Assigning lender ${lenderId} to application ${applicationId}`
    );

    const lenderDetails = await lenderClient.getLenderDetails(lenderId);
    if (!lenderDetails.success) {
      return res.status(404).json(lenderDetails);
    }

    res.json({
      success: true,
      applicationId,
      lenderId,
      lenderName: lenderDetails.lender.name,
      loanAmount: loanAmount || 500000,
      loanTenor: loanTenor || 36,
      assignedAt: new Date().toISOString(),
      nextStep: "document_collection",
      message: `Application ready for ${lenderDetails.lender.name} submission`,
    });
  } catch (error) {
    console.error("Assign lender error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/routing/batch-eligibility-check
 * Check eligibility for multiple applications
 * Used for batch campaigns (50K+/day)
 *
 * Request body:
 * {
 *   applications: [
 *     { phone, age, income, cibilScore, hunterScore, loanAmount, loanTenor },
 *     ...
 *   ]
 * }
 */
router.post("/batch-eligibility-check", async (req, res) => {
  try {
    const { applications } = req.body;

    if (!Array.isArray(applications) || applications.length === 0) {
      return res.status(400).json({
        success: false,
        error: "applications array is required",
      });
    }

    console.log(
      `[Phase 2] Batch eligibility check for ${applications.length} applications`
    );

    const results = [];
    for (const app of applications) {
      const result = await lenderClient.getEligibleLenders(app);
      results.push({
        phone: app.phone,
        success: result.success,
        totalEligible: result.totalEligible,
        primaryLender: result.primaryLender,
        error: result.error,
      });
    }

    const successCount = results.filter((r) => r.success && r.totalEligible > 0)
      .length;
    res.json({
      success: true,
      totalApplications: applications.length,
      successCount,
      failureCount: applications.length - successCount,
      results,
    });
  } catch (error) {
    console.error("Batch eligibility check error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

export default router;
