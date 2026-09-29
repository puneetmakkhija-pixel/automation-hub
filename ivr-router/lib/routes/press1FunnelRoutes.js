import express from "express";
import { press1Funnel } from "../press1Funnel.js";
import { pacerStats } from "../dialPacer.js";
import { queueStats as pressQueueStats } from "../pressQueue.js";
import { ourBotDailyCap, ourBotEnabled, ourBotVariants } from "../ourVoiceBotDispatch.js";

const router = express.Router();

/**
 * GET /api/press1-funnel/status?date=YYYY-MM-DD
 *
 * The press-1 funnel for one IST day (default: today): how many presses
 * reached the dispatch decision, which bot each went to, how many of those
 * were actually dialled, and what stopped the rest — read back out of
 * crm.voice_dispatch. See lib/press1Funnel.js for the rollup.
 *
 * Live pacer/queue depth and the current routing config (daily cap, enabled,
 * allowed variants) ride along so a stalled funnel and its cause show up in
 * one call — same reasoning as /health's dial/press stats, just addressed at
 * this one path instead of buried in the container's log line.
 *
 * Read-only: no write, no dial. Gated behind CONSOLE_SECRET anyway because it
 * reports real call volume and outcomes, same posture as /api/voice-poll's
 * /status.
 */
router.get("/status", async (req, res) => {
  try {
    const { default: SupabaseClient } = await import("../supabaseClient.js");
    const sb = new SupabaseClient().client.schema("crm");

    const funnel = await press1Funnel(sb, { date: req.query.date });

    res.json({
      success: true,
      ...funnel,
      config: {
        our_bot_enabled: ourBotEnabled(),
        daily_cap: ourBotDailyCap(),
        variants: [...ourBotVariants()],
      },
      live: { dial: pacerStats(), press: pressQueueStats() },
    });
  } catch (error) {
    res.status(503).json({ success: false, error: error?.message ?? String(error) });
  }
});

export default router;
