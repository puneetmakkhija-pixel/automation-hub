import SupabaseClient from "./supabaseClient.js";

/**
 * What actually happened on our own bot's calls, asked for rather than waited for.
 *
 * journey-run writes crm.journey_run_log.voice_status = "sent" the moment
 * ElevenLabs accepts a call request. That is not a phone ringing. ElevenLabs
 * returns a conversation_id before the SIP INVITE is even answered, so "sent"
 * is an optimistic record of our intent and nothing more.
 *
 * The push half of the pair -- the `voice-status` edge function -- is deployed
 * and correct, and has never received a single delivery: post-call webhooks are
 * a WORKSPACE-level setting in ElevenLabs, and no workspace webhook points at
 * it. So on 17 Sep 2026 all 14 calls our bot had ever placed read "sent" with a
 * null disposition, and the truth was worse than unknown -- it was wrong:
 *
 *   19 Aug  conv_2001m0d7ac...  no_answer                  (rang, not picked up)
 *   02 Sep  conv_9301m1gbde...  call_initialization_error  (never rang)
 *   17 Sep  conv_3601m2qbzd...  call_initialization_error  (never rang)
 *
 * Eleven of those were real customers on 2 Sep. Every one read "sent".
 *
 * ── Why pull and not push ─────────────────────────────────────────────────
 *
 * Registering the workspace webhook needs a human in the ElevenLabs dashboard,
 * and a webhook that is registered can still be un-registered by anyone with
 * that dashboard -- silently, with the same symptom as before: rows that say
 * "sent" forever. A poll asks the question ourselves and cannot be switched off
 * from someone else's settings page.
 *
 * The two are not exclusive. If the workspace webhook is registered later,
 * `voice-status` writes the disposition first and this poller skips the row --
 * see `PENDING_FILTER`. Whichever arrives first wins and neither overwrites the
 * other.
 *
 * ── Terminal, or come back later ──────────────────────────────────────────
 *
 * Only `done` and `failed` are written. Any other status -- a call still
 * ringing, still being processed -- is left exactly as it is for the next run.
 * That is the single most important property here: a call that is RINGING must
 * never be filed as one that failed, because the row is then never revisited
 * and the lead looks dead when nobody has spoken to them yet.
 */

/** ElevenLabs conversation statuses that mean the call is over. */
const TERMINAL_STATUSES = new Set(["done", "failed"]);

/**
 * Don't poll a call younger than this: a call placed seconds ago is still
 * ringing, and asking about it only costs a request that says "processing".
 */
const SETTLE_MS = 2 * 60 * 1000;

/** Nor older than this. A row this stale is not going to resolve itself. */
const MAX_AGE_DAYS = 7;

/** Rows per run. Poll is a loop of one HTTP call each; it is not a queue. */
const DEFAULT_BATCH = 50;

/**
 * ElevenLabs `error.error_type` -> our disposition.
 *
 * The five dispositions are the same ones crm.voice_call_events already uses
 * for Oriserve, so one query still answers "how many answered today" across
 * both bots.
 *
 * Deliberately a lookup and not a regex sweep. voice-status has to guess
 * because DeepCall's vocabulary was never confirmed; ElevenLabs gives a small
 * structured enum, so guessing here would only invent precision we do not have.
 * An error_type that is not in this table maps to "failed" -- accurate at the
 * coarse level, since the call did fail -- and is logged by name so the next
 * one can be added deliberately rather than absorbed silently.
 */
const ERROR_TYPE_DISPOSITION = Object.freeze({
  no_answer: "no_answer",
  busy: "busy",
  declined: "busy",
  rejected: "busy",
  cancelled: "cancelled",
  canceled: "cancelled",
  call_initialization_error: "failed",
  call_failed: "failed",
});

/**
 * One conversation, read into the four facts the CRM stores.
 *
 * Pure: no network, no database, no clock. The mapping is the part that can be
 * wrong in a way that matters, so it is the part that is testable on its own.
 *
 * @param {object} conversation the ElevenLabs conversation object
 * @returns {{terminal: boolean, disposition: string|null, durationSec: number|null,
 *            status: string|null, errorType: string|null, errorReason: string|null,
 *            agentId: string|null, unmappedErrorType: boolean}}
 */
