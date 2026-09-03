/**
 * Editing one field of a webhook must not quietly erase the others.
 *
 *   node test-edit-webhook.mjs
 *
 * No framework, same as test-press-forward.mjs: plain node, plain asserts, and
 * a fake provider stood up on a loopback port, so this needs no credentials and
 * no network.
 *
 * What it holds, in one sentence: headerJson and bodyJson survive an edit that
 * did not mention them. bodyJson names the fields the panel posts to us — mobile,
 * dtmf, unique_id — and headerJson carries the secret /webhooks/ivr checks, so
 * losing either turns a live campaign into 401s or into presses with no mobile,
 * with nothing to say why.
 *
 * Every check was confirmed to fail against the old positional editWebhook.
 */
import http from "node:http";
import assert from "node:assert/strict";
import OBDApiClient from "./lib/obdApiClient.js";

const HERO = {
  id: 551,
  webhookName: "Hero Fincorp - WhatsApp DTMF Key1",
  url: "https://example.test/webhooks/ivr/whatsapp/herofincorp?token=s3cret",
  event: "DTMF",
  userId: 501756,
  status: 0,
  bodyJson: '{"mobile":"{mobile}","dtmf":"{dtmf}","unique_id":"{unique_id}"}',
  headerJson: '{"Content-Type":"application/json"}',
};

/** A stand-in for obdapi2.ivrsms.com. `onEdit` decides how it behaves. */
async function provider(onEdit) {
  const state = { hooks: [{ ...HERO }], edits: [] };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/obd/login") {
        return res.end(JSON.stringify({ token: "t", userid: 501756 }));
      }
      if (req.url.startsWith("/api/obd/webhooks/edit")) {
        state.edits.push(body);
        state.hooks = state.hooks.map((h) =>
          String(h.id) === String(body.id) ? onEdit(h, body) : h
        );
        return res.end(JSON.stringify({ success: true }));
      }
      if (req.url.startsWith("/api/obd/webhooks/")) {
        return res.end(JSON.stringify(state.hooks));
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const client = new OBDApiClient(`http://127.0.0.1:${server.address().port}`, "u", "p");
  return { state, client, close: () => server.close() };
}

/** A provider that stores exactly what it was sent — the honest case. */
const replaces = (_h, body) => ({ ...body });
/** A provider that keeps only what it was sent — the clobbering case. */
const clobbers = (_h, body) => ({ ...body, headerJson: "", bodyJson: "" });

let failed = 0;
const check = async (name, fn) => {
  const p = await provider(replaces);
  try { await fn(p); console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
  finally { p.close(); }
};

console.log("\neditWebhook\n");

await check("changing the URL leaves headerJson and bodyJson intact", async ({ client, state }) => {
  await client.editWebhook(551, { url: "https://example.test/webhooks/ivr/whatsapp/herofincorp" });
  const sent = state.edits[0];
  assert.equal(sent.headerJson, HERO.headerJson, "headerJson was not carried through");
  assert.equal(sent.bodyJson, HERO.bodyJson, "bodyJson was not carried through");
  assert.equal(sent.url, "https://example.test/webhooks/ivr/whatsapp/herofincorp");
  assert.equal(sent.event, "DTMF", "event should be untouched");
  assert.equal(sent.webhookName, HERO.webhookName, "name should be untouched");
});

await check("a header can be set without touching anything else", async ({ client, state }) => {
  const headerJson = '{"Content-Type":"application/json","X-Webhook-Secret":"abc"}';
  await client.editWebhook(551, { headerJson });
  const sent = state.edits[0];
  assert.equal(sent.headerJson, headerJson);
  assert.equal(sent.url, HERO.url, "url should be untouched");
  assert.equal(sent.bodyJson, HERO.bodyJson);
});

await check("an unknown id is refused rather than blind-written", async ({ client, state }) => {
  await assert.rejects(
    () => client.editWebhook(999, { url: "https://example.test/x" }),
    /no such webhook/
  );
  assert.deepEqual(state.edits, [], "nothing should have been sent");
});

await check("an edit that changes nothing is refused", async ({ client, state }) => {
  await assert.rejects(() => client.editWebhook(551, {}), /nothing to change/);
  await assert.rejects(
    () => client.editWebhook(551, { url: undefined, event: undefined }),
    /nothing to change/
  );
  assert.deepEqual(state.edits, []);
});

await check("the old positional call still works", async ({ client, state }) => {
  await client.editWebhook(551, "Renamed", "https://example.test/y", "DTMF");
  const sent = state.edits[0];
  assert.equal(sent.webhookName, "Renamed");
  assert.equal(sent.url, "https://example.test/y");
  assert.equal(sent.bodyJson, HERO.bodyJson, "positional form must preserve too");
});

// This one needs the clobbering provider, so it stands its own up.
{
  const p = await provider(clobbers);
  try {
    await assert.rejects(
      () => p.client.editWebhook(551, { url: "https://example.test/z" }),
      (e) =>
        /DROPPED headerJson/.test(e.message) &&
        // The old value has to come back with the error, or there is no way to
        // put it right.
        e.message.includes(HERO.headerJson)
    );
    console.log("  ok   a provider that drops headerJson raises, with the old value");
  } catch (e) {
    failed++;
    console.log(`  FAIL a provider that drops headerJson raises, with the old value\n       ${e.message}`);
  } finally { p.close(); }
}

console.log(failed ? `\n${failed} failed\n` : "\nall passed\n");
process.exit(failed ? 1 : 0);
