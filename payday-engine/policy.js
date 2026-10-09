// A credit policy is plain JSON: parameters and weights, grade bands, decisions per grade, offer caps and the
// review-flag thresholds. It can be stored in the database as a numbered version and edited by the credit team
// without a developer. Every change is a NEW version; an activated version is never edited.
//
// What a policy can NOT change (enforced by validatePolicy, so a bad edit cannot weaken a safety rule):
//   - the hard declines (NPA, wilful defaulter, KYC failed, fraud flag) always apply and always force grade E
//   - grade E must decide "reject"
//   - a parameter may only read a feature the system actually produces
import {
  PARAMS, MODEL_VERSION, MISSING_SCORE_10, MAX_MISSING_FOR_AUTO, BANDS, DECISION_BY_GRADE, MAX_PCT_OF_SALARY, AMOUNT_STEP,
} from './config.js';

const GRADES = ['A', 'B', 'C', 'D', 'E'];
const DECISIONS = ['approve', 'refer', 'reject'];
export const ALLOWED_FIELDS = [...new Set(PARAMS.map((p) => p.field))];

// Review flags: each has an on/off switch and one threshold.
export const REVIEW_FLAG_SPECS = {
  RF3: { key: 'months', min: 0, max: 120, label: 'Write-off within N months' },
  RF4: { key: 'dpd', min: 0, max: 365, label: 'Max DPD above N days' },
  RF7: { key: 'pct', min: 0, max: 100, label: 'Salary mismatch above N %' },
  RF8: { key: 'pct', min: 0, max: 100, label: 'FOIR above N %' },
  RF9: { key: 'count', min: 0, max: 50, label: 'Bank bounces in 6 months above N' },
  RF11: { key: 'count', min: 0, max: 50, label: 'Hard enquiries in 90 days above N' },
  RF12: { key: null, label: 'Loan purpose vague or personal use' },
};
const DEFAULT_REVIEW = {
  RF3: { enabled: true, months: 36 },
  RF4: { enabled: true, dpd: 30 },
  RF7: { enabled: true, pct: 30 },
  RF8: { enabled: true, pct: 55 },
  RF9: { enabled: true, count: 2 },
  RF11: { enabled: true, count: 6 },
  RF12: { enabled: true },
};

const clone = (o) => JSON.parse(JSON.stringify(o));

// JSON cannot hold -Infinity, so the lowest band stores min: null ("no lower bound").
export const DEFAULT_POLICY = Object.freeze({
  version: MODEL_VERSION,
  params: clone(PARAMS),
  missingScore10: MISSING_SCORE_10,
  maxMissingForAuto: MAX_MISSING_FOR_AUTO,
  bands: BANDS.map((b) => ({ grade: b.grade, min: Number.isFinite(b.min) ? b.min : null })),
  decisionByGrade: { ...DECISION_BY_GRADE },
  maxPctOfSalary: { ...MAX_PCT_OF_SALARY },
  amountStep: AMOUNT_STEP,
  flags: { review: clone(DEFAULT_REVIEW) },
});

const TOP_KEYS = ['version', 'params', 'missingScore10', 'maxMissingForAuto', 'bands', 'decisionByGrade', 'maxPctOfSalary', 'amountStep', 'flags'];
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export class PolicyError extends Error {
  constructor(errors) {
    super(`invalid credit policy: ${errors.join('; ')}`);
    this.name = 'PolicyError';
    this.errors = errors;
  }
}

