import test from "node:test";
import assert from "node:assert/strict";
import router from "./lib/routes/flexiloansCampaignRoutes.js";

// Composing a press-1 campaign that hands off to WhatsApp needs a webhookId,
// and nothing in this service ever exposed the webhook list. The id had to be
// read off the vendor's panel by eye and typed in -- and a wrong one fails
// inside a compose that answers 400 with an empty body, which is the least
// debuggable place in the whole pipeline to put a typo.

const WEBHOOKS = [
  { id: "31", webhookName: "WhatsApp Business Loans", url: "https://x/w", event: "DTMF" },
  { id: "32", webhookName: "Hangup logger", url: "https://x/h", event: "HANGUP" },
];
const PROMPTS = [
  { promptId: "68361", fileName: "msmescheme.wav", promptCategory: "menu" },
  { promptId: "68362", fileName: "msmepress1.wav", promptCategory: "thanks" },
];

/** The GET /obd-lookup handler, reached without standing up a server. */
function handler() {
  const layer = router.stack.find(
    (l) => l.route?.path === "/obd-lookup" && l.route?.methods?.get
  );
  assert.ok(layer, "the /obd-lookup route should be registered");
  return layer.route.stack[0].handle;
}

async function call(query, { webhooks = WEBHOOKS, prompts = PROMPTS } = {}) {
  process.env.OBD_BASE_URL = "https://obd.test";
  process.env.OBD_USERNAME = "u";
  process.env.OBD_PASSWORD = "p";
  process.env.SUPABASE_URL ??= "https://sb.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "key";

  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/login")) {
      return { ok: true, status: 200, json: async () => ({ token: "t", userid: "501756" }) };
    }
    if (u.includes("/webhooks/")) return { ok: true, status: 200, json: async () => webhooks };
    return { ok: true, status: 200, json: async () => prompts };
  };

  let captured;
  const res = {
    json: (body) => { captured = body; return res; },
    status: () => res,
  };
  try {
    await handler()({ query }, res);
  } finally {
    globalThis.fetch = original;
  }
  return captured;
}

test("the lookup returns the webhook ids that press 1 needs", async () => {
  const out = await call({});
  assert.equal(out.ok, true);
  assert.equal(out.webhooks.length, 2);
  assert.equal(out.webhooks[0].id, "31");
});

test("q narrows the list by name", async () => {
  // Several hundred prompts live in this account. An unfiltered blob is its own
  // kind of blind.
  const out = await call({ q: "whatsapp" });
  assert.equal(out.webhooks.length, 1);
  assert.equal(out.webhooks[0].webhookName, "WhatsApp Business Loans");
});

test("q matches a prompt by file name", async () => {
  const out = await call({ q: "msmescheme" });
  assert.equal(out.prompts.length, 1);
  assert.equal(out.prompts[0].promptId, "68361");
});

test("an empty q returns everything rather than nothing", async () => {
  const out = await call({ q: "" });
  assert.equal(out.webhooks.length, 2);
  assert.equal(out.prompts.length, 2);
});

test("a wrapped list is unwrapped, not handed back as an object", async () => {
  // The vendor is not consistent about whether a list arrives bare or inside
  // {webhooks:[...]} -- findPromptId already had to learn this the hard way.
  const out = await call({}, { webhooks: { webhooks: WEBHOOKS }, prompts: { prompts: PROMPTS } });
  assert.ok(Array.isArray(out.webhooks), "webhooks should be an array");
  assert.equal(out.webhooks.length, 2);
});

test("a webhook-list outage does not hide the prompts, or vice versa", async () => {
  // Reported side by side deliberately: the webhook list is the part press 1
  // depends on, and a prompt-list failure must not take it down with it.
  const original = globalThis.fetch;
  process.env.OBD_BASE_URL = "https://obd.test";
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/login")) {
      return { ok: true, status: 200, json: async () => ({ token: "t", userid: "501756" }) };
    }
    if (u.includes("/webhooks/")) return { ok: true, status: 200, json: async () => WEBHOOKS };
    return { ok: false, status: 500, text: async () => "prompt list down" };
  };
  let captured;
  const res = { json: (b) => { captured = b; return res; }, status: () => res };
  try {
    await handler()({ query: {} }, res);
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(captured.webhooks.length, 2, "webhooks must survive a prompt-list failure");
  assert.ok(captured.prompts.error, "and the prompt failure must be reported, not swallowed");
});
