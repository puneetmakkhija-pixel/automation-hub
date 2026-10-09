// decide(): the single entry point. Raw facts in, one auditable decision out.
import { scoreParameters, totalPoints, classify, evaluateFlags } from './scorecard.js';
import { offerFor, repaymentFor } from './offer.js';
import { DEFAULT_POLICY, resolvePolicy } from './policy.js';

const present = (v) => v !== null && v !== undefined && !Number.isNaN(v);

// Fill the derived ratios the scorecard needs. Caller-supplied values win.
export function deriveFeatures(raw, { product, requestedAmount }) {
  const f = { ...raw };
  const repayment = repaymentFor(product, requestedAmount);
  if (!present(f.abbToRepayment) && present(f.abb)) f.abbToRepayment = f.abb / repayment;
  if (!present(f.loanToNetSalaryPct) && present(f.netSalary) && f.netSalary > 0) {
    f.loanToNetSalaryPct = (requestedAmount / f.netSalary) * 100;
  }
  return f;
}

// last-3 vs prior-3 average, as a percentage. Needs 6 monthly values, oldest first.
export function trendPct(monthly) {
  if (!Array.isArray(monthly) || monthly.length < 6) return null;
  const last6 = monthly.slice(-6);
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const prior = avg(last6.slice(0, 3));
  if (prior === 0) return null;
  return ((avg(last6.slice(3)) - prior) / prior) * 100;
}

// Biggest point losses first: the plain-language "why" for a refer or reject.
function topDrags(scored, n = 3) {
  return [...scored]
    .map((p) => ({ ...p, lost: p.weight - p.points }))
    .filter((p) => p.lost > 0)
    .sort((a, b) => b.lost - a.lost)
    .slice(0, n)
    .map((p) => `${p.code} ${p.name}: ${p.missing ? 'not available' : p.value} (lost ${p.lost.toFixed(1)} of ${p.weight})`);
}

// `policy` is a credit policy (see policy.js); the built-in default applies when none is given. An invalid policy
// throws PolicyError instead of deciding (fail closed).
export function decide({ features: raw, product, requestedAmount, customerLimit = null, policy = DEFAULT_POLICY }) {
  const pol = resolvePolicy(policy);
  const features = deriveFeatures(raw, { product, requestedAmount });
  const parameters = scoreParameters(features, pol.params, pol.missingScore10);
  const points = totalPoints(parameters);
  const flags = evaluateFlags(features, pol.flags.review);
  const missingCount = parameters.filter((p) => p.missing).length;
  const reasons = [];

  let grade = classify(points, pol.bands);
  if (flags.hard.length) {
    grade = 'E';
    flags.hard.forEach((f) => reasons.push(`Hard decline ${f.code}: ${f.label}`));
  }

  let decision = pol.decisionByGrade[grade];

  if (decision === 'approve' && flags.review.length) {
    decision = 'refer';
    flags.review.forEach((f) => reasons.push(`Review ${f.code}: ${f.label}`));
  }
  if (decision !== 'reject' && missingCount > pol.maxMissingForAuto) {
    decision = 'refer';
    reasons.push(`Insufficient data: ${missingCount} of ${parameters.length} parameters missing`);
  }

  let offer = null;
  if (decision !== 'reject') {
    const o = offerFor({
      grade, product, requestedAmount, netSalary: features.netSalary, customerLimit, maxPctOfSalary: pol.maxPctOfSalary, amountStep: pol.amountStep,
    });
    if (o.amount === null) {
      decision = 'reject';
      reasons.push(`No viable offer: ${o.reason}`);
    } else {
      offer = o;
    }
  }

  if (decision !== 'approve') reasons.push(...topDrags(parameters));

  return {
    modelVersion: pol.version,
    totalPoints: points,
    maxPoints: pol.maxPoints,
    grade,
    decision,
    // refer: the amount is indicative until a person signs it off
    offer,
    redFlags: { hard: flags.hard, review: flags.review },
    missingCount,
    reasons,
    parameters,
  };
}
