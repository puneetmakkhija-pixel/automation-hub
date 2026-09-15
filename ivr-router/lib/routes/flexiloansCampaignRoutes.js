import express from "express";
import SupabaseClient from "../supabaseClient.js";
import {
  campaignCap,
  campaignEnabled,
  liveDeps,
  resolveRunCap,
  runFlexiloansCampaign,
  selectBase,
} from "../flexiloansCampaignOrchestrator.js";

/**
 * The ignition for the Flexiloans (Epimoney) broadcast.
 *
 * The orchestrator was written before this file and had no caller at all — it
 * was imported by its own test and nothing else. So the campaign could not be
 * started even with FLEXI_CAMPAIGN_ENABLED set: there was an engine and no key.
 * This is the key.
 *
 * Mounted behind CONSOLE_SECRET in index.js. Starting a broadcast spends money
 * and rings real phones, so it answers to the operator credential rather than
 * to a provider webhook secret.
 *
 *   GET  /api/flexiloans-campaign/status   what would happen, touching nothing
 *   POST /api/flexiloans-campaign/run      the pipeline
 *
 * /status exists because "is it ready" and "do it" must be different requests.
 * It reads the base and the switches and returns; it calls neither ElevenLabs
 * nor OBD, so it cannot upload, cannot spend and cannot dial.
 */
const router = express.Router();

function sb() {
  return new SupabaseClient().client.schema("crm");
}

router.get("/status", async (_req, res) => {
  try {
    const enabled = campaignEnabled();
    const cap = campaignCap();
    const rows = await selectBase(sb(), { limit: cap });

    res.json({
      ok: true,
      would_dial: enabled,
      // Named so it cannot be misread as "we called this many".
      people_in_this_run: rows.length,
      cap,
      switch: enabled
        ? "FLEXI_CAMPAIGN_ENABLED=on — a run WILL broadcast"
        : "FLEXI_CAMPAIGN_ENABLED is not 'on' — a run prepares and stops",
      obd_configured: Boolean(
        process.env.OBD_BASE_URL && process.env.OBD_USERNAME && process.env.OBD_PASSWORD
      ),
      tts_configured: Boolean(process.env.ELEVEN_LABS_API_KEY),
      sample: rows.slice(0, 3).map((r) => ({
        mobile10: r.mobile10,
        best_score: r.best_score,
        best_rank: r.best_rank,
      })),
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error?.message ?? String(error) });
  }
});

router.post("/run", async (req, res) => {
  try {
    // A cap in the body may only NARROW the run — see resolveRunCap.
    const cap = resolveRunCap(req.body?.cap, campaignCap());

    const out = await runFlexiloansCampaign(liveDeps(sb()), { cap });
    res.status(out.ok ? 200 : 502).json(out);
  } catch (error) {
    res.status(500).json({ ok: false, error: error?.message ?? String(error) });
  }
});

export default router;
