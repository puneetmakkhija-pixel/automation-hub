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

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const istHour = (iso) => new Date(new Date(iso).getTime() + IST_OFFSET_MS).getUTCHours();

/**
 * GET /api/press1-funnel/non-engaged-breakdown?days=7
 *
 * One-off diagnostic: when do our-bot dispatch attempts land by hour-of-day
 * (IST), how many attempts per mobile10, and how connect/no-connect on
 * crm.voice_call_events splits by hour. Answers whether the non-engaged
 * bucket is a dial-time-window or retry-cadence problem rather than a bot
 * script problem. Read-only, same CONSOLE_PRESS1_FUNNEL gate as /status.
 *
 * TEMPORARY: added for one investigation, remove once answered.
 */
router.get("/non-engaged-breakdown", async (req, res) => {
  try {
    const { default: SupabaseClient } = await import("../supabaseClient.js");
    const sb = new SupabaseClient().client.schema("crm");
    const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 30);
    const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const [dispatchR, callsR] = await Promise.all([
      sb
        .from("voice_dispatch")
        .select("mobile10, created_at")
        .eq("provider", "ours")
        .eq("dispatched", true)
        .gte("created_at", sinceIso),
      sb
        .from("voice_call_events")
        .select("mobile10, duration_sec, received_at")
        .eq("provider", "elevenlabs")
        .gte("received_at", sinceIso),
    ]);
    if (dispatchR.error) throw new Error(dispatchR.error.message);
    if (callsR.error) throw new Error(callsR.error.message);

    const byHourDispatch = Array(24).fill(0);
    const attemptsByMobile = new Map();
    for (const row of dispatchR.data ?? []) {
      byHourDispatch[istHour(row.created_at)]++;
      attemptsByMobile.set(row.mobile10, (attemptsByMobile.get(row.mobile10) ?? 0) + 1);
    }
    const attemptCountHistogram = {};
    for (const n of attemptsByMobile.values()) {
      const key = n >= 3 ? "3+" : String(n);
      attemptCountHistogram[key] = (attemptCountHistogram[key] ?? 0) + 1;
    }

    const byHourConnected = Array(24).fill(0);
    const byHourNotConnected = Array(24).fill(0);
    let connected = 0;
    for (const row of callsR.data ?? []) {
      const h = istHour(row.received_at);
      if (Number(row.duration_sec ?? 0) > 0) {
        byHourConnected[h]++;
        connected++;
      } else {
        byHourNotConnected[h]++;
      }
    }
    const totalCalls = (callsR.data ?? []).length;

    res.json({
      success: true,
      window_days: days,
      dispatch: {
        total_attempts: (dispatchR.data ?? []).length,
        unique_mobiles: attemptsByMobile.size,
        by_hour_ist: byHourDispatch,
        attempt_count_histogram: attemptCountHistogram,
      },
      calls: {
        total: totalCalls,
        connected,
        not_connected: totalCalls - connected,
        connect_rate: totalCalls ? connected / totalCalls : 0,
        by_hour_ist: { connected: byHourConnected, not_connected: byHourNotConnected },
      },
    });
  } catch (error) {
    res.status(503).json({ success: false, error: error?.message ?? String(error) });
  }
});

export default router;
