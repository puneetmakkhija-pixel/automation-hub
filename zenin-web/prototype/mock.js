// Browser-only stand-in for the Zenin BFF API, so the app can be tried from one file with no server.
// It mirrors the shapes the real server returns (zenin-web/app.js). Nothing here is real: no money, no data.
(() => {
  const DAY = 86_400_000;
  const iso = (d) => new Date(Date.now() + d * DAY).toISOString().slice(0, 10);
  const stamp = (d) => new Date(Date.now() + d * DAY).toISOString();
  const SIGN_CODE = '246810';
  const JOB = { monthly_salary: 48000, employer_type: 'listed_large', months_with_employer: 26, residence: 'rented_long' };
  const SCENARIOS = {
    new: 'New customer: first loan',
    welcome: 'Returning: pre-approved',
    offer: 'Returning: saved offer (3 days left)',
    refresh_permissions: 'Needs refresh: permission withdrawn',
    refresh_identity: 'Needs refresh: PAN older than 1 year',
    refresh_job: 'Needs refresh: job details older than 90 days',
    refresh_all: 'Needs refresh: all three',
    review: 'No offer: under review',
    declined: 'No offer: declined, try later',
    blocked: 'No offer: not available',
    kyc_pending: 'No offer: identity check pending',
    loan: 'Open loan, due in 12 days',
    wheel2: 'Loyalty: 2 loans repaid (no spin yet)',
    wheel3: 'Loyalty: 3 loans repaid, 1 spin waiting',
    reward: 'Loyalty: 30% fee waiver in hand',
  };
  const hash = () => (location.hash.match(/s=(\w+)/) || [])[1];
  const scenario = SCENARIOS[hash()] ? hash() : 'new';
  const sc = scenario;

  const st = {
    signedIn: sc !== 'new', next: 'start', repaid: 0, spins: 0, reward: null, refresh: [], missing: [], profile: null,
    offer: null, offerExpires: null, declinedUntil: null, loan: null, application: null, consents: ['kyc', 'credit_bureau', 'terms'], history: [], cap: 10000,
  };
  if (sc === 'new') { st.consents = []; st.missing = ['kyc', 'credit_bureau', 'terms']; }
  const repeat = () => { st.repaid = Math.max(st.repaid, 1); st.cap = 15000; st.profile = { ...JOB }; };
  const hist = (n) => { st.history = Array.from({ length: n }, (_, i) => ({ loan_id: 'L' + i, status: 'closed', amount: 10000, disbursed_at: stamp(-30 * (n - i) - 5), closed_at: stamp(-30 * (n - i) + 24) })); };
  if (sc === 'welcome') { repeat(); hist(1); }
  if (sc === 'offer') { repeat(); hist(1); st.next = 'offer'; st.offer = 10000; st.offerExpires = iso(3); st.application = { id: 'A1', status: 'offered' }; }
  if (sc.startsWith('refresh')) {
    repeat(); hist(1); st.next = 'refresh';
    if (sc === 'refresh_permissions' || sc === 'refresh_all') { st.refresh.push('permissions'); st.missing = ['credit_bureau']; st.consents = ['kyc', 'terms']; }
    if (sc === 'refresh_identity' || sc === 'refresh_all') st.refresh.push('identity');
    if (sc === 'refresh_job' || sc === 'refresh_all') st.refresh.push('job');
  }
  if (sc === 'review') { repeat(); hist(1); st.next = 'review'; st.application = { id: 'A2', status: 'scored', reference: 'A2B7C9D1' }; }
  if (sc === 'declined') { repeat(); hist(1); st.next = 'declined'; st.declinedUntil = iso(24); st.application = { id: 'A3', status: 'rejected', reference: 'F3E1A0C4' }; }
  if (sc === 'blocked') { repeat(); hist(1); st.next = 'blocked'; }
  if (sc === 'kyc_pending') { st.next = 'kyc_pending'; st.application = { id: 'A4', status: 'kyc_pending', reference: 'K9D2E5B7' }; }
  if (sc === 'loan') { repeat(); hist(1); st.next = 'loan'; st.loan = { loan_id: 'L9', status: 'active', principal: 10000, due_date: iso(12), outstanding: 10800, days_overdue: 0, apr_pct: 97.3 }; }
  if (sc === 'wheel2') { repeat(); st.repaid = 2; st.cap = 20000; hist(2); }
  if (sc === 'wheel3') { repeat(); st.repaid = 3; st.cap = 25000; st.spins = 1; hist(3); }
  if (sc === 'reward') { repeat(); st.repaid = 3; st.cap = 25000; hist(3); st.reward = { waiver_pct: 30, expires_at: stamp(27) }; }

  const WHEEL = __WHEEL__;
  const ODDS = [10, 20, 30, 40, 50].map((w) => ({ waiver: w, slices: WHEEL.filter((x) => x === w).length }));
  const waiver = () => (st.reward ? st.reward.waiver_pct : 0);
  const round2 = (n) => Math.round(n * 100) / 100;
  function terms(amount, w = 0) {
    const fullFee = amount * 0.08; const fee = round2(fullFee * (1 - w / 100));
    return {
      amount, fee, repayment: amount + fee, tenureDays: 30, aprSimplePct: round2((fee / amount) * (365 / 30) * 100),
      aprEffectivePct: round2(((1 + fee / amount) ** (365 / 30) - 1) * 100), lateChargePctPerDay: 1, waiverPct: w, feeBeforeWaiver: w ? fullFee : null,
    };
  }
  function me() {
    const o = {
      mode: 'demo', mobile_masked: 'XXXXXX1234', consents: st.consents, missing_consents: st.missing, next: st.next, cap: st.cap, min_amount: 5000,
      is_repeat: st.repaid > 0, refresh_items: st.refresh, need_pan: st.repaid === 0 || st.refresh.includes('identity'), declined_until: st.declinedUntil,
      history: st.history, preapproved: st.repaid > 0 && st.next === 'start', spins: st.spins, reward: st.reward,
      reason: { review: 'under_review', declined: 'reapply_later', blocked: 'not_available' }[st.next] ?? null,
    };
    if (st.profile && ['start', 'refresh'].includes(st.next)) o.profile = { ...st.profile };
    if (st.application) o.application = st.application;
    if (st.offer) { o.offer = terms(st.offer, st.offerWaiver || 0); if (st.next === 'offer') o.offer_expires = st.offerExpires; }
    if (st.loan && st.next === 'loan') o.loan = st.loan;
    return o;
  }
  const res = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const err = (status, error, message, extra = {}) => res(status, { error, message, ...extra });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  async function handle(method, path, query, body) {
    if (method === 'GET' && path === '/config') {
      return res(200, { mode: 'demo', brand: 'Zenin Credit', product: { min: 5000, max: 50000, tenure_days: 30, late_charge_pct_per_day: 1 }, first_loan_max: 10000,
        wheel: { slices: WHEEL, odds: ODDS, valid_days: 30, repaid_needed: 3 }, demo: { otp: '123456', sign_code: SIGN_CODE, hint: '' } });
    }
    if (method === 'GET' && path === '/quote') {
      const a = Number(query.get('amount'));
      if (!(a >= 5000 && a <= 50000) || a % 500) return err(400, 'bad_amount', 'Choose an amount from 5000 to 50000 in steps of 500.');
      return res(200, terms(a, st.signedIn ? waiver() : 0));
    }
    if (method === 'POST' && path === '/otp/send') return res(200, { sent: true });
    if (method === 'POST' && path === '/otp/verify') {
      if (body.code !== '123456') return err(400, 'bad_code', 'That code is not right.');
      st.signedIn = true; return res(200, me());
    }
    if (!st.signedIn) return err(401, 'signed_out', 'Please sign in again.');
    if (method === 'GET' && path === '/me') return res(200, me());
    if (method === 'POST' && path === '/logout') { st.signedIn = false; return res(200, {}); }
    if (method === 'POST' && path === '/consents') {
      st.consents = ['kyc', 'credit_bureau', 'terms']; st.missing = [];
      st.refresh = st.refresh.filter((k) => k !== 'permissions');
      if (!st.refresh.length && st.next === 'refresh') st.next = 'start';
      return res(200, {});
    }
    if (method === 'POST' && path === '/consents/revoke') { st.consents = st.consents.filter((c) => c !== body.purpose); return res(200, { revoked: body.purpose }); }
    if (method === 'GET' && path === '/history') return res(200, { history: st.history });
    if (method === 'GET' && path === '/wheel') return res(200, { spins: st.spins, reward: st.reward, repaid_loans: st.repaid, loans_needed: Math.max(0, 3 - st.repaid), slices: WHEEL, odds: ODDS });
    if (method === 'POST' && path === '/wheel/spin') {
      if (st.spins < 1) return err(409, 'no_spin', 'There is no spin waiting for you.');
      const slice = Math.floor(Math.random() * WHEEL.length);
      st.spins -= 1; st.reward = { waiver_pct: WHEEL[slice], expires_at: stamp(30) };
      return res(200, { slice, waiver_pct: WHEEL[slice], expires_at: st.reward.expires_at });
    }
    if (method === 'POST' && path === '/applications') {
      const a = Number(body.amount);
      if (!(a >= 5000 && a <= st.cap) || a % 500) return err(400, 'bad_amount', `You can ask for 5000 to ${st.cap} in steps of 500.`);
      const fields = {};
      if (body.use_saved) { if (!st.profile) return err(409, 'details_needed', 'Please confirm your details first.'); if (!body.purpose) fields.purpose = 'Choose what the money is for.'; }
      else {
        if (!(Number(body.monthly_salary) >= 8000)) fields.monthly_salary = 'Enter your monthly take-home salary in rupees.';
        if (!body.employer_type) fields.employer_type = 'Choose your employer type.';
        if (body.months_with_employer === '' || body.months_with_employer === undefined) fields.months_with_employer = 'Enter the number of months you have worked there.';
        if (!body.residence) fields.residence = 'Choose where you live.';
        if (!body.purpose) fields.purpose = 'Choose what the money is for.';
        if (st.repaid === 0 || st.refresh.includes('identity')) if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(String(body.pan || ''))) fields.pan = 'Enter your PAN, for example ABCDE1234F.';
      }
      if (Object.keys(fields).length) return err(400, 'invalid', 'Please check the highlighted fields.', { fields });
      if (!body.use_saved) st.profile = { monthly_salary: Number(body.monthly_salary), employer_type: body.employer_type, months_with_employer: Number(body.months_with_employer), residence: body.residence };
      st.refresh = []; st.application = { id: 'A' + Date.now(), status: 'offered' };
      if (body.purpose === 'other') { st.next = 'review'; st.application.reference = 'R7T2Q9X1'; return res(200, { decision: 'review', application_id: st.application.id, reference: st.application.reference }); }
      st.next = 'offer'; st.offer = a; st.offerWaiver = waiver(); st.offerExpires = iso(7);
      return res(200, { decision: 'approved', application_id: st.application.id, offer: terms(a, st.offerWaiver) });
    }
    let m = /^\/applications\/([\w-]+)\/(accept|sign|disburse)$/.exec(path);
    if (method === 'POST' && m) {
      if (m[2] === 'accept') { st.next = 'sign'; return res(200, { status: 'agreement_sent' }); }
      if (m[2] === 'sign') { if (String(body.code) !== SIGN_CODE) return err(400, 'bad_code', 'That code is not right.'); st.next = 'bank'; return res(200, { status: 'signed' }); }
      const t = terms(st.offer, st.offerWaiver || 0);
      if (st.offerWaiver) st.reward = null;
      st.loan = { loan_id: 'L' + Date.now(), status: 'active', principal: st.offer, due_date: iso(30), outstanding: t.repayment, days_overdue: 0, apr_pct: t.aprSimplePct };
      st.next = 'loan'; st.offerWaiver = 0;
      return res(200, { status: 'paid', due_date: st.loan.due_date });
    }
    if (method === 'POST' && path === '/loan/pay') {
      st.history.push({ loan_id: st.loan.loan_id, status: 'closed', amount: st.loan.principal, disbursed_at: stamp(-30), closed_at: stamp(0) });
      st.repaid += 1; st.loan = null; st.offer = null; st.application = null; st.next = 'start';
      st.cap = Math.min(50000, 10000 + 5000 * st.repaid);
      if (st.repaid >= 3) st.spins += 1;
      if (!st.profile) st.profile = { ...JOB };
      return res(200, { status: 'paid' });
    }
    return err(404, 'not_found', 'Not found.');
  }

  window.fetch = async (url, opts = {}) => {
    const u = new URL(String(url), 'http://x');
    if (!u.pathname.startsWith('/api/')) return err(404, 'not_found', 'Not found.');
    let body = {}; try { body = opts.body ? JSON.parse(opts.body) : {}; } catch { /* none */ }
    await wait(120);
    return handle((opts.method || 'GET').toUpperCase(), u.pathname.slice(4), u.searchParams, body);
  };

  // scenario bar
  document.addEventListener('DOMContentLoaded', () => {
    const bar = document.createElement('div');
    bar.id = 'protobar';
    bar.innerHTML = '<b>PROTOTYPE</b><label>Scenario <select id="protosel">' + Object.entries(SCENARIOS).map(([k, v]) => `<option value="${k}"${k === scenario ? ' selected' : ''}>${v}</option>`).join('') + '</select></label><button id="protorst" type="button">Restart</button><span>Sign-in code 123456 · agreement code ' + SIGN_CODE + ' · nothing here is real</span>';
    document.body.prepend(bar);
    document.getElementById('protosel').addEventListener('change', (e) => { location.hash = 's=' + e.target.value; location.reload(); });
    document.getElementById('protorst').addEventListener('click', () => location.reload());
  });
})();
