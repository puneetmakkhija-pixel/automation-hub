/**
 * One /apply link per caller per window — and the press still counted.
 *
 *   node test-apply-link-dedupe.mjs
 *
 * Driven through the real keypress handler against a fake PostgREST, with
 * Ananta's send stubbed, because the property that matters is a row: the BL
 * leads page and crm.v_ivr_lead count presses from public.whatsapp_messages
 * rows where metadata->>'digit' = '1'. A skipped send that wrote nothing would
 * make a repeat press disappear from the funnel.
 */
import assert from "node:assert/strict";
import http from "node:http";

let inserts = [];
let lookups = [];
let priorRows = [];
let lookupStatus = 200;

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const url = decodeURIComponent(req.url);
    let reply = "[]";
    let status = req.method === "POST" ? 201 : 200;
    if (req.method === "POST" && url.includes("/whatsapp_messages")) {
      const body = JSON.parse(raw || "null");
      inserts.push(Array.isArray(body) ? body[0] : body);
    } else if (req.method === "GET" && url.includes("/whatsapp_messages") && url.includes("metadata->>digit")) {
      lookups.push(url);
      status = lookupStatus;
      reply = lookupStatus === 200 ? JSON.stringify(priorRows) : JSON.stringify({ message: "boom" });
    }
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(reply);
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

// `=`, not `||=`: an inherited real URL would make this suite write to the CRM.
process.env.SUPABASE_URL = `http://127.0.0.1:${server.address().port}`;
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.ANANTA_API_KEY = "test-ananta";
process.env.IVR_DTMF_TEMPLATES = JSON.stringify({ 1: "loan_apply", 2: "other" });
process.env.IVR_DTMF_PLACEHOLDERS = JSON.stringify({
  1: ["https://crmbusinessloans.com/apply"],
  2: ["https://lender.example/journey"],
});
process.env.CRM_BASE_URL = "https://crmbusinessloans.com";
process.env.CRM_PRESS_FORWARD = "0";
process.env.ORI_PRESS_DISPATCH = "0";
process.env.IVR_SMS_MODE = "off";
delete process.env.CRM_SSO_SECRET;
delete process.env.APPLY_LINK_DEDUPE_HOURS;
delete process.env.BOT_SPLIT_MODE;
delete process.env.OUR_BOT_PRESS_ENABLED;

const { default: axios } = await import("axios");
let sends = 0;
axios.post = async (url) => {
  if (String(url).includes("anantadot")) {
    sends++;
    return { data: { status: "success", message_id: `m-${sends}` } };
  }
  throw new Error(`unexpected POST ${url}`);
};

const { acknowledgeThenHandle } = await import("./lib/routes/ivrWhatsAppRoutes.js");
const { applyDedupeHours, isApplyLink, recentApplyLink } = await import("./lib/applyLinkDedupe.js");

let failed = 0;
let n = 0;
const check = async (name, fn) => {
  inserts = [];
  lookups = [];
  priorRows = [];
  lookupStatus = 200;
  sends = 0;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
};

/** A fresh mobile per press: the handler's in-memory retry dedupe is process-wide. */
const press = async ({ digit = "1", variant = "businessloans", mobile } = {}) => {
  n++;
  const res = { json() { return res; }, status() { return res; } };
  const captured = await acknowledgeThenHandle(
    {
      params: { variant },
      body: { mobile: mobile ?? String(9800000000 + n), dtmf: digit, campaign_name: "BL_Sep26", campaign_id: "c-1" },
    },
    res
  );
  // recordSend is fire-and-forget; give its insert a moment to land.
  await new Promise((r) => setTimeout(r, 50));
  return captured;
};

const priorApply = (link = "https://crmbusinessloans.com/apply?t=abc&alias=x") => ({
  id: "prior-1",
  created_at: new Date(Date.now() - 3600e3).toISOString(),
  metadata: { digit: "1", status: "sent", link },
});

console.log("\nsettings\n");

