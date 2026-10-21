import assert from "node:assert/strict";
import { parseVendor, parseClosure, latestPerPo, billingMonth, loadThreads, printDryRun, stripDebug } from "./finTrackerSync.js";
import { matchLender, matchVendor } from "./finNames.js";

const d = (s) => new Date(s);
const msg = (o) => ({ subject: "", from: "", fromName: "", date: d("2026-10-13T05:00:00Z"), text: "", files: [], ...o });

// --- billing month: from the subject, else the month before the mail
assert.equal(billingMonth("Sep 2026 invoice", d("2026-10-13")), "Sep-26");
assert.equal(billingMonth("Tax Invoice-30", d("2026-10-13")), "Sep-26", "no month in subject -> month before the mail");
assert.equal(billingMonth("Bill Closure - InCred - Aug'26", d("2026-10-13")), "Aug-26");

// --- vendor invoice with a PO table in the body
const tracker = "Hi\nBVAL/VNDR/000016 Cube Finserv BVAL/26-27/PO/0237 Sep-26 4900000 2108244 2441011 2458989\nThanks";
const v = parseVendor({
  id: "1a134f0ed3b7e132", url: "https://mail.google.com/mail/u/0/#all/1a134f0ed3b7e132", subject: "Tax Invoice-30",
  msgs: [msg({ from: "jaideep@x.com", fromName: "Jaideep Singh", text: tracker, files: ["inv30.pdf"] })],
});
assert.equal(v.vendor.source_key, "1a134f0ed3b7e132", "keyed by thread id, like the seed");
assert.equal(v.vendor.po_number, "BVAL/26-27/PO/0237");
assert.equal(v.vendor.amount_ex_gst, 2108244);
assert.equal(v.vendor.vendor, "Cube Finserv");
assert.equal(v.vendor.needs_check, false);
assert.equal(v.vendor.status, "Submitted for approval");
assert.equal(v.po.po_amount, 4900000);
assert.equal(v.po.invoiced_amount, 2441011);
assert.deepEqual(v.vendor.attachments, ["inv30.pdf"]);

// --- an approver's reply flips the status
const approved = parseVendor({
  id: "t2", url: "u", subject: "Invoice",
  msgs: [msg({ from: "jaya@x.com", fromName: "Jaya", text: tracker }), msg({ from: "puneet.makhija@buddyloan.com", date: d("2026-10-14T05:00:00Z"), text: "approved" })],
});
assert.equal(approved.vendor.status, "Approved");

// --- no PO table: falls back to a total and is flagged for a human
const noPo = parseVendor({ id: "t3", url: "u", subject: "Sep 2026 invoice", msgs: [msg({ from: "a@x.com", fromName: "Abhishek", text: "Grand Total: Rs. 87,550.00" })] });
assert.equal(noPo.vendor.amount_ex_gst, 87550);
assert.equal(noPo.vendor.needs_check, true);
assert.equal(noPo.po, null);

// --- lender closure
const c = parseClosure({
  id: "1a12ef118723c79f", url: "u", subject: "Bill Closure - InCred - Sep'26",
  msgs: [
    msg({ from: "x@buddyloan.com", text: "SO Number: 100000012345\nInvoice Amount: Rs. 2,88,378\nPayment terms 30 days" }),
    msg({ from: "shubhashis.singh@buddyloan.com", date: d("2026-10-14T05:00:00Z"), text: "approved" }),
    msg({ from: "accounts@buddyloan.com", date: d("2026-10-15T05:00:00Z"), text: "Invoice raised: BL/123" }),
  ],
});
assert.equal(c.lender, "InCred");
assert.equal(c.billing_month, "Sep-26");
assert.equal(c.so_number, "100000012345");
assert.equal(c.revenue_ex_gst, 288378);
assert.equal(c.approved_on, "2026-10-14");
assert.equal(c.invoice_raised_on, "2026-10-15");
assert.equal(c.needs_check, false);

// --- a closure where only a "Total" row is found is flagged
const t = parseClosure({ id: "t4", url: "u", subject: "Bill closure - Fibe - Sep'26", msgs: [msg({ text: "Total 5,14,773" })] });
assert.equal(t.revenue_ex_gst, 514773);
assert.equal(t.needs_check, true);

// --- the latest tracker row per PO wins
const rows = latestPerPo([{ po_number: "P1", invoiced_amount: 100 }, { po_number: "P1", invoiced_amount: 300 }, { po_number: "P1", invoiced_amount: 200 }, { po_number: "P2", invoiced_amount: 5 }]);
assert.equal(rows.find((r) => r.po_number === "P1").invoiced_amount, 300);
assert.equal(rows.length, 2);

// --- a fake mailbox: one good thread, one thread with a body-less message, one thread that throws
const raw = (subject, from, body) => Buffer.from(`From: ${from}\r\nSubject: ${subject}\r\nDate: Tue, 13 Oct 2026 10:00:00 +0530\r\n\r\n${body}`);
const fake = {
  search: async (q) => {
    if (q.gmraw) return [1, 2, 3];
    if (q.threadId === "100") return [1];
    if (q.threadId === "200") return [2, 22];
    throw new Error("search blew up");
  },
  fetch: async function* (uids, q) {
    if (q.threadId) { yield { uid: 1, threadId: "100" }; yield { uid: 2, threadId: "200" }; yield { uid: 3, threadId: "300" }; return; }
    for (const uid of uids) {
      if (uid === 1) yield { uid, source: raw("Tax Invoice-30", "Jaideep <j@x.com>", "Grand Total: 1000") };
      if (uid === 2) yield { uid, source: raw("Invoice 2", "Jaya <jj@x.com>", "Grand Total: 2000") };
      if (uid === 22) yield { uid }; // no body
    }
  },
};
const warn = [];
const threads = await loadThreads(fake, "x", warn);
assert.equal(threads.length, 2, "good threads survive");
assert.equal(threads[1].msgs.length, 1, "the body-less message is dropped, the other kept");
assert.equal(warn.length, 2);
assert.match(warn.join(" | "), /no message body returned/);
assert.match(warn.join(" | "), /search blew up/);
assert.equal(threads[0].id, (100n).toString(16));

