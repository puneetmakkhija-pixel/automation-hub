import express from "express";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Railway healthcheck
app.get("/health", (_req, res) => res.status(200).send("ok"));

// Twilio calls this when a call comes in to your IVR number.
// Twilio sends form-encoded params (From, To, Digits, CallSid, ...).
app.post("/voice", (req, res) => {
  const digits = req.body.Digits;

  // TODO: replace this with your real menu. Keep responses as TwiML.
  // Docs: https://www.twilio.com/docs/voice/twiml
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
    // TODO: look up the caller's loan status (by From number) and say it,
    // or hand off to the ElevenLabs voice agent for a conversational flow.
    res.type("text/xml").send(`
      <Response>
        <Say>Loan status lookup is not wired up yet. Goodbye.</Say>
      </Response>
    `);
    return;
  }

  if (digits === "2") {
    // TODO: <Dial> to a real number, or <Redirect> into an ElevenLabs
    // Agent phone number for a full conversational handoff.
    res.type("text/xml").send(`
      <Response>
        <Say>Connecting you to an agent is not wired up yet. Goodbye.</Say>
      </Response>
    `);
    return;
  }

  res.type("text/xml").send(`<Response><Say>Invalid option. Goodbye.</Say></Response>`);
});

app.listen(PORT, () => console.log(`ivr-router listening on ${PORT}`));
