import express from "express";
import axios from "axios";
import { verifyWebhookSecret } from "../middleware/verifyWebhookSecret.js";
import SupabaseClient from "../supabaseClient.js";
import { resolveCustomerId } from "../customerIds.js";
import { resolveSsoLink } from "../crmSsoLink.js";
import { forwardPressToCrm } from "../crmPressForward.js";
import { dispatchPressToVoiceBot } from "../oriVoiceDispatch.js";
import { aliasFor } from "../mobileAlias.js";

/**
 * IVR keypress -> WhatsApp, in one hop.
 *
 * voice2.ivrsms.com posts its flat call payload here; if the caller pressed a
 * digit that has a template mapped, we send that WhatsApp template via Ananta
 * and return. No database, no journey engine, no queue.
 *
 * This calls Ananta's DOCUMENTED WhatsApp API directly rather than reusing
 * lib/anantaApiClient.js or lib/clients/anantaClient.js. Neither matches what
 * Ananta documents: one posts to data-api.anantadot.com/WhatsApp/send with
 * api_token/api_sec_key in the body, the other to {ANANTA_BASE_URL}/messages/send
 * with Api-Key/Api-Token headers. The real API is
 *   POST https://utilsapi.anantadot.com/waba/sendmessage
 *   header: api_key
 *   body:   { template, phone, is_short_url, message: { placeholders: [...] } }
 * Wiring this onto either client would fail at the provider.
 *
 * is_short_url is sent as "1" unless ANANTA_IS_SHORT_URL says otherwise, so the
 * lender journey URL reaches the customer as a short anantadot.com link rather
 * than 190 characters of UTM parameters. See the payload below.
 */

const router = express.Router();

const WABA_URL =
  process.env.ANANTA_WABA_URL || "https://utilsapi.anantadot.com/waba/sendmessage";

/**
 * Digit -> template id, e.g. {"1":"loan_apply_v2"}.
 * Digits with no entry send nothing, so a misconfigured map cannot spend money
 * on every call. JSON so digits can be added without a code change.
 */
function templateMap() {
  const raw = process.env.IVR_DTMF_TEMPLATES;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    console.error(
      "[IVR_WA] IVR_DTMF_TEMPLATES is not valid JSON — no messages will be sent. " +
        'Expected e.g. {"1":"<template_id>"}'
    );
    return {};
  }
}

function parseJsonEnv(name) {
  const raw = process.env[name];
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    console.error(`[IVR_WA] ${name} is not valid JSON — ignoring it`);
    return null;
  }
}

/**
 * Placeholder values for a keypress, e.g. {"1":[" ","https://apply.example/"]}.
 * {{field}} is replaced from the IVR payload. Templates with placeholders
 * REQUIRE them, and the count must match exactly — Ananta returns 1325/1327
 * otherwise.
 *
 * Three sources, most specific first:
 *
 *   1. IVR_LINK_<VARIANT>   one plain URL per lender — IVR_LINK_HEROFINCORP
 *   2. IVR_VARIANT_PLACEHOLDERS  {"<variant>":{"<digit>":[...]}}
 *   3. IVR_DTMF_PLACEHOLDERS     {"<digit>":[...]}, the default for every campaign
 *
 * (1) exists because (2) is a nested JSON object that operators edit by hand in
 * a web textarea, and its failure mode is silent and total: one stray comma and
 * parseJsonEnv logs, returns null, and EVERY variant quietly falls back to the
 * default link. That is indistinguishable, from the outside, from the variant
 * never having been configured — a campaign for one lender sends another
 * lender's application link and nothing anywhere says so. A plain URL in its
 * own variable cannot be mispunctuated, and a mistake in it is contained to the
 * one lender it names.
 *
 * (1) supplies only the LINK. The placeholder SHAPE — how many values the
 * template wants, and any fixed ones like a leading " " — is borrowed from the
 * digit map and its last entry replaced. So the count always matches the
 * template that the default campaign already sends successfully, and the
 * 1325/1327 mismatch is not reachable through this path.
 *
 * The variant is either the URL suffix the panel posts to (/whatsapp/herofincorp)
 * or, on the bare /whatsapp path, the campaign_id. The URL is the sturdier of the
 * two — one webhook per destination in the panel, and nothing depends on
 * campaign_id being included in the configured body — so prefer it; campaign_id
 * is there for panels that post everything to one URL.
 *
 * A variant with no entry in any source falls back to the digit map, so a new
 * campaign or a mistyped suffix sends the default link rather than nothing.
 */

