/**
 * How fast our voice bot may dial.
 *
 * ── What broke ────────────────────────────────────────────────────────────
 *
 * 24 Sep 2026. The daily cap went from 100 to 200, and the morning's presses
 * arrived as they always do — in one lump from the IVR panel. All 200 slots
 * were claimed inside 203 seconds, and 98 calls went out in three minutes.
 *
 * 42 of the first 100 died with call_duration_secs = 0 and message_count = 0.
 * Not short calls — calls that never connected at all. Measured against how
 * many calls started in the preceding sixty seconds:
 *
 *     calls/min    n   failed   rate
 *        1 - 5     6        0     0%
 *        6 - 10    6        0     0%
 *       11 - 20   10        1    10%
 *       21 - 40   24       12    50%
 *         41 +    54       29    54%
 *
 * Per minute it is starker still: 10:33 IST started 35 and lost 31% of them,
 * 10:34 started 49 and lost 55%. At 11:11 and 11:41, one call each, nothing
 * lost. Below roughly ten a minute nothing fails; past twenty, half of it does.
 *
 * The ceiling is ours, not the vendor's — the ElevenLabs agent runs with
 * agent_concurrency_limit -1 and a 100,000/day allowance. Which component of
 * ours gives out first (Asterisk, the PJSIP endpoint, the trunk) is not
 * established, and this module does not need to know: the shape of the failure
 * is a rate, so the remedy is a rate.
 *
 * ── What this does about it ───────────────────────────────────────────────
 *
 * Spaces the dials out. A burst becomes a queue that drains at a survivable
 * rate — 200 calls take about twenty-five minutes at the default, which is
 * comfortably inside the 10:00-19:00 calling window.
 *
 * It paces the START of each call and does not wait for it to finish. The
 * measurement above counted calls started per minute, so that is what is
 * capped; a two-minute conversation must not slow the queue behind it.
 *
 * ── Why this is not pressQueue ────────────────────────────────────────────
 *
 * pressQueue bounds how many presses are IN FLIGHT, to keep a burst from
 * exhausting Supabase's connection pool. That is a different failure and a
 * different remedy: eight concurrent jobs that each finish in 200ms still dial
 * fifty times a minute, which is deep in the half-failing band above. One
 * limits parallelism, the other limits pace, and the press path needs both.
 *
 * ── Why not a durable queue ───────────────────────────────────────────────
 *
 * A restart drops whatever is waiting, and those presses are then never dialled
 * by this path. That is survivable and deliberate: no row is written to
 * crm.voice_dispatch for a call that did not happen, so the lead reads as
 * un-dialled, and the CRM's follow-up sweep picks it up on its next pass. A
 * Redis or jobs-table queue would remove that gap at the cost of a new
 * dependency and a second place for a press to get stuck. The loss being fixed
 * here is not caused by restarts.
 */

/**
 * Dials per minute. Eight sits inside the band where nothing failed, with room
 * underneath it rather than at the edge of the one that started to.
 *
 * Raising it past ten is knowingly re-entering the failure band, and the cost
 * is not a slow queue but a customer whose phone never rings.
 */
export function callsPerMinute(env = process.env) {
  return readInt(env.OUR_BOT_CALLS_PER_MINUTE, 8, 1);
}

/**
 * The batch: at most this many dials START in any rolling window of
 * windowMinutes(). 15 per 10 minutes by default.
 *
 * 24 Sep, 10:35 IST: 103 calls in the hour, and 42 rejected by ElevenLabs with
 * error 4300 -- "Agent ... has reached its maximum concurrent capacity of 30.
 * Current agent limit: 30, workspace limit: 30". The per-minute pace above
 * spaces a burst out; this bounds how much of it can overlap at all. Fifteen
 * in ten minutes keeps even five-minute calls (the agent's max_duration)
 * well under thirty at once.
 *
 * Within a batch the per-minute pace still applies, so fifteen dials take
 * about two minutes to start and the rest of the window is quiet.
 */
export function callsPerWindow(env = process.env) {
  return readInt(env.OUR_BOT_CALLS_PER_WINDOW, 15, 1);
}

/** Length of that rolling window, in minutes. */
export function windowMinutes(env = process.env) {
  return readInt(env.OUR_BOT_WINDOW_MINUTES, 10, 1);
}

