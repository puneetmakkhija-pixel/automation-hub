import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { createClient } from "@supabase/supabase-js";
import { openMailbox } from "./fetch-mis-mail.js";
import { withHealthcheck } from "./healthcheck.js";

// Finance tracker sync: mailbox -> crm.fin_load on smecircle (ymdkcaedwnnhszhzirli).
//
// Ported from the finance team's original loader (the same rules that produced the Sep-Oct seed):
//   - vendor invoices: mail from Jaideep / Abhishek / Jaya with "invoice" or "bill" in the subject
//   - lender billing:  every "Bill Closure" mail, whoever sent it
// Rows are keyed by the Gmail THREAD id (hex), exactly as the seeded rows are, so a reply on an existing
// invoice thread updates that row instead of creating a second one.
//
// SCHEDULE: Railway cron '30 3 * * *' = 03:30 UTC = 09:00 IST. data-jobs has no Redis, so this is a
// one-shot script like its siblings, not a BullMQ worker.
//
// WHAT THE DATABASE PROTECTS: the 120 seeded rows are locked = true, and crm.fin_load keeps locked values,
// so a re-run can never overwrite a curated row. New rows from this job that a rule could not read
// cleanly arrive needs_check = true.
//
// ENV: GMAIL_IMAP_USER / GMAIL_IMAP_APP_PASSWORD (or MIS_IMAP_*), SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
//      Optional: FIN_LOOKBACK_DAYS (3; 60 for a backfill), FIN_TEAM (Gmail "from" terms, default
//      "jaideep OR abhishek OR jaya"). Flag: --dry-run prints the rows and writes nothing.

export const SOURCE = "railway-imap";

const VENDOR_FROM = /jaideep|abhishek|jaya/i;
const APPROVERS = /puneet\.makhija@|shubhashis\.singh@/i;
const ACCOUNTS = /accounts@buddyloan\.com/i;
const PO_RE = /BVAL\/\d{2}-\d{2}\/PO\/\d{3,4}/;
const num = (s) => Number(String(s).replace(/[₹,\s]/g, "")) || 0;
const nums = (s) => (String(s).match(/\d[\d,]*\.?\d*/g) || []).map(num);
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const gmailUrl = (thrid) => `https://mail.google.com/mail/u/0/#all/${BigInt(thrid).toString(16)}`;
const firstPart = (t) =>
  String(t || "").replace(/\r/g, "").split(/\nOn (Mon|Tue|Wed|Thu|Fri|Sat|Sun),/)[0].replace(/[ \t ]+/g, " ");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function billingMonth(subject, fallbackDate) {
  const m = subject.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[\s'’\-]*(?:20)?(\d{2})/i);
  if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1, 3).toLowerCase()}-${m[2]}`;
  const d = new Date(fallbackDate);
  d.setMonth(d.getMonth() - 1);
  return `${MONTHS[d.getMonth()]}-${String(d.getFullYear()).slice(2)}`;
}

// ---------- parsers ----------
export function parseVendor(thread) {
  const first = thread.msgs.find((m) => VENDOR_FROM.test(m.from) || VENDOR_FROM.test(m.fromName)) || thread.msgs[0];
  const body = firstPart(first.text);
  const po = (body.match(PO_RE) || [])[0] || null;
  let poRow = null;
  let inv = null;
  let needs = false;
  if (po) {
    const i = body.indexOf(po) + po.length;
    const vendorCode = (body.match(/BVAL\/VNDR\/\d+/) || [])[0] || null;
    const vendor = (body.match(/BVAL\/VNDR\/\d+\s+(.+?)\s+BVAL\/\d{2}-\d{2}\/PO/) || [])[1] || null;
    const spend = (body.slice(i, i + 40).match(/^\s*([A-Za-z]{3,9}(?:-\d{2})?)/) || [])[1] || null;
    const n = nums(body.slice(i, i + 700)).filter((x) => x >= 100);
    if (n.length >= 3) {
      const [poAmt] = n;
      const total = n[n.length - 2];
      const invs = n.slice(1, -2);
      inv = invs[invs.length - 1] ?? null;
      poRow = {
        po_number: po, vendor: vendor || thread.subject, vendor_code: vendorCode, spend_month: spend, po_amount: poAmt,
        invoiced_amount: total, invoice_count: invs.length, last_invoice_at: day(first.date),
        invoices: invs.map((a, k) => ({ ref: `#${k + 1}`, amount: a })),
      };
    }
  }
  if (inv == null) {
    const m = body.match(/(?:Total Payable|Grand Total|Invoice Amount|Total)[^\d]{0,20}([\d,]+\.?\d*)/i);
    inv = m ? num(m[1]) : null;
    needs = true;
  }
  const appr = thread.msgs.find((m) => APPROVERS.test(m.from) && m !== first);
  return {
    vendor: {
      source_key: thread.id, category: null,
      vendor: poRow?.vendor || thread.subject.replace(/^(re|fwd?):\s*/i, "").slice(0, 80),
      invoice_ref: thread.subject.slice(0, 120), billing_month: billingMonth(thread.subject, first.date), po_number: po,
      sent_at: first.date, sent_by: first.fromName, amount_ex_gst: inv, status: appr ? "Approved" : "Submitted for approval",
      attachments: [...new Set(thread.msgs.flatMap((m) => m.files))], gmail_url: thread.url, needs_check: needs,
    },
    po: poRow,
  };
}

