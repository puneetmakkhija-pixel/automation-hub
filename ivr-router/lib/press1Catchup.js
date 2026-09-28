import SupabaseClient from "./supabaseClient.js";
import { dispatchPressToOurBot } from "./ourVoiceBotDispatch.js";

/**
 * The end-of-gap sweep: every Business Loans press-1 from TODAY that no
 * dispatcher has yet attempted a bot call for, dialled in the order the
 * customer pressed — oldest first.
 *
 * ── Why this exists on top of the real-time dispatch ────────────────────────
 *
 * A press-1 already gets a call attempt the moment it arrives
 * (ivrWhatsAppRoutes.js -> dispatchPressToOurBot / dispatchPressToVoiceBot).
 * This is not a replacement for that path; it is the safety net underneath
 * it. A press can reach neither bot for reasons that have nothing to do with
 * the caller — the daily cap was already spent, the dial queue was full, the
 * process restarted mid-pace, ORI_PRESS_DISPATCH=0 with our bot also refusing
 * — and today, with no Oriserve fallback to catch what our bot cannot take,
 * a press that misses its real-time window has nowhere else to go. This
 * sweep is that "else": it re-reads the day's press-1s against what was
 * actually dispatched and rings whoever is still missing.
 *
 * ── The source of truth ──────────────────────────────────────────────────
 *
 * crm.v_ivr_lead already answers "did this press-1 get a bot dispatch
 * attempt" via bot_dispatched (crm.voice_dispatch, bool_or across every
 * attempt, Oriserve and ours alike — see the view). Re-deriving that here
 * from voice_dispatch directly would be a second opinion the view's own
 * comments already warn against duplicating.
 *
 * ── Oldest first, deliberately opposite the allocator ────────────────────
 *
 * crm.allocate_bl_press1 deals freshest-press-first, because it is working
 * the day's live traffic while the customer still remembers pressing 1. This
 * sweep is the opposite case on purpose: it is catching up on presses that
 * were ALREADY missed, so the ones waiting longest go first — nobody who
 * pressed at 9am should sit behind somebody who pressed at 5pm because this
 * only looked at the freshest end of the queue.
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

/**
 * Today's businessloans press-1s with no bot dispatch attempt yet, oldest
 * press first. `sb` must be pinned to the crm schema.
 */
export async function catchupCandidates(sb, { limit = DEFAULT_LIMIT, now = new Date() } = {}) {
  const { data, error } = await sb
    .from("v_ivr_lead")
    .select("mobile10, customer_name, first_pressed_at, press_variant")
    .eq("pressed_1", true)
    .eq("bot_dispatched", false)
    .gte("first_pressed_at", istDayStartIso(now))
    .order("first_pressed_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(`candidate read failed: ${error.message}`);

  const rows = (data ?? []).filter((r) => validMobile(r.mobile10));
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
