// The site's request handler: { method, path, query, headers, rawBody } -> { status, headers, body }.
// It serves the website and the app shell, and a small JSON API (/api/*) that sits between the browser and the loan
// system. The browser never holds a vendor or loan-system key: it holds only a signed session cookie, and every
// request is checked against that session's own customer.
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { feeFor, repaymentFor, aprFor, withFeeWaiver } from '../payday-engine/index.js';
import { REQUIRED_CONSENTS, CONSENT_PURPOSES, WHEEL, wheelOdds, REWARD_VALID_DAYS, MIN_REPAID_LOANS } from '../payday-journey/index.js';
import { createSessions } from './session.js';
import { createLimiter } from './ratelimit.js';
import { renderPage, renderAppShell, renderNotFound, SITEMAP_PATHS } from './pages.js';

const PUBLIC = resolve(fileURLToPath(new URL('./public', import.meta.url)));
const TEXT_VERSION = 'v1-draft'; // consent wording version: replace when compliance signs the final text
const OPEN_STATUSES = ['offered', 'scored', 'kyc_pending', 'agreement_sent', 'signed'];
const DEMO_SIGN_CODE = '246810';

const ENUMS = {
  employerCategory: ['govt_psu', 'listed_large', 'mnc', 'sme_registered', 'startup', 'unknown', 'informal'],
  residence: ['owned', 'family', 'rented_long', 'rented_short', 'none'],
  purpose: ['medical', 'bills', 'education', 'travel', 'family', 'other'],
};
const MIME = {
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.ico': 'image/x-icon',
};

