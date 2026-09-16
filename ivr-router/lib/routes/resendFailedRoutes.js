import express from "express";
import axios from "axios";
import SupabaseClient from "../supabaseClient.js";
import { aliasFor } from "../mobileAlias.js";
import { addAliasToLinks } from "../applyLinkAlias.js";
import { resolveSsoLink, upgradeApplyLinks } from "../crmSsoLink.js";
import { forwardPressToCrm } from "../crmPressForward.js";
import {
  WABA_URL,
  templateMap,
  rawPlaceholders,
  interpolate,
  formatPhone,
  recordSend,
} from "./ivrWhatsAppRoutes.js";

const router = express.Router();

/**
 * The messages that were never delivered, sent again.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * On 16 Sep 2026 Ananta timed out for ninety minutes. 769 send attempts
 * failed, covering 257 people, every one of whom had pressed 1 and was owed a
 * WhatsApp. Nothing retried them and nothing noticed: the router sends once, on
 * receipt of the press, and a failure is terminal. The day simply ended.
 *
 *   04:00 UTC   341 sent    0 failed
 *   05:00 UTC   295 sent  149 failed
 *   06:00 UTC     0 sent  620 failed   <- last hour of the batch
 *
 * The provider outage is not ours to fix. Having no way to recover from one is.
 *
 * ── Why not just replay the press webhook ─────────────────────────────────
 *
 * Because that dials. Both dedupe sets -- the send one in ivrWhatsAppRoutes and
 * the dial one in oriVoiceDispatch -- are in-memory and are emptied by every
 * deploy, so replaying a press after a restart places a SECOND paid voice call
 * to somebody the bot already spoke to, and writes a duplicate
 * ivr_campaign_events row. This route sends the WhatsApp and nothing else: it
 * does not dial, and it does not forward to the CRM.
 *
 * ── What it will not do ───────────────────────────────────────────────────
 *
 * Only a mobile with a FAILED send and no SUCCESSFUL send on the same day is a
 * candidate, so nobody receives a second copy of a message they already got.
 * `limit` may only narrow the run, never widen it -- the same rule as the
 * Flexiloans campaign cap, and for the same reason: reaching this route is
 * permission to run it, not permission to decide its size. Send limit=1 first
 * and read the result before sending the rest; when the provider is the thing
 * that failed, one message is the cheapest possible test of whether it is back.
 *
 * Mounted behind CONSOLE_SECRET in index.js, failClosed: this messages real
 * customers and costs money, so it answers to the operator credential rather
 * than to a provider's webhook secret.
 *
 *   GET  /api/resend/failed/status   who is owed a message, sending nothing
 *   POST /api/resend/failed          send them, oldest press first
 */

const DEFAULT_DIGIT = "1";
const MAX_RUN = 2000;

/** The marker a re-broadcast leaves on its own sends, so it never repeats one. */
const REBROADCAST_SOURCE = "ivr_rebroadcast";

/** A re-broadcast is a whole base, not an outage cohort, so it has its own ceiling. */
const MAX_REBROADCAST = 20000;

/**
 * Where the press backfill starts, and why not the 1st.
 *
 * 02 Sep has 688 presses with no CRM event, but the forward did not exist yet
 * that day — those presses were never lost, they were never meant to arrive.
 * Recovering them would create 688 leads for an integration that was not live,
 * dated today, which is a different decision from repairing an outage. Pass an
 * earlier `since` deliberately if that is what is wanted.
 *
 * From the 3rd the forward WAS live, so a missing event is a failure:
 *   03 Sep  718 lost
 *   11 Sep  562 lost
 */
const DEFAULT_BACKFILL_SINCE = "2026-09-03T00:00:00.000Z";

function db() {
  try {
    return new SupabaseClient().client;
  } catch {
    return null;
  }
}

/** A cap in the body may only narrow the run. Never widen it. */
export function resolveRunCap(requested, available, ceiling = MAX_RUN) {
  const n = Number(requested);
  if (!Number.isFinite(n) || n <= 0) return Math.min(available, ceiling);
  return Math.min(Math.floor(n), available, ceiling);
}

/**
 * Mobiles with a failed send and no successful one on the same IST day.
 *
 * Read from the send log rather than from the press log on purpose: the send
 * log is what records whether a message actually reached the provider, and it
 * is the only place a failure is written down.
 */
