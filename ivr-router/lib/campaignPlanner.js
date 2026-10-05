import { createDtmfCampaign, plannerDialConfig } from "./campaignTemplates.js";
import { buildBaseCsv, recordDispatch } from "./flexiloansCampaignOrchestrator.js";

/**
 * IVR campaign planner — the hourly half.
 *
 * The panel (public/campaigns.html) creates a plan: a base, a recording, a
 * batch size and a calling window. This file turns an APPROVED plan into one
 * OBD DTMF campaign per hour, `batch_size` people each, until the base is
 * worked or the owner stops it.
 *
 * Guards, in the order they are checked (any one of them means nobody is
 * dialled this hour):
 *
 *   1. CAMPAIGN_PLANNER_ENABLED must be exactly "on". Anything else prepares the
 *      batch (base upload) and stops before compose, like FLEXI_CAMPAIGN_ENABLED.
 *   2. crm.app_config pipeline_paused = "on" — the master kill switch.
 *   3. The plan is approved/running, inside its dates, its days and its window.
 *   4. The window is clamped to 09:00–21:00 IST whatever the plan says (TRAI
 *      commercial-call hours). A plan saying 07:00–23:00 dials 09:00–21:00.
 *   5. One batch per plan per IST hour (unique index) — a double-fired cron
 *      cannot double-dial.
 *   6. Suppression is re-checked at claim time (crm.ivr_plan_claim).
 *   7. Three failed batches in a row pause the plan with a reason.
 *
 * Pure helpers are exported for tests; runPlannerTick takes every dependency
 * injected so it can be exercised without OBD or a database.
 */

export const TRAI_START = "09:00";
export const TRAI_END = "21:00";
export const MAX_CONSECUTIVE_FAILURES = 3;
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/** Clock in IST: date (YYYY-MM-DD), time (HH:MM), ISO day-of-week (1=Mon..7=Sun), hourKey. */
export function istClock(now = new Date()) {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const iso = ist.toISOString();
  const jsDow = ist.getUTCDay(); // 0 = Sunday
  return {
    date: iso.slice(0, 10),
    time: iso.slice(11, 16),
    dow: jsDow === 0 ? 7 : jsDow,
    hourKey: iso.slice(0, 13),
  };
}

const hhmm = (t) => String(t ?? "").slice(0, 5);
const maxT = (a, b) => (a > b ? a : b);
const minT = (a, b) => (a < b ? a : b);

/** The plan's window after the TRAI clamp. Null if nothing is left of it. */
export function effectiveWindow(plan) {
  const start = maxT(hhmm(plan.window_start) || "10:00", TRAI_START);
  const end = minT(hhmm(plan.window_end) || "19:00", TRAI_END);
  return start < end ? { start, end } : null;
}

/**
 * Is this plan due a batch right now? Returns { due: true } or { due: false, why }.
 * A batch is started only if at least 30 minutes of window remain, so a batch
 * composed at 18:55 for a 19:00 close does not ring people at 19:40.
 */
export function planDue(plan, now = new Date()) {
  if (!["approved", "running"].includes(plan.status)) return { due: false, why: `status ${plan.status}` };
  if (!plan.prompt_id) return { due: false, why: "no recording" };
  const c = istClock(now);
  if (plan.start_date && c.date < String(plan.start_date).slice(0, 10)) return { due: false, why: "before start date" };
  if (plan.end_date && c.date > String(plan.end_date).slice(0, 10)) return { due: false, why: "after end date" };
  const days = Array.isArray(plan.days_of_week) && plan.days_of_week.length ? plan.days_of_week.map(Number) : [1, 2, 3, 4, 5, 6];
  if (!days.includes(c.dow)) return { due: false, why: "not a calling day" };
  const w = effectiveWindow(plan);
  if (!w) return { due: false, why: "window empty after 09:00–21:00 clamp" };
  if (c.time < w.start || c.time >= w.end) return { due: false, why: `outside window ${w.start}–${w.end}` };
  const [eh, em] = w.end.split(":").map(Number);
  const [nh, nm] = c.time.split(":").map(Number);
  if (eh * 60 + em - (nh * 60 + nm) < 30) return { due: false, why: "less than 30 min of window left" };
  return { due: true };
}

