// Fixed-window rate limiter in memory. Fine for one instance; behind several instances use a shared store.
export function createLimiter({ windowMs, max, now = () => Date.now() }) {
  const hits = new Map();
  return {
    hit(key) {
      const t = now();
      const e = hits.get(key);
      if (!e || e.reset <= t) {
        hits.set(key, { count: 1, reset: t + windowMs });
        if (hits.size > 5000) for (const [k, v] of hits) if (v.reset <= t) hits.delete(k);
        return { ok: true, retryAfter: 0 };
      }
      e.count += 1;
      return e.count <= max ? { ok: true, retryAfter: 0 } : { ok: false, retryAfter: Math.ceil((e.reset - t) / 1000) };
    },
  };
}
