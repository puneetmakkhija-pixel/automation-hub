import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import { openMailbox } from "./fetch-mis-mail.js";
import { withHealthcheck } from "./healthcheck.js";

// Finance tracker sync: mailbox -> Claude -> crm.fin_load on smecircle.
//
// SCHEDULE: Railway cron '30 3 * * *' = 03:30 UTC = 09:00 IST, on the `jobs`
// service (npm run sync:fin-tracker:cron). data-jobs has no Redis, so this is a
// one-shot script like its siblings, not a BullMQ worker.
//
// WHY EVERY ROW COMES IN needs_check = true
//
// The 120 seeded rows were read by a person (statuses, "subject says 28,
// attachment is 29"). A model reading a PDF is good but not that good, so a new
// row is a proposal: the dashboard counts it under needs_check until someone
// confirms. Seeded rows are locked = true in crm.fin_*, and crm.fin_load keeps
// locked values, so a re-run can never overwrite a curated row.
//
// source_key is the Gmail message id (X-GM-MSGID in hex, which imapflow exposes
// as emailId) -- the same key the seed used -- so a mail already in the tracker
// is skipped BEFORE it costs a model call.

export const SOURCE = "railway-imap";
const DEFAULT_MODEL = "claude-haiku-5-5";
const MAX_PDF_BYTES = 12 * 1024 * 1024;

const MONTH = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2}$/;

const EXTRACT_TOOL = {
  name: "record_finance_mail",
  description:
    "Record what this email is. Use kind 'other' for anything that is not a vendor invoice, a purchase order, or a lender billing closure. Never guess: leave a field null when the mail and attachments do not state it.",
  input_schema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["vendor_invoice", "po", "lender_closure", "other"] },
      vendor_invoices: {
        type: "array",
        description: "One entry per invoice the mail carries.",
        items: {
          type: "object",
          properties: {
            category: { type: ["string", "null"], description: "e.g. 'DSA / Lending partner', 'Office & IT'" },
            vendor: { type: "string" },
            invoice_ref: { type: ["string", "null"], description: "Invoice number as printed on the ATTACHMENT, not the subject" },
            billing_month: { type: ["string", "null"], description: "Mon-YY, e.g. Sep-26" },
            po_number: { type: ["string", "null"], description: "e.g. BVAL/26-27/PO/0237" },
            amount_ex_gst: { type: ["number", "null"] },
            amount_incl_gst: { type: ["number", "null"] },
            notes: { type: ["string", "null"], description: "Any mismatch between subject and attachment" },
          },
          required: ["vendor"],
        },
      },
      po_ledger: {
        type: "array",
        items: {
          type: "object",
          properties: {
            po_number: { type: "string" },
            vendor: { type: "string" },
            vendor_code: { type: ["string", "null"] },
            spend_month: { type: ["string", "null"], description: "Mon-YY" },
            po_amount: { type: "number" },
          },
          required: ["po_number", "vendor", "po_amount"],
        },
      },
      lender_billing: {
        type: "array",
        description: "One entry per lender closure line.",
        items: {
          type: "object",
          properties: {
            lender: { type: "string" },
            billing_month: { type: "string", description: "Mon-YY" },
            so_number: { type: ["string", "null"] },
            revenue_ex_gst: { type: ["number", "null"] },
            notes: { type: ["string", "null"] },
          },
          required: ["lender", "billing_month"],
        },
      },
    },
    required: ["kind"],
  },
};

const SYSTEM =
  "You read mail for an Indian lending-services company's finance team. Amounts are INR. " +
  "Take invoice numbers and amounts from the attached PDF when there is one, not from the subject. " +
  "Return amounts as plain numbers (no commas). If the mail is not a vendor invoice, PO, or lender billing closure, use kind 'other'.";

/**
 * The finance team's own rule, from the tracker workbook ("Daily Auto-Update Setup"):
 *   - vendor invoices: mail from the team (FIN_SENDERS) with "invoice" or "bill" in the subject;
 *   - lender billing: EVERY "Bill Closure" mail, whoever sent it (FIN_CLOSURE_SUBJECT).
 * Pure so it is tested without a mailbox.
 */
export function subjectHasAny(subject, words) {
  const s = String(subject ?? "").toLowerCase();
  return words.some((w) => w && s.includes(w.toLowerCase()));
}

/** Mon-YY or null; anything else is dropped rather than stored malformed. */
export function cleanMonth(m) {
  return typeof m === "string" && MONTH.test(m.trim()) ? m.trim() : null;
}

