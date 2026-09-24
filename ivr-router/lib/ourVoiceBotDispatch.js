import SupabaseClient from "./supabaseClient.js";
import { recordVoiceDispatch } from "./voiceDispatchLog.js";
import { dispatchPressToVoiceBot } from "./oriVoiceDispatch.js";
import { hasRoom, paceDial } from "./dialPacer.js";

/**
 * A press of 1, handed to OUR voice bot instead of Oriserve's.
 *
 * Oriserve's bot runs their script on their tenant. Ours is the ElevenLabs
 * Conversational AI agent in the CRM — our persona (agent/persona.md), our
 * knowledge base, and `get_case_context` for live grounding, so it answers
 * "am I eligible?" from crm.bre_eligible rather than from a script. Measured
 * 15 Sep, journey-run reports it configured with nothing missing:
 * provider=elevenlabs, agent_id_set, phone_number_id_set, missing=[].
 *
 * It is reached through the journey bot's own entry point rather than by a
 * second copy of the calling code:
 *
 *   POST journey_fn_url {action:"run", mobile, step:"intent",
 *                        channels:{whatsapp:false, voice:true}}
 *
 * That is deliberate. runJourney already resolves the customer, composes the
 * opener, places the call through _shared/voicebot.ts and writes
 * crm.journey_run_log. A dialler that reimplemented any of that would drift
 * from it, and the outcome would stop being readable in one place.
 *
 * ── WHICH PRESSES ───────────────────────────────────────────────────────────
 *
 * OUR_BOT_VARIANTS is a hardcoded allowlist and the env var can only SUBTRACT
 * from it — the same shape as DIALABLE_VARIANTS in oriVoiceDispatch.js, for the
 * same reason it was made that way there: a one-word edit in a dashboard must
 * not be able to point a paid bot at a book it was never meant to call.
 *
 * `businessloans` was deliberately NOT in this list, and the reason was sound:
 * that variant is Oriserve's live campaign at 700-1,500 calls a day, and moving
 * it wholesale is a decision with a blast radius rather than a side effect of
 * adding a second bot.
 *
 * It is here now because the DAILY CAP below changes what including it means.
 * Our bot does not take the variant; it takes the first OUR_BOT_DAILY_CAP
 * presses of each day from it. Press 101 goes to Oriserve exactly as press 1
 * did yesterday. The blast radius is the cap, and the cap is a number.
 *
 * The allowlist still cannot be widened from a dashboard -- OUR_BOT_VARIANTS
 * can only subtract from this set -- so the one-word edit that would point a
 * paid bot at a book it was never meant to call is still impossible.
 */
const OUR_BOT_VARIANTS = new Set(["flexiloans", "businessloans"]);

/** Presses our bot may take per IST day. Anything unparseable means the default. */
const DEFAULT_DAILY_CAP = 100;

export function ourBotDailyCap(env = process.env) {
  const raw = String(env.OUR_BOT_DAILY_CAP ?? "").trim();
  if (!raw) return DEFAULT_DAILY_CAP;
  const n = Number(raw);
  // Not a number, negative, or fractional: fall back to the default rather than
  // guess. A typo in a dashboard must not silently become "no cap" or "no calls".
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_DAILY_CAP;
}

/** Off unless explicitly on. Absent, blank and anything else are off. */
export function ourBotEnabled(env = process.env) {
  return String(env.OUR_BOT_PRESS_ENABLED ?? "").trim().toLowerCase() === "on";
}

/**
 * Whatever OUR_BOT_VARIANTS currently selects, narrowed to the allowlist.
 *
 * Unset means the whole allowlist. Explicitly BLANK means none — a way to take
 * our bot off every variant without editing the allowlist. The two readings are
 * different instructions and only the safe one can be typed by accident.
 */
export function ourBotVariants(env = process.env) {
  const raw = String(env.OUR_BOT_VARIANTS ?? "*").trim();
  const wanted = raw === "*"
    ? [...OUR_BOT_VARIANTS]
    : raw.split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);
  // Intersect, never union: the env can pick a subset and nothing more.
  return new Set(wanted.filter((v) => OUR_BOT_VARIANTS.has(v)));
}

