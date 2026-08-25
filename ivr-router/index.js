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
import intentGenerationRoutes from "./lib/routes/intentGenerationRoutes.js";
import applicationPushRoutes from "./lib/routes/applicationPushRoutes.js";
import rejectionTrackingRoutes from "./lib/routes/rejectionTrackingRoutes.js";

dotenv.config();

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Initialize OBD API Client
const obdClient = new OBDApiClient(
  process.env.OBD_BASE_URL || "https://obdapi2.ivrsms.com",
  process.env.OBD_USERNAME,
  process.env.OBD_PASSWORD
);

// ==================== Health Check ====================
app.get("/health", (_req, res) => res.status(200).send("ok"));

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

// ==================== Voice Webhook Handlers ====================
// Main OBD Webhook: Processes voice call events
app.post("/webhooks/obd", (req, res) => {
  try {
    const { eventType, payload } = req.body;
    console.log(`\n[${new Date().toISOString()}] Webhook: ${eventType}`);

    const result = routeWebhookEvent(eventType, payload);

    res.json({
      success: true,
      message: "Webhook processed",
      data: result,
    });
  } catch (error) {
    console.error("Voice webhook error:", error);
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
    res.json({ success: true, data: result });
  } catch (error) {
    console.error("Hangup webhook error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Specific call connect endpoint
app.post("/webhooks/obd/connect", (req, res) => {
  try {
    const result = routeWebhookEvent("CALL_CONNECT", req.body);
    res.json({ success: true, data: result });
  } catch (error) {
    console.error("Call connect webhook error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Specific completion endpoint
app.post("/webhooks/obd/completion", (req, res) => {
  try {
    const result = routeWebhookEvent("CAMPAIGN_COMPLETE", req.body);
    res.json({ success: true, data: result });
  } catch (error) {
    console.error("Completion webhook error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== SMS/WhatsApp Webhook Handlers ====================
// Main SMS Webhook: Processes SMS/WhatsApp delivery events
app.post("/webhooks/sms", (req, res) => {
  try {
    const { eventType, payload } = req.body;
    console.log(`\n[${new Date().toISOString()}] SMS Webhook: ${eventType}`);

    const result = routeWebhookEvent(eventType, payload);

    res.json({
      success: true,
      message: "SMS webhook processed",
      data: result,
    });
  } catch (error) {
    console.error("SMS webhook error:", error);
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
    res.json({ success: true, data: result });
  } catch (error) {
    console.error("WhatsApp webhook error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Specific SMS confirmation endpoint
app.post("/webhooks/sms/confirmation", (req, res) => {
  try {
    const result = routeWebhookEvent("SMS_DELIVERY", req.body);
    res.json({ success: true, data: result });
  } catch (error) {
    console.error("SMS confirmation webhook error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== Ananta Webhook Handlers ====================
// Ananta WhatsApp delivery webhook
app.post("/webhooks/ananta", (req, res) => {
  try {
    const payload = req.body;
    console.log(`\n[${new Date().toISOString()}] Ananta Webhook - Phone: ${payload.phone}, Status: ${payload.status}`);

    // Parse and process Ananta webhook
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
    console.error("Ananta webhook error:", error);
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
    console.log(`\n[${new Date().toISOString()}] Oriserve Webhook - Campaign: ${payload.campaign_id}, Phone: ${payload.mobile}, Status: ${payload.status}`);

    // Parse and process Oriserve webhook
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
    console.error("Oriserve webhook error:", error);
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
    console.log(`\n[${new Date().toISOString()}] Chatsense Webhook - Phone: ${payload.phone}, Status: ${payload.status}`);

    // Parse and process Chatsense webhook
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
    console.error("Chatsense webhook error:", error);
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

app.listen(PORT, () => {
  console.log(`IVR Router listening on ${PORT}`);
  console.log(`OBD API configured at ${process.env.OBD_BASE_URL}`);
});
