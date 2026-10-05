import crypto from "crypto";
import express from "express";
import SupabaseClient from "../supabaseClient.js";
import { createDtmfCampaign } from "../campaignTemplates.js";
import { findPromptId } from "../obdApiClient.js";
import { buildBaseCsv, obdClient, resolveTestMobiles } from "../flexiloansCampaignOrchestrator.js";
import { runPlannerTick, projectSchedule, effectiveWindow } from "../campaignPlanner.js";

/**
 * /api/campaign-planner — the panel's backend.
 *
 * Mounted behind CONSOLE_SECRET (index.js). Approve is a second key on top:
 * CAMPAIGN_APPROVER_SECRET, sent as X-Approver-Secret. Whoever can open the
 * panel can build and submit a plan; only the owner can let it dial.
 *
 *   GET  /plans                    list with progress
 *   GET  /plans/:id                one plan + its batches
 *   POST /plans                    create a draft (settings)
 *   PATCH /plans/:id               edit a draft's settings
 *   POST /plans/:id/contacts       add a chunk of rows [{mobile,name}] (≤ 10,000 per call)
 *   POST /plans/:id/recording      { audioBase64, ext } | { promptId } | { script }
 *   POST /plans/:id/test-call      { mobiles: [...] } ≤ 5 own numbers, dials now
 *   POST /plans/:id/submit         draft -> pending_approval
 *   POST /plans/:id/approve        pending_approval -> approved   (X-Approver-Secret)
 *   POST /plans/:id/pause|resume|cancel
 *   POST /tick                     the hourly run (also what the cron calls)
 */
const router = express.Router();
const sb = () => new SupabaseClient().client.schema("crm");

const PLAN_FIELDS = ["name", "lender", "variant", "dtmf", "webhook_id", "batch_size", "window_start",
  "window_end", "days_of_week", "start_date", "end_date"];

function pick(body) {
  const o = {};
  for (const k of PLAN_FIELDS) if (body?.[k] !== undefined) o[k] = body[k] === "" ? null : body[k];
  if (o.batch_size !== undefined) o.batch_size = Math.trunc(Number(o.batch_size));
  if (o.days_of_week !== undefined) o.days_of_week = (o.days_of_week ?? []).map(Number).filter((d) => d >= 1 && d <= 7);
  return o;
}

const send = (res, fn) =>
  fn().then((body) => res.json({ ok: true, ...body }))
    .catch((e) => res.status(e.status ?? 500).json({ ok: false, error: e?.message ?? String(e) }));

const fail = (status, message) => Object.assign(new Error(message), { status });

async function loadPlan(id) {
  const { data, error } = await sb().from("v_ivr_plan_progress").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw fail(404, "plan not found");
  return data;
}

async function setStatus(id, from, to, extra = {}) {
  const { data, error } = await sb().from("ivr_plan")
    .update({ status: to, updated_at: new Date().toISOString(), ...extra })
    .eq("id", id).in("status", from).select("id, status");
  if (error) throw new Error(error.message);
  if (!data?.length) throw fail(409, `plan is not in ${from.join("/")}`);
  return { plan: data[0] };
}

function approverOk(req) {
  const want = process.env.CAMPAIGN_APPROVER_SECRET;
  const got = req.get("x-approver-secret") ?? "";
  if (!want) return false; // fail closed: no approver configured, nothing gets approved
  const h = (s) => crypto.createHash("sha256").update(String(s)).digest();
  return crypto.timingSafeEqual(h(want), h(got));
}

router.get("/plans", (_req, res) =>
  send(res, async () => {
    const { data, error } = await sb().from("v_ivr_plan_progress").select("*").order("created_at", { ascending: false }).limit(100);
    if (error) throw new Error(error.message);
    return { plans: (data ?? []).map((p) => ({ ...p, projection: projectSchedule(p, p.remaining), window: effectiveWindow(p) })) };
  }));

