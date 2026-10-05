import crypto from "crypto";
import express from "express";
import SupabaseClient from "../supabaseClient.js";
import { createDtmfCampaign, obdScheduleTime, plannerDialConfig } from "../campaignTemplates.js";
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
 *   GET  /audiences                bases already in Supabase, with counts
 *   POST /plans/:id/contacts-from-base  {audience, limit, minScore?} random sample from one of them
 *   POST /plans/:id/recording      { audioBase64, ext } | { promptId } | { script }
 *   POST /plans/:id/test-call      { mobiles: [...] } ≤ 5 own numbers, dials now
 *   POST /plans/:id/submit         draft -> pending_approval
 *   POST /plans/:id/approve        pending_approval -> approved   (X-Approver-Secret)
 *   POST /plans/:id/pause|resume|cancel
 *   POST /tick                     the hourly run (also what the cron calls)
 */
const router = express.Router();

// The guesses the server-side probe tries, in order, on each host. Each is a change to one field of the default DTMF campaign payload.
const PROBE_VARIANTS = [
  { name: "baseline", config: () => ({}) },
  // Mumbai (id 1) got past the location check; the dialler then said "change values of retries: 0, retryInterval: 0".
  { name: "Mumbai + retries 0/0", config: () => ({ location: '{"locationList":[{"locationId":1,"locationName":"Mumbai"}]}', retries: 0, retryInterval: 0 }), drop: ["locationList"] },
  { name: "Mumbai + retries '0'/'0'", config: () => ({ location: '{"locationList":[{"locationId":1,"locationName":"Mumbai"}]}', retries: "0", retryInterval: "0" }), drop: ["locationList"] },
  { name: "Mumbai + retries 1/30", config: () => ({ location: '{"locationList":[{"locationId":1,"locationName":"Mumbai"}]}', retries: 1, retryInterval: 30 }), drop: ["locationList"] },
  { name: "Mumbai + retries 3/60", config: () => ({ location: '{"locationList":[{"locationId":1,"locationName":"Mumbai"}]}', retries: 3, retryInterval: 60 }), drop: ["locationList"] },
  { name: "Mumbai + no retry fields", config: () => ({ location: '{"locationList":[{"locationId":1,"locationName":"Mumbai"}]}' }), drop: ["locationList", "retries", "retryInterval"] },
  { name: "agentRows {}", config: () => ({ agentRows: "{}" }) },
  { name: "agentRows []", config: () => ({ agentRows: "[]" }) },
  { name: "clis []", config: () => ({ clis: "[]" }) },
  { name: "location []", config: () => ({ location: "[]" }) },
  { name: "location Mumbai (vendor example)", config: () => ({ location: '{"locationList":[{"locationId":1,"locationName":"Mumbai"}]}' }), drop: ["locationList"] },
  { name: "location id 0 All", config: () => ({ location: '{"locationList":[{"locationId":0,"locationName":"All"}]}' }), drop: ["locationList"] },
  { name: "location id 0 All India", config: () => ({ location: '{"locationList":[{"locationId":0,"locationName":"All India"}]}' }), drop: ["locationList"] },
  { name: "location as documented", config: () => ({ location: '{"locationList":[]}' }) },
  { name: "location as documented, no locationList", config: () => ({ location: '{"locationList":[]}' }), drop: ["locationList"] },
  { name: "drop agentRows+clis+ttsRows", config: () => ({}), drop: ["agentRows", "clis", "ttsRows"] },
  { name: "drop every empty field", config: () => ({}), drop: "empty" },
  { name: "baseId as number", config: () => ({}), after: (c) => ({ ...c, baseId: Number(c.baseId) }) },
  { name: "scheduleTime +5min, no seconds", config: () => ({ scheduleTime: obdScheduleTime(new Date(), 5).slice(0, 16) }) },
];
const sb = () => new SupabaseClient().client.schema("crm");

