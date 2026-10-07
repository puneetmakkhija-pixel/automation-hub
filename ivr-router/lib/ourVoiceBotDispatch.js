import SupabaseClient from "./supabaseClient.js";
import { recordVoiceDispatch } from "./voiceDispatchLog.js";
import { dispatchPressToVoiceBot, oriDialsVariant } from "./oriVoiceDispatch.js";
import { hasRoom, paceDial } from "./dialPacer.js";
import { armFor, splitModeOn, voiceVariantFor } from "./botSplit.js";

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

/**
 * ── THE FLEXI CAMPAIGN ───────────────────────────────────────────────────────
 *
 * variant alone cannot tell one businessloans campaign from another -- every
 * campaign launched through the planner dials the same `businessloans` press-1
 * flow (confirmed against crm.whatsapp_messages.metadata: dozens of distinct
 * campaign_name values, e.g. "1_LAKH_FLEXI_B1_2026100516", all under
 * variant=businessloans). campaign_name IS reliably present on a real press,
 * carried on `body` all the way from handleKeypress, so this is what tells the
 * Flexiloans campaign apart from the rest of the book.
 *
 * A substring match, not exact: the planner's display name ("Flexiloans_
 * Oct2026_FullBase") and the batch id actually stamped on a press
 * (precedent: "1_LAKH_FLEXI_B1_...") are not provably the same string, and an
 * exact match that misses silently sends the whole campaign to Priya's capped
 * share instead -- the quiet failure mode. Configurable because a campaign
 * gets relaunched under a new name/date; verify the real stamped value once
 * the first batch actually dials (`metadata->>'campaign_name'` on a fresh
 * crm.whatsapp_messages row for digit=1) and tighten OUR_BOT_FLEXI_CAMPAIGN_MATCH
 * if "flexi" alone is ever too broad.
 */
export function flexiCampaignMatch(env = process.env) {
  const raw = String(env.OUR_BOT_FLEXI_CAMPAIGN_MATCH ?? "").trim().toLowerCase();
  return raw || "flexi";
}

/**
 * OUR_BOT_FLEXI_ONLY=on: the Flexiloans bot is the only bot of ours that dials.
 *
 * Priya's presses (every businessloans press that is not the Flexiloans campaign) stop being ours and go where they went before our bot
 * took them, to Oriserve, exactly as when OUR_BOT_PRESS_ENABLED is off. Flexiloans campaign presses are unaffected. Off unless explicitly
 * "on", and removable without a deploy: unset it and Priya takes her presses again.
 */
export function ourBotFlexiOnly(env = process.env) {
  return String(env.OUR_BOT_FLEXI_ONLY ?? "").trim().toLowerCase() === "on";
}

/** Does this press's campaign belong to the dedicated Flexiloans voice bot? */
export function isFlexiCampaignPress(campaignName, env = process.env) {
  const got = String(campaignName ?? "").trim().toLowerCase();
  return Boolean(got) && got.includes(flexiCampaignMatch(env));
}

const IST_OFFSET_MINUTES = 5.5 * 60;

function istHourOfDay(now) {
  const ist = new Date(now.getTime() + IST_OFFSET_MINUTES * 60000);
  return ist.getUTCHours() + ist.getUTCMinutes() / 60;
}

/**
 * The Flexi campaign's own calling window — 10:00 to 20:00 IST, start
 * inclusive, end exclusive, the window given directly for this campaign.
 *
 * Deliberately NOT a change to lib/telephony/calling-hours.ts or
 * supabase/functions/_shared/calling-hours.ts: both had enforcement removed
 * 29 Sep 2026 on the owner's own earlier explicit instruction, for Priya and
 * Oriserve's existing traffic, and this does not reverse that. It is a new,
 * narrower rule for this one campaign, checked here because journey-run's own
 * copy of the check is the global one that is currently off.
 */
export function withinFlexiCallingHours(now = new Date(), env = process.env) {
  const start = Number(env.OUR_BOT_FLEXI_START_HOUR ?? 10);
  const end = Number(env.OUR_BOT_FLEXI_END_HOUR ?? 20);
  const h = istHourOfDay(now);
  return h >= start && h < end;
}