/**
 * Does OUR bot take this press? Pure, so the routing decision is testable
 * without a database — and it is the decision that matters, because the
 * alternative branch spends money on a different vendor.
 */
export function handledByOurBot(variant, env = process.env) {
  if (!ourBotEnabled(env)) return false;
  const key = String(variant ?? "").trim().toLowerCase();
  if (!key) return false;
  return ourBotVariants(env).has(key);
}

/** journey-run's URL and the secret it demands, both from crm.app_config. */
async function journeyEndpoint(sb) {
  const { data, error } = await sb
    .from("app_config")
    .select("key, value")
    .in("key", ["journey_fn_url", "sync_secret"]);
  if (error) throw new Error(`app_config unreadable: ${error.message}`);
  const at = (k) => (data ?? []).find((r) => r.key === k)?.value ?? null;
  return { url: at("journey_fn_url"), secret: at("sync_secret") };
}

/**
 * Our bot is not taking this press, for a reason that has nothing to do with
 * the caller. Hand it to Oriserve and say so in the ledger.
 *
 * Only reached from the branch that already chose our bot, so the press still
 * goes to exactly one vendor -- the route's "TWO BOTS, ONE PRESS, NEVER BOTH"
 * holds, with this function being how our branch declines.
 */
function overflowToOriserve(body, { digit, variant } = {}, deps = {}, reason = "daily_cap") {
  console.log(`[OUR_BOT] ${reason} — press for ${String(body?.mobile ?? "")} goes to Oriserve`);
  const toOri = deps.dispatchToOri ?? dispatchPressToVoiceBot;
  // Fire-and-forget, exactly as the route calls it: this whole path is already
  // unawaited and must not start rejecting now.
  try {
    toOri(body, { digit, variant });
  } catch (error) {
    console.error(`[OUR_BOT] handover to Oriserve failed: ${error?.message ?? error}`);
  }
  return { dialled: false, reason, handedToOriserve: true };
}

/**
 * Reserve one of today's slots. True when this press may go to our bot.
 *
 * The count and the decision happen inside crm.claim_our_bot_slot() in one
 * statement, because the obvious version here is a race:
 *
 *     const used = await count(today);   // two presses both read 99
 *     if (used < cap) dial();            // two presses both dial
 *
 * The IVR panel delivers presses in bursts and retries them, so simultaneous
 * presses are normal rather than the tail. Every overshoot is a real phone
 * ringing on a vendor we are paying.
 *
 * Any failure here returns false, which sends the press to Oriserve. A database
 * we cannot read is not a reason to skip the cap and dial anyway.
 */
async function claimDailySlot(sb, cap) {
  try {
    const { data, error } = await sb.rpc("claim_our_bot_slot", { p_cap: cap });
    if (error) {
      console.error(`[OUR_BOT] slot claim failed, deferring to Oriserve: ${error.message}`);
      return false;
    }
    return data === true;
  } catch (error) {
    console.error(`[OUR_BOT] slot claim threw, deferring to Oriserve: ${error?.message ?? error}`);
    return false;
  }
}

/**
 * Hand one press to our bot. Never throws: the keypress route does not await
 * this, and a dialler that rejected would surface as an unhandled rejection
 * rather than as a lead nobody called.
 */
