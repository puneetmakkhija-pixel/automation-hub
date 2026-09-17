import express from "express";
import { pollVoiceOutcomes } from "../voiceOutcomePoll.js";

const router = express.Router();

/**
 * Asking ElevenLabs what happened on our own bot's calls.
 *
 * lib/voiceOutcomePoll.js has why this is a poll and not a webhook. This file
 * is only the two doors into it.
 *
 * Both are behind CONSOLE_SECRET at the mount in index.js. /run spends API
 * requests and writes customer rows; /status lists nothing but counts, and is
 * gated with it because splitting the two would be a second credential for no
 * benefit.
 */

/**
 * POST /api/voice-poll/run  { limit? }
 *
 * Safe to call repeatedly and safe to call concurrently: every write is
 * conditioned on the disposition still being null, so a second run in flight
 * fills nothing twice. Answers 200 with what it did, including partial
 * failures -- one conversation ElevenLabs will not return is not a reason to
 * throw away the outcomes that did come back.
 */
router.post("/run", async (req, res) => {
  const limit = req.body?.limit;
  const result = await pollVoiceOutcomes({ limit });

  if (result.reason === "not_configured") {
    // 200, not 500: the service is behaving correctly, it just has no key.
    // A 500 here reads as "the poller is broken" to anything watching.
    return res.json({
      success: true,
      ran: false,
      reason: "ELEVEN_LABS_API_KEY is not set on this service",
      ...result,
    });
  }

  res.json({ success: true, ran: true, ...result });
});

/**
 * GET /api/voice-poll/status
 *
 * How many of our bot's calls still have no outcome, and how the ones that do
 * came out. The number that matters is `pending_outcome`: if it climbs and
 * never falls, either this poller is not running or every call is failing
 * before it settles.
 */
router.get("/status", async (_req, res) => {
  try {
    const { default: SupabaseClient } = await import("../supabaseClient.js");
    const sb = new SupabaseClient().client.schema("crm");

    const { data, error } = await sb
      .from("journey_run_log")
      .select("voice_disposition, voice_status")
      .eq("voice_provider", "elevenlabs");

    if (error) throw new Error(error.message);

    const rows = data ?? [];
    const byDisposition = {};
    let pending = 0;
    for (const row of rows) {
      if (row.voice_status === "sent" && row.voice_disposition == null) pending++;
      if (row.voice_disposition) {
        byDisposition[row.voice_disposition] = (byDisposition[row.voice_disposition] ?? 0) + 1;
      }
    }

    res.json({
      success: true,
      configured: Boolean(process.env.ELEVEN_LABS_API_KEY),
      total_calls: rows.length,
      pending_outcome: pending,
      by_disposition: byDisposition,
    });
  } catch (error) {
    res.status(503).json({ success: false, error: error?.message ?? String(error) });
  }
});

export default router;
