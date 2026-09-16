import express from "express";
import axios from "axios";
import SupabaseClient from "../supabaseClient.js";
import { aliasFor } from "../mobileAlias.js";
import { addAliasToLinks } from "../applyLinkAlias.js";
import { resolveSsoLink, upgradeApplyLinks } from "../crmSsoLink.js";
import {
  WABA_URL,
  templateMap,
  rawPlaceholders,
  interpolate,
  formatPhone,
  recordSend,
} from "./ivrWhatsAppRoutes.js";

const router = express.Router();

/**
 * The messages that were never delivered, sent again.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * On 16 Sep 2026 Ananta timed out for ninety minutes. 769 send attempts
 * failed, covering 257 people, every one of whom had pressed 1 and was owed a
 * WhatsApp. Nothing retried them and nothing noticed: the router sends once, on
 * receipt of the press, and a failure is terminal. The day simply ended.
 *
 *   04:00 UTC   341 sent    0 failed
 *   05:00 UTC   295 sent  149 failed
 *   06:00 UTC     0 sent  620 failed   <- last hour of the batch
 *
 * The provider outage is not ours to fix. Having no way to recover from one is.
 *
 * ── Why not just replay the press webhook ─────────────────────────────────
 *
 * Because that dials. Both dedupe sets -- the send one in ivrWhatsAppRoutes and
 * the dial one in oriVoiceDispatch -- are in-memory and are emptied by every
 * deploy, so replaying a press after a restart places a SECOND paid voice call
 * to somebody the bot already spoke to, and writes a duplicate
 * ivr_campaign_events row. This route sends the WhatsApp and nothing else: it
 * does not dial, and it does not forward to the CRM.
 *
 * ── What it will not do ───────────────────────────────────────────────────
 *
 * Only a mobile with a FAILED send and no SUCCESSFUL send on the same day is a
 * candidate, so nobody receives a second copy of a message they already got.
 * `limit` may only narrow the run, never widen it -- the same rule as the
 * Flexiloans campaign cap, and for the same reason: reaching this route is
 * permission to run it, not permission to decide its size. Send limit=1 first
 * and read the result before sending the rest; when the provider is the thing
 * that failed, one message is the cheapest possible test of whether it is back.
 *
 * Mounted behind CONSOLE_SECRET in index.js, failClosed: this messages real
 * customers and costs money, so it answers to the operator credential rather
 * than to a provider's webhook secret.
 *
 *   GET  /api/resend/failed/status   who is owed a message, sending nothing
 *   POST /api/resend/failed          send them, oldest press first
 */

const DEFAULT_DIGIT = "1";
const MAX_RUN = 2000;

function db() {
  try {
    return new SupabaseClient().client;
  } catch {
    return null;
  }
}

/** A cap in the body may only narrow the run. Never widen it. */
export function resolveRunCap(requested, available) {
  const n = Number(requested);
  if (!Number.isFinite(n) || n <= 0) return Math.min(available, MAX_RUN);
  return Math.min(Math.floor(n), available, MAX_RUN);
}

/**
 * Mobiles with a failed send and no successful one on the same IST day.
 *
 * Read from the send log rather than from the press log on purpose: the send
 * log is what records whether a message actually reached the provider, and it
 * is the only place a failure is written down.
 */
export async function findOwed(client, { sinceIso, variant }) {
  if (!client) return { rows: [], error: "no_client" };

  const { data, error } = await client
    .from("whatsapp_messages")
    .select("phone_number, created_at, metadata")
    .eq("direction", "outbound")
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: true })
    .limit(20000);

  if (error) return { rows: [], error: error.message };

  const ten = (v) => String(v ?? "").replace(/\D/g, "").slice(-10);
  const day = (iso) =>
    new Date(new Date(iso).getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

  const succeeded = new Set();
  const failed = new Map();

  for (const row of data ?? []) {
    const m = ten(row.phone_number);
    if (m.length !== 10) continue;
    if (variant && (row.metadata?.variant ?? null) !== variant) continue;

    const k = `${m}:${day(row.created_at)}`;
    if (row.metadata?.status === "sent") succeeded.add(k);
    else if (row.metadata?.status === "failed" && !failed.has(k)) {
      failed.set(k, {
        mobile: m,
        day: day(row.created_at),
        firstFailedAt: row.created_at,
        digit: String(row.metadata?.digit ?? DEFAULT_DIGIT),
        variant: row.metadata?.variant ?? null,
        campaignId: row.metadata?.campaign_id ?? null,
        campaignName: row.metadata?.campaign_name ?? null,
        uniqueId: row.metadata?.unique_id ?? null,
      });
    }
  }

  // A mobile that later succeeded that day is not owed anything.
  return { rows: [...failed.entries()].filter(([k]) => !succeeded.has(k)).map(([, v]) => v) };
}

