// node:http wrapper around app.js. Start: `node payday-api/server.js`.
// Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PAYDAY_API_KEY.
// Optional: PORT (default 3000), PAN_PEPPER, VENDOR_* and each vendor's own variables.
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { createApp } from './app.js';
import { createRegistry, supabaseStore } from '../payday-journey/index.js';

const MAX_BODY = 1_000_000; // 1 MB

export function makeHttpServer(app) {
  return http.createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      let size = 0;
      let tooBig = false;
      const chunks = [];
      for await (const c of req) {
        size += c.length;
        if (size > MAX_BODY) {
          // Stop buffering but keep draining, so the client receives the 413 instead of a reset.
          // A stream far beyond the limit is cut off.
          tooBig = true;
          chunks.length = 0;
          if (size > MAX_BODY * 8) { req.destroy(); return; }
          continue;
        }
        if (!tooBig) chunks.push(c);
      }
      if (tooBig) return send(413, { error: 'body too large' });
      const url = new URL(req.url, 'http://x');
      const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v]));
      const r = await app.handle({
        method: req.method, path: url.pathname, headers, rawBody: Buffer.concat(chunks).toString('utf8'),
        query: Object.fromEntries(url.searchParams),
      });
      send(r.status, r.body);
    } catch (e) {
      console.error(`payday-api server error: ${e.message}`);
      send(500, { error: 'internal error' });
    }
  });
}

async function main(env = process.env) {
  const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'PAYDAY_API_KEY'].filter((k) => !env[k]);
  if (missing.length) {
    console.error(`payday-api: missing env ${missing.join(', ')}`);
    process.exit(1);
  }
  const { createClient } = await import('@supabase/supabase-js'); // loaded here so tests never need it
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  // Throws in production if any vendor slot is still "mock" (see registry.js).
  const registry = createRegistry({ env });
  const app = createApp({ store: supabaseStore(client), registry, env, log: (l) => console.log(l) });
  const port = Number(env.PORT) || 3000;
  makeHttpServer(app).listen(port, () => console.log(`payday-api listening on ${port}; vendors: ${JSON.stringify(registry.names)}`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
