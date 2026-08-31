import express from "express";
import dotenv from "dotenv";
import OBDApiClient from "./lib/obdApiClient.js";
import createObdRoutes from "./lib/obdRoutes.js";
import { routeWebhookEvent } from "./lib/webhookHandlers.js";
import anantaRoutes from "./lib/anantaRoutes.js";
import oriserveRoutes from "./lib/oriserveRoutes.js";
import chatsenseRoutes from "./lib/chatsenseRoutes.js";
import supabaseRoutes from "./lib/supabaseRoutes.js";
import elevenLabsRoutes from "./lib/elevenLabsRoutes.js";
import pincodeRoutes from "./lib/pincodeRoutes.js";
import poonawalaaCampaignRoutes from "./lib/poonawalaaCampaignRoutes.js";
import crmIntegrationRoutes from "./lib/crmIntegrationRoutes.js";
import lenderRoutingRoutes from "./lib/lenderRoutingRoutes.js";
import whatsappBotRoutes from "./lib/routes/whatsappBotRoutes.js";
import { verifyWebhookSecret } from "./lib/middleware/verifyWebhookSecret.js";
import intentGenerationRoutes from "./lib/routes/intentGenerationRoutes.js";
import applicationPushRoutes from "./lib/routes/applicationPushRoutes.js";
import rejectionTrackingRoutes from "./lib/routes/rejectionTrackingRoutes.js";
import suppressionAnalysisRoutes from "./lib/routes/suppressionAnalysisRoutes.js";
import reengagementRoutes from "./lib/routes/reengagementRoutes.js";
import breShortlistingRoutes from "./lib/routes/breShortlistingRoutes.js";
import ivrCampaignRouterRoutes from "./lib/routes/ivrCampaignRouterRoutes.js";
import ivrCampaignsRoutes from "./lib/routes/ivrCampaignsRoutes.js";
import lendersRoutes from "./lib/routes/lendersRoutes.js";
import misFeedbackCollectorRoutes from "./lib/routes/misFeedbackCollectorRoutes.js";
import recordingRoutes from "./lib/routes/recordingRoutes.js";
import anantaConfigRoutes from "./lib/routes/anantaConfigRoutes.js";
import whatsappFlowRoutes from "./lib/routes/whatsappFlowRoutes.js";
import flexiloansDocumentRoutes from "./lib/routes/flexiloansDocumentRoutes.js";
import logger from "./lib/logging.js";

dotenv.config();

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Initialize OBD API Client
let obdClient = null;
try {
  obdClient = new OBDApiClient(
    process.env.OBD_BASE_URL || "https://obdapi2.ivrsms.com",
    process.env.OBD_USERNAME,
    process.env.OBD_PASSWORD
  );
} catch (error) {
  console.warn('⚠️ OBD API Client initialization failed:', error.message);
  console.warn('   OBD voice calling features will be unavailable until configuration is complete');
}

// ==================== Health Check ====================
app.get("/health", (_req, res) => {
  try {
    if (logger) {
      logger.log('info', 'HEALTH_CHECK', 'Service health check', {
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        type: 'health',
      });
    }
  } catch (logError) {
    console.warn('Health check logging failed:', logError.message);
  }
  res.status(200).send("ok");
});

// ==================== OBD API Routes ====================
app.use("/api/obd", createObdRoutes(obdClient));

// ==================== Ananta API Routes ====================
app.use("/api/ananta", anantaRoutes);

// ==================== Oriserve Voice Agent Routes ====================
app.use("/api/oriserve", oriserveRoutes);

// ==================== Chatsense API Routes ====================
app.use("/api/chatsense", chatsenseRoutes);

// ==================== Supabase Database Routes ====================
app.use("/api/db", supabaseRoutes);

// ==================== Eleven Labs Voice Generation Routes ====================
app.use("/api/voice", elevenLabsRoutes);

// ==================== Pincode Gating & Eligibility Routes ====================
app.use("/api/gating", pincodeRoutes);

