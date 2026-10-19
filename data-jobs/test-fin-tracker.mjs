import assert from "node:assert/strict";
import { toRows, cleanMonth } from "./finTrackerSync.js";

const mail = { date: "2026-10-19T04:00:00.000Z", from: "Jaideep Singh <j@x.com>" };

assert.equal(cleanMonth("Sep-26"), "Sep-26");
assert.equal(cleanMonth("September 2026"), null);

const r = toRows("1a134f0ed3b7e132", mail, {
  kind: "vendor_invoice",
  vendor_invoices: [
    { vendor: "Cube Finserv", invoice_ref: "Tax Invoice-30", billing_month: "Sep-26", po_number: "BVAL/26-27/PO/0237", amount_ex_gst: 332767 },
    { vendor: "  " },
    { vendor: "Cube Finserv", amount_ex_gst: "12" },
  ],
});
assert.equal(r.vendor_invoices.length, 2, "blank vendor dropped");
assert.equal(r.vendor_invoices[0].source_key, "1a134f0ed3b7e132", "first row keeps the plain Gmail id, like the seed");
assert.equal(r.vendor_invoices[1].source_key, "1a134f0ed3b7e132:2", "later rows are suffixed by position");
assert.equal(r.vendor_invoices[1].amount_ex_gst, null, "non-number amount becomes null, not a guess");
assert.ok(r.vendor_invoices.every((v) => v.needs_check === true), "new rows are always flagged");
assert.equal(r.vendor_invoices[0].gmail_url, "https://mail.google.com/mail/u/0/#all/1a134f0ed3b7e132");

const l = toRows("abc", mail, {
  kind: "lender_closure",
  lender_billing: [
    { lender: "InCred", billing_month: "Sep-26", revenue_ex_gst: 288378 },
    { lender: "Indifi", billing_month: "bad" },
  ],
});
assert.equal(l.lender_billing.length, 1, "closure without a valid month is dropped");
assert.equal(l.lender_billing[0].closure_sent_on, "2026-10-19");

const p = toRows("abc", mail, { kind: "po", po_ledger: [{ po_number: "BVAL/26-27/PO/0203", vendor: "Cube Finserv", po_amount: 4900000 }, { po_number: "X", vendor: "Y" }] });
assert.equal(p.po_ledger.length, 1, "PO without an amount is dropped");
assert.equal(p.po_ledger[0].invoiced_amount, 0);

console.log("fin-tracker: ok");
