// Pure scoring: features in, per-parameter points + total + grade + flags out.
import {
  PARAMS, MISSING_SCORE_10, BANDS, HARD_FLAGS, REVIEW_FLAGS,
} from './config.js';
import { DEFAULT_POLICY } from './policy.js';

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

export function scoreParameters(features, params = PARAMS, missingScore10 = MISSING_SCORE_10) {
  return params.map((p) => {
    const { value, score10: s } = score10(p, features);
    const missing = s === null;
    const used = missing ? missingScore10 : s;
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
  // the lowest band has no lower bound: min is -Infinity (or null when read straight from stored JSON)
  return bands.find((b) => b.min === null || points >= b.min).grade;
}

// Flags are only raised on data we have; a missing field raises nothing here
// (missing data is handled by the missing-parameter rule in decide.js).
// Hard declines are fixed (never in a policy). Review flags take their switch and threshold from the policy.
export function evaluateFlags(f, reviewCfg = DEFAULT_POLICY.flags.review) {
  const hard = [];
  const review = [];
  const addHard = (code) => hard.push({ code, label: HARD_FLAGS[code].label });
  const addReview = (code) => review.push({ code, label: REVIEW_FLAGS[code].label });
  const on = (code) => reviewCfg[code]?.enabled === true;

  if (f.npaStatus === 'npa') addHard('RF1');
  if (f.wilfulDefaulter === true) addHard('RF2');
  if (f.kycFailed === true) addHard('RF5');
  if (f.fraudFlag === true) addHard('RF10');

  if (on('RF3') && f.npaStatus === 'writeoff' && (isMissing(f.writeOffMonthsAgo) || f.writeOffMonthsAgo <= reviewCfg.RF3.months)) addReview('RF3');
  if (on('RF4') && !isMissing(f.maxDpd12m) && f.maxDpd12m > reviewCfg.RF4.dpd) addReview('RF4');
  if (on('RF7') && !isMissing(f.salaryMatchVariancePct) && f.salaryMatchVariancePct > reviewCfg.RF7.pct) addReview('RF7');
  if (on('RF8') && !isMissing(f.foirPct) && f.foirPct > reviewCfg.RF8.pct) addReview('RF8');
  if (on('RF9') && !isMissing(f.bankBounces6m) && f.bankBounces6m > reviewCfg.RF9.count) addReview('RF9');
  if (on('RF11') && !isMissing(f.enquiries90d) && f.enquiries90d > reviewCfg.RF11.count) addReview('RF11');
  if (on('RF12') && f.purposeClarity === 'vague_personal') addReview('RF12');

  return { hard, review };
}