export async function findOwed(client, { sinceIso, variant }) {
  if (!client) return { rows: [], error: "no_client" };

  const { data, error } = await client
    .from("whatsapp_messages")
    .select("phone_number, created_at, metadata")
    .eq("direction", "outbound")
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: true })
    .limit(20000);

  if (error) return { rows: [], error: error.message };

  const ten = (v) => String(v ?? "").replace(/\D/g, "").slice(-10);
  const day = (iso) =>
    new Date(new Date(iso).getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

  const succeeded = new Set();
  const failed = new Map();

  for (const row of data ?? []) {
    const m = ten(row.phone_number);
    if (m.length !== 10) continue;
    if (variant && (row.metadata?.variant ?? null) !== variant) continue;

    const k = `${m}:${day(row.created_at)}`;
    if (row.metadata?.status === "sent") succeeded.add(k);
    else if (row.metadata?.status === "failed" && !failed.has(k)) {
      failed.set(k, {
        mobile: m,
        day: day(row.created_at),
        firstFailedAt: row.created_at,
        digit: String(row.metadata?.digit ?? DEFAULT_DIGIT),
        variant: row.metadata?.variant ?? null,
        campaignId: row.metadata?.campaign_id ?? null,
        campaignName: row.metadata?.campaign_name ?? null,
        uniqueId: row.metadata?.unique_id ?? null,
      });
    }
  }

  // A mobile that later succeeded that day is not owed anything.
  return { rows: [...failed.entries()].filter(([k]) => !succeeded.has(k)).map(([, v]) => v) };
}

/** Compose and send one message, exactly as the press route would. */
async function sendOne(client, owed) {
  const phone = formatPhone(owed.mobile);
  if (!phone.valid) return { mobile: owed.mobile, sent: false, reason: "bad_mobile" };

  const template = templateMap()[owed.digit];
  if (!template) return { mobile: owed.mobile, sent: false, reason: "no_template" };

  const apiKey = (process.env.ANANTA_API_KEY || "").trim();
  if (!apiKey) return { mobile: owed.mobile, sent: false, reason: "no_api_key" };

  const body = {
    mobile: owed.mobile,
    campaign_id: owed.campaignId,
    campaign_name: owed.campaignName,
    unique_id: owed.uniqueId,
  };
  const { list: raw, source: linkSource } = rawPlaceholders(owed.digit, body, owed.variant);
  if (!raw.length) return { mobile: owed.mobile, sent: false, reason: "no_placeholders" };

  const sso = await resolveSsoLink(owed.mobile, client);
  const alias = aliasFor(owed.mobile);
  const placeholders = addAliasToLinks(
    upgradeApplyLinks(
      interpolate(raw, { ...body, customer_id: "", sso_link: sso.url, alias }),
      sso.minted ? sso.url : ""
    ),
    alias
  );
  if (placeholders.some((v) => v === "")) {
    return { mobile: owed.mobile, sent: false, reason: "placeholder_empty" };
  }

  const payload = {
    template,
    phone: phone.phone,
    is_short_url: process.env.ANANTA_IS_SHORT_URL || "1",
    message: { placeholders },
  };

  const common = {
    phone: phone.phone,
    digit: owed.digit,
    template,
    variant: owed.variant,
    campaignId: owed.campaignId,
    campaignName: owed.campaignName,
    uniqueId: owed.uniqueId,
    linkSource,
    source: owed.source,
    ssoMinted: sso.minted,
    ssoReason: sso.reason,
    link: placeholders[placeholders.length - 1],
  };

  try {
    const r = await axios.post(WABA_URL, payload, {
      headers: { api_key: apiKey, "Content-Type": "application/json" },
      timeout: 10000,
    });
    console.log(
      `[IVR_RESEND] Sent phone=${phone.phone} template=${template} ` +
        `first_failed=${owed.firstFailedAt} message_id=${r.data?.message_id || "-"}`
    );
    recordSend({ ...common, status: "sent", messageId: r.data?.message_id });
    return { mobile: owed.mobile, sent: true, messageId: r.data?.message_id ?? null };
  } catch (error) {
    const detail = error.response?.data ?? error.message;
    console.error(`[IVR_RESEND] Send FAILED phone=${phone.phone}:`, detail);
    recordSend({ ...common, status: "failed", error: detail });
    return { mobile: owed.mobile, sent: false, reason: "send_failed", detail };
  }
}