export function outcomeOf(conversation) {
  const status = str(conversation?.status);
  const meta = conversation?.metadata ?? {};
  const errorType = str(meta?.error?.error_type);
  const errorReason = str(meta?.error?.reason);
  const durationSec = int(meta?.call_duration_secs);
  // When the call actually started, so the row can record when it ENDED rather
  // than when we happened to ask. Seconds since epoch, per the ElevenLabs
  // conversation payload.
  const startedAtUnix = int(meta?.start_time_unix_secs ?? conversation?.start_time_unix_secs);
  // WHICH agent took the call. There are two "BuddyLoan Sales Agent - Priya"
  // agents on the workspace with different voices, deliberately kept so the two
  // can be compared. A comparison needs the arm recorded against the outcome,
  // and nothing else on this path records it: journey_run_log has no column for
  // it and the dialler reads one VOICEBOT_AGENT_ID. The conversation carries it
  // already, so reading it here costs a field and makes the comparison possible
  // the moment calls start connecting.
  const agentId = str(conversation?.agent_id);

  const base = {
    status,
    errorType,
    errorReason,
    durationSec,
    startedAtUnix,
    agentId,
    unmappedErrorType: false,
  };

  // Not over yet. Write nothing, keep the row, ask again next run.
  if (!status || !TERMINAL_STATUSES.has(status)) {
    return { ...base, terminal: false, disposition: null };
  }

  if (status === "failed") {
    // Order matters, and this is the same trap voice-status documents: a call
    // that was never answered is a FAILED call with error_type "no_answer".
    // Reading `status` alone and calling it "failed" loses the single most
    // useful distinction in the table -- the customer's phone rang, and they
    // did not pick up, which is a retry; a call that never rang is a fault.
    // Object.hasOwn, not a bare index: an error_type of "constructor" or
    // "toString" indexes Object.prototype and yields a function, which would
    // be written to voice_disposition as-is. Object.freeze does not stop that.
    const mapped =
      errorType && Object.hasOwn(ERROR_TYPE_DISPOSITION, errorType)
        ? ERROR_TYPE_DISPOSITION[errorType]
        : undefined;
    return {
      ...base,
      terminal: true,
      disposition: mapped ?? "failed",
      unmappedErrorType: Boolean(errorType) && mapped === undefined,
    };
  }

  // status === "done": the conversation ran to completion.
  return { ...base, terminal: true, disposition: "answered" };
}

const str = (v) => {
  const s = typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
  return s === "" ? null : s;
};

const int = (v) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

/** Ten digits, or null -- crm.voice_call_events.mobile10 is generated from this. */
export function mobile10Of(raw) {
  const digits = String(raw ?? "").replace(/\D/g, "");
  const ten = digits.length > 10 ? digits.slice(-10) : digits;
  return ten.length === 10 ? ten : null;
}

