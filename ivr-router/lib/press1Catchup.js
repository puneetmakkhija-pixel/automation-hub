import SupabaseClient from "./supabaseClient.js";
import { dispatchPressToOurBot } from "./ourVoiceBotDispatch.js";

/**
 * The end-of-gap sweep: every Business Loans press-1 from TODAY OR YESTERDAY
 * that no dispatcher has yet attempted a bot call for, dialled in the order
 * the customer pressed — oldest first.
 *
 * ── Why this exists on top of the real-time dispatch ────────────────────────
 *
 * A press-1 already gets a call attempt the moment it arrives
 * (ivrWhatsAppRoutes.js -> dispatchPressToOurBot / dispatchPressToVoiceBot).
 * This is not a replacement for that path; it is the safety net underneath
 * it. A press can reach neither bot for reasons that have nothing to do with
 * the caller — the daily cap was already spent, the dial queue was full, the
 * process restarted mid-pace, ORI_PRESS_DISPATCH=0 with our bot also refusing
 * — and with no Oriserve fallback to catch what our bot cannot take, a press
 * that misses its real-time window has nowhere else to go. This sweep is
 * that "else": it re-reads recent press-1s against what was actually
 * dispatched and rings whoever is still missing.
 *
 * ── Yesterday too, not just today ────────────────────────────────────────
 *
 * The dial pacer caps sustained throughput below what a single busy hour can
 * hand it (28 Sep 2026: ~90/hr sustainable against bursts over 400/hr-
 * equivalent). Without Oriserve to absorb the overflow, a big-enough burst
 * near the end of a calling day can still have un-dialled presses sitting in
 * the queue when the day's calling window closes. A same-day-only lookback
 * would drop those permanently — the next run, tomorrow, only reads
 * tomorrow's presses. Looking back one calendar day catches that backlog on
 * the first run of the next day instead of losing it silently. Two days is
 * the deliberate ceiling: a press old enough to miss a second day's calling
 * window is a stale lead by then, and this sweep dials from the customer's
 * own press, not a cold callback — it should not keep reaching back forever.
 *
 * ── The source of truth ──────────────────────────────────────────────────
 *
 * crm.v_ivr_lead already answers "did this press-1 get a bot dispatch
 * attempt" via bot_dispatched (crm.voice_dispatch, bool_or across every
 * attempt, Oriserve and ours alike — see the view). Re-deriving that here
 * from voice_dispatch directly would be a second opinion the view's own
 * comments already warn against duplicating.
 *
 * ── Oldest first within each day, but today gets a guaranteed half ───────
 *
 * crm.allocate_bl_press1 deals freshest-press-first, because it is working
 * the day's live traffic while the customer still remembers pressing 1. This
 * sweep is the opposite case on purpose: it is catching up on presses that
 * were ALREADY missed, so within a single day the ones waiting longest go
 * first.
 *
 * Across days, pure oldest-first starves today: 29 Sep 2026, four runs in a
 * row (05:14 through 06:44) spent their entire candidate limit clearing
 * yesterday's backlog before ever reading a single press from today, because
 * yesterday's presses are unconditionally older. A customer who pressed 1
 * twenty minutes ago waited behind hundreds of people who pressed the day
 * before. NEW_LEAD_SHARE reserves half of each run's limit for today before
 * the rest goes to the backlog — and if today doesn't have enough candidates
 * to fill its half, the unused share rolls over to yesterday's rather than
 * being left on the table.
 *
 * ── Every call still goes through the one dispatcher ────────────────────
 *
 * dispatchPressToOurBot, unchanged. The daily cap, the dial pacer (the thing
 * that actually stands between this and the 24 Sep failure), calling hours
 * (enforced inside journey-run) and the Oriserve overflow-or-not behaviour
 * all apply exactly as they do to a live press. A sweep that called anything
 * else would be a second, weaker way to dial, and the weaker one always wins
 * eventually — same reasoning as send-lead/route.ts in the CRM.
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Start of "today" in IST, as a UTC ISO string. Pure, so it is testable without a clock mock. */
export function istDayStartIso(now = new Date()) {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const istMidnight = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 0, 0, 0);
  return new Date(istMidnight - IST_OFFSET_MS).toISOString();
}

/** How many extra IST calendar days before today the sweep still looks back. */
const LOOKBACK_DAYS = 1;

/**
 * Start of the sweep's lookback floor in IST (today minus LOOKBACK_DAYS), as
 * a UTC ISO string — yesterday's midnight, not today's, so a burst's backlog
 * still un-dialled when yesterday's calling window closed gets one more day
 * to be caught before it ages out for good.
 */
export function istLookbackStartIso(now = new Date()) {
  return istDayStartIso(new Date(now.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000));
}

/** Presses considered per run. Unparseable or non-positive means the default. */
const DEFAULT_LIMIT = 200;

export function catchupLimit(env = process.env) {
  const raw = String(env.PRESS1_CATCHUP_LIMIT ?? "").trim();
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_LIMIT;
}

