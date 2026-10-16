// Builds docs/partner-api.html from the OpenAPI spec: one file, no server, no outside scripts.
// Run: node payday-api/docs/build-docs.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openApiSpec } from '../openapi.js';

const here = dirname(fileURLToPath(import.meta.url));
const spec = openApiSpec({ sandbox: true });
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const md = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\n\n/g, '<br><br>');
const pre = (o) => `<pre>${esc(JSON.stringify(o, null, 2))}</pre>`;

const ops = Object.entries(spec.paths).flatMap(([path, m]) => Object.entries(m).map(([method, op]) => ({ path, method: method.toUpperCase(), ...op })));
const byTag = spec.tags.map((t) => ({ name: t.name, ops: ops.filter((o) => o.tags[0] === t.name) }));
const opHtml = (o) => {
  const req = o.requestBody?.content['application/json'].example;
  const res = o.responses[200].content['application/json'].example;
  const params = (o.parameters || []).map((p) => `<code>${esc(p.name)}</code> (${p.in})`).join(', ');
  return `<details id="${esc(o.method + o.path)}"><summary><span class="m ${o.method}">${o.method}</span> <code>${esc(o.path)}</code> <span class="s">${esc(o.summary)}</span></summary>
    <div class="body"><p>${md(o.description)}</p>${params ? `<p><b>Parameters:</b> ${params}</p>` : ''}
    ${req ? `<h4>Request</h4>${pre(req)}` : ''}<h4>Response 200</h4>${pre(res)}</div></details>`;
};
const hooks = Object.entries(spec.webhooks).map(([type, h]) => `<details><summary><code>${esc(type)}</code> <span class="s">${esc(h.post.description.split('\n')[0])}</span></summary><div class="body"><p>${md(h.post.description)}</p>${pre(h.post.requestBody.content['application/json'].example)}</div></details>`).join('');

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>PaydayOS partner API</title>
<style>
:root{--bg:#f5f6f4;--surface:#fff;--fg:#1b2024;--muted:#5d666d;--line:#d9ddd9;--accent:#1f4e79;--soft:#e3ecf4}
@media (prefers-color-scheme:dark){:root{--bg:#13181c;--surface:#1b2126;--fg:#e6eaec;--muted:#9aa4ab;--line:#2f373d;--accent:#8db8e0;--soft:#1e2d3a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,sans-serif;padding:24px 16px 60px}
.wrap{max-width:900px;margin:0 auto}h1{font-size:30px;margin:0 0 6px}h2{margin:28px 0 8px;font-size:20px;border-bottom:1px solid var(--line);padding-bottom:6px}
.lead{color:var(--muted)}details{background:var(--surface);border:1px solid var(--line);border-radius:8px;margin:8px 0}
summary{padding:10px 14px;cursor:pointer;display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}.body{padding:0 16px 14px}
.m{font:600 11px ui-monospace,monospace;padding:3px 7px;border-radius:4px;background:var(--soft);color:var(--accent)}.m.POST{background:#dff0e6;color:#1d6b43}
.s{color:var(--muted)}code{font:13px ui-monospace,monospace;background:var(--soft);padding:1px 5px;border-radius:3px;overflow-wrap:anywhere}
pre{background:var(--soft);padding:10px 12px;border-radius:6px;overflow-x:auto;font:12.5px/1.5 ui-monospace,monospace;margin:6px 0}
h4{margin:12px 0 2px;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
</style></head><body><div class="wrap">
<h1>${esc(spec.info.title)}</h1>
<p class="lead">${md(spec.info.description)}</p>
<p>Send your key as <code>x-api-key</code>. The same document is served at <code>GET /openapi.json</code>. The step-by-step guide is <code>docs/PARTNER_GUIDE.md</code>.</p>
${byTag.map((t) => `<h2>${esc(t.name)}</h2>${t.ops.map(opHtml).join('')}`).join('')}
<h2>Events we send you</h2><p class="lead">Each is a signed <code>POST</code> to your callback URL. Answer any 2xx once saved. Events can arrive twice or out of order: use <code>event_id</code>, and call the read endpoints for the truth.</p>${hooks}
</div></body></html>`;
writeFileSync(join(here, 'partner-api.html'), html);
console.log(`wrote partner-api.html (${Math.round(html.length / 1024)} KB)`);