await check("24 hours by default, 0 turns it off, a typo is the default", () => {
  assert.equal(applyDedupeHours({}), 24);
  assert.equal(applyDedupeHours({ APPLY_LINK_DEDUPE_HOURS: "0" }), 0);
  assert.equal(applyDedupeHours({ APPLY_LINK_DEDUPE_HOURS: "6" }), 6);
  assert.equal(applyDedupeHours({ APPLY_LINK_DEDUPE_HOURS: "abc" }), 24);
  assert.equal(applyDedupeHours({ APPLY_LINK_DEDUPE_HOURS: "-3" }), 24);
});

await check("only our /apply counts as an apply link, minted or plain", () => {
  assert.equal(isApplyLink("https://crmbusinessloans.com/apply"), true);
  assert.equal(isApplyLink("https://crmbusinessloans.com/apply/?t=x&alias=y"), true);
  assert.equal(isApplyLink("https://lender.example/apply"), false);
  assert.equal(isApplyLink("https://crmbusinessloans.com/login"), false);
  assert.equal(isApplyLink(null), false);
});

console.log("\nthe press\n");

await check("no apply link in the window: sent as before, one 'sent' row", async () => {
  const out = await press();
  assert.equal(out.body.sent, true);
  assert.equal(sends, 1);
  assert.equal(lookups.length, 1, "the send log should be asked once");
  // The window, the digit and the status are all in the query.
  assert.match(lookups[0], /created_at=gte\./);
  assert.match(lookups[0], /metadata->>status=in\.\(sent,delivered\)/);
  assert.match(lookups[0], /phone_number=in\./);
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].metadata.status, "sent");
});

await check("an apply link inside the window: no send, but the press is still a row", async () => {
  priorRows = [priorApply()];
  const out = await press();
  assert.equal(out.body.sent, false);
  assert.equal(sends, 0, "a paid template went out anyway");
  assert.equal(inserts.length, 1, "the press must still be written down");
  const row = inserts[0];
  // Exactly what crm.v_ivr_lead and the BL leads page select on.
  assert.equal(row.metadata.digit, "1");
  assert.equal(row.metadata.status, "skipped_duplicate");
  assert.equal(row.metadata.variant, "businessloans");
  assert.equal(row.metadata.campaign_name, "BL_Sep26");
  assert.equal(row.metadata.campaign_id, "c-1");
  assert.equal(row.metadata.deduped_against, "prior-1");
  assert.equal(row.metadata.link, priorApply().metadata.link);
  assert.match(row.phone_number, /^\d{10}$/);
});

await check("a prior LENDER link is not our apply link and does not suppress it", async () => {
  priorRows = [priorApply("https://lender.example/journey?x=1")];
  const out = await press();
  assert.equal(out.body.sent, true);
  assert.equal(sends, 1);
});

await check("a press whose link is not /apply is never checked", async () => {
  priorRows = [priorApply()];
  const out = await press({ digit: "2" });
  assert.equal(out.body.sent, true);
  assert.equal(lookups.length, 0);
});

await check("APPLY_LINK_DEDUPE_HOURS=0 turns it off", async () => {
  process.env.APPLY_LINK_DEDUPE_HOURS = "0";
  try {
    priorRows = [priorApply()];
    const out = await press();
    assert.equal(out.body.sent, true);
    assert.equal(lookups.length, 0);
  } finally {
    delete process.env.APPLY_LINK_DEDUPE_HOURS;
  }
});

await check("a send log that cannot be read fails open: the link goes", async () => {
  lookupStatus = 500;
  priorRows = [priorApply()];
  const out = await press();
  assert.equal(out.body.sent, true);
  assert.equal(sends, 1);
});

await check("the lookup matches every shape the send log stores a phone in", async () => {
  let inArgs = null;
  const chain = {
    select: () => chain,
    eq: () => chain,
    in: (col, vals) => ((col === "phone_number" ? (inArgs = vals) : null), chain),
    gte: () => chain,
    order: () => chain,
    limit: async () => ({ data: [], error: null }),
  };
  await recentApplyLink({ from: () => chain }, "+91 98765 43210", { hours: 24 });
  assert.deepEqual(inArgs, ["9876543210", "+919876543210", "919876543210"]);
});

server.close();
console.log(failed ? `\n${failed} failed\n` : "\nall passed\n");
process.exit(failed ? 1 : 0);
