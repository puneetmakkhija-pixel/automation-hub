/**
 * Secret rotation: the current and the NEXT secret both open the door.
 *
 *   node test-webhook-secret-overlap.mjs
 *
 * Plain node, no framework, no network beyond loopback. Each check was confirmed
 * to fail with the NEXT handling removed.
 */
import express from "express";
import http from "node:http";
import assert from "node:assert/strict";
import { verifyWebhookSecret } from "./lib/middleware/verifyWebhookSecret.js";

const VAR = "TEST_ROTATION_SECRET";

function hit(headers = {}, query = "") {
  const app = express();
  app.use(verifyWebhookSecret(VAR, "ROTATION_TEST"), (req, res) => res.json({ ok: true }));
  const server = http.createServer(app);
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", async () => {
      const { port } = server.address();
      try {
        const r = await fetch(`http://127.0.0.1:${port}/x${query}`, { headers });
        resolve(r.status);
      } finally {
        server.close();
      }
    })
  );
}

const reset = () => { delete process.env[VAR]; delete process.env[`${VAR}_NEXT`]; };
let passed = 0;
const check = async (name, fn) => { reset(); await fn(); passed++; console.log(`  ok   ${name}`); };

await check("only the current secret set: it works, a wrong one is refused", async () => {
  process.env[VAR] = "old-secret";
  assert.equal(await hit({ "x-webhook-secret": "old-secret" }), 200);
  assert.equal(await hit({ "x-webhook-secret": "new-secret" }), 401);
});

await check("during rotation the old secret still works", async () => {
  process.env[VAR] = "old-secret";
  process.env[`${VAR}_NEXT`] = "new-secret";
  assert.equal(await hit({ "x-webhook-secret": "old-secret" }), 200);
});

await check("during rotation the new secret works too, in all three forms", async () => {
  process.env[VAR] = "old-secret";
  process.env[`${VAR}_NEXT`] = "new-secret";
  assert.equal(await hit({ "x-webhook-secret": "new-secret" }), 200);
  assert.equal(await hit({ authorization: "Bearer new-secret" }), 200);
  assert.equal(await hit({}, "?token=new-secret"), 200);
});

await check("during rotation a wrong or missing secret is still refused", async () => {
  process.env[VAR] = "old-secret";
  process.env[`${VAR}_NEXT`] = "new-secret";
  assert.equal(await hit({ "x-webhook-secret": "guess" }), 401);
  assert.equal(await hit({}), 401);
});

await check("after promotion (NEXT removed) the retired secret stops working", async () => {
  process.env[VAR] = "new-secret";
  assert.equal(await hit({ "x-webhook-secret": "new-secret" }), 200);
  assert.equal(await hit({ "x-webhook-secret": "old-secret" }), 401);
});

await check("an empty NEXT does not open the door to an empty secret", async () => {
  process.env[VAR] = "old-secret";
  process.env[`${VAR}_NEXT`] = "";
  assert.equal(await hit({ "x-webhook-secret": "" }), 401);
  assert.equal(await hit({}), 401);
});

await check("NEXT alone (main unset) still enforces", async () => {
  process.env[`${VAR}_NEXT`] = "new-secret";
  assert.equal(await hit({ "x-webhook-secret": "new-secret" }), 200);
  assert.equal(await hit({ "x-webhook-secret": "other" }), 401);
});

await check("nothing set: fails open as before", async () => {
  assert.equal(await hit({}), 200);
});

console.log(`\n${passed} checks passed`);
