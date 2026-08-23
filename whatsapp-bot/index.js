import express from "express";
import twilio from "twilio";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const client =
  process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
    ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    : null;

app.get("/health", (_req, res) => res.status(200).send("ok"));

// Twilio calls this whenever someone messages your WhatsApp number.
app.post("/whatsapp/inbound", async (req, res) => {
  const from = req.body.From; // e.g. "whatsapp:+91XXXXXXXXXX"
  const body = (req.body.Body || "").trim();

  console.log(`WhatsApp inbound from ${from}: ${body}`);

  // TODO: replace with real routing — DSA update lookup, payment reminder
  // opt-out handling, Samay horoscope subscription toggle, etc.
  const reply = `Thanks for messaging. This bot isn't wired up to real data yet.`;

  res.type("text/xml").send(`
    <Response><Message>${escapeXml(reply)}</Message></Response>
  `);
});

// Call this from data-jobs or backend-api to push an outbound message
// (payment reminder, DSA status update, Samay daily push).
app.post("/whatsapp/send", async (req, res) => {
  if (!client) return res.status(500).json({ error: "Twilio not configured" });

  const { to, body } = req.body;
  if (!to || !body) return res.status(400).json({ error: "to and body are required" });

  try {
    const msg = await client.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER, // e.g. "whatsapp:+14155238886"
      to: `whatsapp:${to}`,
      body,
    });
    res.json({ sid: msg.sid, status: msg.status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function escapeXml(s) {
  return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));
}

app.listen(PORT, () => console.log(`whatsapp-bot listening on ${PORT}`));