/** How many hourly batches a base of `remaining` needs, and roughly how many calling days. */
export function projectSchedule(plan, remaining) {
  const w = effectiveWindow(plan);
  if (!w || !plan.batch_size) return { batches: 0, hoursPerDay: 0, days: 0 };
  const [sh, sm] = w.start.split(":").map(Number);
  const [eh, em] = w.end.split(":").map(Number);
  const hoursPerDay = Math.max(0, Math.floor((eh * 60 + em - 30 - (sh * 60 + sm)) / 60) + 1);
  const batches = Math.ceil(Math.max(0, remaining) / plan.batch_size);
  return { batches, hoursPerDay, days: hoursPerDay ? Math.ceil(batches / hoursPerDay) : 0 };
}

/** OBD campaign names must be unique; keep them short and readable. */
export function batchName(plan, batchNo, clock) {
  const code = String(plan.name ?? "PLAN").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 20) || "PLAN";
  return `${code}_B${batchNo}_${clock.hourKey.replace(/[-T]/g, "")}`;
}

async function isPaused(sb) {
  const { data, error } = await sb.from("app_config").select("value").eq("key", "pipeline_paused").maybeSingle();
  // Unreadable kill switch = treat as paused. Dialling blind is the worse error.
  if (error) return true;
  return String(data?.value ?? "off").trim().toLowerCase() === "on";
}

/**
 * One tick. Never throws; returns what it did per plan.
 *
 * @param deps { sb (crm-schema supabase client), obd, env?, now? }
 */
export async function runPlannerTick(deps, opts = {}) {
  const { sb, obd } = deps;
  const env = deps.env ?? process.env;
  const now = deps.now ? deps.now() : new Date();
  const enabled = String(env.CAMPAIGN_PLANNER_ENABLED ?? "").trim() === "on";
  const out = { at: now.toISOString(), enabled, plans: [] };

  try {
    if (await isPaused(sb)) return { ...out, skipped: "pipeline_paused" };

    const { data: plans, error } = await sb
      .from("ivr_plan")
      .select("*")
      .in("status", ["approved", "running"])
      .order("approved_at", { ascending: true });
    if (error) throw new Error(`plans unreadable: ${error.message}`);

    for (const plan of plans ?? []) {
      if (opts.planId && plan.id !== opts.planId) continue;
      await logVendorReport(plan, { sb, obd, now });
      out.plans.push(await runPlanBatch(plan, { sb, obd, enabled, now }));
    }
  } catch (e) {
    out.error = e?.message ?? String(e);
  }
  return out;
}

// Read-only: before each hour's batch, write the dialler's own numbers for today (answered, pressed, DND-skipped...) to the service log
// as [PLANNER_REPORT], so how the previous batch went is readable without opening the vendor panel. Never blocks or fails a tick.
async function logVendorReport(plan, { sb, obd, now }) {
  try {
    if (typeof obd?.analyzeCampaign !== "function") return;
    const { data: last } = await sb.from("ivr_plan_batch").select("obd_campaign_id, batch_no").eq("plan_id", plan.id)
      .not("obd_campaign_id", "is", null).order("created_at", { ascending: false }).limit(1);
    if (!last?.length) return;
    const day = istClock(now).date;
    const report = await obd.analyzeCampaign(day, day);
    console.log("[PLANNER_REPORT]", JSON.stringify({ plan: plan.name, campaignId: last[0].obd_campaign_id, batchNo: last[0].batch_no, day, report }).slice(0, 6000));
  } catch (e) {
    console.log("[PLANNER_REPORT]", JSON.stringify({ plan: plan.name, error: String(e?.message ?? e).slice(0, 300) }));
  }
}

