// Builds zenin-prototype.html: the real app (public/js/app.js, i18n.js, css/site.css) plus a browser mock of the API.
// Run: node zenin-web/prototype/build.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WHEEL } from '../../payday-journey/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const pub = join(here, '..', 'public');
const read = (p) => readFileSync(p, 'utf8');
const css = read(join(pub, 'css', 'site.css'));
const i18n = read(join(pub, 'js', 'i18n.js')).replace('export const STRINGS', 'const STRINGS');
const app = read(join(pub, 'js', 'app.js'))
  .replace(/^import .*$/m, '')
  .replace(/if \('serviceWorker' in navigator\).*\n/, '')
  .replace(/window\.addEventListener\('beforeinstallprompt'.*\n/, '');
const mock = read(join(here, 'mock.js')).replace('__WHEEL__', JSON.stringify(WHEEL));
const bar = `
body{padding-top:46px}@media(max-width:600px){#protobar span,#protobar label{font-size:11px}#protobar span{display:none}body{padding-top:40px}}
#protobar{position:fixed;top:0;left:0;right:0;z-index:100;display:flex;gap:10px;align-items:center;flex-wrap:wrap;background:#16241f;color:#fafaf5;padding:6px 12px;font:12px/1.3 'DM Mono',monospace;border-bottom:2px solid #ffd23f}
#protobar b{background:#ffd23f;color:#16241f;padding:2px 6px;border-radius:3px}
#protobar select,#protobar button{font:inherit;padding:3px 6px;border-radius:3px;border:1px solid #fafaf5;background:#0e3b36;color:#fafaf5}
#protobar span{opacity:.75}`;
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Zenin Credit app prototype</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Anton&family=DM+Mono:wght@400;500&family=Hind:wght@400;500;600&display=swap">
<style>${css}${bar}</style></head>
<body class="appbody" data-mode="demo"><div id="root"></div>
<script>${mock}</script>
<script>${i18n}\n${app}</script>
</body></html>`;
writeFileSync(join(here, 'zenin-prototype.html'), html);
console.log(`wrote zenin-prototype.html (${Math.round(html.length / 1024)} KB)`);