router.get("/plans/:id", (req, res) =>
  send(res, async () => {
    const plan = await loadPlan(req.params.id);
    const { data: batches } = await sb().from("ivr_plan_batch").select("*").eq("plan_id", plan.id).order("created_at", { ascending: false }).limit(200);
    return { plan: { ...plan, projection: projectSchedule(plan, plan.remaining), window: effectiveWindow(plan) }, batches: batches ?? [] };
  }));

router.post("/plans", (req, res) =>
  send(res, async () => {
    const fields = pick(req.body);
    if (!fields.name) throw fail(400, "name is required");
    const { data, error } = await sb().from("ivr_plan").insert({ ...fields, created_by: req.body?.created_by ?? "panel" }).select("*").single();
    if (error) throw fail(400, error.message);
    return { plan: data };
  }));

router.patch("/plans/:id", (req, res) =>
  send(res, async () => {
    const { data, error } = await sb().from("ivr_plan").update({ ...pick(req.body), updated_at: new Date().toISOString() })
      .eq("id", req.params.id).in("status", ["draft", "paused"]).select("*");
    if (error) throw fail(400, error.message);
    if (!data?.length) throw fail(409, "only a draft or paused plan can be edited");
    return { plan: data[0] };
  }));

router.post("/plans/:id/contacts", (req, res) =>
  send(res, async () => {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (rows.length === 0) throw fail(400, "rows is empty");
    if (rows.length > 10000) throw fail(413, "send at most 10,000 rows per call");
    const { data, error } = await sb().rpc("ivr_plan_add_contacts", { p_plan: req.params.id, p_rows: rows });
    if (error) throw fail(400, error.message);
    return { result: data };
  }));

router.post("/plans/:id/recording", (req, res) =>
  send(res, async () => {
    const plan = await loadPlan(req.params.id);
    if (!["draft", "paused"].includes(plan.status)) throw fail(409, "recording can only change on a draft or paused plan");
    const obd = obdClient();
    // "thanks" is the optional message played after the key is pressed; the default slot is the menu prompt.
    const slot = req.body?.slot === "thanks" ? "thanks" : "menu";
    let promptId = null, promptName = null, source = null;

    if (req.body?.promptId) {
      promptId = String(req.body.promptId);
      promptName = req.body.promptName ?? null;
      source = "existing";
    } else if (req.body?.audioBase64 || req.body?.script) {
      let audio, ext;
      if (req.body.audioBase64) {
        audio = Buffer.from(String(req.body.audioBase64), "base64");
        ext = String(req.body.ext ?? "wav").toLowerCase().replace(/[^a-z0-9]/g, "");
        if (!["wav", "mp3"].includes(ext)) throw fail(400, "recording must be .wav or .mp3");
        if (audio.length < 1000) throw fail(400, "recording is empty");
        if (audio.length > 10 * 1024 * 1024) throw fail(413, "recording over 10 MB");
        source = "upload";
      } else {
        const { default: ElevenLabsClient } = await import("../elevenLabsClient.js");
        const { IVR_VOICE_ID, IVR_MODEL_ID } = await import("../flexiloansCampaignOrchestrator.js");
        const tts = new ElevenLabsClient(process.env.ELEVEN_LABS_API_KEY);
        const spoken = await tts.textToSpeech({ text: String(req.body.script).slice(0, 1500), voiceId: req.body.voiceId ?? IVR_VOICE_ID, modelId: IVR_MODEL_ID });
        audio = spoken?.audio;
        if (!audio || !(audio.byteLength ?? audio.length)) throw new Error("text-to-speech returned no audio");
        ext = "mp3";
        source = "tts";
      }
      promptName = `${String(plan.name).toUpperCase().replace(/[^A-Z0-9]+/g, "_").slice(0, 24)}${slot === "thanks" ? "_THANKS" : ""}_${Date.now().toString().slice(-6)}`;
      // "menu": the prompt asks for a keypress (see flexiloansCampaignOrchestrator). "thanks": the message after it.
      const up = await obd.uploadVoiceFile(audio, `${promptName}.${ext}`, slot, ext);
      promptId = up?.promptId ?? up?.id ?? findPromptId(await obd.getVoiceFiles(), promptName);
      if (!promptId) throw new Error(`OBD did not return a prompt id (${up?.message ?? "no message"})`);
      promptId = String(promptId);
    } else {
      throw fail(400, "send audioBase64+ext, promptId, or script");
    }

    const patch = slot === "thanks"
      ? { thanks_prompt_id: promptId, thanks_prompt_name: promptName }
      : { prompt_id: promptId, prompt_name: promptName, recording_source: source };
    const { error } = await sb().from("ivr_plan")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", plan.id);
    if (error) throw new Error(error.message);
    return { slot, prompt_id: promptId, prompt_name: promptName, source };
  }));