/** Compose and send one message, exactly as the press route would. */
async function sendOne(client, owed) {
  const phone = formatPhone(owed.mobile);
  if (!phone.valid) return { mobile: owed.mobile, sent: false, reason: "bad_mobile" };

  const template = templateMap()[owed.digit];
  if (!template) return { mobile: owed.mobile, sent: false, reason: "no_template" };

  const apiKey = (process.env.ANANTA_API_KEY || "").trim();
  if (!apiKey) return { mobile: owed.mobile, sent: false, reason: "no_api_key" };

  const body = {
    mobile: owed.mobile,
    campaign_id: owed.campaignId,
    campaign_name: owed.campaignName,
    unique_id: owed.uniqueId,
  };
  const { list: raw, source: linkSource } = rawPlaceholders(owed.digit, body, owed.variant);
  if (!raw.length) return { mobile: owed.mobile, sent: false, reason: "no_placeholders" };

  const sso = await resolveSsoLink(owed.mobile, client);
  const alias = aliasFor(owed.mobile);
  const placeholders = addAliasToLinks(
    upgradeApplyLinks(
      interpolate(raw, { ...body, customer_id: "", sso_link: sso.url, alias }),
      sso.minted ? sso.url : ""
    ),
    alias
  );
  if (placeholders.some((v) => v === "")) {
    return { mobile: owed.mobile, sent: false, reason: "placeholder_empty" };
  }

  const payload = {
    template,
    phone: phone.phone,
    is_short_url: process.env.ANANTA_IS_SHORT_URL || "1",
    message: { placeholders },
  };

  const common = {
    phone: phone.phone,
    digit: owed.digit,
    template,
    variant: owed.variant,
    campaignId: owed.campaignId,
    campaignName: owed.campaignName,
    uniqueId: owed.uniqueId,
    linkSource,
    ssoMinted: sso.minted,
    ssoReason: sso.reason,
    link: placeholders[placeholders.length - 1],
  };

  try {
    const r = await axios.post(WABA_URL, payload, {
      headers: { api_key: apiKey, "Content-Type": "application/json" },
      timeout: 10000,
    });
    console.log(
      `[IVR_RESEND] Sent phone=${phone.phone} template=${template} ` +
        `first_failed=${owed.firstFailedAt} message_id=${r.data?.message_id || "-"}`
    );
    recordSend({ ...common, status: "sent", messageId: r.data?.message_id });
    return { mobile: owed.mobile, sent: true, messageId: r.data?.message_id ?? null };
  } catch (error) {
    const detail = error.response?.data ?? error.message;
    console.error(`[IVR_RESEND] Send FAILED phone=${phone.phone}:`, detail);
    recordSend({ ...common, status: "failed", error: detail });
    return { mobile: owed.mobile, sent: false, reason: "send_failed", detail };
  }
}

/** Who is owed a message. Sends nothing, costs nothing. */
router.get("/failed/status", async (req, res) => {
  const since = String(req.query.since || "").trim() ||
    new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const variant = String(req.query.variant || "").trim() || null;

  const { rows, error } = await findOwed(db(), { sinceIso: since, variant });
  if (error) return res.status(503).json({ ok: false, error });

  const byDay = {};
  for (const r of rows) byDay[r.day] = (byDay[r.day] ?? 0) + 1;

  res.json({
    ok: true,
    since,
    variant: variant ?? "(any)",
    owed: rows.length,
    by_day: byDay,
    max_run: MAX_RUN,
    note:
      rows.length === 0
        ? "Nobody is owed a message in this window."
        : "POST /api/resend/failed to send. Start with {\"limit\":1} — one message is the " +
          "cheapest test of whether the provider is back.",
  });
});

/** Send them. Oldest press first. */
router.post("/failed", async (req, res) => {
  const since = String(req.body?.since || "").trim() ||
    new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const variant = String(req.body?.variant || "").trim() || null;

  const client = db();
  const { rows, error } = await findOwed(client, { sinceIso: since, variant });
  if (error) return res.status(503).json({ ok: false, error });

  const cap = resolveRunCap(req.body?.limit, rows.length);
  const batch = rows.slice(0, cap);

  const results = [];
  for (const owed of batch) {
    // Serial, not parallel. This runs after a provider outage, and hitting a
    // recovering API with 257 concurrent requests is how it goes down again.
    results.push(await sendOne(client, owed));
  }

  const sent = results.filter((r) => r.sent).length;
  console.log(`[IVR_RESEND] Run complete: ${sent}/${batch.length} sent, ${rows.length} owed`);

  res.json({
    ok: true,
    owed: rows.length,
    attempted: batch.length,
    sent,
    failed: batch.length - sent,
    remaining: rows.length - sent,
    results,
  });
});

export default router;
