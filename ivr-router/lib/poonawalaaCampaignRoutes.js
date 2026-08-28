import express from "express";
import PoonawalaaCampaignOrchestrator from "./poonawalaaCampaignOrchestrator.js";

const router = express.Router();
let orchestrator = null;

try {
  orchestrator = new PoonawalaaCampaignOrchestrator();
} catch (error) {
  console.warn('⚠️ Poonawala Campaign Orchestrator initialization failed:', error.message);
  console.warn('   Poonawala campaign features will be unavailable until configuration is complete');
}

// Guard: Check if orchestrator is available
router.use((req, res, next) => {
  if (!orchestrator) {
    return res.status(503).json({
      success: false,
      error: 'Poonawala Campaign Orchestrator not initialized - Supabase configuration required',
    });
  }
  next();
});

router.get("/health", async (_req, res) => {
  try {
    const health = await orchestrator.healthCheck();
    res.json(health);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get("/config", (_req, res) => {
  res.json({
    success: true,
    campaignConfig: orchestrator.campaignConfig,
    targetSegment: {
      ageRange: `${orchestrator.campaignConfig.targetAge.min}-${orchestrator.campaignConfig.targetAge.max}`,
      minCibilScore: orchestrator.campaignConfig.minCibilScore,
      description: "Young professionals with strong credit profiles",
    },
    channels: ["OBD Voice Calls", "Ananta WhatsApp Follow-up"],
    dailyCapacity: orchestrator.campaignConfig.dailyVolume,
    estimatedDuration: `${orchestrator.campaignConfig.campaignDuration} days`,
  });
});

router.post("/start-batch", async (req, res) => {
  try {
    const { batchNumber = 1, limit = 50000 } = req.body;

    if (batchNumber < 1) {
      return res.status(400).json({ success: false, error: "Batch number must be >= 1" });
    }

    if (limit < 1000 || limit > 500000) {
      return res.status(400).json({ success: false, error: "Limit must be between 1000 and 500000" });
    }

    const result = await orchestrator.orchestrateCampaign(batchNumber, limit);

    res.json({
      success: true,
      message: `Campaign batch ${batchNumber} initiated successfully`,
      ...result,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post("/trigger-custom", async (req, res) => {
  try {
    const { customers, campaignName, channels = ["voice", "whatsapp"] } = req.body;

    if (!customers || !Array.isArray(customers) || customers.length === 0) {
      return res.status(400).json({ success: false, error: "Customers array is required" });
    }

    const campaign = await orchestrator.createCampaignBatch(customers, 1);

    const results = {
      campaignId: campaign.campaignId,
      campaignName: campaign.campaignName,
      customerCount: customers.length,
      voiceResults: [],
      whatsappResults: [],
    };

    if (channels.includes("voice")) {
      for (const customer of customers) {
        const voiceResult = await orchestrator.triggerVoiceCall(customer, campaign.campaignId);
        results.voiceResults.push(voiceResult);
      }
    }

    if (channels.includes("whatsapp")) {
      for (let i = 0; i < customers.length; i++) {
        const customer = customers[i];
        const voiceResult = results.voiceResults[i];
        const whatsappResult = await orchestrator.triggerWhatsAppFollowUp(customer, campaign.campaignId, voiceResult);
        results.whatsappResults.push(whatsappResult);
      }
    }

    res.json({
      success: true,
      ...results,
      voiceSuccessRate: (
        (results.voiceResults.filter((r) => r.success).length / results.voiceResults.length) *
        100
      ).toFixed(2) + "%",
      whatsappSuccessRate:
        results.whatsappResults.length > 0
          ? (
              (results.whatsappResults.filter((r) => r.success).length / results.whatsappResults.length) *
              100
            ).toFixed(2) + "%"
          : "N/A",
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get("/campaign/:campaignId/status", async (req, res) => {
  try {
    const { campaignId } = req.params;

    if (!campaignId) {
      return res.status(400).json({ success: false, error: "Campaign ID is required" });
    }

    const status = await orchestrator.getCampaignStatus(campaignId);
    res.json({ success: true, ...status });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get("/campaign/:campaignId/roi", async (req, res) => {
  try {
    const { campaignId } = req.params;

    if (!campaignId) {
      return res.status(400).json({ success: false, error: "Campaign ID is required" });
    }

    const roi = await orchestrator.calculateCampaignROI(campaignId);
    res.json({ success: true, ...roi });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post("/estimate", async (req, res) => {
  try {
    const { targetAge = { min: 24, max: 35 }, minCibilScore = 720 } = req.body;

    const query = await orchestrator.querySMECircleBase({
      minAge: targetAge.min,
      maxAge: targetAge.max,
      minCibilScore,
      limit: 100,
      offset: 0,
    });

    const eligibilityTests = [];
    const sampleSize = Math.min(100, query.customers.length);

    for (let i = 0; i < sampleSize; i++) {
      const customer = query.customers[i];
      const eligibility = await orchestrator.checkPoonawalaEligibility(customer);
      eligibilityTests.push({
        phone: customer.phone,
        eligible: eligibility.eligible,
        reason: eligibility.hardRejects[0] || "Eligible",
      });
    }

    const eligibleCount = eligibilityTests.filter((t) => t.eligible).length;
    const eligibilityRate = (eligibleCount / sampleSize) * 100;
    const estimatedEligible = Math.round((query.totalCount * eligibilityRate) / 100);

    res.json({
      success: true,
      estimate: {
        totalCustomers: query.totalCount,
        sampleSize,
        eligibleInSample: eligibleCount,
        sampleEligibilityRate: eligibilityRate.toFixed(2) + "%",
        estimatedEligibleTotal: estimatedEligible,
        estimatedDailyCapacity: orchestrator.campaignConfig.dailyVolume,
        estimatedCampaignDuration: Math.ceil(estimatedEligible / orchestrator.campaignConfig.dailyVolume) + " days",
      },
      sampleResults: eligibilityTests.slice(0, 20), // Return first 20 for review
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