/**
 * herofincorp -> IVR_LINK_HEROFINCORP.
 *
 * The variant comes off the request path, so this reads an environment variable
 * named partly by the caller. Two things contain that: the IVR_LINK_ prefix,
 * which confines it to a namespace that exists for exactly this, and the
 * [A-Z0-9_] normalisation, which leaves no way to escape the prefix. Nothing
 * outside that namespace is reachable whatever the caller sends.
 */
function variantEnvName(variant) {
  const slug = String(variant || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!slug || slug.length > 64) return null;
  return `IVR_LINK_${slug}`;
}

/** The per-variant URL, or null when unset or unusable. */
function variantLink(variant) {
  const name = variantEnvName(variant);
  if (!name) return null;

  const url = (process.env[name] || "").trim();
  if (!url) return null;

  // A value that is not an absolute URL is a paste error, not a link. Refusing
  // it here falls back to the default rather than sending a customer something
  // their phone will not open.
  if (!/^https?:\/\//i.test(url)) {
    console.error(
      `[IVR_WA] ${name} is not an absolute http(s) URL — ignoring it and using ` +
        "the placeholder maps instead"
    );
    return null;
  }
  return url;
}

/**
 * @returns {{list: string[], source: string}} — `source` names which of the
 * three the values came from, so a send can be traced to its configuration.
 * Not having this is what let a Hero Fincorp campaign send Poonawalla links
 * through a correctly-resolved variant without anything looking wrong.
 */
function rawPlaceholders(digit, body, variant) {
  const key = String(variant || body.campaign_id || "").trim();
  const digitList = parseJsonEnv("IVR_DTMF_PLACEHOLDERS")?.[String(digit)];

  const link = key ? variantLink(key) : null;
  if (link) {
    // Borrow the shape, replace the link. An empty or missing digit map leaves
    // nothing to borrow, so the template is assumed to take the link alone.
    const list = Array.isArray(digitList) && digitList.length ? [...digitList] : [link];
    list[list.length - 1] = link;
    return { list, source: variantEnvName(key) };
  }

  const perVariant = key
    ? parseJsonEnv("IVR_VARIANT_PLACEHOLDERS")?.[key]?.[String(digit)]
    : null;
  if (Array.isArray(perVariant)) {
    return { list: perVariant, source: `IVR_VARIANT_PLACEHOLDERS[${key}]` };
  }

  if (Array.isArray(digitList)) {
    return { list: digitList, source: `IVR_DTMF_PLACEHOLDERS[${digit}]` };
  }

  return { list: [], source: "none" };
}

function interpolate(list, fields) {
  return list.map((v) =>
    String(v).replace(/\{\{(\w+)\}\}/g, (_, k) => (fields[k] == null ? "" : String(fields[k])))
  );
}

/**
 * Ananta's docs are self-contradictory on phone format: the field description
 * says "10-digit ... without (+91) country code", the sample payloads show
 * "+916384xxxxxx". Default to the description; ANANTA_PHONE_FORMAT=e164 switches.
 */
function formatPhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  const ten = digits.length > 10 ? digits.slice(-10) : digits;
  if (ten.length !== 10 || !/^[6-9]/.test(ten)) {
    return { valid: false, error: `Not a valid Indian mobile: "${raw}"` };
  }
  return {
    valid: true,
    phone: process.env.ANANTA_PHONE_FORMAT === "e164" ? `+91${ten}` : ten,
  };
}

/**
 * The IVR panel retries, and every retry that reaches Ananta costs money.
 *
 * unique_id is the right key — one per call — but the panel only sends it if
 * the operator added it to the webhook body, and the first live test showed it
 * arriving empty while the panel retried nine times on a failing send. Keying
 * on nothing meant no dedupe at all, so fall back to campaign+mobile+digit.
 * That is coarser: a caller who rings the same campaign twice and presses the
 * same key gets one message until the window clears. Sending one message too
 * few is the cheaper mistake here.
 *
 * In-memory: resets on restart and is not shared across replicas. That is
 * acceptable for a single-replica service and is the tradeoff to revisit if
 * this ever scales out — the durable version belongs in Postgres.
 */
const sent = new Set();
const SENT_MAX = 5000;

function dedupeKey(body, digit, variant) {
  const uid = String(body.unique_id || "").trim();
  if (uid) return `uid:${uid}`;
  // The variant is part of the key: two webhooks sending different links to the
  // same caller are two distinct messages, not a retry of one.
  const scope = String(variant || body.campaign_id || "-").trim();
  const mobile = String(body.mobile || "-").trim();
  return `cmd:${scope}:${mobile}:${digit}`;
}