router.post("/plans/:id/test-call", (req, res) =>
  send(res, async () => {
    const plan = await loadPlan(req.params.id);
    if (!plan.prompt_id) throw fail(409, "add a recording first");
    const mobiles = resolveTestMobiles(req.body?.mobiles);
    if (mobiles.length === 0 || mobiles.length > 5) throw fail(400, "give 1–5 valid ten-digit mobiles you own");
    const obd = obdClient();
    const name = `TEST_${Date.now()}`;
    const base = await obd.uploadBaseFile(buildBaseCsv(mobiles.map((m) => ({ mobile10: m }))), name, "", "csv");
    const baseId = base?.baseId ?? base?.id;
    if (!baseId) throw new Error(`base upload returned no id (${base?.message ?? "no message"})`);
    const campaign = await obd.composeCampaign(createDtmfCampaign({
      campaignName: name, baseId, menuPromptId: plan.prompt_id, dtmf: plan.dtmf || "1",
      ...(plan.thanks_prompt_id ? { thanksPromptId: plan.thanks_prompt_id } : {}),
      ...(plan.webhook_id ? { webhook: true, webhookId: plan.webhook_id } : {}),
    }));
    return { campaignId: campaign?.campaignId ?? campaign?.id ?? null, said: campaign?.message ?? null, mobiles };
  }));

router.post("/plans/:id/submit", (req, res) =>
  send(res, async () => {
    const plan = await loadPlan(req.params.id);
    if (!plan.prompt_id) throw fail(409, "add a recording before submitting");
    if (!plan.total_contacts) throw fail(409, "upload contacts before submitting");
    return setStatus(plan.id, ["draft"], "pending_approval");
  }));

router.post("/plans/:id/approve", (req, res) =>
  send(res, async () => {
    if (!approverOk(req)) throw fail(403, "approver secret missing or wrong");
    return setStatus(req.params.id, ["pending_approval"], "approved", {
      approved_by: req.body?.approved_by ?? "owner", approved_at: new Date().toISOString(),
    });
  }));

router.post("/plans/:id/pause", (req, res) =>
  send(res, () => setStatus(req.params.id, ["approved", "running"], "paused", { pause_reason: req.body?.reason ?? "paused from panel" })));

router.post("/plans/:id/resume", (req, res) =>
  send(res, async () => {
    // Resuming a plan is letting it dial again, so it needs the approver too.
    if (!approverOk(req)) throw fail(403, "approver secret missing or wrong");
    return setStatus(req.params.id, ["paused"], "approved", { pause_reason: null, consecutive_failures: 0 });
  }));

router.post("/plans/:id/cancel", (req, res) =>
  send(res, () => setStatus(req.params.id, ["draft", "pending_approval", "approved", "running", "paused"], "cancelled")));

router.post("/tick", (req, res) =>
  send(res, async () => ({ tick: await runPlannerTick({ sb: sb(), obd: obdClient() }, { planId: req.body?.planId }) })));

export default router;