/**
 * How many dials may WAIT. Past this the press goes to Oriserve instead.
 *
 * Handing it over is better than holding it: Oriserve has its own capacity and
 * has been answering this traffic for weeks, so an overflowing queue costs a
 * slower bot rather than an unrung phone. 300 is above a full day's cap, so in
 * normal running it is never reached and the value only matters if something
 * upstream goes wrong.
 */
export function maxWaiting(env = process.env) {
  return readInt(env.OUR_BOT_DIAL_QUEUE_LIMIT, 300, 0);
}

/**
 * An integer from an environment variable, or the fallback.
 *
 * Number("") is 0, not NaN — which is how an unset-looking variable becomes a
 * rate of zero and stops the bot dead. Blank means "not configured", and only a
 * value at or above `floor` is taken.
 */
function readInt(raw, fallback, floor) {
  const text = String(raw ?? "").trim();
  if (text === "") return fallback;
  const n = Number(text);
  return Number.isFinite(n) && n >= floor ? Math.floor(n) : fallback;
}

const waiting = [];
/** Start times of recent dials, oldest first, for the rolling window. */
const recentStarts = [];
let pumping = false;
let lastStartedAt = 0;
const idleWaiters = [];

/** The gap between two dials, from the configured rate. */
export function intervalMs(env = process.env) {
  return Math.max(1, Math.round(60000 / callsPerMinute(env)));
}

/** Live depth, for the health endpoint and for tests. */
export function pacerStats() {
  return {
    waiting: waiting.length,
    callsPerMinute: callsPerMinute(),
    callsPerWindow: callsPerWindow(),
    windowMinutes: windowMinutes(),
    maxWaiting: maxWaiting(),
  };
}

/**
 * Is there room to queue another dial?
 *
 * Asked BEFORE the daily slot is claimed, so a press this module cannot take
 * costs nothing and can still go to Oriserve with its slot intact.
 */
export function hasRoom() {
  return waiting.length < maxWaiting();
}

/** Test seam: drop anything queued and reset the clock. */
export function resetPacer() {
  waiting.length = 0;
  recentStarts.length = 0;
  pumping = false;
  lastStartedAt = 0;
  idleWaiters.length = 0;
}

/** Resolves once nothing is queued — for tests and for an orderly shutdown. */
export function drainPacer() {
  if (waiting.length === 0 && !pumping) return Promise.resolve();
  return new Promise((resolve) => idleWaiters.push(resolve));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (waiting.length > 0) {
      const due = lastStartedAt + intervalMs() - Date.now();
      if (due > 0) await sleep(due);

      // The batch. When this window's quota is spent, wait for its oldest
      // dial to age out rather than start one more on top of it.
      const windowMs = windowMinutes() * 60000;
      while (recentStarts.length > 0 && recentStarts[0] <= Date.now() - windowMs) recentStarts.shift();
      if (recentStarts.length >= callsPerWindow()) {
        // unref: a timer holding for the window must not by itself keep the
        // process alive through a shutdown.
        await new Promise((resolve) => setTimeout(resolve, recentStarts[0] + windowMs - Date.now()).unref());
        continue;
      }

      const job = waiting.shift();
      lastStartedAt = Date.now();
      recentStarts.push(lastStartedAt);

      // Started, not awaited. The rate being capped is calls STARTED per
      // minute; waiting for a two-minute conversation here would throttle the
      // queue to the length of its calls and quietly undo the cap.
      //
      // Errors are swallowed into the resolution for the same reason they are
      // in pressQueue: an unhandled rejection in Node 22 ends the process, and
      // with it every dial still queued behind this one.
      Promise.resolve()
        .then(job.fn)
        .then(job.resolve, (error) => job.resolve({ dialled: false, reason: `error: ${error?.message ?? error}` }));
    }
  } finally {
    pumping = false;
    while (idleWaiters.length > 0) idleWaiters.shift()();
  }
}

/**
 * Run `fn` when the pace allows. Resolves with whatever `fn` returned.
 *
 * Never rejects — the caller has already answered the IVR panel and has nothing
 * to do with a rejection.
 */
export function paceDial(fn) {
  return new Promise((resolve) => {
    waiting.push({ fn, resolve });
    pump();
  });
}

export default paceDial;
