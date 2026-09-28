import express from "express";
import SupabaseClient from "../supabaseClient.js";
import { catchupCandidates, catchupLimit, runPress1Catchup } from "../press1Catchup.js";

/**
 * The ignition for the press1-catchup sweep. Mounted behind CONSOLE_SECRET in
 * index.js, same as the Flexiloans campaign and BRE shortlisting routes —
 * this places real calls, so it answers to the operator credential rather
 * than to a provider webhook secret.
 *
 *   GET  /api/press1-catchup/status   who would be called, touching nothing
 *   POST /api/press1-catchup/run      the sweep
 *
 * /status exists for the same reason it does on the Flexiloans campaign: "is
 * there anyone to catch up on" and "call them" must be different requests.
 */
const router = express.Router();

function sb() {
  return new SupabaseClient().client.schema("crm");
}

router.get("/status", async (_req, res) => {
  try {
    const limit = Number(_req.query.limit) || catchupLimit();
    const candidates = await catchupCandidates(sb(), { limit });
    res.json({
      ok: true,
      candidates: candidates.length,
      limit,
      // The full list only up to a sane page: this is an operator screen, not
      // a bulk export, and the run itself re-reads candidates fresh anyway.
      oldest_first: candidates.slice(0, 25).map((c) => ({
        mobile10: c.mobile10,
        first_pressed_at: c.first_pressed_at,
      })),
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error?.message ?? String(error) });
  }
});

router.post("/run", async (req, res) => {
  try {
    const limit = Number(req.query.limit ?? req.body?.limit) || undefined;
    const report = await runPress1Catchup({ limit });
    res.status(report.ok ? 200 : 500).json(report);
  } catch (error) {
    res.status(500).json({ ok: false, error: error?.message ?? String(error) });
  }
});

export default router;