async function runPlanBatch(plan, { sb, obd, enabled, now }) {
  const result = { plan: plan.id, name: plan.name };
  const due = planDue(plan, now);
  if (!due.due) return { ...result, skipped: due.why };

  const clock = istClock(now);
  const { count: prior } = await sb.from("ivr_plan_batch").select("id", { count: "exact", head: true }).eq("plan_id", plan.id);
  const batchNo = (prior ?? 0) + 1;

  // The unique (plan_id, hour_key) row IS the lock. A second tick this hour
  // fails the insert and goes home.
  const { data: batch, error: bErr } = await sb
    .from("ivr_plan_batch")
    .insert({ plan_id: plan.id, batch_no: batchNo, hour_key: clock.hourKey, status: "claimed" })
    .select("id")
    .single();
  if (bErr) {
    return { ...result, skipped: /duplicate|unique/i.test(bErr.message) ? "already batched this hour" : `batch insert: ${bErr.message}` };
  }

  const steps = [];
  let claimed = [];
  try {
    const { data: rows, error: cErr } = await sb.rpc("ivr_plan_claim", { p_plan: plan.id, p_batch: batch.id, p_limit: plan.batch_size });
    if (cErr) throw new Error(`claim: ${cErr.message}`);
    claimed = Array.isArray(rows) ? rows : [];
    steps.push({ step: "claim", people: claimed.length });

    if (claimed.length === 0) {
      await sb.from("ivr_plan_batch").update({ status: "empty", size: 0, steps }).eq("id", batch.id);
      await sb.from("ivr_plan").update({ status: "completed", updated_at: new Date().toISOString() }).eq("id", plan.id);
      return { ...result, completed: true };
    }

    const name = batchName(plan, batchNo, clock);
    const base = await obd.uploadBaseFile(buildBaseCsv(claimed, "numbers"), name, "", "csv");
    const baseId = base?.baseId ?? base?.id ?? null;
    steps.push({ step: "base", id: baseId, said: typeof base?.message === "string" ? base.message.slice(0, 200) : null });
    if (baseId === null) throw new Error(`base upload returned no id (${base?.message ?? "no message"})`);

    if (!enabled) {
      // Prepared, visible in the OBD panel, not dialled. People go back.
      await sb.rpc("ivr_plan_release", { p_batch: batch.id });
      await sb.from("ivr_plan_batch").update({ status: "prepared_only", size: claimed.length, obd_base_id: String(baseId), steps }).eq("id", batch.id);
      return { ...result, prepared: claimed.length, dialled: false, reason: "CAMPAIGN_PLANNER_ENABLED is not 'on'" };
    }

    const campaign = await obd.composeCampaign(
      createDtmfCampaign({
        campaignName: name,
        baseId,
        menuPromptId: plan.prompt_id,
        ...(plan.thanks_prompt_id ? { thanksPromptId: plan.thanks_prompt_id } : {}),
        dtmf: plan.dtmf || "1",
        ...(plan.webhook_id ? { webhook: true, webhookId: plan.webhook_id } : {}),
        ...plannerDialConfig(),
      })
    );
    const campaignId = campaign?.campaignId ?? campaign?.id ?? null;
    steps.push({ step: "compose", id: campaignId, said: typeof campaign?.message === "string" ? campaign.message.slice(0, 200) : null });
    if (campaignId === null) throw new Error(`compose returned no campaign id (${campaign?.message ?? "no message"})`);

    await sb.rpc("ivr_plan_mark_dispatched", { p_batch: batch.id });
    await sb.from("ivr_plan_batch")
      .update({ status: "composed", size: claimed.length, obd_base_id: String(baseId), obd_campaign_id: String(campaignId), steps })
      .eq("id", batch.id);
    await sb.from("ivr_plan").update({ status: "running", consecutive_failures: 0, updated_at: new Date().toISOString() }).eq("id", plan.id);

    if (plan.lender) {
      try {
        await recordDispatch(sb, { lender: plan.lender, campaign: name, rows: claimed });
      } catch (e) {
        steps.push({ step: "ledger", error: e?.message ?? String(e) });
      }
    }
    return { ...result, dialled: claimed.length, campaignId, name };
  } catch (e) {
    const msg = e?.message ?? String(e);
    await sb.rpc("ivr_plan_release", { p_batch: batch.id });
    await sb.from("ivr_plan_batch").update({ status: "failed", error: msg.slice(0, 500), size: claimed.length, steps }).eq("id", batch.id);
    const failures = (plan.consecutive_failures ?? 0) + 1;
    const patch = { consecutive_failures: failures, updated_at: new Date().toISOString() };
    if (failures >= MAX_CONSECUTIVE_FAILURES) {
      patch.status = "paused";
      patch.pause_reason = `auto-paused after ${failures} failed batches in a row: ${msg.slice(0, 200)}`;
    }
    await sb.from("ivr_plan").update(patch).eq("id", plan.id);
    return { ...result, failed: msg, autoPaused: failures >= MAX_CONSECUTIVE_FAILURES || undefined };
  }
}

export default runPlannerTick;