/**
 * Which bot takes this press, and under which experiment label.
 *
 * Without BOT_SPLIT_MODE=split this IS handledByOurBot(): same answer for every
 * press as before, arm and voiceVariant null, nothing new written anywhere.
 *
 * With it, a press-1 that BOTH bots could take -- on our allowlist (narrowed by
 * OUR_BOT_VARIANTS as ever) and on Oriserve's (today: businessloans) -- goes to
 * whichever arm lib/botSplit.js hashes the caller's mobile into, and
 * OUR_BOT_PRESS_ENABLED stops mattering for it. Everything else keeps the
 * flag's answer. Flexiloans in particular: Oriserve does not dial it, so
 * splitting it would hand half its callers to a bot that drops them.
 *
 * Still exactly one bot per press. The arm only picks which one.
 *
 * @returns {{ours: boolean, arm: 'ours'|'oriserve'|null, voiceVariant: 'A'|'B'|null, voiceBot: 'flexi'|null}}
 */
export function routePress({ variant, mobile, digit, campaignName } = {}, env = process.env, oriDials = oriDialsVariant) {
  // Which AGENT, not which voice of the same agent -- answers a different
  // question than the A/B arm below, and applies however that question is
  // decided (flag or split), so it is computed once up front.
  const voiceBot = isFlexiCampaignPress(campaignName, env) ? "flexi" : null;

  // Flexi-only: a press that is not the Flexiloans campaign is not ours, whatever else says so. Checked before the flag and the split, so
  // neither can hand Priya a press. It is the Flexi campaign press that still reaches the dedicated bot below.
  if (ourBotFlexiOnly(env) && !voiceBot) {
    return { ours: false, arm: null, voiceVariant: null, voiceBot: null };
  }

  const byFlag = { ours: handledByOurBot(variant, env), arm: null, voiceVariant: null, voiceBot };
  if (!splitModeOn(env)) return byFlag;
  if (String(digit ?? "").trim() !== "1") return byFlag;

  const key = String(variant ?? "").trim().toLowerCase();
  if (!key || !ourBotVariants(env).has(key) || !oriDials(key)) return byFlag;

  // No ten-digit mobile, no hash -- and no call either bot could place. The
  // flag's answer keeps whatever refusal the dispatcher would have logged.
  const arm = armFor(mobile, env);
  if (!arm) return byFlag;

  return {
    ours: arm === "ours",
    arm,
    voiceVariant: arm === "ours" ? voiceVariantFor(mobile, env) : null,
    voiceBot,
  };
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
function overflowToOriserve(body, { digit, variant, arm = null } = {}, deps = {}, reason = "daily_cap") {
  console.log(`[OUR_BOT] ${reason} — press for ${String(body?.mobile ?? "")} goes to Oriserve`);
  const toOri = deps.dispatchToOri ?? dispatchPressToVoiceBot;
  // Fire-and-forget, exactly as the route calls it: this whole path is already
  // unawaited and must not start rejecting now.
  try {
    // arm stays 'ours' on the Oriserve row: the caller was ASSIGNED to our bot,
    // and an intent-to-treat read of the split must count them there.
    toOri(body, { digit, variant, arm, fallbackReason: reason });
  } catch (error) {
    console.error(`[OUR_BOT] handover to Oriserve failed: ${error?.message ?? error}`);
  }
  return { dialled: false, reason, handedToOriserve: true };
}

/**
 * The Flexi campaign's own refusal: never Oriserve, because Oriserve does not
 * dial this campaign at all (same reasoning as the module-level note on why
 * `businessloans` alone would have been unsafe to split -- splitting
 * Flexiloans traffic to Oriserve hands half its callers to a bot that drops
 * them). Logged to the same ledger as a dialled press so the ledger stays
 * the one place "who was called" is answered, with `dispatched: false` so
 * crm.v_ivr_lead.bot_dispatched reads false and press1Catchup.js's existing
 * retry sweep -- unchanged, already re-attempts exactly this -- picks it up
 * on its next run, inside the next window if this one already closed.
 */
function refuseAndRetryLater(body, { digit, variant, arm = null, voiceVariant = null } = {}, reason) {
  console.log(`[OUR_BOT] flexi: ${reason} — press for ${String(body?.mobile ?? "")} held for retry, not Oriserve`);
  recordVoiceDispatch({
    mobile: body?.mobile,
    dispatched: false,
    reason,
    variant: variant ?? null,
    digit: digit ?? null,
    provider: "ours",
    uniqueId: body?.unique_id || body?.call_id || null,
    arm,
    voiceVariant,
    raw: { bot: "elevenlabs_convai", via: "journey-run", voice_bot: "flexi" },
  }).catch(() => {});
  return { dialled: false, reason, handedToOriserve: false };
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
  // Decided again here rather than trusted from the route. It is deterministic,
  // so it agrees with the route's answer, and a caller that skipped the route
  // still cannot put a press on our bot that the rules would not.
  const route = (deps.route ?? routePress)({
    variant,
    mobile: body?.mobile,
    digit,
    campaignName: body?.campaign_name,
  });
  const { arm, voiceVariant, voiceBot } = route;
  const ctx = { digit, variant, arm, voiceVariant };
  // Flexiloans never falls back to Oriserve — Oriserve does not dial this
  // campaign at all, so "overflow" would be handing the caller to a bot that
  // drops them. It retries instead; see refuseAndRetryLater.
  const refuse = voiceBot === "flexi"
    ? (reason) => refuseAndRetryLater(body, ctx, reason)
    : (reason) => overflowToOriserve(body, ctx, deps, reason);

  try {
    if (!route.ours) {
      return { dialled: false, reason: "not_our_variant" };
    }
    if (mobile.length < 10) {
      return { dialled: false, reason: "bad_mobile" };
    }

    const sb = deps.sb ?? new SupabaseClient().client.schema("crm");

    // The Flexi campaign's own window (10:00-20:00 IST, given directly for
    // this campaign) -- checked here because journey-run's copy of this check
    // is the global one, off since 29 Sep for Priya/Oriserve's traffic, and
    // this does not reverse that. Before the pacer and the cap, same as
    // calling-hours was checked before the daily slot in the old flow: a
    // press outside the window costs nothing and is still a press-again
    // candidate for press1Catchup.js the moment the window reopens.
    if (voiceBot === "flexi" && !(deps.withinFlexiHours ?? withinFlexiCallingHours)()) {
      return refuse("outside_flexi_calling_hours");
    }

    // ── THE PACE ────────────────────────────────────────────────────────────
    //
    // Asked BEFORE the slot is claimed, so a press this service cannot pace
    // keeps its slot and goes to Oriserve whole. See lib/dialPacer.js for the
    // measurement: past twenty dials a minute, half of them never connect.
    // Shared with Priya's calls unchanged -- the Flexi agent is on the same
    // ElevenLabs workspace and the same 30-concurrent ceiling, and this is
    // the one rail that actually holds that ceiling, so it applies here too.
    if (!(deps.hasRoom ?? hasRoom)()) {
      return refuse("dial_queue_full");
    }

    // ── THE COHORT CAP ──────────────────────────────────────────────────────
    //
    // Claimed BEFORE the journey call, not after. The window between dialling
    // and recording is another way to overshoot, and it is wide: the journey
    // round trip places a real call inside it.
    //
    // Flexiloans is deliberately NOT capped here: "all press-1 from this
    // campaign" was the ask, not a trial slice sharing Priya's existing
    // ~100-200/day businessloans budget -- a shared counter would also make
    // this campaign silently eat into Priya's budget for every OTHER
    // campaign, which nothing about this change should touch. The pace above
    // is what keeps it safe, not this cap.
    if (voiceBot !== "flexi") {
      const cap = deps.cap ?? ourBotDailyCap();
      if (!(await claimDailySlot(sb, cap))) {
        return overflowToOriserve(body, ctx, deps, "daily_cap");
      }
    }

    const { url, secret } = await journeyEndpoint(sb);
    if (!url || !secret) {
      console.error("[OUR_BOT] journey_fn_url / sync_secret not configured — no call placed");
      // A slot was claimed and will not be used (non-Flexi only; Flexi claims
      // none). Deliberately not released: releasing it needs a second write
      // that can itself fail, and the failure mode of leaking a slot is
      // calling 99 instead of 100 today. The failure mode of a double release
      // is calling someone twice.
      return refuse("not_configured");
    }

    // Everything above decided; only the dial itself waits its turn. A burst of
    // 200 presses still resolves 200 routing decisions in seconds — it just
    // does not put 200 calls on the trunk in three minutes.
    return await (deps.pace ?? paceDial)(() =>
      placeAndRecord({ url, secret, mobile, body, digit, variant, arm, voiceVariant, voiceBot, deps })
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
      arm,
      voiceVariant,
      raw: { bot: "elevenlabs_convai", via: "journey-run" },
    }).catch(() => {});
    return { dialled: false, reason };
  }
}