/** Who is owed a message. Sends nothing, costs nothing. */
router.get("/failed/status", async (req, res) => {
  const since = String(req.query.since || "").trim() ||
    new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const variant = String(req.query.variant || "").trim() || null;

  const { rows, error } = await findOwed(db(), { sinceIso: since, variant });
  if (error) return res.status(503).json({ ok: false, error });

  const byDay = {};
  for (const r of rows) byDay[r.day] = (byDay[r.day] ?? 0) + 1;

  res.json({
    ok: true,
    since,
    variant: variant ?? "(any)",
    owed: rows.length,
    by_day: byDay,
    max_run: MAX_RUN,
    note:
      rows.length === 0
        ? "Nobody is owed a message in this window."
        : "POST /api/resend/failed to send. Start with {\"limit\":1} — one message is the " +
          "cheapest test of whether the provider is back.",
  });
});

/** Send them. Oldest press first. */
router.post("/failed", async (req, res) => {
  const since = String(req.body?.since || "").trim() ||
    new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const variant = String(req.body?.variant || "").trim() || null;

  const client = db();
  const { rows, error } = await findOwed(client, { sinceIso: since, variant });
  if (error) return res.status(503).json({ ok: false, error });

  const cap = resolveRunCap(req.body?.limit, rows.length);
  const batch = rows.slice(0, cap);

  const results = [];
  for (const owed of batch) {
    // Serial, not parallel. This runs after a provider outage, and hitting a
    // recovering API with 257 concurrent requests is how it goes down again.
    results.push(await sendOne(client, owed));
  }

  const sent = results.filter((r) => r.sent).length;
  console.log(`[IVR_RESEND] Run complete: ${sent}/${batch.length} sent, ${rows.length} owed`);

  res.json({
    ok: true,
    owed: rows.length,
    attempted: batch.length,
    sent,
    failed: batch.length - sent,
    remaining: rows.length - sent,
    results,
  });
});

/**
 * ── The re-broadcast ──────────────────────────────────────────────────────
 *
 * A DIFFERENT operation from /failed above, and deliberately a different
 * endpoint. /failed exists because a message never arrived. This exists
 * because the message arrived, was read, and led nowhere — until 16 Sep the
 * link it carried put an OTP screen in front of the customer, and 93% of the
 * people who opened it stopped there.
 *
 * So the safety rule is the opposite one. /failed refuses anybody who already
 * received a message; this one selects them ON PURPOSE. That makes every other
 * guard load-bearing:
 *
 *   1. crm.contact_suppression, where released_at is null. 10,634 rows. A
 *      person on this list has asked not to be contacted and the reason is not
 *      this route's to second-guess.
 *   2. Anyone the voice bot recorded as DND, NOT_INTERESTED or WRNG. They said
 *      it out loud on a recorded call; sending them a second link is how a
 *      WhatsApp sender gets reported.
 *   3. Anyone who has already had a re-broadcast. Every send this route makes
 *      is stamped source='ivr_rebroadcast', and a mobile carrying that stamp is
 *      never selected again. Re-running the whole job is therefore safe: it
 *      sends only to whoever is left.
 *   4. Anyone who has since started the apply journey. They do not need
 *      chasing, and a nudge after somebody has already engaged reads as spam.
 *
 * Guard 3 is the one that matters most in practice. This is a 9,765-message
 * run over a slow serial loop; it will be interrupted, and somebody will run
 * it again. Without the stamp, the second run sends the whole base a second
 * time.
 */

/** Mobiles that were sent a link, never started applying, and may be contacted. */
export async function findRebroadcast(client, { sinceIso, variant }) {
  if (!client) return { rows: [], error: "no_client" };
  const ten = (v) => String(v ?? "").replace(/\D/g, "").slice(-10);

  const { data: msgs, error } = await client
    .from("whatsapp_messages")
    .select("phone_number, created_at, metadata")
    .eq("direction", "outbound")
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: true })
    .limit(50000);
  if (error) return { rows: [], error: error.message };

  const candidates = new Map();
  const alreadyRebroadcast = new Set();

  for (const row of msgs ?? []) {
    const m = ten(row.phone_number);
    if (m.length !== 10) continue;

    if (row.metadata?.source === REBROADCAST_SOURCE) {
      alreadyRebroadcast.add(m);
      continue;
    }
    if (row.metadata?.status !== "sent") continue;
    if (variant && (row.metadata?.variant ?? null) !== variant) continue;

    if (!candidates.has(m)) {
      candidates.set(m, {
        mobile: m,
        firstSentAt: row.created_at,
        digit: String(row.metadata?.digit ?? DEFAULT_DIGIT),
        variant: row.metadata?.variant ?? null,
        campaignId: row.metadata?.campaign_id ?? null,
        campaignName: row.metadata?.campaign_name ?? null,
        uniqueId: null, // a re-broadcast is not tied to the original call
      });
    }
  }

  for (const m of alreadyRebroadcast) candidates.delete(m);

  const excluded = { already_rebroadcast: alreadyRebroadcast.size, started: 0, suppressed: 0, refused_bot: 0 };

  const started = await readSet(client, "portal_otp_sessions", "mobile", { gte: null });
  for (const m of started) if (candidates.delete(m)) excluded.started++;

  const suppressed = await readSuppressed(client);
  for (const m of suppressed) if (candidates.delete(m)) excluded.suppressed++;

  const refused = await readBotRefusals(client);
  for (const m of refused) if (candidates.delete(m)) excluded.refused_bot++;

  return { rows: [...candidates.values()], excluded };
}