// --- canonical names: messy subjects map to the names the reports group on; unknown or ambiguous stay unknown
assert.equal(matchLender("Muthoot Fincorp BL July 2026 | DSA"), "Muthoot Fincorp - BL");
assert.equal(matchLender("Tata Capital LAP Aug 2026"), "Tata Capital - LAP", "the longer, more specific name wins");
assert.equal(matchLender("Tata Capital"), "Tata Capital");
assert.equal(matchLender("Kissht"), "Kissht + Ring");
assert.equal(matchLender("Bharat Pe July 2026 | DSA"), "BharatPe", "subject spelling with a space");
assert.equal(matchLender("Credillio July 2026"), "Credilio", "subject spelling with a double l");
assert.equal(matchLender("Rupee112 Bharat Loans Jul"), "Rupee112 / Bharat Loans / Loan112 / ROT", "Bharat Pe alias must not steal Bharat Loans");
assert.equal(matchLender("SmartCoin"), "Olyv (SmartCoin)");
assert.equal(matchLender("Poonawalla Fincorp"), null, "ambiguous between five products: unknown, not a guess");
assert.equal(matchLender("Bajaj Finance"), null);
assert.equal(matchLender("Mystery Lender"), null);
assert.equal(matchVendor("I2 FINTECH PRIVATE LIMITED")?.name, "I2 Fintech Pvt Ltd");
assert.equal(matchVendor("EDNT")?.name, "Earth Digital Network Technology (EDNT)");
assert.equal(matchVendor("Cube Finserv Sep Invoice - 28 ( PO - BVAL/26-27/PO/0203 )")?.category, "DSA / Lending partner");
assert.equal(matchVendor("INVOICE - BUDDYLOAN - 05 Oct 2026"), null);

const messy = parseClosure({ id: "t5", url: "u", subject: "Bill Closure - Muthoot Fincorp BL July 2026 | DSA", msgs: [msg({ text: "Invoice Amount: 15,144" })] });
assert.equal(messy.lender, "Muthoot Fincorp - BL");
assert.equal(messy.needs_check, false);
assert.equal(messy._lender_raw.includes("Muthoot"), true, "the raw text is kept for the dry run");
const stranger = parseClosure({ id: "t6", url: "u", subject: "Bill Closure - Mystery Lender - Sep'26", msgs: [msg({ text: "Invoice Amount: 5,000" })] });
assert.equal(stranger.lender, "Mystery Lender");
assert.equal(stranger.needs_check, true, "a lender we have never billed is flagged");

const poVendor = parseVendor({ id: "t7", url: "u", subject: "Invoice", msgs: [msg({ from: "j@x.com", fromName: "Jaideep", text: "BVAL/VNDR/000081 I2 FINTECH PRIVATE LIMITED BVAL/26-27/PO/0226 Jul-26 4500000 873878 3342102 1157898" })] });
assert.equal(poVendor.vendor.vendor, "I2 Fintech Pvt Ltd");
assert.equal(poVendor.po.vendor, "I2 Fintech Pvt Ltd", "the PO ledger gets the same name");
assert.equal(poVendor.vendor.category, "DSA / Lending partner");
assert.equal(poVendor.vendor.needs_check, false);
const unknownVendor = parseVendor({ id: "t8", url: "u", subject: "INVOICE - BUDDYLOAN - 05 Oct 2026", msgs: [msg({ from: "x@x.com", fromName: "Someone", text: "Grand Total: 5000" })] });
assert.equal(unknownVendor.vendor.needs_check, true);
assert.equal(unknownVendor.vendor.category, null);

// --- the dry-run printer runs end to end against a fake database and tags rows new / exists
const lines = [];
const origLog = console.log;
console.log = (l) => lines.push(l);
const fakeSb = { from: (table) => ({ select: (col) => ({ in: async (_c, vals) => ({ data: vals.filter((v) => v === "have").map((v) => ({ [col]: v })), error: null }) }) }) };
await printDryRun(fakeSb, {
  vendor_invoices: [{ source_key: "have", vendor: "Cube Finserv", needs_check: false }, { source_key: "fresh", vendor: "X", needs_check: true }],
  lender_billing: [messy], po_ledger: [{ po_number: "P1", vendor: "V", po_amount: 1, invoiced_amount: 0, invoice_count: 0 }],
});
console.log = origLog;
assert.equal(lines.filter((l) => l.startsWith("[fin-row] V exists")).length, 1);
assert.equal(lines.filter((l) => l.startsWith("[fin-row] V new")).length, 1);
assert.equal(lines.filter((l) => l.startsWith("[fin-row] L new")).length, 1);
assert.match(lines.find((l) => l.includes(" L new")), /"raw":"Muthoot/, "a changed lender name shows its raw text");
assert.match(lines.at(-1), /"new":2,"exists":1,"need_check":1/);
assert.equal("_lender_raw" in stripDebug(messy), false);

console.log("fin-tracker: ok");
