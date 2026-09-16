import express from "express";
import SupabaseClient from "../supabaseClient.js";
import {
  campaignCap,
  campaignEnabled,
  countDialable,
  liveDeps,
  resolveRunCap,
  runFlexiloansCampaign,
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
    // Counted, not fetched: at the owner's volume, fetching the list to measure
    // it would make a readiness check take as long as the run it reports on.
    const dialable = await countDialable(sb());

    res.json({
      ok: true,
      would_dial: enabled,
      // Named so it cannot be misread as "we called this many".
      people_in_this_run: Math.min(dialable, cap),
      dialable_in_base: dialable,
      days_to_work_the_base: dialable > 0 ? Math.ceil(dialable / cap) : 0,
      cap,
      switch: enabled
        ? "FLEXI_CAMPAIGN_ENABLED=on — a run WILL broadcast"
        : "FLEXI_CAMPAIGN_ENABLED is not 'on' — a run prepares and stops",
      obd_configured: Boolean(
        process.env.OBD_BASE_URL && process.env.OBD_USERNAME && process.env.OBD_PASSWORD
      ),
      tts_configured: Boolean(process.env.ELEVEN_LABS_API_KEY),
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error?.message ?? String(error) });
  }
});

router.post("/run", async (req, res) => {
  try {
    // A cap in the body may only NARROW the run — see resolveRunCap.
    const cap = resolveRunCap(req.body?.cap, campaignCap());

    // testMobile / testMobiles dials exactly those numbers and never the base.
    // Hearing the recording once, on a number you own, before it goes to
    // 25,000 strangers is the step this pipeline has never had.
    //
    // Passed through as given: the orchestrator decides what is a valid test
    // and REFUSES a test that resolves to nobody, rather than letting a typo
    // fall through to a broadcast.
    const out = await runFlexiloansCampaign(liveDeps(sb()), {
      cap,
      ...(req.body?.testMobiles !== undefined ? { testMobiles: req.body.testMobiles } : {}),
      ...(req.body?.testMobile !== undefined ? { testMobile: req.body.testMobile } : {}),
      // The dialler refuses the base upload both with contactList: "null" and
      // with the field absent, and says nothing useful either way. Until the
      // right value is known it is probeable from here rather than baked in.
      ...(req.body?.contactList !== undefined ? { contactList: req.body.contactList } : {}),
      // "numbers" | "csv" | "csv-header". The dialler rejects the FILE, not the
      // field, and the header was always an unverified assumption — so the
      // shape is probeable from here too.
      ...(req.body?.baseFormat !== undefined ? { baseFormat: req.body.baseFormat } : {}),
    });
    res.status(out.ok ? 200 : 502).json(out);
  } catch (error) {
    // steps rides along on the error. Without it the caller gets one sentence
    // and no idea how far the run got — which is how "Compose campaign failed:
    // HTTP 400" cost a whole cycle without saying whether the ids it composed
    // with had even been read.
    res.status(500).json({
      ok: false,
      error: error?.message ?? String(error),
      steps: error?.steps ?? [],
    });
  }
});

export default router;