const num = (n) => (typeof n === "number" && Number.isFinite(n) ? n : null);
const str = (s) => (typeof s === "string" && s.trim() ? s.trim() : null);

/**
 * Turns one model result into fin_load rows. Pure, so it is tested without a
 * mailbox or an API key.
 */
export function toRows(emailId, mail, result) {
  const gmail_url = `https://mail.google.com/mail/u/0/#all/${emailId}`;
  const key = (i) => (i === 0 ? emailId : `${emailId}:${i}`);
  const out = { vendor_invoices: [], po_ledger: [], lender_billing: [] };

  (result.vendor_invoices ?? []).forEach((v, i) => {
    if (!str(v.vendor)) return;
    out.vendor_invoices.push({
      source_key: key(i),
      category: str(v.category),
      vendor: str(v.vendor),
      invoice_ref: str(v.invoice_ref),
      billing_month: cleanMonth(v.billing_month),
      po_number: str(v.po_number),
      sent_at: mail.date,
      sent_by: mail.from,
      amount_ex_gst: num(v.amount_ex_gst),
      amount_incl_gst: num(v.amount_incl_gst),
      status: "Received",
      notes: str(v.notes),
      gmail_url,
      needs_check: true,
    });
  });

  for (const p of result.po_ledger ?? []) {
    if (!str(p.po_number) || !str(p.vendor) || num(p.po_amount) === null) continue;
    out.po_ledger.push({
      po_number: str(p.po_number),
      vendor: str(p.vendor),
      vendor_code: str(p.vendor_code),
      spend_month: cleanMonth(p.spend_month),
      po_amount: num(p.po_amount),
      invoiced_amount: 0,
      notes: "from mail; verify",
    });
  }

  (result.lender_billing ?? []).forEach((l, i) => {
    const month = cleanMonth(l.billing_month);
    if (!str(l.lender) || !month) return;
    out.lender_billing.push({
      source_key: key(i),
      lender: str(l.lender),
      billing_month: month,
      so_number: str(l.so_number),
      revenue_ex_gst: num(l.revenue_ex_gst),
      closure_sent_on: mail.date ? mail.date.slice(0, 10) : null,
      notes: str(l.notes),
      gmail_url,
      needs_check: true,
    });
  });

  return out;
}

async function extract(anthropic, model, parsed) {
  const content = [];
  let bytes = 0;
  for (const a of parsed.attachments ?? []) {
    const isPdf = a.contentType === "application/pdf" || /\.pdf$/i.test(a.filename ?? "");
    if (!isPdf || bytes + a.content.length > MAX_PDF_BYTES) continue;
    bytes += a.content.length;
    content.push({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: a.content.toString("base64") },
    });
  }
  content.push({
    type: "text",
    text: `From: ${parsed.from?.text}\nSubject: ${parsed.subject}\n\n${(parsed.text ?? "").slice(0, 6000)}`,
  });

  const res = await anthropic.messages.create({
    model,
    max_tokens: 2000,
    system: SYSTEM,
    tools: [EXTRACT_TOOL],
    tool_choice: { type: "tool", name: EXTRACT_TOOL.name },
    messages: [{ role: "user", content }],
  });
  const block = res.content.find((b) => b.type === "tool_use");
  return block?.input ?? { kind: "other" };
}