function alreadySent(key) {
  if (!key) return false;
  if (sent.has(key)) return true;
  if (sent.size >= SENT_MAX) sent.clear();
  sent.add(key);
  return false;
}

/**
 * The send log, in public.whatsapp_messages.
 *
 * Without it the only record of who was messaged is the Railway log, which
 * ages out and cannot be queried. Each row carries the phone number as a real
 * column and everything else — variant, template, digit, campaign, unique_id,
 * Ananta's message_id, the outcome — in metadata, so no schema change was
 * needed and the existing whatsapp_messages readers keep working.
 *
 * Constructed lazily: SupabaseClient throws when SUPABASE_URL or
 * SUPABASE_SERVICE_ROLE_KEY is unset, and that must not stop a send. Logging is
 * a side effect of this webhook, never a precondition for it.
 */
let db = null;
let dbUnavailable = false;

function database() {
  if (db) return db;
  if (dbUnavailable) return null;
  try {
    db = new SupabaseClient();
    return db;
  } catch (error) {
    console.warn(
      `[IVR_WA] Send log unavailable (${error.message}) — messages will still ` +
        "send, but nothing will be recorded."
    );
    dbUnavailable = true;
    return null;
  }
}

/**
 * Fire and forget: never awaited, so a slow or broken database cannot add
 * latency to the webhook or fail a send that already happened.
 */
function recordSend(row) {
  const client = database()?.client;
  if (!client) return;

  const onError = (message) =>
    console.error(`[IVR_WA] Could not record send (${row.status}): ${message}`);

  client
    .from("whatsapp_messages")
    .insert([
      {
        phone_number: row.phone,
        direction: "outbound",
        type: "ivr_dtmf_template",
        metadata: {
          source: "ivr_keypress_webhook",
          status: row.status, // sent | failed
          digit: row.digit,
          template: row.template,
          variant: row.variant || null,
          campaign_id: row.campaignId || null,
          campaign_name: row.campaignName || null,
          unique_id: row.uniqueId || null,
          customer_id: row.customerId || null,
          sso_minted: row.ssoMinted === true,
          sso_reason: row.ssoReason || null,
          link: row.link || null,
          link_source: row.linkSource || null,
          message_id: row.messageId || null,
          error: row.error ?? null,
        },
      },
    ])
    .then(({ error }) => {
      if (error) onError(error.message);
    }, (error) => onError(error?.message ?? String(error)));
}

/**
 * Has this exact call already produced a message?
 *
 * The in-memory set only remembers within one process, and this service was
 * redeployed six times in a single afternoon — every restart forgets. A retry
 * arriving after one would send a second paid message. This survives restarts.
 *
 * Only meaningful when unique_id is present: it is the one key that identifies
 * a call rather than a caller, so a repeat press is not mistaken for a retry.
 *
 * Fails OPEN. If the database is unreachable this returns false and the message
 * sends — a rare duplicate is a better failure than a customer who pressed 1
 * and heard nothing because Supabase was down.
 */
async function sentPreviously(uniqueId) {
  if (!uniqueId) return false;
  const client = database()?.client;
  if (!client) return false;

  try {
    const { data, error } = await client
      .from("whatsapp_messages")
      .select("id")
      .eq("direction", "outbound")
      .eq("metadata->>unique_id", uniqueId)
      .eq("metadata->>status", "sent")
      .limit(1);

    if (error) {
      console.error(`[IVR_WA] Send-log lookup failed, sending anyway: ${error.message}`);
      return false;
    }
    return Array.isArray(data) && data.length > 0;
  } catch (error) {
    console.error(`[IVR_WA] Send-log lookup threw, sending anyway: ${error.message}`);
    return false;
  }
}

