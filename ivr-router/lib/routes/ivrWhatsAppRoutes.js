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

/**
 * Optional per-digit placeholder values, e.g. {"1":["{{campaign_name}}"]}.
 * {{field}} is replaced from the IVR payload. Templates with placeholders
 * REQUIRE them — Ananta returns 1325/1327 otherwise.
 */
function placeholdersFor(digit, body) {
  const raw = process.env.IVR_DTMF_PLACEHOLDERS;
  if (!raw) return [];
  let map;
  try {
    map = JSON.parse(raw);
  } catch {
    console.error("[IVR_WA] IVR_DTMF_PLACEHOLDERS is not valid JSON — sending none");
    return [];
  }
  const list = map[String(digit)];
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
 * unique_id is per call, so remember the ones already sent.
 * In-memory: resets on restart and is not shared across replicas. That is
 * acceptable for a single-replica service and is the tradeoff to revisit if
 * this ever scales out — the durable version belongs in Postgres.
 */
const sent = new Set();
const SENT_MAX = 5000;
function alreadySent(id) {
  if (!id) return false;
  if (sent.has(id)) return true;
  if (sent.size >= SENT_MAX) sent.clear();
  sent.add(id);
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

    if (alreadySent(unique_id)) {
      console.log(`[IVR_WA] Duplicate webhook for unique_id=${unique_id} — not resending`);
      return res.json({ success: true, sent: false, reason: "duplicate", unique_id });
    }

    const apiKey = process.env.ANANTA_API_KEY;
    if (!apiKey) {
      console.error("[IVR_WA] ANANTA_API_KEY is not set — cannot send");
      return res.status(503).json({ success: false, error: "WhatsApp sender not configured" });
    }

    const payload = {
      template,
      phone: phone.phone,
      is_short_url: process.env.ANANTA_IS_SHORT_URL || "0",
      message: { placeholders: placeholdersFor(digit, body) },
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
        `[IVR_WA] Send FAILED template=${template} phone=${phone.phone} ` +
          `unique_id=${unique_id}:`,
        detail
      );
      // Let the send be retried: drop it from the dedupe set.
      if (unique_id) sent.delete(unique_id);
      return res.status(502).json({ success: false, error: "Ananta send failed", detail });
    }
  }
);

export default router;