// The planner's OBD client. PLANNER_OBD_BASE_URL points the planner (and only the planner) at another allowlisted dialler host, because
// the dialler's own panel talks to obd3api.expressivr.com while the default host answers compose with an empty HTTP 400. An explicit
// override (the probe below) wins; both are checked against OBD_ALLOWED_HOSTS inside obdClient.
export const plannerObd = (override) => obdClient(override ?? (process.env.PLANNER_OBD_BASE_URL || undefined));

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

// Audiences already in Supabase (crm.lender_campaign_base), so a plan can be built without a file.
router.get("/audiences", (_req, res) =>
  send(res, async () => {
    const { data, error } = await sb().rpc("ivr_audiences");
    if (error) throw new Error(error.message);
    return { audiences: data ?? [] };
  }));

router.post("/plans/:id/contacts-from-base", (req, res) =>
  send(res, async () => {
    const audience = String(req.body?.audience ?? "").trim();
    const limit = Math.floor(Number(req.body?.limit));
    if (!audience) throw fail(400, "pick an audience");
    if (!Number.isFinite(limit) || limit < 1 || limit > 100000) throw fail(400, "limit must be 1 to 100,000");
    const minScore = req.body?.minScore === "" || req.body?.minScore == null ? null : Number(req.body.minScore);
    if (minScore !== null && !Number.isFinite(minScore)) throw fail(400, "minScore must be a number");
    const { data, error } = await sb().rpc("ivr_plan_add_from_base", {
      p_plan: req.params.id, p_audience: audience, p_limit: limit, p_min_score: minScore,
    });
    if (error) throw fail(400, error.message);
    return { result: data };
  }));

