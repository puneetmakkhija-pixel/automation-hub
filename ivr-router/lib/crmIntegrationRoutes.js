import express from "express";
import CrmIntegrationClient, { LEAD_STAGES, LEAD_EVENT_TYPES } from "./crmIntegrationClient.js";

/**
 * CRM Integration Routes — /api/crm/*
 *
 * Everything is addressed by LEAD. `:ref` is either a numeric crm.leads.id or a
 * phone number in any format; the client resolves it. The older
 * /application/:applicationId/* paths answer 410 with the replacement, because
 * no application_id exists for the voice side to hold — see
 * ../CRM_CLIENT_SCHEMA_GAPS.md.
 */

const router = express.Router();
let crmClient = null;

try {
  crmClient = new CrmIntegrationClient();
} catch (error) {
  console.warn("⚠️ CRM Integration Client initialization failed:", error.message);
  console.warn("   CRM features will be unavailable until configuration is complete");
}

// ==================== Health Check ====================
router.get("/health", async (_req, res) => {
  if (!crmClient) {
    return res.json({
      success: false,
      service: "crm_integration",
      status: "unavailable",
      timestamp: new Date().toISOString(),
    });
  }

  const health = await crmClient.healthCheck();
  res.json({ ...health, service: "crm_integration", timestamp: new Date().toISOString() });
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

// ==================== Lead ====================

/**
 * GET /api/crm/lead/:ref
 * Read a lead by crm.leads.id or by phone number.
 *
 * A phone matching several leads returns the most recently updated one, with
 * matchCount saying how many it could have been.
 */
router.get("/lead/:ref", async (req, res) => {
  try {
    const result = await crmClient.getLead(req.params.ref);
    res.status(result.success ? 200 : 404).json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/crm/lead/:ref/log-event
 * Append a disposition to crm.lead_events.
 *
 * Body: { disposition, details?, type? }  type defaults to "call".
 */
router.post("/lead/:ref/log-event", async (req, res) => {
  try {
    const { disposition, details, type } = req.body;

    if (!disposition) {
      return res.status(400).json({ success: false, error: "disposition is required" });
    }

    const result = await crmClient.logVoiceDisposition({
      ref: req.params.ref,
      disposition,
      details: details || {},
      type: type || "call",
    });

    res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/crm/lead/:ref/record-call
 * Write the call itself to crm.pbx_calls.
 *
 * Body: { providerCallId, provider?, metrics: { duration, talkSeconds,
 *         disposition, recordingUrl, direction } }
 *
 * providerCallId is the primary key, so re-posting the same call updates its
 * row rather than adding another.
 */
router.post("/lead/:ref/record-call", async (req, res) => {
  try {
    const { providerCallId, provider, metrics } = req.body;

    if (!providerCallId) {
      return res.status(400).json({
        success: false,
        error: "providerCallId is required — it is the primary key in crm.pbx_calls",
      });
    }

    const result = await crmClient.recordVoiceCall({
      ref: req.params.ref,
      providerCallId,
      provider: provider || "oriserve",
      metrics: metrics || {},
    });

    res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/crm/lead/:ref/update-stage
 * Move the lead's stage and record the transition.
 *
 * Body: { stage, substate? }  stage must be one of LEAD_STAGES.
 */
router.post("/lead/:ref/update-stage", async (req, res) => {
  try {
    const { stage, substate } = req.body;

    if (!stage) {
      return res.status(400).json({
        success: false,
        error: "stage is required",
        validStages: LEAD_STAGES,
      });
    }

    const result = await crmClient.updateLeadStage({
      ref: req.params.ref,
      stage,
      substate: substate ?? null,
    });

    if (!result.success && /Invalid stage/.test(result.error || "")) {
      return res.status(400).json({ ...result, validStages: LEAD_STAGES });
    }

    res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/crm/vocabulary
 * The enum values these routes accept, read from the client rather than
 * restated, so a stage rejected here can be looked up rather than guessed.
 */
router.get("/vocabulary", (_req, res) => {
  res.json({ success: true, stages: LEAD_STAGES, eventTypes: LEAD_EVENT_TYPES });
});

// ==================== Gone ====================

/**
 * The application-keyed routes. They never worked: crm.applications holds no
 * rows and the voice side has no application_id, so every one of them answered
 * success:false. 410 rather than 404 so a caller learns the replacement instead
 * of retrying a path that will never come back.
 */
// Express 4 path syntax: the bare path and its sub-paths are two patterns.
router.all(["/application/:applicationId", "/application/:applicationId/*"], (req, res) => {
  const ref = req.params.applicationId;
  res.status(410).json({
    success: false,
    error: "Applications are not addressable from the voice side; use the lead routes.",
    replacement: {
      read: `GET /api/crm/lead/${ref}`,
      logEvent: `POST /api/crm/lead/${ref}/log-event`,
      recordCall: `POST /api/crm/lead/${ref}/record-call`,
      updateStage: `POST /api/crm/lead/${ref}/update-stage`,
    },
    note: "`:ref` is a crm.leads.id or a phone number. See ivr-router/CRM_CLIENT_SCHEMA_GAPS.md.",
  });
});

/**
 * Lead intake. crm.lead_intake_sync exists but is a bulk agent-attribution
 * importer — crm.lead_intake_sync(p_secret text, p_rows jsonb), upserting
 * mobile/agent/tl/source into crm.lead_intake — not a create-application call,
 * and it returns no identifier. The code here called it with fifteen scalar
 * arguments, so it never ran. Creating leads from voice needs a decision about
 * what may write into an 80k-row book of business; until then this says so
 * rather than pretending.
 */
router.all(["/lead-intake-sync", "/batch-lead-intake"], (_req, res) => {
  res.status(501).json({
    success: false,
    error: "Lead creation from voice is not implemented.",
    reason:
      "crm.lead_intake_sync(p_secret, p_rows) is a bulk agent-attribution importer keyed on " +
      "mobile and returns no identifier. It is not a create-application endpoint, and this " +
      "service called it with a signature it does not have.",
    instead:
      "To attach a call outcome to an existing lead, use POST /api/crm/lead/:ref/log-event " +
      "or /record-call, which resolve a lead by id or phone.",
  });
});

export default router;
