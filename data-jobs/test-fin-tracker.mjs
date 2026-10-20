import assert from "node:assert/strict";
import { parseVendor, parseClosure, latestPerPo, billingMonth } from "./finTrackerSync.js";

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

console.log("fin-tracker: ok");