router.post("/plans/:id/recording", (req, res) =>
  send(res, async () => {
    const plan = await loadPlan(req.params.id);
    if (!["draft", "paused"].includes(plan.status)) throw fail(409, "recording can only change on a draft or paused plan");
    const obd = plannerObd();
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
    // Optional probe fields, for finding out why the dialler refuses a compose without a deploy per guess: baseUrl (an allowlisted host),
    // menuPromptId, and campaignConfig (any createDtmfCampaign field). With `raw: true` the dialler's own status and body come back
    // instead of a thrown error. It still only ever dials the 1-5 numbers above.
    const obd = plannerObd(req.body?.baseUrl);
    const name = `TEST_${Date.now()}`;
    const base = await obd.uploadBaseFile(buildBaseCsv(mobiles.map((m) => ({ mobile10: m }))), name, "", "csv");
    const baseId = base?.baseId ?? base?.id;
    if (!baseId) throw new Error(`base upload returned no id (${base?.message ?? "no message"})`);
    const config = createDtmfCampaign({
      campaignName: name, baseId, menuPromptId: req.body?.menuPromptId ?? plan.prompt_id, dtmf: plan.dtmf || "1",
      ...(plan.thanks_prompt_id ? { thanksPromptId: plan.thanks_prompt_id } : {}),
      ...(plan.webhook_id ? { webhook: true, webhookId: plan.webhook_id } : {}),
      ...plannerDialConfig(),
      ...(req.body?.campaignConfig ?? {}),
    });
    // matrix: true runs the whole set of guesses on the server, on the configured host and then on the vendor panel's host, stops at the
    // first compose that returns a campaign id, and writes every answer to the service log as [PLANNER_PROBE] so the result survives a
    // browser tool that loses it. Only the 1-5 numbers above are ever dialled, and only if a compose succeeds.
    if (req.body?.matrix) {
      const results = [];
      const note = (row) => { results.push(row); console.log("[PLANNER_PROBE]", JSON.stringify(row)); };
      const promptId = req.body?.menuPromptId ?? plan.prompt_id;
      // The vendor's API document says an uploaded prompt waits for "Admin Approval" (promptStatus), so first show where our prompt stands
      // and find an already-approved menu prompt to compose with as the first variant.
      let approvedId = null;
      try {
        const list = await plannerObd().getVoiceFiles();
        const arr = Array.isArray(list) ? list : list?.prompts ?? list?.data ?? list?.result ?? [];
        const idOf = (p) => String(p?.promptId ?? p?.id ?? "");
        const ours = arr.find((p) => idOf(p) === String(promptId));
        note({ step: "prompt list", total: arr.length, ours: ours ? { id: idOf(ours), category: ours.promptCategory ?? ours.category, file: ours.fileName, status: ours.promptStatus } : "not in list" });
        const ok = arr.find((p) => (p.promptCategory ?? p.category) === "menu" && Number(p.promptStatus) === 1 && idOf(p) !== String(promptId));
        approvedId = ok ? idOf(ok) : null;
        note({ step: "approved menu prompt", id: approvedId, file: ok?.fileName ?? null });
      } catch (e) { note({ step: "prompt list", error: String(e?.message ?? e).slice(0, 300) }); }
      // Read-only: the dialler said "locationList is empty", so look for the endpoint that lists valid locations.
      try {
        const o = plannerObd();
        await o.ensureToken();
        for (const path of ["locations", "location", "location/list", "locationList", "locations/list", "campaign/locations", "campaign/location", "circles", "states"]) {
          for (const tail of ["", `/${o.userId}`]) {
            const r = await fetch(`${o.baseUrl}/api/obd/${path}${tail}`, { headers: o.getAuthHeader() }).catch((e) => ({ status: 0, text: async () => String(e) }));
            const t = r.status === 404 ? "" : (await r.text().catch(() => "")).slice(0, 400);
            if (r.status !== 404) note({ step: "location endpoint", path: path + tail, status: r.status, body: t });
          }
        }
      } catch (e) { note({ step: "location endpoint", error: String(e?.message ?? e).slice(0, 200) }); }
      const variants = approvedId
        ? [{ name: "approved menu prompt " + approvedId, config: () => ({ menuPromptId: approvedId }) }, ...PROBE_VARIANTS]
        : PROBE_VARIANTS;
      for (const host of [undefined]) {
        const o = plannerObd(host);
        let id;
        try {
          const b = await o.uploadBaseFile(buildBaseCsv(mobiles.map((m) => ({ mobile10: m }))), `TEST_${Date.now()}`, "", "csv");
          id = b?.baseId ?? b?.id;
          if (!id) { note({ host: o.baseUrl, step: "base upload", error: `no id (${b?.message ?? "no message"})` }); continue; }
        } catch (e) { note({ host: o.baseUrl, step: "base upload", error: String(e?.message ?? e).slice(0, 300) }); continue; }
        for (const v of variants) {
          let cfg = createDtmfCampaign({
            campaignName: `TEST_${Date.now()}`, baseId: id, menuPromptId: promptId, dtmf: plan.dtmf || "1",
            ...(plan.thanks_prompt_id ? { thanksPromptId: plan.thanks_prompt_id } : {}),
            ...v.config(),
          });
          if (v.drop === "empty") cfg = Object.fromEntries(Object.entries(cfg).filter(([, x]) => x !== "" && x !== undefined));
          else if (v.drop) for (const k of v.drop) delete cfg[k];
          if (v.after) cfg = v.after(cfg);
          let row;
          try {
            const r = await o.composeCampaignRaw(cfg);
            let body = null; try { body = r.text ? JSON.parse(r.text) : null; } catch { /* not JSON */ }
            const composed = r.ok && Boolean(body?.campaignId ?? body?.id);
            row = { host: o.baseUrl, variant: v.name, status: r.status, composed, body: (r.text ?? "").slice(0, 300) };
          } catch (e) { row = { host: o.baseUrl, variant: v.name, error: String(e?.message ?? e).slice(0, 300) }; }
          note(row);
          if (row.composed) return { matrix: results, winner: { host: row.host, variant: row.variant }, mobiles };
        }
      }
      return { matrix: results, winner: null, mobiles };
    }
    if (req.body?.raw) {
      const r = await obd.composeCampaignRaw(config);
      return { composed: r.ok, status: r.status, body_raw: r.text, host: obd.baseUrl, baseId, sent: r.payload, mobiles };
    }
    const campaign = await obd.composeCampaign(config);
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
  send(res, async () => ({ tick: await runPlannerTick({ sb: sb(), obd: plannerObd() }, { planId: req.body?.planId }) })));

export default router;