// ==================== Poonawala Campaign Orchestration Routes ====================
app.use("/api/poonawala/campaign", poonawalaaCampaignRoutes);

// ==================== CRM Integration Routes (Phase 1: Lead Intake) ====================
app.use("/api/crm", crmIntegrationRoutes);

// ==================== Lender Routing Routes (Phase 2: Eligibility & Multi-Lender) ====================
app.use("/api/routing", lenderRoutingRoutes);

// ==================== WhatsApp Bot Routes (Phase 3a: Conversation State Machine) ====================
app.use("/api", whatsappBotRoutes);

// ==================== Intent Generation Routes (Phase 3.5a: LLM Intelligence) ====================
app.use("/api/llm", intentGenerationRoutes);

// ==================== Application Push Routes (Phase 3.5b: Multi-Channel Orchestration) ====================
app.use("/api/push", applicationPushRoutes);

// ==================== Rejection Tracking Routes (Phase 3.5c: Lender Feedback) ====================
app.use("/api/rejections", rejectionTrackingRoutes);

// ==================== Suppression & Recalibration Routes (Phase 3.5d: Rule Optimization) ====================
app.use("/api/suppression", suppressionAnalysisRoutes);

// ==================== Re-engagement Campaign Routes (Phase 3.5e: Feedback Loop Closer) ====================
app.use("/api/reengagement", reengagementRoutes);

// ==================== BRE Shortlisting Routes (Daily Base Filtering) ====================
app.use("/api/bre", breShortlistingRoutes);

// ==================== IVR Campaign Router Routes (Dual-Path Routing) ====================
app.use("/api/router", ivrCampaignRouterRoutes);

// ==================== IVR Campaigns Management Routes (Campaign CRUD) ====================
app.use("/api/ivr-campaigns", ivrCampaignsRoutes);

// ==================== Lenders Management Routes ====================
app.use("/api/lenders", lendersRoutes);

// ==================== MIS Feedback Collector Routes (Lender Rejection Feedback) ====================
app.use("/api/mis", misFeedbackCollectorRoutes);

// ==================== Recording Management Routes ====================
app.use("/api/recordings", recordingRoutes);

// ==================== Ananta WhatsApp Configuration Routes ====================
app.use("/api/ananta", anantaConfigRoutes);

// ==================== WhatsApp Chatbot Flow Routes ====================
app.use("/api/whatsapp/flow", whatsappFlowRoutes);

// ==================== FlexiLoans Document Submission Routes ====================
app.use("/api/flexiloans", flexiloansDocumentRoutes);

