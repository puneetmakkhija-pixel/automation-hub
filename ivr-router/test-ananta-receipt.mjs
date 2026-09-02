/**
 * The Ananta delivery receipt, recorded instead of discarded.
 *
 *   node test-ananta-receipt.mjs
 *
 * The advancing logic — read > delivered > sent, never backwards — lives in
 * public.wa_record_receipt and is the database's job; it was verified against
 * the live table on all five paths. What is checked here is the wrapper's one
 * promise: it never throws, because a receipt is worth less than the 200 the
 * provider is waiting for, and a provider handed a 500 retries the same payload
 * for hours.
 */
import assert from "node:assert/strict";
import SupabaseClient from "./lib/supabaseClient.js";

let calls = [];
const db = new SupabaseClient("http://stub.invalid", "stub-key");

const stub = (reply) => ({
  rpc: (fn, args) => {
    calls.push({ fn, args });
    return Promise.resolve(reply);
  },
});

let failed = 0;
const check = async (name, fn) => {
  calls = [];
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};

console.log("\nrecordWhatsAppReceipt");

await check("passes the receipt to wa_record_receipt", async () => {
  db.client = stub({ data: { ok: true, matched: 1, advanced: true }, error: null });
  const out = await db.recordWhatsAppReceipt({
    messageId: "wamid.abc", phone: "9812345678", status: "delivered",
  });
  assert.deepEqual(out, { ok: true, matched: 1, advanced: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].fn, "wa_record_receipt");
  assert.deepEqual(calls[0].args, {
    p_message_id: "wamid.abc", p_phone: "9812345678", p_status: "delivered",
  });
});

await check("returns the RPC's refusal without treating it as a failure", async () => {
  // matched 0 is the ordinary out-of-order or unknown-message case.
  db.client = stub({ data: { ok: true, matched: 0, advanced: false }, error: null });
  const out = await db.recordWhatsAppReceipt({ messageId: "wamid.x", status: "delivered" });
  assert.equal(out.ok, true);
  assert.equal(out.matched, 0);
});

await check("swallows an RPC error rather than throwing", async () => {
  db.client = stub({ data: null, error: { message: "connection reset" } });
  const out = await db.recordWhatsAppReceipt({ messageId: "wamid.x", status: "read" });
  assert.equal(out.ok, false);
  assert.match(out.error, /connection reset/);
});

await check("swallows a client that throws outright", async () => {
  db.client = { rpc: () => { throw new Error("boom"); } };
  const out = await db.recordWhatsAppReceipt({ messageId: "wamid.x", status: "read" });
  assert.equal(out.ok, false);
  assert.match(out.error, /boom/);
});

await check("survives a receipt with no message id", async () => {
  db.client = stub({ data: { ok: false, error: "message_id and status are required" }, error: null });
  const out = await db.recordWhatsAppReceipt({ messageId: undefined, status: "read" });
  assert.equal(out.ok, false);
  assert.equal(calls[0].args.p_message_id, null, "undefined must reach the RPC as null");
});

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
