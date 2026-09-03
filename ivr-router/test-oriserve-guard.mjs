/**
 * The Oriserve router is locked, and locked by default.
 *
 *   node test-oriserve-guard.mjs
 *
 * No framework, same as test-obd-guard.mjs: plain node, plain asserts,
 * self-contained, no credentials and no network.
 *
 * What this holds, in one sentence: nothing places an outbound voice call
 * without the console secret. /api/oriserve/campaigns/trigger rings one real
 * person on our Oriserve key, /campaigns/bulk-trigger rings a list of them, and
 * /campaigns/:id/cancel stops a campaign mid-flight. It was mounted open — the
 * same exposure /api/obd had one router over, missed by the same pass.
 *
 * As with OBD, the mount passes NO onlyPaths, so a route added later is locked
 * the moment it exists. The check below is written against a path that does not
 * exist in oriserveRoutes.js at all.
 *
 * Each check was confirmed to fail with the guard removed.
 */
import express from "express";
import http from "node:http";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { verifyWebhookSecret } from "./lib/middleware/verifyWebhookSecret.js";

const SECRET = "test-console-secret";

/** The exact wiring index.js uses for /api/oriserve, with a stub for the router. */
function appWithGuard() {
  const app = express();
  const reached = [];
  // Stands in for every route on oriserveRoutes.js, including ones not written
  // yet. A bare middleware rather than a path pattern, so this matches on both
  // Express 4 and 5 — the wildcard syntax differs and the subject is the guard.
  const stub = (req, res) => {
    reached.push(req.path);
    res.json({ ok: true });
  };
  app.use(
    "/api/oriserve",
    verifyWebhookSecret("CONSOLE_SECRET", "CONSOLE_ORISERVE", { failClosed: true }),
    stub
  );
  return { app, reached };
}

const request = async (app, path, headers = {}) => {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
    return { status: res.status };
  } finally {
    server.close();
  }
};

let failed = 0;
const check = async (name, fn) => {
  process.env.CONSOLE_SECRET = SECRET;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
};

console.log("\nOriserve router guard\n");

await check("placing a voice call needs the secret", async () => {
  const { app, reached } = appWithGuard();
  const res = await request(app, "/api/oriserve/campaigns/trigger");
  assert.equal(res.status, 401);
  // The point is not the status code. It is that nobody's phone rang.
  assert.deepEqual(reached, [], "request reached Oriserve without a secret");
});

await check("bulk-triggering a whole list needs the secret", async () => {
  const { app, reached } = appWithGuard();
  const res = await request(app, "/api/oriserve/campaigns/bulk-trigger");
  assert.equal(res.status, 401);
  assert.deepEqual(reached, []);
});

await check("cancelling a live campaign needs the secret", async () => {
  const { app, reached } = appWithGuard();
  const res = await request(app, "/api/oriserve/campaigns/abc123/cancel");
  assert.equal(res.status, 401);
  assert.deepEqual(reached, []);
});

await check("a wrong secret is refused", async () => {
  const { app, reached } = appWithGuard();
  const res = await request(app, "/api/oriserve/campaigns", {
    "x-webhook-secret": "nope",
  });
  assert.equal(res.status, 401);
  assert.deepEqual(reached, []);
});

await check("the console's own secret gets through", async () => {
  const { app, reached } = appWithGuard();
  const res = await request(app, "/api/oriserve/campaigns", {
    "x-webhook-secret": SECRET,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(reached, ["/campaigns"]);
});

await check("an unset CONSOLE_SECRET refuses rather than opens", async () => {
  delete process.env.CONSOLE_SECRET;
  const { app, reached } = appWithGuard();
  const res = await request(app, "/api/oriserve/campaigns/trigger");
  assert.equal(res.status, 503, "failClosed must refuse, not fall open");
  assert.deepEqual(reached, []);
});

await check("a route that does not exist yet is locked too", async () => {
  // No onlyPaths, so protection is not a list anyone has to remember to update.
  const { app, reached } = appWithGuard();
  const res = await request(app, "/api/oriserve/some-future-route");
  assert.equal(res.status, 401);
  assert.deepEqual(reached, []);
});

console.log("\nindex.js wiring\n");

await check("index.js mounts /api/oriserve behind consoleAuth", () => {
  const src = readFileSync(new URL("./index.js", import.meta.url), "utf8");
  const mount = src.match(/app\.use\(\s*"\/api\/oriserve"[^\n]*\n?/);
  assert.ok(mount, "no /api/oriserve mount found");
  assert.match(
    mount[0],
    /consoleAuth\(/,
    "/api/oriserve is mounted without consoleAuth — this is the original bug"
  );
});

await check("the mount passes no onlyPaths", () => {
  // An onlyPaths list would leave /campaigns/trigger locked but the next route
  // added open, which is exactly how this hole survived the last pass.
  const src = readFileSync(new URL("./index.js", import.meta.url), "utf8");
  const mount = src.match(/app\.use\(\s*"\/api\/oriserve"[^\n]*\n?/);
  assert.doesNotMatch(
    mount[0],
    /consoleAuth\([^)]*,\s*\[/,
    "/api/oriserve must lock the whole router, not a list of paths"
  );
});

await check('/api/oriserve is mounted before the broader "/api" prefix', () => {
  // whatsappBotRoutes is mounted on "/api". Express matches in registration
  // order, so moving this mount below it would let that router see
  // /api/oriserve/* first — and the guard would sit behind it.
  const src = readFileSync(new URL("./index.js", import.meta.url), "utf8");
  const ori = src.indexOf('app.use("/api/oriserve"');
  const api = src.indexOf('app.use("/api", whatsappBotRoutes)');
  assert.ok(ori > -1 && api > -1, "expected both mounts to be present");
  assert.ok(ori < api, "/api/oriserve must be registered before the /api catch-all");
});

await check("the top-level Oriserve callback stays open to Oriserve", () => {
  // The guard must not reach the webhook Oriserve actually posts to. That one
  // is in index.js on its own ORISERVE_WEBHOOK_SECRET; locking it behind
  // CONSOLE_SECRET would silently drop every call outcome.
  const src = readFileSync(new URL("./index.js", import.meta.url), "utf8");
  const hook = src.match(/app\.post\("\/webhooks\/oriserve"[^\n]*\n?/);
  assert.ok(hook, "no top-level /webhooks/oriserve handler found");
  assert.match(hook[0], /ORISERVE_WEBHOOK_SECRET/);
  assert.doesNotMatch(hook[0], /CONSOLE_SECRET|consoleAuth/);
});

console.log(failed ? `\n${failed} failed\n` : "\nall passed\n");
process.exit(failed ? 1 : 0);
