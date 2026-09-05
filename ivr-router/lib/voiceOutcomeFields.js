/**
 * Reading the four facts out of a voice provider's callback.
 *
 * Who was called, what happened, how long it lasted, and the provider's own id
 * for the call. Every provider agrees those matter and none of them agree where
 * to put them.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * logVoiceCallOutcome read flat top-level keys only — payload.mobile,
 * payload.status, payload.call_id, payload.duration. Oriserve sends none of
 * those at the top level. Its callback is three nested objects:
 *
 *   { call:     { caller_id, ivr_variant, ivr_campaign_id, ... },
 *     result:   { status, disposition, call_id, call_duration_seconds, ... },
 *     analysis: { disposition, summary, ... },
 *     qc:       { overall_score, ... } }
 *
 * So on 5 Sep 2026 the first 719 callbacks — the first that ever got past the
 * webhook guard — were written with provider set and every other column NULL.
 * The rows existed, the IVR leads screen still read "Voice bot called: 0", and
 * 75 qualified leads and 50 callback requests were invisible. Nothing was lost
 * (the payload is kept whole in `raw`) but nothing was usable either.
 *
 * ── Generous, but not guessing ────────────────────────────────────────────
 *
 * Each fact has an ordered list of candidate paths, most specific first, and
 * the first non-empty one wins. Adding a provider means adding paths, not
 * rewriting the reader.
 *
 * It searches only the containers a callback actually uses, and only one level
 * down. It does NOT walk the payload looking for anything that resembles a
 * phone number: `from_number` on an Oriserve callback is OUR outbound line
 * (+918031806342 on every row), and a reader clever enough to find it would
 * file 719 calls against the same fictional lead.
 */

/** Containers a nested callback puts its fields in, searched in this order. */
const CONTAINERS = ["result", "call", "data", "payload", "event", "analysis"];

/** Ordered candidates: "key" is top-level, "container.key" is one level down. */
const MOBILE_PATHS = [
  // The person we rang. caller_id is Oriserve's name for the destination —
  // confirmed against 719 live callbacks, where it matched a dispatch row every
  // time. from_number is deliberately absent: that is our own outbound line.
  "call.caller_id",
  "mobile",
  "phone",
  "msisdn",
  "customer_number",
  "to_number",
  "call.mobile",
  "call.phone",
  "data.mobile",
  "data.phone",
  "payload.mobile",
];

const CALL_ID_PATHS = [
  "result.call_id",
  "call_id",
  "callId",
  "campaign_call_id",
  "call._campaign_call_id",
  "call.call_id",
  "data.call_id",
  "uuid",
];

const STATUS_PATHS = [
  // result.status is the outcome the bot reached — QUALIFIED_LEAD, DEAD AIR,
  // NOT_ELIGIBLE, CALLBACK. That is the fact worth reporting.
  //
  // result.disposition is NOT a fallback for it: it is a coarser field that
  // reads "Connected" for a qualified lead and for dead air alike, so letting
  // it stand in would turn 99 silent calls into successes. It is only reached
  // when there is no status at all, and it still beats storing null.
  "result.status",
  "status",
  "event_status",
  "call_status",
  "data.status",
  "analysis.disposition",
  "result.disposition",
];

const DURATION_PATHS = [
  "result.call_duration_seconds",
  "call_duration_seconds",
  "call_duration",
  "duration_sec",
  "duration",
  "data.duration",
  "result.duration",
];

function at(payload, path) {
  const dot = path.indexOf(".");
  if (dot === -1) return payload?.[path];
  const head = path.slice(0, dot);
  if (!CONTAINERS.includes(head)) return undefined;
  const inner = payload?.[head];
  if (!inner || typeof inner !== "object" || Array.isArray(inner)) return undefined;
  return inner[path.slice(dot + 1)];
}

/** First candidate that is present and not blank. */
function firstOf(payload, paths) {
  for (const path of paths) {
    const value = at(payload, path);
    if (value == null) continue;
    const text = String(value).trim();
    // "" and "null" both appear in Oriserve callbacks for fields it has no
    // value for — unique_id, transfer_reason, callback_date. Treated as absent,
    // because storing the string "null" is worse than storing nothing.
    if (!text || text.toLowerCase() === "null" || text.toLowerCase() === "undefined") continue;
    return text;
  }
  return null;
}

/**
 * @param {object} payload the callback body as received
 * @returns {{mobile: string|null, callId: string|null, status: string|null,
 *            duration: number|null}}
 */
export function readVoiceOutcome(payload = {}) {
  const body = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};

  const rawDuration = firstOf(body, DURATION_PATHS);
  const durationNumber = rawDuration == null ? NaN : Number(rawDuration);

  return {
    mobile: firstOf(body, MOBILE_PATHS),
    callId: firstOf(body, CALL_ID_PATHS),
    status: firstOf(body, STATUS_PATHS),
    // A negative duration is a provider bug, not a short call; null says
    // "unknown" rather than putting a nonsense number in a reporting column.
    duration:
      Number.isFinite(durationNumber) && durationNumber >= 0
        ? Math.trunc(durationNumber)
        : null,
  };
}

export default readVoiceOutcome;
