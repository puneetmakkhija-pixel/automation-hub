import express from "express";
import SupabaseClient from "../supabaseClient.js";
import { createDtmfCampaign } from "../campaignTemplates.js";
import {
  campaignCap,
  campaignEnabled,
  countDialable,
  liveDeps,
  obdClient,
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
 *   GET  /api/flexiloans-campaign/status         what would happen, touching nothing
 *   POST /api/flexiloans-campaign/run            the pipeline
 *   POST /api/flexiloans-campaign/probe-compose  one compose, both sides shown
 *   GET  /api/flexiloans-campaign/obd-lookup     the ids the dialler already has
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
      // "csv" | "txt" | anything. Sets the part filename's extension AND the
      // mime type together, because the two travel as a pair and the dialler
      // has never said which it reads.
      ...(req.body?.baseExt !== undefined ? { baseExt: req.body.baseExt } : {}),
      // Anything else createDtmfCampaign takes — webhookId, retries, clis,
      // scheduleTime — without a deploy per field.
      ...(req.body?.campaignConfig !== undefined ? { campaignConfig: req.body.campaignConfig } : {}),
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

/**
 * Compose one payload and report both sides of the conversation.
 *
 * The pipeline is four steps green and stuck on the fifth. Every field before
 * this one was found by sending a payload and reading the dialler's complaint,
 * one merge and one deploy per guess. That loop has stopped working, because
 * the dialler stopped talking:
 *
 *   {"ok":false,"error":"Compose campaign failed: HTTP 400", ...}
 *
 * -- a 400 with an EMPTY body, so there is no field name to act on. Guessing
 * blind at five minutes a guess is not a plan.
 *
 * This route makes a guess cost about a second and shows what the previous
 * loop never did: the exact payload that went out, beside the exact bytes that
 * came back. It reuses a prompt and base that are ALREADY uploaded -- ids from
 * any earlier run -- so a probe spends no ElevenLabs credit, uploads nothing,
 * and adds no prompt to the approval queue.
 *
 * It is not a way to dial. A composed campaign is scheduled, not placed, and
 * this route returns the dialler's answer rather than acting on it: nothing
 * here writes the dispatch ledger, so a probe can never mark 25,000 people as
 * contacted. Behind CONSOLE_SECRET with the rest of the router.
 *
 *   POST /api/flexiloans-campaign/probe-compose
 *   { "baseId": "2774773", "menuPromptId": "68339",
 *     "campaignConfig": { "locationList": "{}" } }
 */
router.post("/probe-compose", async (req, res) => {
  try {
    const baseId = req.body?.baseId;
    const menuPromptId = req.body?.menuPromptId;
    // Refused rather than defaulted. A probe composed against a made-up id
    // would get a 400 for the WRONG reason and read exactly like the failure
    // being investigated -- which is how three runs were spent last week
    // believing a base had uploaded when it had not.
    if (!baseId || !menuPromptId) {
      return res.status(400).json({
        ok: false,
        error: "probe-compose needs baseId and menuPromptId from an earlier run",
      });
    }

    const campaignName =
      req.body?.campaignName ??
      `FLEXI_PROBE_${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")}`;

    const config = createDtmfCampaign({
      campaignName,
      baseId,
      menuPromptId,
      ...(req.body?.campaignConfig ?? {}),
    });

    // obdClient rather than liveDeps: composing talks only to the dialler, and
    // liveDeps would also demand an ElevenLabs key to build a TTS client this
    // route never uses.
    // obdClient rather than liveDeps: composing talks only to the dialler, and
    // liveDeps would also demand an ElevenLabs key to build a TTS client this
    // route never uses.
    //
    // baseUrl is how the host question gets settled. The vendor's own panel
    // talks to obd3api.expressivr.com; this service posts to
    // obdapi2.ivrsms.com, where uploads succeed and compose answers 400 with
    // an empty body. A legacy host that still accepts uploads but no longer
    // composes fits every fact we have, and one probe tells us. Allowlisted in
    // obdClient -- the server logs in before every call, so an unchecked host
    // here would hand OBD credentials to whoever asked.
    const obd = obdClient(req.body?.baseUrl);
    const { status, ok, text, payload } = await obd.composeCampaignRaw(config);

    res.json({
      ok: true,
      composed: ok,
      status,
      // Named body_raw, not body: it is bytes, and the whole point of this
      // route is that the last one was empty.
      body_raw: text,
      body_len: text.length,
      // Echoed so a result can never be attributed to the wrong host.
      host: obd.baseUrl,
      sent: payload,
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error?.message ?? String(error) });
  }
});

/**
 * What the dialler already has, so a campaign can be built out of real ids.
 *
 * Composing needs ids that exist on the vendor's side: a menu prompt, a thanks
 * prompt, and -- to send the WhatsApp link on press 1 -- a webhookId. The
 * prompts can be read with getVoiceFiles, but nothing here ever exposed the
 * webhook list, so the one id the press-1 hand-off depends on could not be
 * discovered at all. It had to be typed in by whoever was looking at the panel,
 * which is how a wrong id gets into a payload that then fails for a reason
 * nobody can see.
 *
 * Read-only on purpose. It lists; it does not upload, compose, edit or dial.
 * Behind CONSOLE_SECRET with the rest of the router.
 *
 *   GET /api/flexiloans-campaign/obd-lookup
 *   GET /api/flexiloans-campaign/obd-lookup?q=whatsapp
 *
 * `q` filters both lists by name, because the account holds several hundred
 * prompts and scrolling them in a JSON blob is its own kind of blind.
 */
router.get("/obd-lookup", async (req, res) => {
  try {
    const obd = obdClient();
    const [webhooks, prompts] = await Promise.all([
      obd.getWebhooks().catch((e) => ({ error: e?.message ?? String(e) })),
      obd.getVoiceFiles().catch((e) => ({ error: e?.message ?? String(e) })),
    ]);

    // Reported side by side rather than one failing the whole call: the webhook
    // list is the part that matters for press 1, and a prompt-list outage
    // should not hide it.
    const q = String(req.query?.q ?? "").toLowerCase();
    const match = (entry) =>
      !q ||
      Object.values(entry ?? {}).some(
        (v) => typeof v === "string" && v.toLowerCase().includes(q)
      );

    const listOf = (raw) => {
      if (!raw || raw.error) return raw;
      const list = Array.isArray(raw)
        ? raw
        : raw.webhooks ?? raw.prompts ?? raw.data ?? raw.result ?? [];
      return Array.isArray(list) ? list.filter(match) : raw;
    };

    res.json({ ok: true, webhooks: listOf(webhooks), prompts: listOf(prompts) });
  } catch (error) {
    res.status(500).json({ ok: false, error: error?.message ?? String(error) });
  }
});

export default router;