const json = (status, body, headers = {}) => ({ status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }, body: JSON.stringify(body) });
const fail = (status, code, message, extra = {}) => json(status, { error: code, message, ...extra });
const round2 = (n) => Math.round(n * 100) / 100;
const addDaysIso = (iso, n) => { const d = new Date(iso); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

export function createWebApp({ cfg, gateway, otp, now = () => Date.now(), log = () => {} }) {
  const sessions = createSessions({ secret: cfg.sessionSecret || `ephemeral-${Math.random()}-${Date.now()}`, hours: cfg.sessionHours, secure: cfg.secure, now });
  const demo = cfg.mode === 'demo';
  const limits = {
    ip: createLimiter({ windowMs: 60_000, max: 120, now }),
    otpIp: createLimiter({ windowMs: 600_000, max: 10, now }),
    otpMobile: createLimiter({ windowMs: 600_000, max: 3, now }),
    verifyIp: createLimiter({ windowMs: 600_000, max: 30, now }),
    sign: createLimiter({ windowMs: 600_000, max: 5, now }),
  };
  let productCache = null;
  const product = async () => (productCache ??= await gateway.product());

  // ---------------------------------------------------------------- security headers
  const securityHeaders = () => ({
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'x-frame-options': 'DENY',
    'cross-origin-opener-policy': 'same-origin',
    ...(cfg.secure ? { 'strict-transport-security': 'max-age=31536000; includeSubDomains' } : {}),
  });

  const clientIp = (headers) => String(headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean).pop() || 'local';

  // ---------------------------------------------------------------- customer-facing views
  const mask = (last4) => `XXXXXX${String(last4).slice(-4)}`;
  const todayIso = () => new Date(now()).toISOString().slice(0, 10);

  // The bill for an amount. A fee waiver won on the wheel lowers the fee, the repayment and both yearly costs.
  async function termsFor(amount, waiverPct = 0) {
    const base = await product();
    const p = withFeeWaiver(base, waiverPct);
    const days = Number(p.tenure_days);
    const fee = feeFor(p, amount);
    const apr = aprFor(p, amount, days);
    return {
      amount, fee, repayment: repaymentFor(p, amount), tenureDays: days,
      aprSimplePct: apr.aprSimplePct, aprEffectivePct: apr.aprEffectivePct,
      lateChargePctPerDay: Number(p.penalty_per_day_pct),
      waiverPct: Number(waiverPct) || 0, feeBeforeWaiver: waiverPct ? feeFor(base, amount) : null,
    };
  }

  async function capFor(snap) {
    const p = await product();
    const productMax = Number(p.max_amount);
    return snap.limit ? Math.min(snap.limit.amount, productMax) : Math.min(cfg.firstLoanMax, productMax);
  }

  async function view(customerId, mobile) {
    const snap = await gateway.snapshot(customerId);
    if (!snap) return null;
    const p = await product();
    const openLoan = snap.loans.find((l) => ['active', 'overdue'].includes(l.status) && l.disbursed_at) ?? null;
    const lastApp = snap.applications[0] ?? null;
    const daysSince = (iso) => (now() - Date.parse(iso)) / 86_400_000;
    // An offer that was not accepted in time lapses: it can no longer be accepted, and a new application is allowed.
    if (lastApp && lastApp.status === 'offered' && daysSince(lastApp.created_at) > cfg.offerValidDays) {
      await gateway.expireOffer(lastApp.id);
      lastApp.status = 'expired';
    }
    let next = 'start';
    let declinedUntil = null;
    if (openLoan) next = 'loan';
    else if (lastApp) {
      const s = lastApp.status;
      if (s === 'offered') next = 'offer';
      else if (s === 'scored') next = 'review';
      else if (s === 'kyc_pending') next = 'kyc_pending';
      else if (s === 'agreement_sent') next = 'sign';
      else if (s === 'signed') next = 'bank';
      else if (s === 'rejected') {
        declinedUntil = addDaysIso(lastApp.created_at, cfg.reapplyAfterDays);
        next = declinedUntil > todayIso() ? 'declined' : 'start';
      }
    }
    const blocked = snap.limit !== null && snap.limit.amount <= 0;
    const isRepeat = snap.loans.some((l) => l.disbursed_at);
    // For a returning customer, find what is out of date. Only those things are asked again.
    const missingConsents = REQUIRED_CONSENTS.filter((c) => !snap.consents.includes(c));
    const refreshItems = [];
    if (isRepeat && next === 'start' && !(blocked && !openLoan)) {
      if (missingConsents.length) refreshItems.push('permissions');
      if (snap.firstApplicationAt && daysSince(snap.firstApplicationAt) > cfg.kycValidDays) refreshItems.push('identity');
      if (lastApp && daysSince(lastApp.created_at) > cfg.dataValidDays) refreshItems.push('job');
    }
    if (refreshItems.length) next = 'refresh';
    const out = {
      mode: cfg.mode,
      mobile_masked: mobile ? mask(mobile) : null,
      consents: snap.consents,
      missing_consents: REQUIRED_CONSENTS.filter((c) => !snap.consents.includes(c)),
      next: blocked && !openLoan ? 'blocked' : next,
      cap: await capFor(snap),
      min_amount: Number(p.min_amount),
      is_repeat: isRepeat,
      refresh_items: refreshItems,
      need_pan: !isRepeat || refreshItems.includes('identity'),
      declined_until: next === 'declined' ? declinedUntil : null,
      history: snap.loans.map((l) => ({
        loan_id: l.id, status: l.status, amount: Number(l.principal), disbursed_at: l.disbursed_at, closed_at: l.closed_at ?? null,
      })),
    };
    if (['offer', 'sign', 'bank'].includes(out.next)) {
      out.application = { id: lastApp.id, status: lastApp.status };
      out.offer = await termsFor(Number(lastApp.approved_amount), Number(lastApp.fee_waiver_pct || 0));
      if (out.next === 'offer') out.offer_expires = addDaysIso(lastApp.created_at, cfg.offerValidDays);
    }
    out.preapproved = isRepeat && out.next === 'start';
    const rw = await gateway.rewards(customerId);
    out.spins = rw.spins_available;
    out.reward = rw.reward;
    // Why there is no offer right now, in words that are safe to show: never a score or a grade.
    out.reason = { review: 'under_review', declined: 'reapply_later', blocked: 'not_available' }[out.next] ?? null;
    if (isRepeat && snap.profile && ['start', 'refresh'].includes(out.next)) {
      const monthsSince = Math.max(0, Math.floor(daysSince(lastApp?.created_at ?? new Date(now()).toISOString()) / 30));
      out.profile = {
        monthly_salary: snap.profile.monthly_salary, employer_type: snap.profile.employer_type, residence: snap.profile.residence,
        months_with_employer: snap.profile.months_with_employer === null ? null : Number(snap.profile.months_with_employer) + monthsSince,
      };
    }
    if (['review', 'declined', 'kyc_pending'].includes(out.next)) out.application = { id: lastApp.id, status: lastApp.status, reference: lastApp.id.slice(0, 8).toUpperCase() };
    if (out.next === 'loan') out.loan = await loanView(openLoan.id);
    return out;
  }

  async function loanView(loanId) {
    const r = await gateway.loanView(loanId);
    if (r.status !== 200) return null;
    const b = r.body;
    return {
      loan_id: b.loan_id, status: b.status, principal: Number(b.principal), due_date: b.due_date, outstanding: Number(b.outstanding),
      days_overdue: b.days_overdue, apr_pct: b.apr_pct,
    };
  }

  // ---------------------------------------------------------------- validation
  const cleanMobile = (v) => String(v ?? '').replace(/[\s-]/g, '').replace(/^(\+91|91)(?=\d{10}$)/, '');
  const MOBILE = /^[6-9]\d{9}$/;
  const PAN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
  const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
  const intOr = (v) => (Number.isInteger(Number(v)) && String(v).trim() !== '' ? Number(v) : NaN);

  function validateIntake(b, { needPan = true } = {}) {
    const errors = {};
    const salary = Number(b.monthly_salary);
    if (!(salary >= 8000 && salary <= 1_000_000)) errors.monthly_salary = 'Enter your monthly take-home salary in rupees.';
    const months = intOr(b.months_with_employer);
    if (!(months >= 0 && months <= 600)) errors.months_with_employer = 'Enter the number of months you have worked there.';
    if (!ENUMS.employerCategory.includes(b.employer_type)) errors.employer_type = 'Choose your employer type.';
    if (!ENUMS.residence.includes(b.residence)) errors.residence = 'Choose where you live.';
    if (!ENUMS.purpose.includes(b.purpose)) errors.purpose = 'Choose what the money is for.';
    const pan = String(b.pan ?? '').toUpperCase().replace(/\s/g, '');
    if (needPan && !PAN.test(pan)) errors.pan = 'Enter your PAN, for example ABCDE1234F.';
    return { errors, pan: needPan ? pan : undefined, intake: {
      declaredSalary: salary, tenureMonths: months, employerCategory: b.employer_type, residence: b.residence,
      // Self-declared answers only. We collect no references, so none are marked verified; "other" purpose is scored as vague.
      purposeClarity: b.purpose === 'other' ? 'vague_personal' : 'generic', referencesVerified: 'none',
    } };
  }

  // ---------------------------------------------------------------- API
  async function api(req, sub) {
    const { method, headers } = req;
    const ip = clientIp(headers);
    if (!limits.ip.hit(ip).ok) return fail(429, 'slow_down', 'Too many requests. Please wait a minute.');

    if (method === 'POST') {
      // A custom header and JSON content type cannot be sent cross-site without a CORS preflight, which we never grant.
      if (headers['x-zenin'] !== '1') return fail(403, 'forbidden', 'Request not allowed.');
      if (req.rawBody && !String(headers['content-type'] || '').toLowerCase().startsWith('application/json')) return fail(415, 'bad_type', 'Send JSON.');
    }
    let body = {};
    if (method === 'POST' && req.rawBody) {
      try { body = JSON.parse(req.rawBody); } catch { return fail(400, 'bad_json', 'Could not read the request.'); }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'bad_json', 'Could not read the request.');
    }

    // ---- public
    if (method === 'GET' && sub === '/config') {
      const p = await product();
      return json(200, {
        mode: cfg.mode, brand: cfg.brand,
        product: { min: Number(p.min_amount), max: Number(p.max_amount), tenure_days: Number(p.tenure_days), late_charge_pct_per_day: Number(p.penalty_per_day_pct) },
        first_loan_max: Math.min(cfg.firstLoanMax, Number(p.max_amount)),
        wheel: { slices: WHEEL, odds: wheelOdds(), valid_days: REWARD_VALID_DAYS, repaid_needed: MIN_REPAID_LOANS },
        demo: demo ? { otp: '123456', sign_code: DEMO_SIGN_CODE, hint: 'Numbers ending 0 to 6 are approved. 7 has no credit history and 8 has a defaulted loan: both are declined. 9 fails the identity check. Choosing "Other personal use" as the purpose sends an approved file to review.' } : null,
      });
    }
    if (method === 'GET' && sub === '/quote') {
      const p = await product();
      const amount = Number(new URLSearchParams(req.query || {}).get('amount') ?? req.query?.amount);
      if (!(amount >= Number(p.min_amount) && amount <= Number(p.max_amount)) || amount % 500 !== 0) return fail(400, 'bad_amount', `Choose an amount from ${p.min_amount} to ${p.max_amount} in steps of 500.`);
      // A signed-in customer with a fee waiver sees their own, lower bill.
      const s = sessions.read(headers.cookie);
      const rw = s ? await gateway.rewards(s.cid) : null;
      return json(200, await termsFor(amount, rw?.reward?.waiver_pct ?? 0));
    }

    if (method === 'POST' && sub === '/otp/send') {
      const mobile = cleanMobile(body.mobile);
      if (!MOBILE.test(mobile)) return fail(400, 'bad_mobile', 'Enter a 10-digit mobile number.');
      if (!limits.otpIp.hit(ip).ok || !limits.otpMobile.hit(mobile).ok) return fail(429, 'too_many_codes', 'Too many codes requested. Please try again in a few minutes.');
      await otp.send({ mobile });
      return json(200, { sent: true });
    }
    if (method === 'POST' && sub === '/otp/verify') {
      const mobile = cleanMobile(body.mobile);
      const code = String(body.code ?? '').trim();
      if (!MOBILE.test(mobile) || !/^\d{6}$/.test(code)) return fail(400, 'bad_input', 'Enter your mobile number and the 6-digit code.');
      if (!limits.verifyIp.hit(ip).ok) return fail(429, 'slow_down', 'Too many attempts. Please wait.');
      const r = await otp.verify({ mobile, code });
      if (r === 'locked') return fail(429, 'locked', 'Too many wrong codes. Ask for a new code.');
      if (r === 'expired') return fail(400, 'expired', 'That code has expired. Ask for a new one.');
      if (r !== 'ok') return fail(400, 'bad_code', 'That code is not right.');
      let customerId;
      try { customerId = await gateway.upsertCustomer(mobile); } catch (e) {
        if (e.demoFull) return fail(503, 'busy', 'The demo is full right now. Please try again later.');
        throw e;
      }
      const s = sessions.issue(customerId, mobile.slice(-4));
      return json(200, await view(customerId, s.payload.m), { 'set-cookie': s.cookie });
    }

    // ---- everything below needs a session
    const sess = sessions.read(headers.cookie);
    if (!sess) return fail(401, 'signed_out', 'Please sign in again.');
    const cid = sess.cid;
    const mobile = sess.m || null;

    if (method === 'POST' && sub === '/logout') {
      sessions.revoke(sess);
      return json(200, { ok: true }, { 'set-cookie': sessions.clear() });
    }
    if (method === 'GET' && sub === '/me') {
      const v = await view(cid, mobile);
      if (!v) return fail(401, 'signed_out', 'Please sign in again.');
      return json(200, v);
    }
    if (method === 'POST' && sub === '/consents') {
      const purposes = Array.isArray(body.purposes) ? body.purposes : [];
      const allowed = CONSENT_PURPOSES;
      if (!purposes.length || purposes.some((x) => !allowed.includes(x))) return fail(400, 'bad_purposes', 'Unknown permission.');
      const r = await gateway.recordConsents(cid, purposes, TEXT_VERSION);
      return r.status === 201 ? json(200, { recorded: purposes }) : fail(400, 'consent_failed', 'We could not save your permission.');
    }
    if (method === 'POST' && sub === '/consents/revoke') {
      if (!CONSENT_PURPOSES.includes(body.purpose)) return fail(400, 'bad_purposes', 'Unknown permission.');
      const r = await gateway.revokeConsent(cid, body.purpose);
      return r.status === 200 ? json(200, { revoked: body.purpose }) : fail(400, 'revoke_failed', 'We could not change that permission.');
    }
    if (method === 'GET' && sub === '/history') {
      const v = await view(cid, mobile);
      return json(200, { history: v.history });
    }

    if (method === 'GET' && sub === '/wheel') {
      const rw = await gateway.rewards(cid);
      return json(200, { spins: rw.spins_available, reward: rw.reward, repaid_loans: rw.repaid_loans, loans_needed: rw.loans_needed, slices: WHEEL, odds: wheelOdds() });
    }
    if (method === 'POST' && sub === '/wheel/spin') {
      const r = await gateway.spin(cid);
      if (r.status === 409) return fail(409, 'no_spin', 'There is no spin waiting for you.');
      if (r.status !== 200) return fail(502, 'try_later', 'Something went wrong on our side. Please try again in a little while.');
      return json(200, { slice: r.body.slice, waiver_pct: r.body.waiver_pct, expires_at: r.body.expires_at });
    }

    if (method === 'POST' && sub === '/applications') {
      const snap = await gateway.snapshot(cid);
      const v = await view(cid, mobile);
      if (v.missing_consents.length) return fail(409, 'consent_required', 'We need your permission first.', { missing: v.missing_consents });
      if (snap.loans.some((l) => ['active', 'overdue'].includes(l.status) && l.disbursed_at)) return fail(409, 'open_loan', 'You already have a loan to repay.');
      if (snap.applications.some((a) => OPEN_STATUSES.includes(a.status))) return fail(409, 'application_in_progress', 'You already have an application in progress.');
      if (v.next === 'declined') return fail(409, 'reapply_later', `You can apply again after ${v.declined_until}.`, { declined_until: v.declined_until });
      if (v.next === 'blocked') return fail(409, 'not_available', 'A new loan is not available for this account right now.');
      const dayAgo = new Date(now() - 86_400_000).toISOString();
      if (snap.applications.filter((a) => a.created_at >= dayAgo).length >= 3) return fail(429, 'too_many_applications', 'You have reached the daily limit for applications. Please try tomorrow.');
      const amount = intOr(body.amount);
      const p = await product();
      if (!(amount >= Number(p.min_amount) && amount <= v.cap) || amount % 500 !== 0) return fail(400, 'bad_amount', `You can ask for ${p.min_amount} to ${v.cap} in steps of 500.`);
      // A returning customer whose details are still fresh can reuse them: only the purpose is asked.
      let form = body;
      if (body.use_saved === true) {
        if (!v.preapproved || !v.profile || v.profile.employer_type === null) return fail(409, 'details_needed', 'Please confirm your details first.');
        form = { ...v.profile, purpose: body.purpose };
      }
      const { errors, pan, intake } = validateIntake(form, { needPan: v.need_pan });
      if (Object.keys(errors).length) return fail(400, 'invalid', 'Please check the highlighted fields.', { fields: errors });
      // Identity out of date: have the loan system run the identity check again for this application.
      if (v.refresh_items.includes('identity')) await gateway.expireKyc(cid);
      await gateway.saveProfile(cid, { monthly_salary: intake.declaredSalary });
      const r = await gateway.apply(cid, { amount, pan, intake });
      if (r.status === 202) return json(202, { decision: 'kyc_pending' });
      if (r.status === 409) return fail(409, r.body.code === 'CONSENT_REQUIRED' ? 'consent_required' : 'not_allowed', 'We cannot take this application right now.');
      if (r.status !== 200) return fail(502, 'try_later', 'Something went wrong on our side. Please try again in a little while.');
      const d = r.body.decision;
      if (d === 'approve') {
        const after = await gateway.snapshot(cid);
        return json(200, { decision: 'approved', application_id: r.body.application_id, offer: await termsFor(Number(r.body.offer.amount), Number(after.applications[0]?.fee_waiver_pct || 0)) });
      }
      if (d === 'refer') return json(200, { decision: 'review', application_id: r.body.application_id, reference: r.body.application_id.slice(0, 8).toUpperCase() });
      return json(200, { decision: 'declined', application_id: r.body.application_id });
    }

    const m = /^\/applications\/([\w-]{1,64})\/(accept|sign|disburse)$/.exec(sub);
    if (method === 'POST' && m) {
      const [, id, action] = m;
      if (!(await gateway.owns(cid, 'application', id))) return fail(404, 'not_found', 'Not found.');
      if (action === 'accept') {
        const r = await gateway.sendAgreement(id);
        return r.status === 200 || r.status === 201 ? json(200, { status: 'agreement_sent' }) : fail(409, 'not_allowed', 'This offer can no longer be accepted.');
      }
      if (action === 'sign') {
        if (!demo) return fail(404, 'not_found', 'Not found.');
        if (!limits.sign.hit(id).ok) return fail(429, 'slow_down', 'Too many attempts. Please wait.');
        if (String(body.code ?? '') !== DEMO_SIGN_CODE) return fail(400, 'bad_code', 'That code is not right.');
        await gateway.signAgreement(id);
        return json(200, { status: 'signed' });
      }
      // disburse
      const a = body.account || {};
      const name = String(a.name ?? '').trim();
      const number = String(a.number ?? '').replace(/\s/g, '');
      const ifsc = String(a.ifsc ?? '').toUpperCase().replace(/\s/g, '');
      const fields = {};
      if (!/^[A-Za-z][A-Za-z .'-]{1,79}$/.test(name)) fields.name = 'Enter the name exactly as it is on your account.';
      if (!/^\d{9,18}$/.test(number)) fields.number = 'Enter your account number (9 to 18 digits).';
      if (!IFSC.test(ifsc)) fields.ifsc = 'Enter a valid IFSC, for example HDFC0001234.';
      if (Object.keys(fields).length) return fail(400, 'invalid', 'Please check the highlighted fields.', { fields });
      const r = await gateway.disburse(id, { name, number, ifsc });
      if (r.status === 200) return json(200, { status: 'paid', due_date: r.body.due_date, reference_last4: r.body.utr ? String(r.body.utr).slice(-4) : null });
      if (r.status === 202) return json(202, { status: 'processing' });
      if (r.status === 502) return fail(502, 'payout_failed', 'We could not send the money. You have not been charged. Please try again or contact support.');
      return fail(409, 'not_allowed', 'The money cannot be sent yet. Please sign the agreement first.');
    }

    if (method === 'GET' && sub === '/loan') {
      const v = await view(cid, mobile);
      return json(200, { loan: v.loan ?? null });
    }
    if (method === 'POST' && sub === '/loan/pay') {
      const v = await view(cid, mobile);
      if (!v.loan) return fail(404, 'not_found', 'You have no loan to repay.');
      if (demo) {
        await gateway.pay(v.loan.loan_id);
        return json(200, { status: 'paid' });
      }
      const r = await gateway.collect(v.loan.loan_id);
      const url = r.body?.payment_url;
      if (r.status !== 201 || !/^https:\/\//.test(url || '')) return fail(502, 'try_later', 'We could not create a payment link. Please try again.');
      return json(200, { status: 'link', payment_url: url, amount: r.body.amount });
    }
    return fail(404, 'not_found', 'Not found.');
  }

  // ---------------------------------------------------------------- static files and pages
  function staticFile(path) {
    if (path.includes('\0') || path.includes('..')) return null;
    const full = resolve(join(PUBLIC, normalize(path)));
    if (full !== PUBLIC && !full.startsWith(PUBLIC + sep)) return null;
    if (!existsSync(full) || !statSync(full).isFile()) return null;
    const ext = extname(full);
    if (!MIME[ext]) return null;
    const cache = path === '/sw.js' ? 'no-cache' : ext === '.webmanifest' ? 'no-cache' : 'public, max-age=3600';
    return { status: 200, headers: { 'content-type': MIME[ext], 'cache-control': cache }, body: readFileSync(full) };
  }

  async function handle(req) {
    const path = req.path.replace(/\/+$/, '') || '/';
    let res;
    try {
      if (path === '/healthz') res = json(200, { ok: true, mode: cfg.mode });
      else if (path.startsWith('/api/')) {
        if (!['GET', 'POST'].includes(req.method)) res = fail(405, 'method', 'Not allowed.');
        else res = await api(req, path.slice(4));
      } else if (req.method !== 'GET' && req.method !== 'HEAD') res = fail(405, 'method', 'Not allowed.');
      else if (path === '/robots.txt') {
        res = { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: demo ? 'User-agent: *\nDisallow: /\n' : `User-agent: *\nAllow: /\nDisallow: /app\nSitemap: ${cfg.siteUrl}/sitemap.xml\n` };
      } else if (path === '/sitemap.xml') {
        res = { status: 200, headers: { 'content-type': 'application/xml; charset=utf-8' }, body: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${SITEMAP_PATHS.map((p) => `  <url><loc>${cfg.siteUrl}${p}</loc></url>`).join('\n')}\n</urlset>\n` };
      } else if (path === '/.well-known/security.txt') {
        res = { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: `Contact: mailto:${cfg.org.SUPPORT_EMAIL ?? 'security@invalid.example'}\nCanonical: ${cfg.siteUrl}/.well-known/security.txt\n` };
      } else if (path === '/app' || path.startsWith('/app/')) {
        res = { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }, body: renderAppShell(cfg) };
      } else {
        res = staticFile(path);
        if (!res) {
          const html = renderPage(cfg, await product(), path);
          res = html
            ? { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }, body: html }
            : { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' }, body: renderNotFound(cfg) };
        }
      }
    } catch (e) {
      log(`error ${req.method} ${path}: ${e.message}`);
      res = fail(500, 'server_error', 'Something went wrong on our side. Please try again.');
    }
    res.headers = { ...securityHeaders(), ...res.headers };
    log(`${req.method} ${path} ${res.status}`);
    return res;
  }

  return { handle, sessions };
}