/**
 * Did this attempt provably put NOTHING on the trunk?
 *
 * The question the handover turns on, and it is not the same question as "did
 * it fail". A journey-run that timed out may well have originated the call
 * before the socket died; handing that press to Oriserve rings one customer
 * from two numbers, which is the single thing the press route promises never to
 * do ("TWO BOTS, ONE PRESS, NEVER BOTH"). So this answers true only on positive
 * evidence of no dial, and an unreachable or 5xx journey-run gets none:
 *
 *   voice.skipped   the CRM's own flag for a refusal BEFORE the originate --
 *                   no recipient, not an Indian mobile, calling hours, backend
 *                   not configured. Every return after the dial is attempted
 *                   sets it false, which is what makes it usable here. Reading
 *                   the flag rather than matching on the message text also
 *                   means a reworded refusal does not silently stop handing
 *                   over.
 *   4xx             journey-run's own validation, which returns before
 *                   runJourney() is called at all. Its 500 does not: that is
 *                   the catch-all around the dial, so it is ambiguous and
 *                   deliberately absent from this list.
 *
 * Anything else -- a 5xx, a timeout, a network error, or ok:false with
 * skipped:false -- stays with our bot and is not dialled twice. The lead reads
 * as un-dialled in crm.voice_dispatch either way, so the CRM's follow-up sweep
 * still picks it up on the next pass.
 */