async function existingKeys(db, keys) {
  if (!keys.length) return new Set();
  const seen = new Set();
  for (const [table, col] of [
    ["fin_vendor_invoice", "source_key"],
    ["fin_lender_billing", "source_key"],
  ]) {
    const { data, error } = await db.from(table).select(col).in(col, keys);
    if (error) throw new Error(`${table}: ${error.message}`);
    for (const r of data) seen.add(r[col]);
  }
  return seen;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const days = Number(process.env.FIN_LOOKBACK_DAYS) || 3;
  const maxMails = Number(process.env.FIN_MAX_MAILS) || 50;
  const model = process.env.FIN_MODEL || DEFAULT_MODEL;
  const subjectWords = (process.env.FIN_SUBJECTS ?? "invoice,bill").split(",").map((w) => w.trim()).filter(Boolean);
  const closureSubject = (process.env.FIN_CLOSURE_SUBJECT ?? "Bill Closure").trim();

  const user = process.env.MIS_IMAP_USER || process.env.GMAIL_IMAP_USER;
  const pass = process.env.MIS_IMAP_APP_PASSWORD || process.env.GMAIL_IMAP_APP_PASSWORD;
  const senders = (process.env.FIN_SENDERS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const missing = [
    !user || !pass ? "MIS_IMAP_USER/MIS_IMAP_APP_PASSWORD (or GMAIL_IMAP_*)" : null,
    !senders.length ? "FIN_SENDERS (comma-separated sender names, addresses or domains)" : null,
    !process.env.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY" : null,
    !process.env.SUPABASE_URL ? "SUPABASE_URL" : null,
    !process.env.SUPABASE_SERVICE_ROLE_KEY ? "SUPABASE_SERVICE_ROLE_KEY" : null,
  ].filter(Boolean);
  if (missing.length) throw new Error(`Missing required environment variable(s): ${missing.join(", ")}`);

  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { db: { schema: "crm" } });
  const anthropic = new Anthropic();

  const imap = new ImapFlow({ host: "imap.gmail.com", port: 993, secure: true, auth: { user, pass }, logger: false });
  await imap.connect();
  const payload = { vendor_invoices: [], po_ledger: [], lender_billing: [] };
  const errors = [];
  const stats = { found: 0, off_topic: 0, already_in_tracker: 0, read: 0, other: 0, failed: 0 };

  const { lock, mailbox } = await openMailbox(imap);
  try {
    const since = new Date(Date.now() - days * 86_400_000);
    // Two routes in, per the finance team's rule (see subjectHasAny). IMAP FROM matches the header text, so a
    // display name ("Jaideep") works as well as an address or domain.
    const fromTeam = new Set();
    for (const from of senders) {
      for (const uid of (await imap.search({ from, since }, { uid: true })) || []) fromTeam.add(uid);
    }
    const closures = new Set();
    if (closureSubject) for (const uid of (await imap.search({ subject: closureSubject, since }, { uid: true })) || []) closures.add(uid);
    const sorted = [...new Set([...fromTeam, ...closures])].sort((a, b) => b - a);
    stats.found = sorted.length;
    console.log(`[fin-tracker] ${mailbox}: ${fromTeam.size} from ${senders.length} sender(s), ${closures.size} "${closureSubject}" since ${since.toISOString().slice(0, 10)}`);

    // Cheap pass first: ids and subjects only, so mails already in the tracker (or off-topic) cost nothing.
    const ids = [];
    for await (const m of imap.fetch(sorted, { emailId: true, envelope: true }, { uid: true })) {
      const ok = closures.has(m.uid) || (fromTeam.has(m.uid) && subjectHasAny(m.envelope?.subject, subjectWords));
      if (ok) ids.push({ uid: m.uid, emailId: m.emailId });
    }
    stats.off_topic = sorted.length - ids.length;
    const known = await existingKeys(db, ids.map((i) => i.emailId));
    const todo = ids.filter((i) => !known.has(i.emailId)).slice(0, maxMails);
    stats.already_in_tracker = ids.length - ids.filter((i) => !known.has(i.emailId)).length;

    for (const { uid, emailId } of todo) {
      try {
        const msg = await imap.fetchOne(String(uid), { source: true }, { uid: true });
        const parsed = await simpleParser(msg.source);
        const result = await extract(anthropic, model, parsed);
        stats.read += 1;
        if (result.kind === "other") {
          stats.other += 1;
          continue;
        }
        const rows = toRows(emailId, { date: parsed.date?.toISOString() ?? null, from: parsed.from?.text ?? null }, result);
        for (const k of Object.keys(payload)) payload[k].push(...rows[k]);
      } catch (e) {
        stats.failed += 1;
        errors.push(`uid ${uid}: ${e.message}`);
      }
    }
  } finally {
    lock.release();
    await imap.logout().catch(() => {});
  }

  const counts = Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, v.length]));
  console.log(`[fin-tracker] ${JSON.stringify({ ...stats, ...counts, model, dryRun })}`);
  if (dryRun) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  // Called even with nothing to load: it writes the crm.fin_sync_log row, which
  // is how "the job ran and found nothing" differs from "the job never ran".
  const { data, error } = await db.rpc("fin_load", {
    p: { ...payload, errors: errors.length ? errors.join("; ") : undefined },
    p_source: SOURCE,
  });
  if (error) throw new Error(`fin_load: ${error.message}`);
  console.log(`[fin-tracker] fin_load ${JSON.stringify(data)}`);
  // Per-mail failures are in fin_sync_log.errors; fail the run so Healthchecks sees them.
  if (stats.failed) throw new Error(`${stats.failed} mail(s) failed: ${errors.slice(0, 3).join("; ")}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  withHealthcheck("fin-tracker", main).catch((e) => {
    console.error(`[fin-tracker] ${e.message}`);
    process.exit(1);
  });
}