export function validatePolicy(p) {
  const e = [];
  if (!isObj(p)) return { ok: false, errors: ['policy must be an object'] };
  for (const k of Object.keys(p)) if (!TOP_KEYS.includes(k)) e.push(`unknown key "${k}"`);

  if (typeof p.version !== 'string' || !/^[A-Za-z0-9_.-]{1,40}$/.test(p.version)) e.push('version must be 1-40 letters, digits, _ . -');

  // parameters
  let maxPoints = 0;
  if (!Array.isArray(p.params) || p.params.length < 1 || p.params.length > 60) e.push('params must be a list of 1 to 60 parameters');
  else {
    const codes = new Set();
    p.params.forEach((q, i) => {
      const at = `params[${i}]`;
      if (!isObj(q)) { e.push(`${at} must be an object`); return; }
      if (typeof q.code !== 'string' || !q.code) e.push(`${at}.code is required`);
      else if (codes.has(q.code)) e.push(`${at}.code "${q.code}" is duplicated`);
      else codes.add(q.code);
      if (typeof q.name !== 'string' || !q.name) e.push(`${at}.name is required`);
      if (typeof q.group !== 'string' || !q.group) e.push(`${at}.group is required`);
      if (!isNum(q.weight) || q.weight <= 0 || q.weight > 50) e.push(`${at}.weight must be a number above 0 and at most 50`);
      else maxPoints += q.weight;
      if (!ALLOWED_FIELDS.includes(q.field)) e.push(`${at}.field "${q.field}" is not a feature the system produces`);
      if (q.kind === 'scale') {
        if (!isNum(q.worst) || !isNum(q.best)) e.push(`${at} needs numeric worst and best`);
        else if (q.worst === q.best) e.push(`${at}: worst and best must differ`);
      } else if (q.kind === 'category') {
        if (!isObj(q.map) || !Object.keys(q.map).length) e.push(`${at}.map must list at least one value`);
        else for (const [k, v] of Object.entries(q.map)) if (!isNum(v) || v < 0 || v > 10) e.push(`${at}.map["${k}"] must be 0 to 10`);
      } else e.push(`${at}.kind must be "scale" or "category"`);
    });
  }

  if (!isNum(p.missingScore10) || p.missingScore10 < 0 || p.missingScore10 > 10) e.push('missingScore10 must be 0 to 10');
  if (!Number.isInteger(p.maxMissingForAuto) || p.maxMissingForAuto < 0 || (Array.isArray(p.params) && p.maxMissingForAuto > p.params.length)) e.push('maxMissingForAuto must be a whole number from 0 to the number of parameters');

  // bands: A..E in order, minimums strictly falling, lowest band unbounded
  if (!Array.isArray(p.bands) || p.bands.length !== 5 || p.bands.some((b, i) => !isObj(b) || b.grade !== GRADES[i])) e.push('bands must be exactly A, B, C, D, E in that order');
  else {
    for (let i = 0; i < 4; i += 1) if (!isNum(p.bands[i].min)) e.push(`band ${GRADES[i]} needs a numeric min`);
    if (p.bands[4].min !== null) e.push('band E must have min null (no lower bound)');
    for (let i = 0; i < 3; i += 1) if (isNum(p.bands[i].min) && isNum(p.bands[i + 1].min) && p.bands[i].min <= p.bands[i + 1].min) e.push(`band ${GRADES[i]} min must be above band ${GRADES[i + 1]} min`);
    if (isNum(p.bands[0].min) && p.bands[0].min > maxPoints) e.push(`band A min ${p.bands[0].min} is above the maximum score ${maxPoints}, so no one could reach it`);
    if (isNum(p.bands[3].min) && p.bands[3].min < 0) e.push('band D min cannot be negative');
  }

  if (!isObj(p.decisionByGrade) || GRADES.some((g) => !DECISIONS.includes(p.decisionByGrade[g]))) e.push('decisionByGrade needs approve, refer or reject for each of A to E');
  else if (p.decisionByGrade.E !== 'reject') e.push('grade E must decide "reject": hard declines force grade E');

  if (!isObj(p.maxPctOfSalary) || GRADES.some((g) => !isNum(p.maxPctOfSalary[g]) || p.maxPctOfSalary[g] < 0 || p.maxPctOfSalary[g] > 1)) e.push('maxPctOfSalary needs a number from 0 to 1 for each of A to E');
  if (!Number.isInteger(p.amountStep) || p.amountStep < 1 || p.amountStep > 10000) e.push('amountStep must be a whole number from 1 to 10000');

  // review flags
  if (!isObj(p.flags) || !isObj(p.flags.review)) e.push('flags.review is required');
  else {
    if (p.flags.hard !== undefined) e.push('hard declines are fixed in code and cannot appear in a policy');
    for (const k of Object.keys(p.flags)) if (k !== 'review' && k !== 'hard') e.push(`unknown flags key "${k}"`);
    for (const [code, spec] of Object.entries(REVIEW_FLAG_SPECS)) {
      const f = p.flags.review[code];
      if (!isObj(f) || typeof f.enabled !== 'boolean') { e.push(`flags.review.${code} needs enabled true or false`); continue; }
      if (spec.key && (!isNum(f[spec.key]) || f[spec.key] < spec.min || f[spec.key] > spec.max)) e.push(`flags.review.${code}.${spec.key} must be ${spec.min} to ${spec.max}`);
    }
    for (const code of Object.keys(p.flags.review)) if (!REVIEW_FLAG_SPECS[code]) e.push(`unknown review flag "${code}"`);
  }
  return { ok: e.length === 0, errors: e, maxPoints };
}

// Runtime form: the lowest band's null becomes -Infinity. Throws PolicyError when invalid, so an engine never
// decides on a broken policy (fail closed).
export function resolvePolicy(p = DEFAULT_POLICY) {
  const v = validatePolicy(p);
  if (!v.ok) throw new PolicyError(v.errors);
  return {
    ...p,
    maxPoints: v.maxPoints,
    bands: p.bands.map((b) => ({ grade: b.grade, min: b.min === null ? -Infinity : b.min })),
  };
}
