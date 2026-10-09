// Dates are 'YYYY-MM-DD' strings in India time (IST). Money is rupees, rounded to paise.

export const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

export const istToday = (now = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(now);

// A bare 'YYYY-MM-DD' is already a date. Anything with a time (e.g. a UTC timestamp) is converted to
// its India-time calendar date, so 2026-02-10T20:00:00Z is 2026-02-11 in IST.
export const toDate = (d) => (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : istToday(new Date(d)));

const ms = (d) => Date.parse(`${toDate(d)}T00:00:00Z`);

export function addDays(date, n) {
  const d = new Date(ms(date));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Whole days from `from` to `to` (negative if `to` is earlier).
export const daysBetween = (from, to) => Math.round((ms(to) - ms(from)) / 86400000);

// First date on or after (asOf + minDays) whose day-of-month is `salaryDay`
// (clamped to the month's last day, so day 31 works in February).
export function nextSalaryDate(asOf, salaryDay, minDays = 0) {
  const start = addDays(asOf, minDays);
  const [y0, m0] = start.split('-').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const y = y0 + Math.floor((m0 - 1 + i) / 12);
    const m = ((m0 - 1 + i) % 12) + 1;
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const cand = `${y}-${String(m).padStart(2, '0')}-${String(Math.min(salaryDay, last)).padStart(2, '0')}`;
    if (cand >= start) return cand;
  }
  throw new Error('nextSalaryDate: no date found');
}

// Split an amount across lender shares [{lender_id, share_pct}]; the last lender takes the rounding
// remainder so the parts always add back to the exact amount.
export function splitAmount(amount, shares) {
  let used = 0;
  return shares.map((s, i) => {
    const part = i === shares.length - 1 ? round2(amount - used) : round2((amount * s.share_pct) / 100);
    used = round2(used + part);
    return { lender_id: s.lender_id, amount: part };
  });
}
