// Signed cookie sessions. The cookie holds only an id, the customer id and an expiry, signed with HMAC.
// Logout adds the id to a revocation list (in memory: a restart signs everyone out of nothing worse than a re-login).
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

const sign = (body, secret) => createHmac('sha256', secret).update(body).digest('base64url');

export function createSessions({ secret, hours = 2, secure = true, now = () => Date.now() }) {
  if (!secret) throw new Error('sessions need a secret');
  const revoked = new Set();
  const name = 'zenin_sid';

  function issue(customerId, last4 = '') {
    const payload = { sid: randomBytes(12).toString('base64url'), cid: customerId, m: String(last4).slice(-4), exp: now() + hours * 3600 * 1000 };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const token = `${body}.${sign(body, secret)}`;
    return { token, payload, cookie: cookie(token, hours * 3600) };
  }

  function cookie(value, maxAge) {
    return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  }

  function read(cookieHeader) {
    const token = parseCookies(cookieHeader)[name];
    if (!token) return null;
    const [body, mac] = token.split('.');
    if (!body || !mac) return null;
    const want = sign(body, secret);
    const a = Buffer.from(mac);
    const b = Buffer.from(want);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    let p;
    try { p = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return null; }
    if (!p || typeof p.cid !== 'string' || typeof p.exp !== 'number' || p.exp <= now() || revoked.has(p.sid)) return null;
    return p;
  }

  const revoke = (payload) => { if (payload) revoked.add(payload.sid); };
  const clear = () => cookie('', 0);
  return { issue, read, revoke, clear };
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