async function handleKeypress(req, res) {
  const body = req.body || {};
  const variant = String(req.params.variant || "").trim();
  const { mobile, dtmf, dtmf_sequence, unique_id, campaign_name } = body;

  // Prefer the discrete digit; fall back to the last key of a sequence.
  const digit =
    dtmf != null && String(dtmf).trim() !== ""
      ? String(dtmf).trim()
      : String(dtmf_sequence || "").trim().slice(-1);

  // The CRM gets the press before any of the decisions below. A digit with no
  // template, an unreadable number and a duplicate delivery all return early
  // from this handler, and all three are facts the funnel wants: the press is
  // what the customer did, the message is only what we did about it.
  //
  // Only for the variants that belong to that CRM's book — this webhook also
  // carries another lender's traffic, several times the volume. Not awaited.
  // lib/crmPressForward.js has both: why it can never fail the send, and which
  // variants it forwards.
  forwardPressToCrm(body, { digit, variant });

  // And the ORI voice bot gets the press-1 itself. By the owner's decision the
  // bot is now the response to a press and this template is enrichment, so it
  // is dispatched here rather than after the send: a Business Loans caller who
  // pressed 1 gets called even when the digit has no template mapped, which is
  // a misconfiguration on our side and not a reason to leave them with nothing.
  //
  // Business Loans only, press 1 only, deduped separately from the send —
  // lib/oriVoiceDispatch.js has why each of those. Not awaited: it spends money
  // and takes a round trip, and neither may delay the message.
  dispatchPressToVoiceBot(body, { digit, variant });

  const template = templateMap()[digit];

  // Every non-send below returns 200. A non-2xx makes the IVR panel retry a
  // decision that will never change, and some panels disable a webhook that
  // keeps erroring.
  if (!template) {
    return res.json({ success: true, sent: false, reason: "no template for digit", digit });
  }

  const phone = formatPhone(mobile);
  if (!phone.valid) {
    console.warn(`[IVR_WA] ${phone.error} (unique_id=${unique_id})`);
    return res.json({ success: true, sent: false, reason: phone.error });
  }

  const key = dedupeKey(body, digit, variant);
  if (alreadySent(key)) {
    console.log(`[IVR_WA] Duplicate webhook (${key}) — not resending`);
    return res.json({ success: true, sent: false, reason: "duplicate", key });
  }

  // The in-memory set above only covers this process; the send log covers
  // restarts. Checked second because it costs a round trip.
  if (await sentPreviously(unique_id)) {
    console.log(`[IVR_WA] Already sent for unique_id=${unique_id} before restart — not resending`);
    return res.json({ success: true, sent: false, reason: "duplicate (send log)", unique_id });
  }

  // Trimmed: a key pasted into the Railway variable editor with a trailing
  // newline is indistinguishable from a wrong one in Ananta's 1310 response.
  const apiKey = (process.env.ANANTA_API_KEY || "").trim();
  if (!apiKey) {
    console.error("[IVR_WA] ANANTA_API_KEY is not set — cannot send");
    // Nothing was sent, so release the dedupe key: once the variable is set,
    // a retry of this same call must still be able to get through.
    sent.delete(key);
    return res.status(503).json({ success: false, error: "WhatsApp sender not configured" });
  }

  // WhatsApp rejects an empty template variable outright (#131008, surfaced by
  // Ananta as 1353), so a {{field}} that resolved to nothing is a config bug
  // worth naming here rather than a failed send to debug from the provider's
  // error. A deliberately blank value is a single space, which passes.
  // One id per mobile number, minted on first contact. Exposed to placeholders
  // as {{customer_id}} so an application link can carry per-lead attribution,
  // and recorded on the send. Null when the database is unreachable — the
  // message still goes.
  const customerId = await resolveCustomerId(database()?.client, phone.phone, {
    campaignId: body.campaign_id,
    variant,
  });

  // {{sso_link}} puts a pre-verified /apply?t=<token> link in the message, so
  // the customer lands past OTP. Minted only when the configured placeholders
  // actually ask for one — otherwise every send would call the CRM for a value
  // nothing uses, and put a cross-service dependency on a path that does not
  // need it.
  const { list: raw, source: linkSource } = rawPlaceholders(digit, body, variant);
  const wantsSso = raw.some((v) => String(v).includes("{{sso_link}}"));
  const sso = wantsSso
    ? await resolveSsoLink(phone.phone, database()?.client)
    : { url: "", minted: false, expiresAt: null, reason: "not_requested" };

  if (wantsSso) {
    console.log(
      sso.minted
        ? `[IVR_WA] SSO link minted for ${phone.phone}, expires ${sso.expiresAt ?? "?"}`
        : `[IVR_WA] Plain apply link for ${phone.phone} (${sso.reason}) — customer will do OTP`
    );
  }

  const placeholders = interpolate(raw, {
    ...body,
    customer_id: customerId ?? "",
    sso_link: sso.url,
    // {{alias}} is the mobile, shifted and base-36'd, for affiliate sub-IDs
    // that must reconcile back to a customer without handing a third party a
    // phone number. lib/mobileAlias.js carries the recon formula.
    alias: aliasFor(phone.phone),
  });
  const blank = placeholders.findIndex((v) => v === "");
  if (blank !== -1) {
    console.error(
      `[IVR_WA] Placeholder ${blank + 1} of ${placeholders.length} resolved to an ` +
        `empty string (digit=${digit} variant=${variant || body.campaign_id || "-"}). WhatsApp ` +
        'rejects empty template variables — use " " for a deliberately blank value, ' +
        "and check any {{field}} against the fields this webhook actually receives."
    );
    sent.delete(key);
    return res
      .status(503)
      .json({ success: false, error: "Placeholder resolved empty", position: blank + 1 });
  }

  const payload = {
    template,
    phone: phone.phone,
    // Ananta's shortener, ON by default.
    //
    // The link this webhook sends is a lender journey URL carrying the whole
    // DSA and UTM query string — the Poonawalla Fincorp one is ~190 characters.
    // In WhatsApp that wraps over three lines, none of it means anything to the
    // person reading it, and a wall of tracking parameters is what a scam
    // message looks like. Ananta rewrites it to op2.in/wt/<code> before
    // it goes out.
    //
    // The tradeoff is where the click lands: their redirect, so an open is
    // recorded in their panel against their id, not in our whatsapp_messages
    // send log. Their panel has a Click URL webhook that can post those back —
    // see ANANTA_QUICK_START.md — which is the way to close that gap without
    // running a redirect of our own.
    //
    // Set ANANTA_IS_SHORT_URL=0 to send links at full length again. The send
    // log records the URL we handed Ananta either way, so what a customer was
    // sent stays answerable from our side whatever this is set to.
    is_short_url: process.env.ANANTA_IS_SHORT_URL || "1",
    message: { placeholders },
  };

  try {
    const r = await axios.post(WABA_URL, payload, {
      headers: { api_key: apiKey, "Content-Type": "application/json" },
      timeout: 10000,
    });

    console.log(
      `[IVR_WA] Sent template=${template} digit=${digit} phone=${phone.phone} ` +
        `variant=${variant || "-"} campaign=${campaign_name || "-"} ` +
        // Which configuration produced the link. A variant that resolved from
        // the URL but drew its link from IVR_DTMF_PLACEHOLDERS is a lender
        // sending another lender's link, and this is the only place it shows.
        `link_source=${linkSource} message_id=${r.data?.message_id || "-"}`
    );

    recordSend({
      status: "sent",
      phone: phone.phone,
      digit,
      template,
      variant,
      campaignId: body.campaign_id,
      campaignName: campaign_name,
      uniqueId: unique_id,
      customerId,
      linkSource,
      ssoMinted: sso.minted,
      ssoReason: sso.reason,
      // The link is the placeholder that differs between campaigns, so record
      // which one this customer actually received.
      link: placeholders[placeholders.length - 1],
      messageId: r.data?.message_id,
    });

    return res.json({
      success: true,
      sent: true,
      digit,
      template,
      variant: variant || undefined,
      messageId: r.data?.message_id,
      anantaStatus: r.data?.status,
    });
  } catch (error) {
    // Ananta signals failures in the body (1301 bad key, 1304 IP not
    // whitelisted, 1314 insufficient balance, 1324 template not approved...),
    // so surface theirs rather than a bare axios message.
    const detail = error.response?.data ?? error.message;
    console.error(
      `[IVR_WA] Send FAILED template=${template} phone=${phone.phone} key=${key}:`,
      detail
    );

    // 1310 is "api_key is invalid" — the panel will retry this on every call
    // and every retry fails the same way, so say what to check once per hit.
    if (String(detail?.code) === "1310") {
      console.error(
        `[IVR_WA] ANANTA_API_KEY is set (${apiKey.length} chars) but Ananta rejects it. ` +
          "This is the WABA send key from utilsapi.anantadot.com — not ANANTA_API_TOKEN " +
          "or ANANTA_API_SECRET_KEY, which belong to the separate Data API."
      );
    }

    recordSend({
      status: "failed",
      phone: phone.phone,
      digit,
      template,
      variant,
      campaignId: body.campaign_id,
      campaignName: campaign_name,
      uniqueId: unique_id,
      customerId,
      linkSource,
      ssoMinted: sso.minted,
      ssoReason: sso.reason,
      link: placeholders[placeholders.length - 1],
      error: detail,
    });

    // Let the send be retried: drop it from the dedupe set. sentPreviously()
    // only matches status "sent", so a failed row never blocks the retry.
    sent.delete(key);
    return res.status(502).json({ success: false, error: "Ananta send failed", detail });
  }
}

const guard = verifyWebhookSecret("ANANTA_WEBHOOK_SECRET", "IVR_WA");

// Two ways in, same handler. The bare path is the original webhook and stays
// the default; /whatsapp/<variant> lets the panel hold one webhook per
// destination, which is how an operator thinks about it and does not depend on
// campaign_id being in the configured body.
router.post("/whatsapp", guard, handleKeypress);
router.post("/whatsapp/:variant", guard, handleKeypress);

export default router;
