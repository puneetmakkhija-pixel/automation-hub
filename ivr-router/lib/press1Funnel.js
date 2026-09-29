/**
 * The press-1 funnel, read back out of crm.voice_dispatch.
 *
 * ourVoiceBotDispatch.js and oriVoiceDispatch.js decide, per press, who dials
 * and why not when they don't — and until now that record only existed as
 * scattered console.log lines and the raw rows themselves. This turns those
 * rows into the shape the question is actually asked in: how many presses
 * came in today, how many went to each bot, how many of those were actually
 * dialled, and what stopped the rest.
 *
 * Read-only. It does not touch routing, pacing, or the daily cap — it reports
 * on what they already decided.
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const PAGE = 1000;

/** Today in IST, as YYYY-MM-DD, without pulling in a date library for one call site. */
export function istToday(now = new Date()) {
  return new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * [start, end) in UTC for one IST calendar day, as ISO strings for a
 * PostgREST range filter.
 *
 * IST is a fixed +5:30 offset (no DST), so "IST midnight" is always the same
 * arithmetic — unlike a real timezone library this cannot drift across a
 * year, which is the only property this needs.
 */
export function istDayBoundsUtc(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr ?? ""))) {
    throw new Error(`bad date "${dateStr}", expected YYYY-MM-DD`);
  }
  const startUtcMs = Date.parse(`${dateStr}T00:00:00.000Z`) - IST_OFFSET_MS;
  const endUtcMs = startUtcMs + 24 * 60 * 60 * 1000;
  return { startIso: new Date(startUtcMs).toISOString(), endIso: new Date(endUtcMs).toISOString() };
}

/** Every voice_dispatch row for the day, paged past PostgREST's row cap. */
async function fetchDayRows(sb, { startIso, endIso }) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("voice_dispatch")
      .select("provider, variant, dispatched, reason, raw, created_at")
      .gte("created_at", startIso)
      .lt("created_at", endIso)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);

    if (error) throw new Error(error.message);
    const page = data ?? [];
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows;
}

const bump = (obj, key) => {
  const k = key ?? "unspecified";
  obj[k] = (obj[k] ?? 0) + 1;
};

/**
 * Roll the day's rows into the funnel shape.
 *
 * Exported separately from the route so it can be unit-tested against a
 * plain array, without a Supabase client or an HTTP request.
 */
export function summarizeRows(rows) {
  const byVariant = {};
  const byProvider = {};
  const notDialledReasons = {};
  const armCounts = {};
  const fallbackReasons = {};
  let dialled = 0;

  for (const row of rows) {
    const provider = String(row.provider || "unknown").toLowerCase();
    bump(byVariant, row.variant);

    byProvider[provider] ??= { dialled: 0, not_dialled: 0 };
    if (row.dispatched) {
      byProvider[provider].dialled++;
      dialled++;
    } else {
      byProvider[provider].not_dialled++;
      notDialledReasons[provider] ??= {};
      bump(notDialledReasons[provider], row.reason);
    }

    // Only present on rows written under BOT_SPLIT_MODE=split (see
    // lib/ourVoiceBotDispatch.js routePress and docs/migrations-needed/
    // crm_voice_dispatch_arm.sql) — absent elsewhere, so these stay empty
    // outside the split rather than misreporting it as zero-volume.
    const arm = row.raw?.arm;
    if (arm) bump(armCounts, arm);
    const fallbackReason = row.raw?.fallback_reason;
    if (fallbackReason) bump(fallbackReasons, fallbackReason);
  }

  return {
    received: rows.length,
    dialled,
    not_dialled: rows.length - dialled,
    by_variant: byVariant,
    by_provider: byProvider,
    not_dialled_reasons: notDialledReasons,
    split: { arm_counts: armCounts, fallback_reasons: fallbackReasons },
  };
}

/** The funnel for one IST calendar day (default: today). */
export async function press1Funnel(sb, { date } = {}) {
  const day = date ?? istToday();
  const bounds = istDayBoundsUtc(day);
  const rows = await fetchDayRows(sb, bounds);
  return { date: day, window_utc: bounds, ...summarizeRows(rows) };
}

export default press1Funnel;
