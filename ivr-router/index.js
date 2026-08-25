import express from "express";
import dotenv from "dotenv";
import OBDApiClient from "./lib/obdApiClient.js";
import createObdRoutes from "./lib/obdRoutes.js";

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

// ==================== Webhook Handlers ====================
// OBD Webhook: Receives campaign events (hangup, etc.)
app.post("/webhooks/obd", (req, res) => {
  try {
    console.log("OBD Webhook received:", req.body);
    // Handle OBD events here
    // Examples: campaign completion, call hangup, etc.
    res.json({
      success: true,
      message: "Webhook received",
    });
  } catch (error) {
    console.error("Webhook error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// SMS Webhook: Receives SMS/WhatsApp callback events
app.post("/webhooks/sms", (req, res) => {
  try {
    console.log("SMS Webhook received:", req.body);
    // Handle SMS/WhatsApp events here
    res.json({
      success: true,
      message: "SMS webhook received",
    });
  } catch (error) {
    console.error("SMS webhook error:", error);
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