export async function dispatchPressToOurBot(body, { digit, variant } = {}, deps = {}) {
  const mobile = String(body?.mobile ?? "").replace(/\D/g, "");

  try {
    if (!handledByOurBot(variant)) {
      return { dialled: false, reason: "not_our_variant" };
    }
    if (mobile.length < 10) {
      return { dialled: false, reason: "bad_mobile" };
    }

    const sb = deps.sb ?? new SupabaseClient().client.schema("crm");

    // ── THE PACE ────────────────────────────────────────────────────────────
    //
    // Asked BEFORE the slot is claimed, so a press this service cannot pace
    // keeps its slot and goes to Oriserve whole. See lib/dialPacer.js for the
    // measurement: past twenty dials a minute, half of them never connect.
    if (!(deps.hasRoom ?? hasRoom)()) {
      return overflowToOriserve(body, { digit, variant }, deps, "dial_queue_full");
    }

    // ── THE COHORT CAP ──────────────────────────────────────────────────────
    //
    // Claimed BEFORE the journey call, not after. The window between dialling
    // and recording is another way to overshoot, and it is wide: the journey
    // round trip places a real call inside it.
    //
    // A refusal hands the press to Oriserve rather than dropping it. That
    // direction is the whole safety argument for putting `businessloans` on
    // our allowlist: over the cap, and on any failure above, the caller reaches
    // the bot that has been answering 700-1,500 presses a day for weeks. The
    // worst case of this change is "today behaves like yesterday".
    const cap = deps.cap ?? ourBotDailyCap();
    if (!(await claimDailySlot(sb, cap))) {
      return overflowToOriserve(body, { digit, variant }, deps, "daily_cap");
    }

    const { url, secret } = await journeyEndpoint(sb);
    if (!url || !secret) {
      console.error("[OUR_BOT] journey_fn_url / sync_secret not configured — no call placed");
      // A slot was claimed and will not be used. Deliberately not released:
      // releasing it needs a second write that can itself fail, and the failure
      // mode of leaking a slot is calling 99 instead of 100 today. The failure
      // mode of a double release is calling someone twice.
      return overflowToOriserve(body, { digit, variant }, deps, "not_configured");
    }

    // Everything above decided; only the dial itself waits its turn. A burst of
    // 200 presses still resolves 200 routing decisions in seconds — it just
    // does not put 200 calls on the trunk in three minutes.
    return await (deps.pace ?? paceDial)(() =>
      placeAndRecord({ url, secret, mobile, body, digit, variant, deps })
    );
  } catch (error) {
    const reason = `error: ${error?.message ?? error}`;
    console.error(`[OUR_BOT] Call failed for ${mobile}: ${error?.message ?? error}`);
    await recordVoiceDispatch({
      mobile: body?.mobile,
      dispatched: false,
      reason,
      variant: variant ?? null,
      digit: digit ?? null,
      provider: "ours",
      uniqueId: body?.unique_id || body?.call_id || null,
      raw: { bot: "elevenlabs_convai", via: "journey-run" },
    }).catch(() => {});
    return { dialled: false, reason };
  }
}

/**
 * The dial, and the ledger row that records what it did.
 *
 * Split out of dispatchPressToOurBot because this half runs LATER — the pacer
 * may hold it for minutes — while the routing decisions above have to be made
 * the moment the press arrives.
 */
async function placeAndRecord({ url, secret, mobile, body, digit, variant, deps }) {
  const outcome = { dialled: false, reason: null };

  try {
    const post = deps.fetch ?? fetch;
    const res = await post(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-sync-secret": secret },
      body: JSON.stringify({
        action: "run",
        mobile,
        // The press IS the intent; the bot's job is to qualify and hand over.
        step: "intent",
        trigger: "command",
        // Voice only. The WhatsApp apply-link is already sent by the keypress
        // route itself, and sending it twice from two places is how a customer
        // gets the same message twice.
        channels: { whatsapp: false, voice: true },
      }),
    });

    const out = await res.json().catch(() => ({}));
    outcome.dialled = res.ok && out?.voice?.ok === true;
    outcome.reason = outcome.dialled ? null : (out?.voice?.reason ?? out?.error ?? `http_${res.status}`);

    console.log(
      `[OUR_BOT] ${outcome.dialled ? "dialled" : "not dialled"} ${mobile} ` +
        `variant=${variant || "-"}${outcome.reason ? ` reason=${outcome.reason}` : ""}`
    );
  } catch (error) {
    outcome.reason = `error: ${error?.message ?? error}`;
    console.error(`[OUR_BOT] Call failed for ${mobile}: ${error?.message ?? error}`);
  }

  // Logged to the same table as the Oriserve dispatches, with provider naming
  // which bot took it, so one query still answers "who was called today".
  await recordVoiceDispatch({
    mobile: body?.mobile,
    dispatched: outcome.dialled,
    reason: outcome.dialled ? null : outcome.reason,
    variant: variant ?? null,
    digit: digit ?? null,
    provider: "ours",
    uniqueId: body?.unique_id || body?.call_id || null,
    raw: { bot: "elevenlabs_convai", via: "journey-run" },
  }).catch(() => {});

  return outcome;
}

export default dispatchPressToOurBot;
