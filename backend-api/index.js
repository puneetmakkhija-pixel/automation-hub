import express from "express";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

app.get("/health", (_req, res) => res.status(200).send("ok"));

// TODO: this is a placeholder namespace. Replace with real endpoints once
// you know what the BuddyLoan/Samay frontends actually need to call —
// e.g. GET /api/loans/:id/status, POST /api/samay/reading.
app.get("/api/ping", (_req, res) => {
  res.json({ ok: true, service: "backend-api", time: new Date().toISOString() });
});

app.listen(PORT, () => console.log(`backend-api listening on ${PORT}`));