/**
 * Off unless explicitly on — the same "reaching the route is not permission
 * to dial" posture the Flexiloans campaign route documents in index.js.
 * CONSOLE_SECRET gates who may hit this route at all; this gates whether it
 * dials anyone once they do, so a cron wired up ahead of time cannot start
 * calling before someone deliberately flips it.
 */
export function catchupEnabled(env = process.env) {
  return String(env.PRESS1_CATCHUP_ENABLED ?? "").trim().toLowerCase() === "on";
}

/** Ten digits starting 6-9, or not a real Indian mobile. */
function validMobile(m) {
  return /^[6-9][0-9]{9}$/.test(String(m ?? ""));
}

/** Share of each run's limit reserved for today's presses, before the rest goes to the backlog. */
const NEW_LEAD_SHARE = 0.5;

/** One bucket of candidates, oldest first, in [gte, lt) of first_pressed_at. */
async function fetchCandidates(sb, { gte, lt, limit }) {
  if (limit <= 0) return [];
  let q = sb
    .from("v_ivr_lead")
    .select("mobile10, customer_name, first_pressed_at, press_variant")
    .eq("pressed_1", true)
    .eq("bot_dispatched", false)
    .gte("first_pressed_at", gte);
  if (lt) q = q.lt("first_pressed_at", lt);
  const { data, error } = await q.order("first_pressed_at", { ascending: true }).limit(limit);
  if (error) throw new Error(`candidate read failed: ${error.message}`);
  return (data ?? []).filter((r) => validMobile(r.mobile10));
}

/**
 * Today's and yesterday's businessloans press-1s with no bot dispatch
 * attempt yet. Today gets NEW_LEAD_SHARE of the limit (oldest-today first);
 * the backlog (yesterday, within the lookback floor) gets the rest, plus
 * whatever today didn't use. `sb` must be pinned to the crm schema.
 */
export async function catchupCandidates(sb, { limit = DEFAULT_LIMIT, now = new Date() } = {}) {
  const todayStart = istDayStartIso(now);
  const newQuota = Math.ceil(limit * NEW_LEAD_SHARE);

  const fresh = await fetchCandidates(sb, { gte: todayStart, limit: newQuota });
  const backlog = await fetchCandidates(sb, {
    gte: istLookbackStartIso(now),
    lt: todayStart,
    limit: limit - fresh.length,
  });

  const rows = [...fresh, ...backlog];
  if (!rows.length) return rows;

  // Do-not-contact, same check the allocator makes before ringing anyone —
  // a catch-up sweep is still an instruction to place a call.
  const { data: suppressed, error: supErr } = await sb
    .from("contact_suppression")
    .select("phone")
    .is("released_at", null)
    .in("phone", rows.map((r) => r.mobile10));
  if (supErr) throw new Error(`suppression read failed: ${supErr.message}`);
  const blocked = new Set((suppressed ?? []).map((r) => r.phone));

  return rows.filter((r) => !blocked.has(r.mobile10));
}

const emptyReport = () => ({
  ok: true, candidates: 0, dialled: 0, handedToOriserve: 0, skipped: 0, errors: 0,
});

/**
 * One run. Never throws: a failure to READ candidates is the one thing that
 * stops the sweep (there is nothing to dial); a failure to dial any one
 * candidate is counted and the sweep moves to the next.
 */
export async function runPress1Catchup({ sb, limit, now, dispatch, env = process.env } = {}) {
  const report = emptyReport();
  if (!catchupEnabled(env)) return { ...report, enabled: false };

  const client = sb ?? new SupabaseClient().client.schema("crm");
  const cap = limit ?? catchupLimit(env);
  const dial = dispatch ?? dispatchPressToOurBot;

  let candidates;
  try {
    candidates = await catchupCandidates(client, { limit: cap, now: now ?? new Date() });
  } catch (error) {
    return { ...report, ok: false, error: error?.message ?? String(error) };
  }
  report.candidates = candidates.length;

  for (const c of candidates) {
    const body = {
      mobile: c.mobile10,
      customer_name: c.customer_name || undefined,
      // Not a real IVR panel unique_id — there isn't one for a sweep — but
      // stable per (mobile, day) so a re-run of the same sweep within the
      // dispatcher's in-memory dedupe window cannot double-dial.
      unique_id: `press1-catchup:${c.mobile10}:${istDayStartIso(now ?? new Date())}`,
      campaign_name: c.press_variant || "businessloans",
    };
    try {
      // eslint-disable-next-line no-await-in-loop -- sequential on purpose:
      // the pacer already serialises dials, and awaiting here keeps this
      // sweep's own report accurate instead of racing its own candidates.
      const outcome = await dial(body, { digit: "1", variant: "businessloans" });
      if (outcome?.dialled) report.dialled++;
      else if (outcome?.handedToOriserve) report.handedToOriserve++;
      else report.skipped++;
    } catch (error) {
      console.error(`[PRESS1_CATCHUP] dispatch threw for ${c.mobile10}: ${error?.message ?? error}`);
      report.errors++;
    }
  }

  return report;
}

export default runPress1Catchup;