/** Every distinct 10-digit mobile in one column of one table. */
async function readSet(client, table, column) {
  const out = new Set();
  const ten = (v) => String(v ?? "").replace(/\D/g, "").slice(-10);
  const { data, error } = await client.from(table).select(column).limit(100000);
  if (error) {
    console.error(`[IVR_REBROADCAST] Could not read ${table}: ${error.message}`);
    // Fail CLOSED on the exclusion lists: an unreadable suppression list must
    // never become an empty one.
    throw new Error(`exclusion list ${table} unreadable: ${error.message}`);
  }
  for (const row of data ?? []) {
    const m = ten(row[column]);
    if (m.length === 10) out.add(m);
  }
  return out;
}

async function readSuppressed(client) {
  const out = new Set();
  const ten = (v) => String(v ?? "").replace(/\D/g, "").slice(-10);
  const { data, error } = await client
    .from("contact_suppression")
    .select("phone, released_at")
    .is("released_at", null)
    .limit(100000);
  if (error) throw new Error(`suppression list unreadable: ${error.message}`);
  for (const row of data ?? []) {
    const m = ten(row.phone);
    if (m.length === 10) out.add(m);
  }
  return out;
}

const BOT_REFUSALS = new Set(["DND", "NOT_INTERESTED", "WRNG"]);

async function readBotRefusals(client) {
  const out = new Set();
  const ten = (v) => String(v ?? "").replace(/\D/g, "").slice(-10);
  const { data, error } = await client
    .from("voice_call_events")
    .select("mobile10, raw")
    .eq("provider", "oriserve")
    .limit(100000);
  if (error) throw new Error(`voice outcomes unreadable: ${error.message}`);
  for (const row of data ?? []) {
    const d = row?.raw?.analysis?.DISPOSITION ?? row?.raw?.analysis?.disposition ?? "";
    if (!BOT_REFUSALS.has(String(d).toUpperCase())) continue;
    const m = ten(row.mobile10);
    if (m.length === 10) out.add(m);
  }
  return out;
}

/** Who would receive a re-broadcast. Sends nothing. */
router.get("/rebroadcast/status", async (req, res) => {
  const since = String(req.query.since || "").trim() || "2026-09-01T00:00:00.000Z";
  const variant = String(req.query.variant || "").trim() || "businessloans";
  try {
    const { rows, excluded, error } = await findRebroadcast(db(), { sinceIso: since, variant });
    if (error) return res.status(503).json({ ok: false, error });
    res.json({ ok: true, since, variant, sendable: rows.length, excluded, max_run: MAX_REBROADCAST });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message });
  }
});

/** Send it. */
router.post("/rebroadcast", async (req, res) => {
  const since = String(req.body?.since || "").trim() || "2026-09-01T00:00:00.000Z";
  const variant = String(req.body?.variant || "").trim() || "businessloans";

  const client = db();
  let rows;
  let excluded;
  try {
    const found = await findRebroadcast(client, { sinceIso: since, variant });
    if (found.error) return res.status(503).json({ ok: false, error: found.error });
    rows = found.rows;
    excluded = found.excluded;
  } catch (e) {
    return res.status(503).json({ ok: false, error: e.message });
  }

  const cap = resolveRunCap(req.body?.limit, rows.length, MAX_REBROADCAST);
  const batch = rows.slice(0, cap);

  const results = [];
  for (const owed of batch) {
    results.push(await sendOne(client, { ...owed, source: REBROADCAST_SOURCE }));
  }

  const sent = results.filter((r) => r.sent).length;
  console.log(
    `[IVR_REBROADCAST] Run complete: ${sent}/${batch.length} sent, ${rows.length} sendable, ` +
      `excluded ${JSON.stringify(excluded)}`
  );

  res.json({
    ok: true,
    sendable: rows.length,
    excluded,
    attempted: batch.length,
    sent,
    failed: batch.length - sent,
    remaining: rows.length - sent,
    results: results.slice(0, 50),
    results_truncated: results.length > 50,
  });
});

