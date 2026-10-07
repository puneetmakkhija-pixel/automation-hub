// Pure scoring: features in, per-parameter points + total + grade + flags out.
import {
  PARAMS, MISSING_SCORE_10, BANDS, HARD_FLAGS, REVIEW_FLAGS,
} from './config.js';

const round2 = (n) => Math.round(n * 100) / 100;
const isMissing = (v) => v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v));

// Linear 0-10 between worst (0) and best (10). Works for either direction.
export function scale(value, worst, best) {
  if (isMissing(value)) return null;
  const t = (value - worst) / (best - worst);
  return Math.min(1, Math.max(0, t)) * 10;
}

function score10(param, features) {
  const value = features[param.field];
  if (isMissing(value)) return { value: null, score10: null };
  if (param.kind === 'scale') return { value, score10: scale(Number(value), param.worst, param.best) };
  // category: an unrecognised value is treated as missing, never as a silent zero
  const s = param.map[value];
  return { value, score10: s === undefined ? null : s };
}

export function scoreParameters(features, params = PARAMS) {
  return params.map((p) => {
    const { value, score10: s } = score10(p, features);
    const missing = s === null;
    const used = missing ? MISSING_SCORE_10 : s;
    return {
      code: p.code,
      name: p.name,
      group: p.group,
      weight: p.weight,
      value,
      score10: round2(used),
      points: round2((p.weight * used) / 10),
      missing,
    };
  });
}

export function totalPoints(scored) {
  return round2(scored.reduce((a, p) => a + p.points, 0));
}

export const maxPoints = (params = PARAMS) => params.reduce((a, p) => a + p.weight, 0);

export function classify(points, bands = BANDS) {
  return bands.find((b) => points >= b.min).grade;
}

// Flags are only raised on data we have; a missing field raises nothing here
// (missing data is handled by the missing-parameter rule in decide.js).
export function evaluateFlags(f) {
  const hard = [];
  const review = [];
  const add = (list, table, code) => list.push({ code, label: table[code].label });

  if (f.npaStatus === 'npa') add(hard, HARD_FLAGS, 'RF1');
  if (f.wilfulDefaulter === true) add(hard, HARD_FLAGS, 'RF2');
  if (f.kycFailed === true) add(hard, HARD_FLAGS, 'RF5');
  if (f.fraudFlag === true) add(hard, HARD_FLAGS, 'RF10');

  if (f.npaStatus === 'writeoff' && (isMissing(f.writeOffMonthsAgo) || f.writeOffMonthsAgo <= 36)) add(review, REVIEW_FLAGS, 'RF3');
  if (!isMissing(f.maxDpd12m) && f.maxDpd12m > 30) add(review, REVIEW_FLAGS, 'RF4');
  if (!isMissing(f.salaryMatchVariancePct) && f.salaryMatchVariancePct > 30) add(review, REVIEW_FLAGS, 'RF7');
  if (!isMissing(f.foirPct) && f.foirPct > 55) add(review, REVIEW_FLAGS, 'RF8');
  if (!isMissing(f.bankBounces6m) && f.bankBounces6m > 2) add(review, REVIEW_FLAGS, 'RF9');
  if (!isMissing(f.enquiries90d) && f.enquiries90d > 6) add(review, REVIEW_FLAGS, 'RF11');
  if (f.purposeClarity === 'vague_personal') add(review, REVIEW_FLAGS, 'RF12');

  return { hard, review };
}