// ==================== Voice Webhook Handlers ====================
// Main OBD Webhook: Processes voice call events
app.post("/webhooks/obd", (req, res) => {
  try {
    const { eventType, payload } = req.body;
    const startTime = Date.now();

    if (!eventType || !payload) {
      return res.status(400).json({
        success: false,
        error: 'eventType and payload are required',
      });
    }

    const result = routeWebhookEvent(eventType, payload);
    const duration = Date.now() - startTime;

    if (eventType === 'CALL_CONNECT' && payload.phone) {
      logger.logIncomingCall(payload.phone, payload.lenderId, payload.callSid);
    } else if (eventType === 'DTMF' && payload.phone) {
      logger.logDTMFInput(payload.phone, payload.dtmfInput, payload.lenderId);
    } else if (payload.phone) {
      logger.log('info', `OBD_${eventType}`, `OBD webhook received`, {
        eventType,
        phone: payload.phone,
        durationMs: duration,
        type: 'webhook_event',
      });
    }

    logger.logApiLatency(`/webhooks/obd/${eventType}`, duration);

    res.json({
      success: true,
      message: "Webhook processed",
      data: result,
    });
  } catch (error) {
    logger.logWebhookError('OBD', error, req.body);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Specific hangup endpoint
app.post("/webhooks/obd/hangup", (req, res) => {
  try {
    const result = routeWebhookEvent("HANGUP", req.body);
    const { phone, callDuration, reason } = req.body;
    logger.logCallHangup(phone, callDuration, reason || 'normal');
    res.json({ success: true, data: result });
  } catch (error) {
    logger.logWebhookError('OBD_HANGUP', error, req.body);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Specific call connect endpoint
app.post("/webhooks/obd/connect", (req, res) => {
  try {
    const result = routeWebhookEvent("CALL_CONNECT", req.body);
    const { phone, lenderId, callSid } = req.body;
    logger.logIncomingCall(phone, lenderId, callSid);
    res.json({ success: true, data: result });
  } catch (error) {
    logger.logWebhookError('OBD_CONNECT', error, req.body);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Specific completion endpoint
app.post("/webhooks/obd/completion", (req, res) => {
  try {
    const result = routeWebhookEvent("CAMPAIGN_COMPLETE", req.body);
    logger.log('info', 'CAMPAIGN_COMPLETION', 'Campaign completed', {
      phone: req.body.phone,
      campaignId: req.body.campaignId,
      type: 'campaign_event',
    });
    res.json({ success: true, data: result });
  } catch (error) {
    logger.logWebhookError('OBD_COMPLETION', error, req.body);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== SMS/WhatsApp Webhook Handlers ====================
// Main SMS Webhook: Processes SMS/WhatsApp delivery events
app.post("/webhooks/sms", (req, res) => {
  try {
    const { eventType, payload } = req.body;
    const startTime = Date.now();

    if (!eventType || !payload) {
      return res.status(400).json({
        success: false,
        error: 'eventType and payload are required',
      });
    }

    const result = routeWebhookEvent(eventType, payload);
    const duration = Date.now() - startTime;

    if (eventType === 'WHATSAPP_SEND' && payload.phone) {
      logger.logWhatsAppSent(payload.phone, payload.message);
    } else if (payload.phone) {
      logger.log('info', `SMS_${eventType}`, 'SMS/WhatsApp event', {
        eventType,
        phone: payload.phone,
        status: payload.status,
        durationMs: duration,
        type: 'sms_event',
      });
    }

    logger.logApiLatency(`/webhooks/sms/${eventType}`, duration);

    res.json({
      success: true,
      message: "SMS webhook processed",
      data: result,
    });
  } catch (error) {
    logger.logWebhookError('SMS', error, req.body);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Specific WhatsApp endpoint
app.post("/webhooks/sms/whatsapp", (req, res) => {
  try {
    const result = routeWebhookEvent("WHATSAPP_DELIVERY", req.body);
    const { phone, messageId, status } = req.body;
    logger.logWhatsAppSent(phone, messageId);
    res.json({ success: true, data: result });
  } catch (error) {
    logger.logWebhookError('WHATSAPP', error, req.body);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Specific SMS confirmation endpoint
app.post("/webhooks/sms/confirmation", (req, res) => {
  try {
    const result = routeWebhookEvent("SMS_DELIVERY", req.body);
    logger.log('info', 'SMS_CONFIRMED', 'SMS delivery confirmed', {
      phone: req.body.phone,
      messageId: req.body.messageId,
      type: 'sms_delivery',
    });
    res.json({ success: true, data: result });
  } catch (error) {
    logger.logWebhookError('SMS_CONFIRMATION', error, req.body);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== Ananta Webhook Handlers ====================
// Ananta WhatsApp delivery webhook
// Delivery receipts from Ananta. Gated on ANANTA_WEBHOOK_SECRET; unauthenticated
// while that variable is unset (see lib/middleware/verifyWebhookSecret.js).
app.post("/webhooks/ananta", verifyWebhookSecret("ANANTA_WEBHOOK_SECRET", "ANANTA"), (req, res) => {
  try {
    const payload = req.body;
    logger.logAnantaMessage(payload.phone, payload.status, payload.msgid);

    res.json({
      success: true,
      message: "Ananta webhook received and processed",
      data: {
        phone: payload.phone,
        status: payload.status,
        messageId: payload.msgid,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    logger.logWebhookError('ANANTA', error, req.body);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ==================== Oriserve Webhook Handlers ====================
// Oriserve voice agent campaign callbacks
app.post("/webhooks/oriserve", (req, res) => {
  try {
    const payload = req.body;
    logger.logOriserveCall(payload.mobile, payload.campaign_id, payload.status);

    logger.log('info', 'ORISERVE_CALLBACK', 'Oriserve voice agent campaign callback', {
      campaignId: payload.campaign_id,
      phone: payload.mobile,
      status: payload.status,
      callDuration: payload.call_duration,
      result: payload.result,
      type: 'voice_provider_callback',
    });

    res.json({
      success: true,
      message: "Oriserve webhook received and processed",
      data: {
        campaign_id: payload.campaign_id,
        mobile: payload.mobile,
        status: payload.status,
        call_duration: payload.call_duration,
        result: payload.result,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    logger.logWebhookError('ORISERVE', error, req.body);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ==================== Chatsense Webhook Handlers ====================
// Chatsense message delivery webhooks
app.post("/webhooks/chatsense", (req, res) => {
  try {
    const payload = req.body;
    logger.log('info', 'CHATSENSE_DELIVERY', 'Chatsense message delivery event', {
      phone: payload.phone,
      status: payload.status,
      messageId: payload.messageId,
      templateName: payload.templateName,
      type: 'chatsense_event',
    });

    res.json({
      success: true,
      message: "Chatsense webhook received and processed",
      data: {
        phone: payload.phone,
        status: payload.status,
        messageId: payload.messageId,
        templateName: payload.templateName,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    logger.logWebhookError('CHATSENSE', error, req.body);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ==================== Twilio IVR (Legacy) ====================
// Twilio calls this when a call comes in to your IVR number.
// Twilio sends form-encoded params (From, To, Digits, CallSid, ...).
app.post("/voice", (req, res) => {
  const digits = req.body.Digits;

  if (!digits) {
    res.type("text/xml").send(`
      <Response>
        <Gather numDigits="1" action="/voice" method="POST" timeout="6">
          <Say voice="Polly.Aditi" language="en-IN">
            Welcome to BuddyLoan support.
            Press 1 for loan status.
            Press 2 to speak with an agent.
          </Say>
        </Gather>
        <Say>We did not receive any input. Goodbye.</Say>
      </Response>
    `);
    return;
  }

  if (digits === "1") {
    res.type("text/xml").send(`
      <Response>
        <Say>Loan status lookup is not wired up yet. Goodbye.</Say>
      </Response>
    `);
    return;
  }

  if (digits === "2") {
    res.type("text/xml").send(`
      <Response>
        <Say>Connecting you to an agent is not wired up yet. Goodbye.</Say>
      </Response>
    `);
    return;
  }

  res.type("text/xml").send(`<Response><Say>Invalid option. Goodbye.</Say></Response>`);
});

// ==================== Monitoring Console ====================
import { fileURLToPath } from 'url';
import { dirname } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
app.get('/console', (req, res) => {
  res.sendFile('public/console.html', { root: __dirname });
});

const server = app.listen(PORT, () => {
  logger.log('info', 'SERVICE_START', 'IVR Router service started', {
    port: PORT,
    obdApiUrl: process.env.OBD_BASE_URL,
    nodeEnv: process.env.NODE_ENV,
    logLevel: process.env.LOG_LEVEL,
    type: 'service_startup',
  });
  console.log(`✓ IVR Router listening on ${PORT}`);
  console.log(`✓ OBD API configured at ${process.env.OBD_BASE_URL}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.log('info', 'SHUTDOWN_SIGNAL', 'SIGTERM received, graceful shutdown initiated', {
    type: 'shutdown',
  });
  server.close(() => {
    logger.log('info', 'SERVICE_STOP', 'IVR Router service stopped', {
      type: 'service_shutdown',
    });
    process.exit(0);
  });
});
