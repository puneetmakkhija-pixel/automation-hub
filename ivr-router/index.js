import express from "express";
import dotenv from "dotenv";
import OBDApiClient from "./lib/obdApiClient.js";
import createObdRoutes from "./lib/obdRoutes.js";
import { routeWebhookEvent } from "./lib/webhookHandlers.js";
import anantaRoutes from "./lib/anantaRoutes.js";
import oriserveRoutes from "./lib/oriserveRoutes.js";
import elevenLabsRoutes from "./lib/elevenLabsRoutes.js";
import pincodeRoutes from "./lib/pincodeRoutes.js";
import poonawalaaCampaignRoutes from "./lib/poonawalaaCampaignRoutes.js";
import crmIntegrationRoutes from "./lib/crmIntegrationRoutes.js";
import lenderRoutingRoutes from "./lib/lenderRoutingRoutes.js";
import whatsappBotRoutes from "./lib/routes/whatsappBotRoutes.js";
import { verifyWebhookSecret } from "./lib/middleware/verifyWebhookSecret.js";
import ivrWhatsAppRoutes from "./lib/routes/ivrWhatsAppRoutes.js";
import plTrackerRoutes from "./lib/routes/plTrackerRoutes.js";
import intentGenerationRoutes from "./lib/routes/intentGenerationRoutes.js";
import applicationPushRoutes from "./lib/routes/applicationPushRoutes.js";
import rejectionTrackingRoutes from "./lib/routes/rejectionTrackingRoutes.js";
import suppressionAnalysisRoutes from "./lib/routes/suppressionAnalysisRoutes.js";
import reengagementRoutes from "./lib/routes/reengagementRoutes.js";
import breShortlistingRoutes from "./lib/routes/breShortlistingRoutes.js";
import ivrCampaignRouterRoutes from "./lib/routes/ivrCampaignRouterRoutes.js";
import misFeedbackCollectorRoutes from "./lib/routes/misFeedbackCollectorRoutes.js";
import anantaConfigRoutes from "./lib/routes/anantaConfigRoutes.js";
import whatsappFlowRoutes from "./lib/routes/whatsappFlowRoutes.js";
import flexiloansDocumentRoutes from "./lib/routes/flexiloansDocumentRoutes.js";
import SupabaseClient from "./lib/supabaseClient.js";
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