export function parseClosure(thread) {
  const first = thread.msgs[0];
  const body = firstPart(first.text);
  const so = (body.match(/SO\s*(?:Number|No)?\s*[:\-]?\s*(\d{12,})/i) || [])[1] || null;
  const terms = Number((body.match(/Payment\s*(?:terms|days)?\s*[:\-]?\s*(\d{2})\s*days/i) || [])[1] || 30);
  let rev = null;
  let needs = false;
  const ia = body.match(/Invoice\s*Amount\s*[:\-]?\s*(?:Rs\.?|₹)?\s*([\d,]+\.?\d*)/i);
  const fin = body.match(/Final Payout\s+([\d,\s.%]+)/i);
  const tot = body.match(/\bTotal\b([^A-Za-z]{0,140})/);
  if (ia) rev = num(ia[1]);
  else if (fin) { const n = nums(fin[1]).filter((x) => x >= 100); rev = n[n.length - 1] ?? null; }
  else if (tot) { const n = nums(tot[1]).filter((x) => x >= 100); rev = n[n.length - 1] ?? null; needs = true; }
  else {
    const k = body.search(/Revenue/i);
    const n = k >= 0 ? nums(body.slice(k, k + 400)).filter((x) => x >= 100 && x < 1e8) : [];
    rev = n[1] ?? n[0] ?? null;
    needs = true;
  }
  const appr = thread.msgs.find((m) => APPROVERS.test(m.from) && m !== first);
  const inv = thread.msgs.find((m) => ACCOUNTS.test(m.from) && /invoice/i.test(m.text || ""));
  const lender = thread.subject.replace(/^(re|fwd?):\s*/i, "").replace(/b[il]ll closure\s*[-|:]?\s*/i, "")
    .replace(/[-|]\s*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[\s\S]*$/i, "").trim() || thread.subject;
  return {
    source_key: thread.id, lender, billing_month: billingMonth(thread.subject, first.date), so_number: so, revenue_ex_gst: rev,
    closure_sent_on: day(first.date), approved_on: day(appr?.date), invoice_raised_on: day(inv?.date), payment_terms_days: terms,
    needs_check: needs, gmail_url: thread.url,
  };
}

/** Latest tracker row per PO wins: a later mail carries a higher invoiced total. */
export function latestPerPo(rows) {
  const byPo = {};
  for (const p of rows) if (!byPo[p.po_number] || p.invoiced_amount >= byPo[p.po_number].invoiced_amount) byPo[p.po_number] = p;
  return Object.values(byPo);
}

