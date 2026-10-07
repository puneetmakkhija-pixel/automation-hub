// Generic, spec-driven HTTP adapter. A vendor is plugged in by filling a spec (see vendors/),
// not by writing code. Credentials always come from env; this file never logs them.
//
// spec = {
//   vendor, slot, configured: true,          // configured:false makes the adapter refuse to run
//   baseUrlEnv: 'ACME_BASE_URL',
//   auth: { type: 'none' }
//       | { type: 'header', name: 'x-api-key', valueEnv: 'ACME_KEY', prefix?: 'Bearer ' }
//       | { type: 'basic', userEnv, passEnv },
//   request: { method: 'POST', path: '/v1/kyc/{{customer.mobile}}', query?: {...}, headers?: {...}, body?: {...} },
//   response: { fields: <extract() spec>, includeRaw?: true },
//   timeoutMs?: 15000,
//   retry?: { count: 2, idempotent: true }   // retried only on network error or 5xx, and only if idempotent
// }
import { render, extract } from './mapping.js';
import { NotConfiguredError, VendorHttpError } from './errors.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function authHeaders(spec, env) {
  const a = spec.auth || { type: 'none' };
  if (a.type === 'none') return {};
  if (a.type === 'header') {
    const v = env[a.valueEnv];
    if (!v) throw new NotConfiguredError(`${spec.vendor} ${spec.slot}`, a.valueEnv);
    return { [a.name]: `${a.prefix || ''}${v}` };
  }
  if (a.type === 'basic') {
    const u = env[a.userEnv];
    const p = env[a.passEnv];
    if (!u) throw new NotConfiguredError(`${spec.vendor} ${spec.slot}`, a.userEnv);
    if (!p) throw new NotConfiguredError(`${spec.vendor} ${spec.slot}`, a.passEnv);
    return { authorization: `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}` };
  }
  throw new NotConfiguredError(`${spec.vendor} ${spec.slot}`, `auth.type "${a.type}"`);
}

export function createHttpAdapter(spec, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  return async function call(input) {
    const label = `${spec?.vendor ?? 'vendor'} ${spec?.slot ?? ''}`.trim();
    if (!spec || spec.configured === false) {
      throw new NotConfiguredError(label, 'the vendor spec (fill it in from the vendor API document and set configured: true)');
    }
    const base = env[spec.baseUrlEnv];
    if (!base) throw new NotConfiguredError(label, spec.baseUrlEnv);

    const req = spec.request || {};
    const method = (req.method || 'POST').toUpperCase();
    const path = render(req.path || '', input);
    const query = req.query ? render(req.query, input) : null;
    const qs = query
      ? `?${new URLSearchParams(Object.entries(query).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => [k, String(v)]))}`
      : '';
    const url = `${String(base).replace(/\/$/, '')}${path}${qs}`;
    const headers = { accept: 'application/json', ...render(req.headers || {}, input), ...authHeaders(spec, env) };
    let body;
    if (method !== 'GET' && method !== 'HEAD') {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(render(req.body || {}, input));
    }

    const attempts = 1 + (spec.retry?.idempotent || method === 'GET' ? (spec.retry?.count ?? 0) : 0);
    let lastErr;
    for (let i = 0; i < attempts; i += 1) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), spec.timeoutMs ?? 15000);
      try {
        const res = await fetchImpl(url, { method, headers, body, signal: ctl.signal });
        if (res.status >= 500 && i < attempts - 1) { lastErr = new VendorHttpError(spec.vendor, spec.slot, `HTTP ${res.status}`, res.status); await sleep(200 * (i + 1)); continue; }
        if (!res.ok) throw new VendorHttpError(spec.vendor, spec.slot, `HTTP ${res.status}`, res.status);
        let json;
        try { json = await res.json(); } catch { throw new VendorHttpError(spec.vendor, spec.slot, 'response was not valid JSON', res.status); }
        const out = extract(spec.response?.fields ?? {}, json);
        if (spec.response?.includeRaw !== false) out.raw = json;
        return out;
      } catch (e) {
        if (e instanceof VendorHttpError || e instanceof NotConfiguredError) throw e;
        lastErr = new VendorHttpError(spec.vendor, spec.slot, e.name === 'AbortError' ? 'timed out' : 'network error');
        if (i < attempts - 1) await sleep(200 * (i + 1));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr;
  };
}

const METHOD = { kyc: 'verify', bureau: 'pull', bankStatement: 'analyse', esign: 'createRequest', payout: 'disburse', collect: 'request' };

// -> { name, [method]: fn } for the registry
export function buildAdapter(vendor, slot, spec, deps) {
  return { name: vendor, [METHOD[slot]]: createHttpAdapter({ ...spec, vendor, slot }, deps) };
}