// Initialize Supabase client (used to persist voice call outcomes)
let db = null;
try {
  db = new SupabaseClient();
} catch (error) {
  console.warn('⚠️ Supabase client initialization failed:', error.message);
  console.warn('   Voice call outcomes will be logged but not persisted');
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
// GUARDED. This router drives the dialler: it can create campaigns, upload lead
// bases, repoint the panel's webhooks, and pause or STOP a campaign that is
// mid-flight. It was reachable by anyone who knew the URL — the same exposure
// the console guards below were added to close, on the one router that can
// spend money and halt live traffic. /api/obd was simply missed in that pass.
//
// Two details worth keeping:
//
// NO onlyPaths, so the whole router is locked rather than a named list of
// paths. Everywhere else in this file the guard names what to lock, and a route
// added later inherits no protection — which is exactly how this hole stayed
// open. On this router the default has to be locked.
//
// MOUNTED HERE, not down with the other guarded mounts, because "/api"
// (whatsappBotRoutes) is a broader prefix registered below: moving this line
// past it would let that router see /api/obd/* first. consoleAuth is a function
// declaration and so is hoisted — it is defined further down, next to the other
// guards, and reading it there is the point.
//
// Nothing external calls this. The /api/obd/* paths in lib/obdApiClient.js are
// the VENDOR's own surface on obdapi2.ivrsms.com, a coincidence of naming, not
// a caller of ours.
app.use("/api/obd", consoleAuth("CONSOLE_OBD"), createObdRoutes(obdClient));

// ==================== Ananta API Routes ====================
app.use("/api/ananta", anantaRoutes);

// ==================== Oriserve Voice Agent Routes ====================
app.use("/api/oriserve", oriserveRoutes);

// ==================== Retired: /api/db, /api/ivr-campaigns, /api/lenders, /api/recordings
//
// Four CRUD routers came off on 1 Sep 2026. They were mounted and reachable —
// this is not the "unreachable code" of PR #32 — but they wrote to tables that
// are empty, absent, or owned by the CRM:
//
//   /api/db            customers (0 rows) + campaigns and campaign_results,
//                      neither of which exists in the database at all
//   /api/ivr-campaigns ivr_campaigns, 0 rows, read by nothing else here
//   /api/lenders       public.lenders, 5 rows, against crm.lenders' 13
//   /api/recordings    ivr_recordings, a table that has never existed
//
// Lenders live in the CRM (crm.lenders, crm.lender_bre, crm.lender_pincode and
// the rest); campaigns are moving to crm.campaign. The dashboard tabs that
// called these went with them, so nothing in this repo asks for them now.
// See ../docs/RETIRED_ENDPOINTS.md.

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

// ==================== Operator console authentication ====================
//
// /console is an operator dashboard that TAKES ACTIONS — it can start the daily
// shortlist, push journeys and process MIS reports. It was reachable by anyone
// who knew the URL, as were the endpoints behind it.
//
// CONSOLE_SECRET rather than ANANTA_WEBHOOK_SECRET: operators should not have
// to hold the credential the providers post with, and either should be
// rotatable without disturbing the other.
//
// Each guard names the exact paths to lock. Everything else on these routers
// stays as it is — /health for uptime checks, /config, the lender MIS webhooks
// and voice-disposition, none of which the console calls and all of which have
// callers outside our control.
function consoleAuth(label, onlyPaths) {
  return verifyWebhookSecret("CONSOLE_SECRET", label, { failClosed: true, onlyPaths });
}

// ==================== BRE Shortlisting Routes (Daily Base Filtering) ====================
app.use(
  "/api/bre",
  consoleAuth("CONSOLE_BRE", [
    /^\/run-daily-shortlist$/,
    /^\/shortlist\//,
    /^\/mark-dispatched$/,
  ]),
  breShortlistingRoutes
);

// ==================== IVR Campaign Router Routes (Dual-Path Routing) ====================
app.use(
  "/api/router",
  consoleAuth("CONSOLE_ROUTER", [
    /^\/document-journey$/,
    /^\/diy-journey$/,
    /^\/lender-rejection$/,
  ]),
  ivrCampaignRouterRoutes
);

// ==================== MIS Feedback Collector Routes (Lender Rejection Feedback) ====================
// /webhook/poonawalla and /webhook/hero-fincorp are LENDER-FACING and stay
// open: locking them would break the feedback those lenders post to us.
app.use(
  "/api/mis",
  consoleAuth("CONSOLE_MIS", [
    /^\/process-report$/,
    /^\/bre-optimization-report\//,
    /^\/customer\//,
  ]),
  misFeedbackCollectorRoutes
);

// ==================== Ananta WhatsApp Configuration Routes ====================
app.use("/api/ananta", anantaConfigRoutes);

// ==================== WhatsApp Chatbot Flow Routes ====================
app.use("/api/whatsapp/flow", whatsappFlowRoutes);

// ==================== FlexiLoans Document Submission Routes ====================
app.use("/api/flexiloans", flexiloansDocumentRoutes);

// IVR keypress -> WhatsApp, direct. voice2.ivrsms.com posts its call payload
// here; a mapped DTMF digit sends the matching Ananta template.
app.use("/webhooks/ivr", ivrWhatsAppRoutes);

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

/**
 * Verification probe.
 *
 * Provider panels commonly GET a webhook URL before they will save it, and
 * this one answered 404 to that — four such probes arrived on 2 Sep. A 404
 * reads to a panel as "there is nothing here", which can block the URL from
 * being accepted at all.
 *
 * It is deliberately unauthenticated: it accepts nothing, writes nothing, and
 * discloses nothing a caller did not already know by holding the URL. Requiring
 * the secret here would defeat the point, since a panel that probes before
 * saving has not been given the token yet. POST — the only method that carries
 * data — keeps its shared secret.
 *
 * `challenge` / `hub.challenge` is echoed back as plain text when present,
 * which is the convention most panels use to confirm they reached the right
 * endpoint. It is bounded and character-restricted so the echo cannot be used
 * to reflect arbitrary content.
 */
app.get("/webhooks/oriserve", (req, res) => {
  const challenge = req.query.challenge ?? req.query["hub.challenge"];

  if (typeof challenge === "string" && /^[\w.-]{1,256}$/.test(challenge)) {
    return res.type("text/plain").send(challenge);
  }

  res.json({
    success: true,
    service: "oriserve_voice_callback",
    message: "Endpoint is live. Send call outcomes as POST with Content-Type: application/json.",
    method: "POST",
    timestamp: new Date().toISOString(),
  });
});

// Oriserve voice agent campaign callbacks
app.post("/webhooks/oriserve", verifyWebhookSecret("ORISERVE_WEBHOOK_SECRET", "ORISERVE"), async (req, res) => {
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

    // Persist the outcome. A storage failure is reported, never thrown: the
    // call already happened and Oriserve cannot usefully replay the callback.
    let saved = { success: false, errors: ['supabase client not configured'] };
    if (db) {
      saved = await db.logVoiceCallOutcome({ provider: 'oriserve', payload });
    }

    if (!saved.success) {
      logger.log('error', 'ORISERVE_CALLBACK_NOT_SAVED', 'Oriserve callback could not be persisted', {
        campaignId: payload.campaign_id,
        phone: payload.mobile,
        errors: saved.errors,
        type: 'voice_provider_callback',
      });
    }

    res.json({
      success: true,
      message: "Oriserve webhook received and processed",
      saved: {
        webhook_events: saved.webhookEvent === true,
        voice_call_events: saved.voiceCallEvent === true,
        errors: saved.errors?.length ? saved.errors : undefined,
      },
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
// Load it as /console?token=<CONSOLE_SECRET> — the page stores the token and
// sends it as a header on every call it makes afterwards.
app.get('/console', consoleAuth('CONSOLE_PAGE', null), (req, res) => {
  res.sendFile('public/console.html', { root: __dirname });
});

// ==================== Personal Loans — IVR press-1 tracker ====================
//
// Poonawalla and Hero Fincorp are a different product from Business Loans: the
// press sends the customer into that lender's own journey, so nothing reaches
// the CRM and no cockpit screen reports on it. public.whatsapp_messages — this
// service's own send log — is the only record, and until now nothing read it.
//
// Behind CONSOLE_SECRET, and failClosed, because every row is a customer's
// mobile number. Load it as /personal-loans?token=<CONSOLE_SECRET>; the page
// keeps the token and sends it as a header, the same way the console does.
app.get('/personal-loans', consoleAuth('CONSOLE_PL_PAGE', null), (req, res) => {
  res.sendFile('public/personal-loans.html', { root: __dirname });
});
app.use('/api/pl-tracker', consoleAuth('CONSOLE_PL_API', null), plTrackerRoutes);

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