// ---------- IMAP ----------
async function loadThreads(client, gmraw) {
  const uids = (await client.search({ gmraw }, { uid: true })) || [];
  const thrids = new Set();
  if (uids.length) for await (const m of client.fetch(uids, { threadId: true }, { uid: true })) thrids.add(m.threadId);
  const threads = [];
  for (const thrid of thrids) {
    const tu = (await client.search({ threadId: thrid }, { uid: true })) || [];
    const msgs = [];
    for await (const m of client.fetch(tu, { source: true }, { uid: true })) {
      const p = await simpleParser(m.source);
      msgs.push({
        subject: p.subject || "", from: p.from?.value?.[0]?.address || "", fromName: p.from?.value?.[0]?.name || "",
        date: p.date, text: p.text || "",
        files: (p.attachments || []).filter((a) => !a.related).map((a) => a.filename).filter(Boolean),
      });
    }
    msgs.sort((a, b) => a.date - b.date);
    if (msgs.length) threads.push({ id: BigInt(thrid).toString(16), url: gmailUrl(thrid), subject: msgs[0].subject, msgs });
  }
  return threads;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const days = Number(process.env.FIN_LOOKBACK_DAYS) || 3;
  const team = process.env.FIN_TEAM || "jaideep OR abhishek OR jaya";
  const user = process.env.MIS_IMAP_USER || process.env.GMAIL_IMAP_USER;
  const pass = process.env.MIS_IMAP_APP_PASSWORD || process.env.GMAIL_IMAP_APP_PASSWORD;
  const missing = [
    !user || !pass ? "MIS_IMAP_USER/MIS_IMAP_APP_PASSWORD (or GMAIL_IMAP_USER/GMAIL_IMAP_APP_PASSWORD)" : null,
    !process.env.SUPABASE_URL ? "SUPABASE_URL" : null,
    !process.env.SUPABASE_SERVICE_ROLE_KEY ? "SUPABASE_SERVICE_ROLE_KEY" : null,
  ].filter(Boolean);
  if (missing.length) throw new Error(`Missing required environment variable(s): ${missing.join(", ")}`);

  const imap = new ImapFlow({ host: "imap.gmail.com", port: 993, secure: true, auth: { user, pass }, logger: false });
  const out = { vendor_invoices: [], po_ledger: [], lender_billing: [], errors: "" };
  await imap.connect();
  // Read-only: the CRM's mail watcher reads this mailbox and marks what it ingested \Seen.
  const { lock, mailbox } = await openMailbox(imap);
  let vendorThreads = [];
  let closureThreads = [];
  try {
    vendorThreads = await loadThreads(imap, `from:(${team}) subject:(invoice OR invoices OR bill) -subject:"bill closure" newer_than:${days}d`);
    for (const t of vendorThreads) {
      try { const r = parseVendor(t); out.vendor_invoices.push(r.vendor); if (r.po) out.po_ledger.push(r.po); }
      catch (e) { out.errors += `V ${t.subject}: ${e.message}; `; }
    }
    closureThreads = await loadThreads(imap, `subject:"bill closure" newer_than:${days}d`);
    for (const t of closureThreads) {
      try { out.lender_billing.push(parseClosure(t)); }
      catch (e) { out.errors += `L ${t.subject}: ${e.message}; `; }
    }
  } finally {
    lock.release();
    await imap.logout().catch(() => {});
  }
  out.po_ledger = latestPerPo(out.po_ledger);

  const counts = { vendor_invoices: out.vendor_invoices.length, po_ledger: out.po_ledger.length, lender_billing: out.lender_billing.length };
  console.log(`[fin-tracker] ${JSON.stringify({ mailbox, days, vendor_threads: vendorThreads.length, closure_threads: closureThreads.length, ...counts, errors: out.errors || null, dryRun })}`);
  if (dryRun) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  // Called even with nothing to load: it writes the crm.fin_sync_log row, which is how "ran and found
  // nothing" differs from "never ran".
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    db: { schema: "crm" }, auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await sb.rpc("fin_load", { p: { ...out, errors: out.errors || undefined }, p_source: SOURCE });
  if (error) throw new Error(`fin_load: ${error.message}`);
  console.log(`[fin-tracker] fin_load ${JSON.stringify(data)}`);
  if (out.errors) throw new Error(`some threads failed to parse: ${out.errors.slice(0, 300)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  withHealthcheck("fin-tracker", main).catch((e) => {
    console.error(`[fin-tracker] ${e.message}`);
    process.exit(1);
  });
}
