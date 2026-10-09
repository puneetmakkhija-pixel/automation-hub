// One-time passcodes behind one interface: send({mobile}) and verify({mobile, code}) -> 'ok' | 'bad' | 'expired' | 'locked'.
// Demo accepts one fixed code and sends nothing. A live provider (an SMS vendor) is not built: createOtp refuses in live.
import { createHash, timingSafeEqual } from 'node:crypto';

export const DEMO_OTP = '123456';
const MAX_ATTEMPTS = 5;
const TTL_MS = 5 * 60 * 1000;

const h = (s) => createHash('sha256').update(s).digest();

export function createDemoOtp({ now = () => Date.now() } = {}) {
  const pending = new Map();
  return {
    name: 'demo',
    async send({ mobile }) {
      pending.set(mobile, { exp: now() + TTL_MS, attempts: 0 });
      return { sent: true };
    },
    async verify({ mobile, code }) {
      const e = pending.get(mobile);
      if (!e) return 'expired';
      if (e.exp <= now()) { pending.delete(mobile); return 'expired'; }
      if (e.attempts >= MAX_ATTEMPTS) return 'locked';
      e.attempts += 1;
      const ok = timingSafeEqual(h(String(code)), h(DEMO_OTP));
      if (ok) { pending.delete(mobile); return 'ok'; }
      return e.attempts >= MAX_ATTEMPTS ? 'locked' : 'bad';
    },
  };
}

export function createOtp({ cfg, now }) {
  if (cfg.mode === 'demo') return createDemoOtp({ now });
  throw new Error('no SMS OTP provider is configured for live mode');
}
