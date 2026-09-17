/**
 * A bounded runway for press-1 work.
 *
 * ── What broke ────────────────────────────────────────────────────────────
 *
 * 17 Sep 2026, campaign 1193640. The dialler put 227 press-1s into this
 * service inside one minute — roughly four a second. Each press is not one
 * unit of work, it is five: resolve the customer, mint an SSO link from the
 * CRM, try the primary template, try the standby, write the send log. Three of
 * those are round trips to Supabase.
 *
 * Express does not push back. It accepted all 227 and ran them at once, so
 * ~227 concurrent requests each held a database connection while waiting on a
 * ten-second HTTP timeout. Supabase ran out of pool:
 *
 *   09:09:31  error 522 from Cloudflare in front of supabase.co
 *   09:09:37  "Timed out acquiring connection from connection pool"
 *   09:09:39  "Could not query the database for the schema cache"
 *   09:09:43  [IVR_WA] Could not record send (sent)  x7
 *
 * Read that last line carefully. The message reached the customer and the log
 * row did not, so the damage is not only the presses that failed — it is that
 * afterwards nobody could tell which ones those were. 99 of 426 callers have
 * no row of any kind for that minute.
 *
 * The SSO mint went down with it. Dozens of
 * "[IVR_WA] Plain apply link for <mobile> (error) — customer will do OTP"
 * in the same seconds: those people got a link that drops them at the OTP
 * screen instead of past it, which is the single widest leak in this funnel.
 *
 * ── What this does about it ───────────────────────────────────────────────
 *
 * Nothing clever. It caps how many presses are in flight at once and makes the
 * rest wait their turn. A burst becomes a queue that drains in a few seconds
 * rather than a stampede that takes the database down for everyone — including
 * the CRM, the cockpit, and the other lender's traffic sharing this webhook.
 *
 * Queueing is only safe because the caller answers the panel BEFORE handing
 * work over (see ivrWhatsAppRoutes). Holding an unanswered webhook in a queue
 * would just move the timeout from our database to their dialler.
 *
 * ── Why not a real queue ──────────────────────────────────────────────────
 *
 * Redis or a jobs table would survive a restart; this does not. It is also a
 * new dependency, new failure modes, and a second place where a press can get
 * stuck. The loss today was not caused by a restart — the process stayed up
 * throughout — it was caused by unbounded fan-out at the database. This fixes
 * that and nothing else, deliberately. If a restart ever does become the thing
 * eating presses, /api/resend/failed already replays from the send log.
 */

/**
 * How many presses may be in flight at once.
 *
 * Eight, because Supabase's pool is sixty connections and this service is not
 * its only client: the CRM crons, the cockpit and pg_net all draw on the same
 * sixty. A press holds at most two connections at a time, so eight in flight
 * is around sixteen — a quarter of the pool at peak, leaving room for everyone
 * else to keep working while a burst drains.
 *
 * Raising it trades safety for drain speed. Below 1 would stop the service
 * dead, so the floor is 1.
 */
export function maxInFlight() {
  return readInt(process.env.IVR_PRESS_CONCURRENCY, 8, 1);
}

/**
 * An integer from an environment variable, or the fallback.
 *
 * Number("") is 0, not NaN — which is how an unset-looking variable becomes a
 * cap of zero and stops the service dead. An empty or whitespace-only value is
 * "not configured" here, and only a value at or above `floor` is taken.
 */
function readInt(raw, fallback, floor) {
  const text = String(raw ?? "").trim();
  if (text === "") return fallback;
  const n = Number(text);
  return Number.isFinite(n) && n >= floor ? Math.floor(n) : fallback;
}

/**
 * How many may WAIT. Past this the work is refused rather than queued.
 *
 * A queue with no ceiling is just a slower way to run out of memory, and a
 * press that has been waiting several minutes is worthless anyway — the caller
 * hung up long ago. Refusing is also louder than queueing: it logs, where an
 * ever-growing backlog looks like nothing at all until the container dies.
 */
export function maxWaiting() {
  return readInt(process.env.IVR_PRESS_QUEUE_LIMIT, 500, 0);
}

let running = 0;
const waiting = [];

/** Live depth, for the health endpoint and for tests. */
export function queueStats() {
  return { running, waiting: waiting.length, maxInFlight: maxInFlight(), maxWaiting: maxWaiting() };
}

/** Test seam: drop any queued work and reset the counters. */
export function resetQueue() {
  running = 0;
  waiting.length = 0;
  idleWaiters.length = 0;
}

const idleWaiters = [];

/**
 * Resolves once nothing is running and nothing is waiting.
 *
 * The webhook answers the panel before the work happens, so "the request came
 * back" no longer means "the message went". Anything that needs to observe the
 * send — a test, or a shutdown that would rather not drop a press on the floor
 * — waits on this instead.
 */
export function drain() {
  if (running === 0 && waiting.length === 0) return Promise.resolve();
  return new Promise((resolve) => idleWaiters.push(resolve));
}

function releaseIdleWaiters() {
  if (running !== 0 || waiting.length !== 0) return;
  while (idleWaiters.length > 0) idleWaiters.shift()();
}

function pump() {
  while (running < maxInFlight() && waiting.length > 0) {
    const job = waiting.shift();
    running += 1;
    // The job's own errors are the job's business — a press that throws must
    // not stop the ones behind it, and must not become an unhandled rejection
    // either, which in Node 22 takes the whole process down and with it every
    // other press in flight.
    // The slot is given back BEFORE the waiter is resolved, not in a .finally
    // after it. Otherwise anyone who awaits runQueued() and then reads
    // queueStats() sees a slot that is logically free still counted as busy —
    // which is a confusing thing for a health check to report and a worse one
    // to debug from.
    const settle = (outcome) => {
      running -= 1;
      job.resolve(outcome);
      pump();
      releaseIdleWaiters();
    };

    Promise.resolve()
      .then(job.fn)
      .then(
        (value) => settle(value),
        (error) => settle({ ok: false, error })
      );
  }
}

/**
 * Run `fn` when there is room. Resolves when it has run.
 *
 * Never rejects: a caller that has already answered the panel has nothing to
 * do with a rejection, and an unhandled one would be fatal. Failures come back
 * as `{ ok: false, error }` and the queue keeps moving.
 *
 * Returns `{ ok: false, reason: "queue full" }` without running anything when
 * the backlog is at its ceiling.
 */
export function runQueued(fn) {
  if (waiting.length >= maxWaiting()) {
    console.error(
      `[IVR_PRESS] Queue full (${waiting.length} waiting, ${running} in flight) — ` +
        "dropping this press. The dialler is delivering faster than this service " +
        "can send. Raise IVR_PRESS_CONCURRENCY only if the database has headroom."
    );
    return Promise.resolve({ ok: false, reason: "queue full" });
  }

  return new Promise((resolve) => {
    waiting.push({ fn, resolve });
    pump();
  });
}