/**
 * ── The presses the CRM never recorded ────────────────────────────────────
 *
 * forwardPressToCrm is fire-and-forget: the customer's WhatsApp must never wait
 * on the CRM, so every failure there is a log line and nothing more. Correct
 * for the customer, and it makes a CRM outage completely silent — the press
 * simply never happened, as far as everything downstream is concerned.
 *
 * It has happened twice and neither was noticed at the time:
 *
 *   03 Sep   761 presses handled,  43 recorded   718 lost
 *   11 Sep   705 presses handled, 142 recorded   563 lost
 *
 * 1,281 people pressed 1, were sent their WhatsApp, and never entered the CRM:
 * no ivr_campaign_events row, no bdl_leads row, no case, no agent. Both
 * incidents ended only because a deploy restarted the router.
 *
 * This replays those presses through the SAME path a live press takes —
 * forwardPressToCrm, POST /api/ivr/press — so a recovered lead is built by the
 * CRM's own logic: campaign resolved, ivr_lead_lookup enrichment applied,
 * lead_ref minted. Reimplementing any of that here would drift from it.
 *
 * WHAT IT DOES NOT DO
 *
 * It does not send a WhatsApp and it does not dial. These people already got
 * their message; the press record is the only thing missing.
 *
 * The CRM's own /api/ivr/press CAN send the apply link, at step 4. It cannot
 * here: that send is gated on crm.app_config 'campaign_nudge_enabled', which is
 * 'off', is read per call rather than cached, fails closed on an unreadable
 * switch, and carries a second bdl_nudge_log guard behind it. If somebody turns
 * that switch on, this route WILL start messaging the people it recovers —
 * which is why the status endpoint reports the switch and the run refuses while
 * it is on.
 *
 * THE TIMESTAMPS ARE TODAY'S
 *
 * public.ivr_press_lead stamps now() and takes no override, so a recovered
 * press is dated today and the lead is created today. The original press time
 * is carried in the event metadata as pressed_at_original instead, alongside
 * backfill: true, so these rows can always be told apart from live ones and the
 * historical daily counts are NOT rewritten. crm.v_press_reconciliation keeps
 * reporting 03 and 11 Sep as incidents, which is the truth.
 *
 * SAFE TO RE-RUN
 *
 * ivr_press_lead does NOT dedupe the event insert — calling it twice for one
 * mobile writes two rows. Selection is therefore the only guard, and it is
 * exact: a mobile is a candidate only while it has NO dtmf event at all. Once
 * recovered it stops being selected, so an interrupted run resumes cleanly and
 * a repeated run sends nothing.
 */

/** Presses the router handled that the CRM has no event for. */
export async function findUnrecordedPresses(client, { sinceIso, variant }) {
  if (!client) return { rows: [], error: "no_client" };
  const ten = (v) => String(v ?? "").replace(/\D/g, "").slice(-10);

  const { data: msgs, error } = await client
    .from("whatsapp_messages")
    .select("phone_number, created_at, metadata")
    .eq("direction", "outbound")
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: true })
    .limit(50000);
  if (error) return { rows: [], error: error.message };

  const handled = new Map();
  for (const row of msgs ?? []) {
    const m = ten(row.phone_number);
    if (m.length !== 10) continue;
    if (String(row.metadata?.digit ?? "") !== "1") continue;
    if (variant && (row.metadata?.variant ?? null) !== variant) continue;
    // A re-broadcast is not a press and must never be recovered as one.
    if (row.metadata?.source === REBROADCAST_SOURCE) continue;
    if (!handled.has(m)) {
      handled.set(m, {
        mobile: m,
        pressedAt: row.created_at,
        campaignId: row.metadata?.campaign_id ?? null,
        campaignName: row.metadata?.campaign_name ?? null,
        uniqueId: row.metadata?.unique_id ?? null,
      });
    }
  }

  const { data: events, error: evError } = await client
    .from("ivr_campaign_events")
    .select("phone_number, dtmf_input, event_type")
    .limit(200000);
  // Fails CLOSED: an unreadable event table would make every press look
  // unrecorded and replay the entire month.
  if (evError) throw new Error(`ivr_campaign_events unreadable: ${evError.message}`);

  let recorded = 0;
  for (const row of events ?? []) {
    const m = ten(row.phone_number);
    if (m.length !== 10) continue;
    if (handled.delete(m)) recorded++;
  }

  return { rows: [...handled.values()], excluded: { already_recorded: recorded } };
}

