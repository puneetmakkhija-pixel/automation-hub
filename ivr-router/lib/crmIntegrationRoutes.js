import express from "express";
import CrmIntegrationClient from "./crmIntegrationClient.js";

const router = express.Router();
let crmClient = null;

try {
  crmClient = new CrmIntegrationClient();
} catch (error) {
  console.warn("⚠️ CRM Integration Client initialization failed:", error.message);
  console.warn("   CRM features will be unavailable until configuration is complete");
}

// ==================== Health Check ====================
router.get("/health", (_req, res) => {
  res.json({
    success: true,
    service: 'crm_integration',
    status: crmClient ? 'healthy' : 'unavailable',
    timestamp: new Date().toISOString(),
  });
});

router.use((req, res, next) => {
  if (!crmClient) {
    return res.status(503).json({
      success: false,
      error: "CRM Integration Client not initialized - Supabase configuration required",
    });
  }
  next();
});

/**
 * CRM Integration Routes
 * Phase 1: Lead Intake Pipeline
 * Endpoint: /api/crm/*
 */

/**
 * POST /api/crm/lead-intake-sync
 * PHASE 1 CORE ENDPOINT
 * Called after: OBD voice call + Chatsense disposition captured
 * Creates application in CRM, returns application_id for tagging future interactions
 *
 * Request body:
 * {
 *   phone: "919876543210",
 *   name: "Rajesh Kumar",
 *   age: 32,
 *   income: 500000,
 *   pincode: "400001",
 *   state: "Maharashtra",
 *   email: "rajesh@email.com",
 *   channel: "obd_voice",
 *   disposition: "interested",
 *   callDuration: 45,
 *   dtmfChoice: 1,
 *   campaignId: "poonawala_stpl_batch_1724095200000_1",
 *   batchId: 1,
 *   customMetadata: {
 *     callSid: "call_12345",
 *     agentId: "agent_001"
 *   }
 * }
 *
 * Response:
 * {
 *   success: true,
 *   applicationId: "app_12345",
 *   message: "Application created successfully"
 * }
 */
router.post("/lead-intake-sync", async (req, res) => {
  try {
    const { phone, name, age, income, pincode, state, email, channel, disposition, callDuration, dtmfChoice, campaignId, batchId, ivrGreeting, customMetadata } = req.body;

    // Validate required fields
    if (!phone || !name) {
      return res.status(400).json({
        success: false,
        error: "Phone and name are required",
      });
    }

    // Validate disposition
    const validDispositions = ["interested", "callback", "rejected", "agent_connect", "contacted"];
    if (disposition && !validDispositions.includes(disposition)) {
      return res.status(400).json({
        success: false,
        error: `Invalid disposition. Must be one of: ${validDispositions.join(", ")}`,
      });
    }

    console.log(`[CRM Integration] Lead intake sync for ${phone} (disposition: ${disposition})`);

    const result = await crmClient.leadIntakeSyncFromVoice({
      phone,
      name,
      age,
      income,
      pincode,
      state,
      email,
      channel,
      disposition: disposition || "contacted",
      callDuration,
      dtmfChoice,
      campaignId,
      batchId,
      ivrGreeting,
      customMetadata: customMetadata || {},
    });

    res.status(result.success ? 201 : 400).json(result);
  } catch (error) {
    console.error("Lead intake sync error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/crm/application/:applicationId/update-call-metrics
 * Called after voice call completes
 * Updates application with call duration, disposition, DTMF choice
 */
router.post("/application/:applicationId/update-call-metrics", async (req, res) => {
  try {
    const { applicationId } = req.params;
    const callMetrics = req.body;

    if (!applicationId) {
      return res.status(400).json({ success: false, error: "Application ID required" });
    }

    const result = await crmClient.updateApplicationWithCallMetrics({
      applicationId,
      callMetrics,
    });

    res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/crm/application/:applicationId/log-event
 * Log any event in CRM audit trail
 * Used for compliance tracking
 */
router.post("/application/:applicationId/log-event", async (req, res) => {
  try {
    const { applicationId } = req.params;
    const { disposition, details } = req.body;

    if (!applicationId || !disposition) {
      return res.status(400).json({ success: false, error: "Application ID and disposition required" });
    }

    const result = await crmClient.logVoiceDisposition({
      applicationId,
      disposition,
      details: details || {},
    });

    res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/crm/application/:applicationId
 * Fetch application details from CRM
 * Used to check application state, eligible lenders, etc.
 */
router.get("/application/:applicationId", async (req, res) => {
  try {
    const { applicationId } = req.params;

    if (!applicationId) {
      return res.status(400).json({ success: false, error: "Application ID required" });
    }

    const result = await crmClient.getApplication(applicationId);

    res.status(result.success ? 200 : 404).json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/crm/application/:applicationId/update-stage
 * Advance application through pipeline
 * Called when: documents received, credit approved, sanctioned, etc.
 *
 * Request body:
 * {
 *   stage: "Documents",
 *   substate: "partial"
 * }
 */
router.post("/application/:applicationId/update-stage", async (req, res) => {
  try {
    const { applicationId } = req.params;
    const { stage, substate } = req.body;

    if (!applicationId || !stage) {
      return res.status(400).json({ success: false, error: "Application ID and stage required" });
    }

    const result = await crmClient.updateApplicationStage({
      applicationId,
      stage,
      substate,
    });

    res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/crm/batch-lead-intake
 * Bulk lead intake for batch campaigns
 * Called after Poonawala batch processing
 *
 * Request body:
 * {
 *   campaignId: "poonawala_stpl_batch_1724095200000_1",
 *   batchId: 1,
 *   leads: [
 *     { phone, name, age, income, pincode, state, disposition, callDuration },
 *     ...
 *   ]
 * }
 */
router.post("/batch-lead-intake", async (req, res) => {
  try {
    const { campaignId, batchId, leads } = req.body;

    if (!campaignId || !Array.isArray(leads) || leads.length === 0) {
      return res.status(400).json({
        success: false,
        error: "campaignId and non-empty leads array required",
      });
    }

    console.log(`[CRM Integration] Bulk lead intake for ${leads.length} leads (campaign: ${campaignId})`);

    const results = [];
    for (const lead of leads) {
      const result = await crmClient.leadIntakeSyncFromVoice({
        phone: lead.phone,
        name: lead.name,
        age: lead.age,
        income: lead.income,
        pincode: lead.pincode,
        state: lead.state,
        email: lead.email,
        channel: "obd_voice",
        disposition: lead.disposition || "contacted",
        callDuration: lead.callDuration || 0,
        dtmfChoice: lead.dtmfChoice,
        campaignId,
        batchId,
        customMetadata: lead.metadata || {},
      });

      results.push({
        phone: lead.phone,
        success: result.success,
        applicationId: result.applicationId,
        error: result.error,
      });
    }

    const successCount = results.filter((r) => r.success).length;
    res.json({
      success: true,
      campaignId,
      batchId,
      totalLeads: leads.length,
      successCount,
      failureCount: leads.length - successCount,
      results,
    });
  } catch (error) {
    console.error("Batch lead intake error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
