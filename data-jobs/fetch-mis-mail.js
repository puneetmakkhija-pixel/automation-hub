import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

// Fetches a lender's daily MIS attachment straight from the mailbox it is sent
// to, so a report that arrives by email does not need a human to save the file.
//
// WHY THIS LIVES HERE AND NOT IN THE CRM'S MAIL WATCHER
//
// dsa-business-crm already runs an IMAP watcher over this same mailbox
// (lib/lender-mis/ingest.ts), and the obvious move was to add a sender entry to
// its ADAPTERS map and be done. Two things make that the wrong table to land
// this report in:
//
//   1. That path writes crm.pl_lender_mis through crm.upsert_pl_mis, which
//      replaces the `raw` column wholesale on conflict. Hero's application feed
//      identifies the customer ONLY inside `raw`, as `cuid`, and crm.v_pl_lead
//      decodes the mobile from it. The disbursal report has no cuid column, so
//      every LAN present in both feeds would lose its mobile the first time
//      this report overwrote it — silently, and progressively, as the overlap
//      between the two feeds grows.
//
//   2. Its NormalizedLead shape has no field for twelve of this report's
//      columns (decile, appsflyerid, campaign id, the utm_*, CPV action,
//      sanction rate, city). They would survive only inside the `raw` this
//      report is not allowed to write.
//
// So the report keeps its own parser and its own table, exactly as
// 008_hero_disbursal_ingest.sql set out, and this module gives that parser the
// one thing it was missing: the file.

/** Where Hero's disbursal report comes from. */
export const HERO_DISBURSAL = {
  from: "sandeep.pant@herofincorp.com",
  // Authoritative. The IMAP SUBJECT search below only narrows what gets
  // fetched; this decides what gets ingested.
  subject: /buddy\s*loan\s+disbursement\s+report/i,
  // The literal substring handed to IMAP. Loose on purpose: a wrong one shows
  // up as "no matching email" rather than as a bad parse.
  searchSubject: "Disbursement Report",
  attachment: /\.(xlsx|xlsm|csv)$/i,
};

// Gmail files a message under All Mail whether or not it is still in the inbox,
// so a report someone has already archived is still found. INBOX is the
// fallback for accounts where All Mail is not exposed.
export const MAILBOXES = ["[Gmail]/All Mail", "INBOX"];

/** True when this subject line is the report we want. */
export function subjectMatches(subject, rule) {
  return rule.subject.test(String(subject ?? ""));
}

/**
 * The attachment to ingest, or null.
 *
 * Filtered by filename rather than by content type because Gmail hands the same
 * .xlsx out as application/octet-stream, application/vnd.ms-excel and the full
 * OpenXML type depending on what sent it. Inline signature images are the thing
 * being excluded and they never carry a spreadsheet extension.
 */
export function pickAttachment(attachments, rule) {
  for (const a of attachments ?? []) {
    if (rule.attachment.test(String(a.filename ?? ""))) return a;
  }
  return null;
}

/**
 * Opens the first mailbox that will have us, READ-ONLY.
 *
 * Read-only is load-bearing, not caution. dsa-business-crm's watcher reads the
 * same account and marks the messages it has ingested \Seen. A second reader
 * that could set flags would be able to mark a lender's report seen before that
 * watcher had processed it, and the report would look handled while nothing had
 * been written. This connection cannot do that.
 */
async function openMailbox(client, log = console) {
  const refused = [];
  for (const name of MAILBOXES) {
    try {
      const lock = await client.getMailboxLock(name, { readOnly: true });
      if (refused.length) log.warn?.(`[mis-mail] fell back to ${name} — ${refused.join("; ")}`);
      return { lock, mailbox: name };
    } catch (e) {
      refused.push(`${name}: ${e.message}`);
    }
  }
  throw new Error(`no mailbox could be opened — ${refused.join("; ")}`);
}

/**
 * The newest matching report as { filename, content, date, subject }, or null
 * when the mailbox has nothing matching in the window.
 *
 * Scans the newest few messages from the sender rather than only the single
 * newest: a lender that sends a corrections copy, or any other mail from the
 * same person on the same day, must not push the report out of view.
 */
export async function fetchLatestReport({ user, pass, rule, sinceDays = 4, scan = 5, log = console }) {
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user, pass },
    logger: false,
  });

  await client.connect();
  let opened;
  try {
    opened = await openMailbox(client, log);
  } catch (e) {
    await client.logout().catch(() => {});
    throw e;
  }

  const { lock, mailbox } = opened;
  try {
    const since = new Date(Date.now() - sinceDays * 86_400_000);
    const uids = (await client.search({ from: rule.from, subject: rule.searchSubject, since }, { uid: true })) || [];
    log.info?.(`[mis-mail] ${mailbox}: ${uids.length} message(s) from ${rule.from} since ${since.toISOString().slice(0, 10)}`);

    for (const uid of uids.sort((a, b) => b - a).slice(0, scan)) {
      const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (!msg?.source) continue;
      const parsed = await simpleParser(msg.source);
      if (!subjectMatches(parsed.subject, rule)) continue;
      const att = pickAttachment(parsed.attachments, rule);
      if (!att) {
        log.warn?.(`[mis-mail] uid=${uid} "${parsed.subject}" matched but carried no spreadsheet`);
        continue;
      }
      return {
        filename: att.filename,
        content: att.content,
        subject: parsed.subject,
        date: parsed.date ? parsed.date.toISOString() : null,
      };
    }
    return null;
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
}
