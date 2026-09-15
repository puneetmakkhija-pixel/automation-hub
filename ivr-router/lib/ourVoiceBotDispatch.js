import SupabaseClient from "./supabaseClient.js";
import { recordVoiceDispatch } from "./voiceDispatchLog.js";

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
 * `businessloans` is deliberately NOT in this list. That variant is Oriserve's
 * live campaign at 700-1,500 calls a day; moving it is a decision with a blast
 * radius, not a side effect of adding a second bot. Our bot starts on the
 * Flexiloans campaign, which has no traffic yet.
 */
const OUR_BOT_VARIANTS = new Set(["flexiloans"]);

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
 * Hand one press to our bot. Never throws: the keypress route does not await
 * this, and a dialler that rejected would surface as an unhandled rejection
 * rather than as a lead nobody called.
 */
export async function dispatchPressToOurBot(body, { digit, variant } = {}, deps = {}) {
  const mobile = String(body?.mobile ?? "").replace(/\D/g, "");
  const outcome = { dialled: false, reason: null };

  try {
    if (!handledByOurBot(variant)) {
      return { dialled: false, reason: "not_our_variant" };
    }
    if (mobile.length < 10) {
      return { dialled: false, reason: "bad_mobile" };
    }

    const sb = deps.sb ?? new SupabaseClient().client.schema("crm");
    const { url, secret } = await journeyEndpoint(sb);
    if (!url || !secret) {
      console.error("[OUR_BOT] journey_fn_url / sync_secret not configured — no call placed");
      return { dialled: false, reason: "not_configured" };
    }

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