/** GET one conversation from ElevenLabs. Throws; the caller decides what that means. */
async function fetchConversation(conversationId, { apiKey, baseUrl, fetchImpl }) {
  const url = `${baseUrl}/convai/conversations/${encodeURIComponent(conversationId)}`;
  const res = await fetchImpl(url, {
    method: "GET",
    headers: { "xi-api-key": apiKey, accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`http_${res.status}`);
  }
  return res.json();
}

/**
 * Fill in the outcomes we are missing.
 *
 * Never throws. This runs behind an operator endpoint and, later, a schedule;
 * a poller that rejected would take the process down for every lender on this
 * service, and none of what it writes is worth that.
 *
 * @returns {Promise<{polled:number, updated:number, pending:number, skipped:number,
 *                    errors:string[], reason?:string}>}
 */
export async function pollVoiceOutcomes(options = {}, deps = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit) || DEFAULT_BATCH, 200));
  const result = { polled: 0, updated: 0, claimed: 0, pending: 0, skipped: 0, errors: [] };

  try {
    const apiKey = deps.apiKey ?? process.env.ELEVEN_LABS_API_KEY;
    if (!apiKey) {
      return { ...result, reason: "not_configured" };
    }
    const baseUrl =
      deps.baseUrl ?? process.env.ELEVEN_LABS_BASE_URL ?? "https://api.elevenlabs.io/v1";
    const fetchImpl = deps.fetch ?? fetch;
    const now = deps.now ? deps.now() : Date.now();

    const sb = deps.sb ?? new SupabaseClient().client.schema("crm");

    const settledBefore = new Date(now - SETTLE_MS).toISOString();
    const notOlderThan = new Date(now - MAX_AGE_DAYS * 86400_000).toISOString();

    const { data: rows, error } = await sb
      .from("journey_run_log")
      .select("id, mobile, voice_provider_call_id, created_at")
      .eq("voice_provider", "elevenlabs")
      .eq("voice_status", "sent")
      // PENDING_FILTER: only rows nobody has answered yet. If the workspace
      // webhook is ever registered, voice-status writes this column and the
      // row drops out of this query rather than being written over.
      .is("voice_disposition", null)
      .not("voice_provider_call_id", "is", null)
      .lt("created_at", settledBefore)
      .gt("created_at", notOlderThan)
      // OLDEST first. Newest-first plus a batch ceiling means a backlog larger
      // than one batch never reaches its oldest rows: each run re-polls the
      // newest `limit` and the stragglers age out under MAX_AGE_DAYS still
      // unresolved -- silently, because they simply stop being selected.
      .order("created_at", { ascending: true })
      .limit(limit);

    if (error) throw new Error(`journey_run_log unreadable: ${error.message}`);
    result.pending = rows?.length ?? 0;

    for (const row of rows ?? []) {
      const callId = row.voice_provider_call_id;
      let conversation;
      try {
        conversation = await fetchConversation(callId, { apiKey, baseUrl, fetchImpl });
        result.polled++;
      } catch (e) {
        result.errors.push(`${callId}: ${e?.message ?? e}`);
        continue;
      }

      const outcome = outcomeOf(conversation);
      if (!outcome.terminal) {
        result.skipped++;
        continue;
      }
      if (outcome.unmappedErrorType) {
        console.warn(
          `[VOICE_POLL] unmapped ElevenLabs error_type "${outcome.errorType}" on ${callId} ` +
            "— recorded as failed. Add it to ERROR_TYPE_DISPOSITION."
        );
      }

      // When the call ended, from the call. Falling back to `now` records the
      // moment we asked, which on a backlog can be days after the fact.
      const endedAtMs =
        outcome.startedAtUnix != null
          ? (outcome.startedAtUnix + (outcome.durationSec ?? 0)) * 1000
          : now;

      const patch = {
        voice_disposition: outcome.disposition,
        voice_ended_at: new Date(endedAtMs).toISOString(),
      };
      if (outcome.durationSec != null) patch.voice_duration_sec = outcome.durationSec;

      const { data: claimedRows, error: updateError } = await sb
        .from("journey_run_log")
        .update(patch)
        .eq("id", row.id)
        // Re-check under the write: between the SELECT above and here, the
        // webhook may have landed. Last writer must not be the one that wins.
        .is("voice_disposition", null)
        // .select() is what makes that re-check OBSERVABLE, and without it the
        // guard only half works. PostgREST matches zero rows and returns
        // success, so `error` is null whether we wrote the row or the webhook
        // beat us to it -- the update is correctly skipped, and then this
        // function counts it as updated and inserts a SECOND voice_call_events
        // row for a call another writer has already filed. Asking for the ids
        // back is the only way to tell the two apart.
        .select("id");

      if (updateError) {
        result.errors.push(`${callId}: update ${updateError.message}`);
        continue;
      }

      // Zero rows back: somebody else filled this in between the select and
      // here. Their disposition stands and there is nothing more to write.
      if (!claimedRows || claimedRows.length === 0) {
        result.claimed++;
        continue;
      }
      result.updated++;

      // The same row Oriserve's callbacks write, so "who did we call today"
      // stays one query across both bots. Failure here is not failure of the
      // poll: the disposition above is the fact worth keeping.
      const { error: eventError } = await sb.from("voice_call_events").insert({
        provider: "elevenlabs",
        call_id: callId,
        mobile: row.mobile ?? null,
        // The DISPOSITION, not the transport status. crm.voice_call_events is
        // shared with Oriserve, whose rows put dispositions here (RNR,
        // VOICEMAIL, QUALIFIED_LEAD...), so writing "done"/"failed" would both
        // break that convention and collapse no_answer, busy and cancelled
        // into one value -- the exact distinction this poller exists to
        // recover. The raw status stays in `raw.status` below.
        event_status: outcome.disposition,
        duration_sec: outcome.durationSec,
        raw: {
          via: "voice-outcome-poll",
          status: outcome.status,
          error_type: outcome.errorType,
          error_reason: outcome.errorReason,
          disposition: outcome.disposition,
          // Queryable as raw->>'agent_id' -- which is how the two Priya agents
          // get compared without a schema change.
          agent_id: outcome.agentId,
        },
      });
      if (eventError) result.errors.push(`${callId}: event ${eventError.message}`);
    }
  } catch (error) {
    result.errors.push(`error: ${error?.message ?? error}`);
  }

  return result;
}

export default pollVoiceOutcomes;
