/**
 * The OBD router is locked, and locked by default.
 *
 *   node test-obd-guard.mjs
 *
 * No framework, same as test-press-forward.mjs: plain node, plain asserts,
 * self-contained, no credentials and no network.
 *
 * What this holds, in one sentence: nothing reaches the dialler without the
 * console secret. /api/obd can create campaigns, upload lead bases, repoint the
 * panel's webhooks and STOP a campaign mid-flight, and it was open to anyone who
 * knew the URL.
 *
 * The property that matters most is the last one. Every other guard in index.js
 * passes onlyPaths — a list of paths to lock — so a route added later inherits
 * no protection. That is how this hole stayed open through the pass that closed
 * the others. This router is mounted with NO onlyPaths, so a new route is locked
 * the moment it exists, and the check below is written against a path that does
 * not exist in obdRoutes.js at all.
 *
 * Each check was confirmed to fail with the guard removed.
 */
import express from "express";
import http from "node:http";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { verifyWebhookSecret } from "./lib/middleware/verifyWebhookSecret.js";

const SECRET = "test-console-secret";

/** The exact wiring index.js uses for /api/obd, with a stub for the real router. */
function appWithGuard() {
  const app = express();
  const reached = [];
  // Stands in for every route on obdRoutes.js, including ones not written yet.
  // A bare middleware rather than a path pattern, so this matches on both
  // Express 4 and 5 — the wildcard syntax differs between them and the subject
  // here is the guard, not routing.
  const stub = (req, res) => {
    reached.push(req.path);
    res.json({ ok: true });
  };
  app.use(
    "/api/obd",
    verifyWebhookSecret("CONSOLE_SECRET", "CONSOLE_OBD", { failClosed: true }),
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

console.log("\nOBD router guard\n");

await check("stopping a live campaign needs the secret", async () => {
  const { app, reached } = appWithGuard();
  const res = await request(app, "/api/obd/campaigns/abc123/stop");
  assert.equal(res.status, 401);
  // The point is not the status code. It is that the dialler was never called.
  assert.deepEqual(reached, [], "request reached the OBD router without a secret");
});

await check("a wrong secret is refused", async () => {
  const { app, reached } = appWithGuard();
  const res = await request(app, "/api/obd/webhooks", { "x-webhook-secret": "nope" });
  assert.equal(res.status, 401);
  assert.deepEqual(reached, []);
});

await check("the console's own secret gets through", async () => {
  const { app, reached } = appWithGuard();
  const res = await request(app, "/api/obd/webhooks", { "x-webhook-secret": SECRET });
  assert.equal(res.status, 200);
  assert.deepEqual(reached, ["/webhooks"]);
});

await check("an unset CONSOLE_SECRET refuses rather than opens", async () => {
  delete process.env.CONSOLE_SECRET;
  const { app, reached } = appWithGuard();
  const res = await request(app, "/api/obd/bases/upload");
  assert.equal(res.status, 503, "failClosed must refuse, not fall open");
  assert.deepEqual(reached, []);
});

await check("a route that does not exist yet is locked too", async () => {
  // No onlyPaths, so protection is not a list anyone has to remember to update.
  const { app, reached } = appWithGuard();
  const res = await request(app, "/api/obd/some-future-route");
  assert.equal(res.status, 401);
  assert.deepEqual(reached, []);
});

console.log("\nindex.js wiring\n");

await check("index.js mounts /api/obd behind consoleAuth", () => {
  const src = readFileSync(new URL("./index.js", import.meta.url), "utf8");
  const mount = src.match(/app\.use\(\s*"\/api\/obd"[^\n]*\n?/);
  assert.ok(mount, "no /api/obd mount found");
  assert.match(
    mount[0],
    /consoleAuth\(/,
    "/api/obd is mounted without consoleAuth — this is the original bug"
  );
});

await check('/api/obd is mounted before the broader "/api" prefix', () => {
  // whatsappBotRoutes is mounted on "/api". Express matches in registration
  // order, so moving the OBD mount below it would let that router see
  // /api/obd/* first — and the guard would sit behind it.
  const src = readFileSync(new URL("./index.js", import.meta.url), "utf8");
  const obd = src.indexOf('app.use("/api/obd"');
  const api = src.indexOf('app.use("/api", whatsappBotRoutes)');
  assert.ok(obd > -1 && api > -1, "expected both mounts to be present");
  assert.ok(obd < api, "/api/obd must be registered before the /api catch-all");
});

console.log(failed ? `\n${failed} failed\n` : "\nall passed\n");
process.exit(failed ? 1 : 0);