/** Is the CRM's own link-send switched on? While it is, this route refuses. */
async function nudgeIsOn(client) {
  if (!client) return null;
  try {
    const { data, error } = await client
      .schema("crm")
      .from("app_config")
      .select("value")
      .eq("key", "campaign_nudge_enabled")
      .maybeSingle();
    if (error) return null;
    return String(data?.value ?? "").trim().toLowerCase() === "on";
  } catch {
    return null;
  }
}

/** Who is missing from the CRM. Writes nothing. */
router.get("/press-backfill/status", async (req, res) => {
  const since = String(req.query.since || "").trim() || DEFAULT_BACKFILL_SINCE;
  const variant = String(req.query.variant || "").trim() || "businessloans";
  const client = db();
  try {
    const { rows, excluded, error } = await findUnrecordedPresses(client, { sinceIso: since, variant });
    if (error) return res.status(503).json({ ok: false, error });

    const byDay = {};
    for (const r of rows) {
      const d = new Date(new Date(r.pressedAt).getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
      byDay[d] = (byDay[d] ?? 0) + 1;
    }
    const nudge = await nudgeIsOn(client);
    res.json({
      ok: true, since, variant,
      unrecorded: rows.length,
      by_ist_day: byDay,
      excluded,
      campaign_nudge_enabled: nudge === null ? "unreadable" : nudge ? "ON" : "off",
      will_send_whatsapp: nudge === true,
      note: nudge === true
        ? "REFUSING to run: crm.app_config campaign_nudge_enabled is ON, so the CRM would message every recovered lead. Turn it off first."
        : "Recovered leads are dated TODAY; the original press time is kept in the event metadata as pressed_at_original.",
    });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message });
  }
});

/** Replay them into the CRM. */
router.post("/press-backfill", async (req, res) => {
  const since = String(req.body?.since || "").trim() || DEFAULT_BACKFILL_SINCE;
  const variant = String(req.body?.variant || "").trim() || "businessloans";
  const client = db();

  const nudge = await nudgeIsOn(client);
  if (nudge !== false) {
    return res.status(409).json({
      ok: false,
      error: nudge === true
        ? "campaign_nudge_enabled is ON — recovering these leads would send each of them a WhatsApp. Refusing."
        : "Could not read campaign_nudge_enabled. Refusing rather than risk messaging every recovered lead.",
    });
  }

  let rows;
  let excluded;
  try {
    const found = await findUnrecordedPresses(client, { sinceIso: since, variant });
    if (found.error) return res.status(503).json({ ok: false, error: found.error });
    rows = found.rows;
    excluded = found.excluded;
  } catch (e) {
    return res.status(503).json({ ok: false, error: e.message });
  }

  const cap = resolveRunCap(req.body?.limit, rows.length, MAX_REBROADCAST);
  const batch = rows.slice(0, cap);

  const results = [];
  for (const p of batch) {
    // Serial. The CRM timing out under load is what lost these presses in the
    // first place; replaying 1,281 of them concurrently would repeat it.
    const r = await forwardPressToCrm(
      {
        mobile: p.mobile,
        campaign_id: p.campaignId ?? undefined,
        campaign_name: p.campaignName ?? undefined,
        unique_id: p.uniqueId ?? undefined,
        // Kept by the CRM as event metadata: these rows must always be
        // distinguishable from a live press, and the real press time must not
        // be lost just because the row is dated today.
        backfill: true,
        pressed_at_original: p.pressedAt,
        backfill_reason: "forwardPressToCrm failed at the time; press never reached the CRM",
      },
      { digit: "1", variant }
    );
    results.push({ mobile: p.mobile, ...r });
  }

  const ok = results.filter((r) => r.forwarded).length;
  console.log(`[IVR_BACKFILL] Recovered ${ok}/${batch.length}, ${rows.length} unrecorded`);

  res.json({
    ok: true,
    unrecorded: rows.length,
    excluded,
    attempted: batch.length,
    recovered: ok,
    failed: batch.length - ok,
    remaining: rows.length - ok,
    results: results.slice(0, 50),
    results_truncated: results.length > 50,
  });
});

export default router;