function noCallWasPlaced(res, out) {
  if (out?.voice?.skipped === true) return true;
  if (res && res.status >= 400 && res.status < 500) return true;
  return false;
}

/**
 * The dial, and the ledger row that records what it did.
 *
 * Split out of dispatchPressToOurBot because this half runs LATER — the pacer
 * may hold it for minutes — while the routing decisions above have to be made
 * the moment the press arrives.
 */
async function placeAndRecord({ url, secret, mobile, body, digit, variant, arm = null, voiceVariant = null, voiceBot = null, deps }) {
  const outcome = { dialled: false, reason: null };
  // Declared out here so the handover decision below can see them even when the
  // fetch itself threw, where "no response at all" is exactly the ambiguous
  // case that must NOT be handed on.
  let res = null;
  let out = null;

  try {
    const post = deps.fetch ?? fetch;
    res = await post(url, {
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
        // Which ElevenLabs agent/voice, under the A/B split. Sent only when
        // there is one: a journey-run that does not read it ignores an extra
        // key, and without the split the request is exactly what it was.
        ...(voiceVariant ? { voice_variant: voiceVariant } : {}),
        // Which agent, not which voice -- see _shared/voicebot.ts's
        // PlaceVoicebotCallInput.bot. "flexi" dials the dedicated Flexiloans
        // agent instead of Priya.
        ...(voiceBot ? { voice_bot: voiceBot } : {}),
      }),
    });

    out = await res.json().catch(() => ({}));
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

  // ── THE PRESS THAT REACHED NEITHER BOT ────────────────────────────────────
  //
  // 23 Sep: two presses arrived just before 10:00 IST. Each claimed a slot,
  // reached journey-run, and came back refused by the calling-hours rule — and
  // then stopped here. Our bot would not dial them and Oriserve was never
  // offered them, so two people who pressed 1 were called by nobody.
  //
  // Everywhere else in this file a refusal ends at Oriserve. This branch was
  // the one exception, and it was an oversight rather than a decision.
  //
  // The slot stays spent, for the reason given at the not_configured branch
  // above: releasing it is a second write that can fail on its own, and the
  // cost of leaking one is calling 199 leads today instead of 200. At two
  // presses in the 09:5x minute that is a rounding error against the cap.
  // (Flexi claims no slot at all, so there is nothing to leak for it.)
  //
  // Flexi still never reaches Oriserve here either -- it stays un-dispatched,
  // which press1Catchup.js's existing sweep (bot_dispatched=false) picks up
  // on its next run.
  if (!outcome.dialled && noCallWasPlaced(res, out)) {
    if (voiceBot === "flexi") {
      outcome.handedToOriserve = false;
    } else {
      outcome.handedToOriserve = true;
      overflowToOriserve(body, { digit, variant, arm }, deps, outcome.reason ?? "no_call_placed");
    }
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
    arm,
    voiceVariant,
    fallbackReason: outcome.handedToOriserve ? outcome.reason ?? "no_call_placed" : null,
    raw: { bot: "elevenlabs_convai", via: "journey-run", ...(voiceBot ? { voice_bot: voiceBot } : {}) },
  }).catch(() => {});

  return outcome;
}

export default dispatchPressToOurBot;
