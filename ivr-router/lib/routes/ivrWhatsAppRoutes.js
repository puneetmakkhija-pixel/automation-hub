import express from "express";
import axios from "axios";
import { verifyWebhookSecret } from "../middleware/verifyWebhookSecret.js";

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
 * Two campaigns can share a template and a digit but need different values —
 * typically the same message pointing at a different application link. So a
 * campaign-scoped map wins over the digit-scoped one:
 *
 *   IVR_CAMPAIGN_PLACEHOLDERS={"1164053":{"1":[" ","https://crmbusinessloans.com/apply"]}}
 *   IVR_DTMF_PLACEHOLDERS={"1":[" ","https://instant-pocket-loan…"]}
 *
 * A campaign with no entry falls back to the digit map, so adding a campaign to
 * the IVR panel without touching this config sends the default link rather than
 * nothing.
 */
function placeholdersFor(digit, body) {
  const campaign = String(body.campaign_id ?? "").trim();
  const perCampaign = campaign
    ? parseJsonEnv("IVR_CAMPAIGN_PLACEHOLDERS")?.[campaign]?.[String(digit)]
    : null;
  const list = Array.isArray(perCampaign)
    ? perCampaign
    : parseJsonEnv("IVR_DTMF_PLACEHOLDERS")?.[String(digit)];

  if (!Array.isArray(list)) return [];
  return list.map((v) =>
    String(v).replace(/\{\{(\w+)\}\}/g, (_, k) => (body[k] == null ? "" : String(body[k])))
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

function dedupeKey(body, digit) {
  const uid = String(body.unique_id || "").trim();
  if (uid) return `uid:${uid}`;
  const campaign = String(body.campaign_id || "-").trim();
  const mobile = String(body.mobile || "-").trim();
  return `cmd:${campaign}:${mobile}:${digit}`;
}

function alreadySent(key) {
  if (!key) return false;
  if (sent.has(key)) return true;
  if (sent.size >= SENT_MAX) sent.clear();
  sent.add(key);
  return false;
}

router.post(
  "/whatsapp",
  verifyWebhookSecret("ANANTA_WEBHOOK_SECRET", "IVR_WA"),
  async (req, res) => {
    const body = req.body || {};
    const { mobile, dtmf, dtmf_sequence, unique_id, campaign_name } = body;

    // Prefer the discrete digit; fall back to the last key of a sequence.
    const digit =
      dtmf != null && String(dtmf).trim() !== ""
        ? String(dtmf).trim()
        : String(dtmf_sequence || "").trim().slice(-1);

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

    const key = dedupeKey(body, digit);
    if (alreadySent(key)) {
      console.log(`[IVR_WA] Duplicate webhook (${key}) — not resending`);
      return res.json({ success: true, sent: false, reason: "duplicate", key });
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
    const placeholders = placeholdersFor(digit, body);
    const blank = placeholders.findIndex((v) => v === "");
    if (blank !== -1) {
      console.error(
        `[IVR_WA] Placeholder ${blank + 1} of ${placeholders.length} resolved to an ` +
          `empty string (digit=${digit} campaign=${body.campaign_id ?? "-"}). WhatsApp ` +
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
      is_short_url: process.env.ANANTA_IS_SHORT_URL || "0",
      message: { placeholders },
    };

    try {
      const r = await axios.post(WABA_URL, payload, {
        headers: { api_key: apiKey, "Content-Type": "application/json" },
        timeout: 10000,
      });

      console.log(
        `[IVR_WA] Sent template=${template} digit=${digit} phone=${phone.phone} ` +
          `campaign=${campaign_name || "-"} message_id=${r.data?.message_id || "-"}`
      );

      return res.json({
        success: true,
        sent: true,
        digit,
        template,
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

      // Let the send be retried: drop it from the dedupe set.
      sent.delete(key);
      return res.status(502).json({ success: false, error: "Ananta send failed", detail });
    }
  }
);

export default router;
