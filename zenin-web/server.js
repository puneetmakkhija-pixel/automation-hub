// Entry point: loads configuration, refuses to start in live mode until everything real customers need is in place,
// and serves the site over node:http.
import { createServer } from 'node:http';
import { loadConfig, liveProblems } from './config.js';
import { createGateway } from './demo.js';
import { createOtp } from './otp.js';
import { createWebApp } from './app.js';

const MAX_BODY = 20_000;

export function makeHttpServer(web) {
  return createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { tooBig = true; return; } // keep draining so the connection stays usable
      chunks.push(c);
    });
    req.on('end', async () => {
      const send = (r) => { res.writeHead(r.status, r.headers); res.end(req.method === 'HEAD' ? undefined : r.body); };
      if (tooBig) return send({ status: 413, headers: { 'content-type': 'application/json' }, body: '{"error":"too_large"}' });
      try {
        send(await web.handle({
          method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers,
          rawBody: Buffer.concat(chunks).toString('utf8'),
        }));
      } catch (e) {
        console.error(`zenin-web error: ${e.message}`);
        send({ status: 500, headers: { 'content-type': 'application/json' }, body: '{"error":"server_error"}' });
      }
    });
  });
}

export async function main(env = process.env) {
  const cfg = loadConfig(env);
  let gateway;
  let otp;
  if (cfg.mode === 'live') {
    // Fail closed: list everything missing, build nothing.
    let gatewayReady = true; let otpReady = true;
    try { gateway = createGateway({ cfg }); } catch { gatewayReady = false; }
    try { otp = createOtp({ cfg }); } catch { otpReady = false; }
    const problems = liveProblems(cfg, { gatewayReady, otpReady });
    if (problems.length) {
      console.error(`zenin-web: live mode is not ready:\n - ${problems.join('\n - ')}`);
      process.exit(1);
    }
  } else {
    gateway = createGateway({ cfg });
    otp = createOtp({ cfg });
  }
  const web = createWebApp({ cfg, gateway, otp, log: (l) => console.log(l) });
  makeHttpServer(web).listen(cfg.port, () => console.log(`zenin-web (${cfg.mode}) listening on ${cfg.port}`));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main();
