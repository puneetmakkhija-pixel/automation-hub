// Run: node --test test-zenin-web.mjs  (CI also runs it as `node test-zenin-web.mjs`)
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { loadConfig, liveProblems, ORG_FIELDS } from './config.js';
import { createDemoGateway, createGateway } from './demo.js';
import { createOtp, createDemoOtp, DEMO_OTP } from './otp.js';
import { createSessions } from './session.js';
import { createLimiter } from './ratelimit.js';
import { createWebApp } from './app.js';
import { makeHttpServer } from './server.js';
import { STRINGS } from './public/js/i18n.js';
import { SITEMAP_PATHS } from './pages.js';

const SECRET = 's'.repeat(40);
const ORG = Object.fromEntries(Object.keys(ORG_FIELDS).map((k) => [k, `value-of-${k}`]));
let seq = 0;
const mobile = (d = 3) => `98${String(10000 + ++seq).padStart(7, '0')}${d}`.slice(0, 9) + d;

function site(envExtra = {}) {
  const cfg = loadConfig({ SITE_URL: 'https://zenin.test', SESSION_SECRET: SECRET, ...envExtra });
  const clock = { t: Date.now() };
  const now = () => clock.t;
  const gateway = createDemoGateway({ now: () => new Date(clock.t) });
  const otp = createDemoOtp({ now });
  const web = createWebApp({ cfg, gateway, otp, now });
  const get = (path, { headers = {}, query } = {}) => web.handle({ method: 'GET', path, query, headers });
  const client = () => {
    let cookie = '';
    const call = async (method, path, body, { headers = {}, raw } = {}) => {
      const r = await web.handle({
        method, path, headers: { 'x-zenin': '1', 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
        rawBody: raw ?? (body === undefined ? '' : JSON.stringify(body)),
      });
      const sc = r.headers['set-cookie'];
      if (sc) cookie = sc.split(';')[0];
      return { status: r.status, body: r.body ? JSON.parse(r.body) : null, headers: r.headers, text: r.body };
    };
    return { call, get cookie() { return cookie; } };
  };
  return { cfg, gateway, otp, web, get, client, advance: (ms) => { clock.t += ms; } };
}

async function login(c, m = mobile(3)) {
  assert.equal((await c.call('POST', '/api/otp/send', { mobile: m })).status, 200);
  const v = await c.call('POST', '/api/otp/verify', { mobile: m, code: DEMO_OTP });
  assert.equal(v.status, 200);
  return { me: v.body, mobile: m };
}
const consent = (c) => c.call('POST', '/api/consents', { purposes: ['kyc', 'credit_bureau', 'terms'] });
const details = (o = {}) => ({
  amount: 10000, monthly_salary: '48000', employer_type: 'listed_large', months_with_employer: '26', residence: 'rented_long', purpose: 'bills', pan: 'ABCDE1234F', ...o,
});
const account = { name: 'Asha Verma', number: '123456789012', ifsc: 'HDFC0001234' };

// ------------------------------------------------------------------ configuration and the live gate
test('config: demo by default, live lists everything missing, and live cannot start yet', () => {
  const demo = loadConfig({});
  assert.deepEqual([demo.mode, demo.reapplyAfterDays, demo.legalReviewed], ['demo', 0, false]);
  assert.throws(() => loadConfig({ ZENIN_MODE: 'prod' }), /demo.*live/);
  const live = loadConfig({ ZENIN_MODE: 'live', SITE_URL: 'http://x.test' });
  assert.equal(live.reapplyAfterDays, 30);
  const p = liveProblems(live, { gatewayReady: false, otpReady: false });
  for (const must of ['SESSION_SECRET', 'https', 'LEGAL_ENTITY_NAME', 'GRIEVANCE_OFFICER_EMAIL', 'LEGAL_REVIEWED', 'live gateway', 'OTP']) {
    assert.ok(p.some((x) => x.includes(must)), `expected a problem mentioning ${must}`);
  }
  const ready = loadConfig({ ZENIN_MODE: 'live', SITE_URL: 'https://z.test', SESSION_SECRET: SECRET, LEGAL_REVIEWED: '1', ...ORG });
  assert.deepEqual(liveProblems(ready, { gatewayReady: true, otpReady: true }), []);
  assert.throws(() => createGateway({ cfg: live }), /live gateway/);
  assert.throws(() => createOtp({ cfg: live }), /OTP/);
});

// ------------------------------------------------------------------ building blocks
test('sessions: signed, tamper-proof, expiring, revocable', () => {
  let t = 1_000_000;
  const s = createSessions({ secret: SECRET, hours: 1, now: () => t });
  const a = s.issue('cust-1', '3210');
  assert.match(a.cookie, /HttpOnly; SameSite=Lax; Max-Age=3600; Secure/);
  assert.equal(s.read(a.cookie.split(';')[0]).cid, 'cust-1');
  const [body, mac] = a.token.split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), cid: 'cust-2' })).toString('base64url');
  assert.equal(s.read(`zenin_sid=${forged}.${mac}`), null, 'a changed payload fails the signature');
  assert.equal(s.read(`zenin_sid=${body}.x${mac}`), null);
  assert.equal(createSessions({ secret: 'other-secret-other-secret-other-secret' }).read(`zenin_sid=${a.token}`), null, 'another secret cannot read it');
  s.revoke(a.payload);
  assert.equal(s.read(`zenin_sid=${a.token}`), null, 'logout revokes');
  const b = s.issue('cust-1');
  t += 3_600_001;
  assert.equal(s.read(`zenin_sid=${b.token}`), null, 'expired');
  assert.throws(() => createSessions({}), /secret/);
});

test('rate limiter: allows up to the max in a window, then reports when to retry', () => {
  let t = 0;
  const l = createLimiter({ windowMs: 1000, max: 2, now: () => t });
  assert.deepEqual([l.hit('a').ok, l.hit('a').ok, l.hit('a').ok], [true, true, false]);
  assert.ok(l.hit('a').retryAfter >= 1);
  assert.equal(l.hit('b').ok, true, 'keys are independent');
  t = 1001;
  assert.equal(l.hit('a').ok, true, 'a new window starts');
});

test('otp: wrong codes lock after 5 attempts, expiry works, success is single-use', async () => {
  let t = 0;
  const o = createDemoOtp({ now: () => t });
  assert.equal(await o.verify({ mobile: '1', code: DEMO_OTP }), 'expired', 'no code was sent');
  await o.send({ mobile: '1' });
  const r = [];
  for (let i = 0; i < 6; i += 1) r.push(await o.verify({ mobile: '1', code: '000000' }));
  assert.deepEqual(r, ['bad', 'bad', 'bad', 'bad', 'locked', 'locked']);
  assert.equal(await o.verify({ mobile: '1', code: DEMO_OTP }), 'locked', 'even the right code is refused once locked');
  await o.send({ mobile: '2' });
  assert.equal(await o.verify({ mobile: '2', code: DEMO_OTP }), 'ok');
  assert.equal(await o.verify({ mobile: '2', code: DEMO_OTP }), 'expired', 'a code works once');
  await o.send({ mobile: '3' });
  t = 5 * 60 * 1000 + 1;
  assert.equal(await o.verify({ mobile: '3', code: DEMO_OTP }), 'expired');
});

// ------------------------------------------------------------------ website
test('site: every page renders with a title, one h1 and security headers; unknown paths are 404', async () => {
  const s = site();
  for (const p of SITEMAP_PATHS) {
    const r = await s.get(p);
    assert.equal(r.status, 200, p);
    assert.match(r.body, /<title>[^<]+<\/title>/, p);
    assert.equal((r.body.match(/<h1[ >]/g) || []).length, 1, `${p} has exactly one h1`);
    assert.match(r.headers['content-security-policy'], /default-src 'self'/);
    assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.match(r.headers['strict-transport-security'], /max-age/);
    assert.doesNotMatch(r.body, /<script(?![^>]*\bsrc=)[^>]*>/, `${p}: no inline scripts, the CSP forbids them`);
  }
  const nf = await s.get('/no-such-page');
  assert.equal(nf.status, 404);
  assert.match(nf.body, /could not find/);
});

test('site: the demo is labelled and hidden from search; live is indexable but never the app', async () => {
  const d = site();
  const home = await d.get('/');
  assert.match(home.body, /Demo\./);
  assert.match(home.body, /noindex/);
  assert.match((await d.get('/robots.txt')).body, /Disallow: \//);
  const l = site({ ZENIN_MODE: 'live', LEGAL_REVIEWED: '1', ...ORG });
  const lh = await l.get('/');
  assert.doesNotMatch(lh.body, /Demo\./);
  assert.doesNotMatch(lh.body, /noindex/);
  const robots = (await l.get('/robots.txt')).body;
  assert.match(robots, /Disallow: \/app/);
  assert.match(robots, /Sitemap: https:\/\/zenin\.test\/sitemap\.xml/);
  assert.match((await l.get('/sitemap.xml')).body, /<loc>https:\/\/zenin\.test\/faq<\/loc>/);
  assert.match((await l.get('/app')).body, /noindex/, 'the app shell is never indexed');
});

test('site: missing lender details show as visible markers, filled ones show their value; legal text is marked draft until signed off', async () => {
  const bare = site({ ZENIN_MODE: 'demo' });
  const home = (await bare.get('/')).body;
  assert.match(home, /\[legal name of the company that runs this site: to be added\]/);
  assert.match((await bare.get('/grievance')).body, /class="draft"/);
  const full = site({ LEGAL_REVIEWED: '1', ...ORG });
  const g = (await full.get('/grievance')).body;
  assert.match(g, /value-of-GRIEVANCE_OFFICER_EMAIL/);
  assert.doesNotMatch(g, /to be added\]|class="draft"/);
  assert.doesNotMatch((await full.get('/')).body, /to be added\]/);
});

test('site: costs shown on the pages come from the engine, and nothing is double-escaped or injected', async () => {
  const s = site({ LEGAL_ENTITY_NAME: '<script>alert(1)</script> Ltd' });
  const home = (await s.get('/')).body;
  assert.match(home, /₹10,800/, 'the example repayment: 10,000 plus the 8 percent fee');
  assert.match(home, /97\.3%/);
  assert.doesNotMatch(home, /<script>alert/);
  assert.match(home, /&lt;script&gt;alert\(1\)&lt;\/script&gt; Ltd/);
  const q = await site().get('/api/quote', { query: { amount: '15000' } });
  assert.deepEqual(JSON.parse(q.body), { amount: 15000, fee: 1200, repayment: 16200, tenureDays: 30, aprSimplePct: 97.33, aprEffectivePct: 155.07, lateChargePctPerDay: 1 });
});

test('static files: served with the right type, nothing outside public/, only known types', async () => {
  const s = site();
  assert.match((await s.get('/css/site.css')).headers['content-type'], /text\/css/);
  assert.match((await s.get('/js/app.js')).headers['content-type'], /javascript/);
  assert.equal((await s.get('/sw.js')).headers['cache-control'], 'no-cache');
  for (const p of ['/../package.json', '/css/../../package.json', '/..%2fpackage.json', '/js/../../server.js', '/%2e%2e/config.js', '/css/site.css%00.png', '/package.json', '/server.js']) {
    assert.equal((await s.get(p)).status, 404, p);
  }
  assert.equal((await s.web.handle({ method: 'PUT', path: '/', headers: {} })).status, 405);
  assert.equal((await s.web.handle({ method: 'DELETE', path: '/api/me', headers: {} })).status, 405);
});

test('PWA: manifest is valid, its icons exist, and the service worker never touches /api', () => {
  const m = JSON.parse(readFileSync(new URL('./public/manifest.webmanifest', import.meta.url), 'utf8'));
  assert.deepEqual([m.start_url, m.display], ['/app', 'standalone']);
  for (const i of m.icons) assert.ok(existsSync(new URL(`./public${i.src}`, import.meta.url)), i.src);
  assert.ok(m.icons.some((i) => i.purpose === 'maskable' && i.sizes === '512x512'));
  const sw = readFileSync(new URL('./public/sw.js', import.meta.url), 'utf8');
  assert.match(sw, /startsWith\('\/api\/'\)\) return/);
});

test('app text: Hindi has every key English has, with the same placeholders', () => {
  const en = Object.keys(STRINGS.en);
  const hi = Object.keys(STRINGS.hi);
  assert.deepEqual(en.filter((k) => !hi.includes(k)), [], 'keys missing in Hindi');
  assert.deepEqual(hi.filter((k) => !en.includes(k)), [], 'keys only in Hindi');
  const ph = (s) => (s.match(/\{\w+\}/g) || []).sort().join();
  for (const k of en) assert.equal(ph(STRINGS.hi[k]), ph(STRINGS.en[k]), `placeholders differ in ${k}`);
});

// ------------------------------------------------------------------ API: access control
test('api: POST needs the custom header and JSON, session is required, bodies are validated', async () => {
  const s = site();
  const raw = (headers, rawBody = '{}') => s.web.handle({ method: 'POST', path: '/api/otp/send', headers, rawBody });
  assert.equal((await raw({ 'content-type': 'application/json' })).status, 403, 'no x-zenin header: a cross-site form cannot do this');
  assert.equal((await raw({ 'x-zenin': '1', 'content-type': 'text/plain' })).status, 415);
  assert.equal((await raw({ 'x-zenin': '1', 'content-type': 'application/json' }, '{bad')).status, 400);
  assert.equal((await raw({ 'x-zenin': '1', 'content-type': 'application/json' }, '[1]')).status, 400);
  const c = s.client();
  assert.equal((await c.call('GET', '/api/me')).status, 401);
  assert.equal((await c.call('POST', '/api/consents', { purposes: ['kyc'] })).status, 401);
  assert.equal((await c.call('POST', '/api/applications', {})).status, 401);
  assert.equal((await c.call('POST', '/api/otp/send', { mobile: '12345' })).status, 400);
  assert.equal((await c.call('POST', '/api/otp/send', { mobile: '5876543210' })).status, 400, 'Indian mobile numbers start 6 to 9');
  assert.equal((await c.call('GET', '/api/quote', undefined, {})).status, 400);
  assert.equal((await c.call('GET', '/api/nope')).status, 401, 'unknown API paths need a session too');
});

test('api: codes are rate limited per mobile, wrong codes lock, and a forged cookie is refused', async () => {
  const s = site();
  const c = s.client();
  const m = mobile(3);
  const codes = [];
  for (let i = 0; i < 4; i += 1) codes.push((await c.call('POST', '/api/otp/send', { mobile: m })).status);
  assert.deepEqual(codes, [200, 200, 200, 429], 'only 3 codes per mobile per 10 minutes');
  const m2 = mobile(3);
  await c.call('POST', '/api/otp/send', { mobile: m2 });
  const wrong = [];
  for (let i = 0; i < 5; i += 1) wrong.push((await c.call('POST', '/api/otp/verify', { mobile: m2, code: '000000' })).body.error);
  assert.deepEqual(wrong, ['bad_code', 'bad_code', 'bad_code', 'bad_code', 'locked']);
  assert.equal((await c.call('POST', '/api/otp/verify', { mobile: m2, code: DEMO_OTP })).status, 429);
  const forged = await s.client().call('GET', '/api/me', undefined, { headers: { cookie: 'zenin_sid=eyJjaWQiOiJ4In0.abc' } });
  assert.equal(forged.status, 401);
});

// ------------------------------------------------------------------ API: the customer journey
test('JOURNEY: sign in, permission, apply, offer, accept, sign, receive money, repay, borrow again with a higher limit', async () => {
  const s = site();
  const c = s.client();
  const { me, mobile: m } = await login(c, mobile(3));
  assert.deepEqual([me.next, me.cap, me.is_repeat, me.mobile_masked], ['start', 10000, false, `XXXXXX${m.slice(-4)}`], 'a first loan starts at the first-loan cap');
  assert.deepEqual(me.missing_consents, ['kyc', 'credit_bureau', 'terms']);

  const early = await c.call('POST', '/api/applications', details());
  assert.equal(early.body.error, 'consent_required', 'nothing is pulled before permission');
  assert.equal((await consent(c)).status, 200);

  const a = await c.call('POST', '/api/applications', details());
  assert.equal(a.status, 200);
  assert.deepEqual([a.body.decision, a.body.offer.amount, a.body.offer.repayment], ['approved', 10000, 10800]);
  const appId = a.body.application_id;
  for (const leak of ['grade', 'points', 'reasons', 'score', 'policy', 'cibil']) assert.doesNotMatch(a.text, new RegExp(leak, 'i'), `the customer never sees "${leak}"`);

  assert.equal((await c.call('GET', '/api/me')).body.next, 'offer', 'closing the app here resumes at the offer');
  assert.equal((await c.call('POST', '/api/applications', details())).body.error, 'application_in_progress');

  assert.equal((await c.call('POST', `/api/applications/${appId}/disburse`, { account })).status, 409, 'no money before the agreement is signed');
  assert.equal((await c.call('POST', `/api/applications/${appId}/accept`)).status, 200);
  assert.equal((await c.call('GET', '/api/me')).body.next, 'sign');
  assert.equal((await c.call('POST', `/api/applications/${appId}/sign`, { code: '000000' })).body.error, 'bad_code');
  assert.equal((await c.call('POST', `/api/applications/${appId}/sign`, { code: '246810' })).status, 200);
  assert.equal((await c.call('GET', '/api/me')).body.next, 'bank');

  const paid = await c.call('POST', `/api/applications/${appId}/disburse`, { account });
  assert.equal(paid.status, 200);
  assert.equal(paid.body.status, 'paid');
  assert.match(paid.body.due_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(!paid.text.includes(account.number), 'the account number is never echoed');
  assert.ok(!JSON.stringify((await c.call('GET', '/api/me')).body).includes(account.number));

  const loan = (await c.call('GET', '/api/me')).body;
  assert.equal(loan.next, 'loan');
  assert.deepEqual([loan.loan.principal, loan.loan.outstanding, loan.loan.status, loan.loan.days_overdue], [10000, 10800, 'active', 0]);
  assert.equal((await c.call('POST', `/api/applications/${appId}/disburse`, { account })).body.status, 'paid', 'a repeat tap does not pay twice');
  assert.equal(s.gateway.store.db.disbursements.filter((d) => d.status === 'success').length, 1);
  assert.equal((await c.call('POST', '/api/applications', details())).body.error, 'open_loan');

  const pay = await c.call('POST', '/api/loan/pay');
  assert.equal(pay.body.status, 'paid');
  const after = (await c.call('GET', '/api/me')).body;
  assert.deepEqual([after.next, after.is_repeat, after.cap], ['start', true, 15000], 'repaid on time: the limit rises one step');
  assert.equal(after.history[0].status, 'closed');

  const again = await c.call('POST', '/api/applications', details({ amount: 15000 }));
  assert.deepEqual([again.body.decision, again.body.offer.amount], ['approved', 15000]);
  assert.equal((await c.call('POST', '/api/applications', details({ amount: 20000 }))).status, 409, 'and an application is already open');
});

test('JOURNEY: a customer can sign out and back in at any step and land on the right screen', async () => {
  const s = site();
  const m = mobile(3);
  const a = s.client();
  await login(a, m);
  await consent(a);
  const app = (await a.call('POST', '/api/applications', details())).body.application_id;
  const reopen = async () => { s.advance(11 * 60 * 1000); const c = s.client(); return (await login(c, m)).me.next; };
  assert.equal(await reopen(), 'offer');
  await a.call('POST', `/api/applications/${app}/accept`);
  assert.equal(await reopen(), 'sign');
  await a.call('POST', `/api/applications/${app}/sign`, { code: '246810' });
  assert.equal(await reopen(), 'bank');
  await a.call('POST', `/api/applications/${app}/disburse`, { account });
  s.advance(11 * 60 * 1000);
  const c = s.client();
  assert.equal((await login(c, m)).me.next, 'loan');
  await c.call('POST', '/api/logout');
  assert.equal((await c.call('GET', '/api/me')).status, 401, 'logout ends the session');
});

test('JOURNEY: review and decline paths say little, and a declined customer is told when they can try again', async () => {
  const s = site({ REAPPLY_AFTER_DAYS: '30' });
  // a good file whose purpose is "other personal use" is raised for a person to look at (review flag RF12)
  const rev = s.client();
  await login(rev, mobile(3)); await consent(rev);
  const t = await rev.call('POST', '/api/applications', details({ purpose: 'other' }));
  assert.equal(t.body.decision, 'review');
  assert.match(t.body.reference, /^[A-Z0-9]{8}$/);
  assert.doesNotMatch(t.text, /RF12|vague|purpose/i, 'the reason is not shown to the customer');
  assert.equal((await rev.call('GET', '/api/me')).body.next, 'review');

  for (const d of [7, 8, 9]) {
    const c = s.client();
    await login(c, mobile(d)); await consent(c);
    const r = await c.call('POST', '/api/applications', details());
    assert.equal(r.body.decision, 'declined', `numbers ending ${d} are declined (no credit history, NPA, identity check)`);
    for (const leak of ['NPA', 'bureau', 'grade', 'reason', 'RF1']) assert.doesNotMatch(r.text, new RegExp(leak, 'i'));
    const me = (await c.call('GET', '/api/me')).body;
    assert.equal(me.next, 'declined');
    assert.match(me.declined_until, /^\d{4}-\d{2}-\d{2}$/);
    const retry = await c.call('POST', '/api/applications', details());
    assert.equal(retry.body.error, 'reapply_later');
  }
});

test('JOURNEY: inputs are validated field by field, and a first loan cannot ask for more than the first-loan cap', async () => {
  const s = site();
  const c = s.client();
  await login(c); await consent(c);
  const bad = await c.call('POST', '/api/applications', details({ pan: 'bad', monthly_salary: '50', employer_type: 'x', residence: '', purpose: '', months_with_employer: 'abc' }));
  assert.equal(bad.status, 400);
  assert.deepEqual(Object.keys(bad.body.fields).sort(), ['employer_type', 'monthly_salary', 'months_with_employer', 'pan', 'purpose', 'residence']);
  for (const amount of [4500, 10500, 12000, 0, -500, 'abc']) assert.equal((await c.call('POST', '/api/applications', details({ amount }))).body.error, 'bad_amount', `amount ${amount}`);
  assert.equal((await c.call('GET', '/api/me')).body.next, 'start', 'nothing was created by the bad requests');
  const ok = await c.call('POST', '/api/applications', details({ pan: 'abcde1234f' }));
  assert.equal(ok.body.decision, 'approved', 'a lowercase PAN is accepted and upper-cased');
});

test('JOURNEY: the bank details form rejects bad input before anything is sent', async () => {
  const s = site();
  const c = s.client();
  await login(c); await consent(c);
  const app = (await c.call('POST', '/api/applications', details())).body.application_id;
  await c.call('POST', `/api/applications/${app}/accept`);
  await c.call('POST', `/api/applications/${app}/sign`, { code: '246810' });
  const r = await c.call('POST', `/api/applications/${app}/disburse`, { account: { name: '1', number: '12', ifsc: 'xx' } });
  assert.equal(r.status, 400);
  assert.deepEqual(Object.keys(r.body.fields).sort(), ['ifsc', 'name', 'number']);
  assert.equal(s.gateway.store.db.disbursements.length, 0);
  assert.equal((await c.call('POST', `/api/applications/${app}/disburse`, { account: { ...account, ifsc: 'hdfc0001234' } })).status, 200, 'a lowercase IFSC is accepted');
});

test('ISOLATION: one customer cannot act on another customer\'s application or loan', async () => {
  const s = site();
  const a = s.client(); const b = s.client();
  await login(a, mobile(3)); await consent(a);
  const appA = (await a.call('POST', '/api/applications', details())).body.application_id;
  await login(b, mobile(4)); await consent(b);
  for (const act of ['accept', 'sign', 'disburse']) {
    const r = await b.call('POST', `/api/applications/${appA}/${act}`, act === 'sign' ? { code: '246810' } : { account });
    assert.equal(r.status, 404, `B cannot ${act} A's application`);
  }
  assert.equal((await b.call('POST', `/api/applications/not-an-id!/accept`)).status, 404);
  assert.equal(s.gateway.store.db.agreements.length, 0, 'nothing happened to A');
  assert.equal((await a.call('GET', '/api/me')).body.next, 'offer');
  assert.equal((await b.call('GET', '/api/me')).body.next, 'start');
  assert.equal((await b.call('POST', '/api/loan/pay')).status, 404, 'B has no loan');
  // B's response never contains A's identifiers
  assert.ok(!JSON.stringify((await b.call('GET', '/api/me')).body).includes(appA));
});

test('permissions: a customer can see and withdraw them; withdrawing a required one blocks the next application', async () => {
  const s = site();
  const c = s.client();
  await login(c); await consent(c);
  assert.deepEqual((await c.call('GET', '/api/me')).body.consents.sort(), ['credit_bureau', 'kyc', 'terms']);
  assert.equal((await c.call('POST', '/api/consents', { purposes: ['nonsense'] })).status, 400);
  assert.equal((await c.call('POST', '/api/consents/revoke', { purpose: 'credit_bureau' })).status, 200);
  const me = (await c.call('GET', '/api/me')).body;
  assert.deepEqual(me.missing_consents, ['credit_bureau']);
  assert.equal((await c.call('POST', '/api/applications', details())).body.error, 'consent_required');
});

test('limits: a customer cannot open more than 3 applications in a day', async () => {
  const s = site();
  const c = s.client();
  await login(c, mobile(8)); await consent(c);
  const out = [];
  for (let i = 0; i < 4; i += 1) out.push((await c.call('POST', '/api/applications', details())).status);
  assert.deepEqual(out, [200, 200, 200, 429]);
});

// ------------------------------------------------------------------ live-only behaviour
test('live: demo-only routes are gone and repayment goes through a payment link', async () => {
  const cfg = loadConfig({ ZENIN_MODE: 'live', SITE_URL: 'https://z.test', SESSION_SECRET: SECRET, LEGAL_REVIEWED: '1', ...ORG });
  const gateway = createDemoGateway();
  gateway.collect = async () => ({ status: 201, body: { payment_url: 'https://pay.example/abc', amount: 10800 } });
  const web = createWebApp({ cfg, gateway, otp: createDemoOtp() });
  let cookie = '';
  const call = async (method, path, body) => {
    const r = await web.handle({ method, path, headers: { 'x-zenin': '1', 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, rawBody: body ? JSON.stringify(body) : '' });
    if (r.headers['set-cookie']) cookie = r.headers['set-cookie'].split(';')[0];
    return { status: r.status, body: JSON.parse(r.body), headers: r.headers };
  };
  const m = mobile(3);
  await call('POST', '/api/otp/send', { mobile: m });
  assert.match((await call('POST', '/api/otp/verify', { mobile: m, code: DEMO_OTP })).headers['set-cookie'] ?? '', /Secure/);
  assert.equal((await call('GET', '/api/config')).body.demo, null, 'no demo hints in live');
  await call('POST', '/api/consents', { purposes: ['kyc', 'credit_bureau', 'terms'] });
  const app = (await call('POST', '/api/applications', details())).body.application_id;
  await call('POST', `/api/applications/${app}/accept`);
  assert.equal((await call('POST', `/api/applications/${app}/sign`, { code: '246810' })).status, 404, 'there is no demo signing code in live');
  // make the loan exist through the gateway, as a signed payout would
  await gateway.signAgreement(app);
  assert.equal((await call('POST', `/api/applications/${app}/disburse`, { account })).status, 200);
  const pay = await call('POST', '/api/loan/pay');
  assert.deepEqual([pay.body.status, pay.body.payment_url], ['link', 'https://pay.example/abc']);
  gateway.collect = async () => ({ status: 201, body: { payment_url: 'http://insecure.example', amount: 1 } });
  assert.equal((await call('POST', '/api/loan/pay')).status, 502, 'a non-https payment link is never handed to the browser');
});

// ------------------------------------------------------------------ real HTTP
test('http: serves pages and the API over a real socket, caps request size, never leaks internals', async () => {
  const s = site();
  const server = makeHttpServer(s.web);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const h = await fetch(`${base}/healthz`);
    assert.deepEqual(await h.json(), { ok: true, mode: 'demo' });
    const page = await fetch(`${base}/faq`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Frequently asked questions/);
    const big = await fetch(`${base}/api/otp/send`, { method: 'POST', headers: { 'x-zenin': '1', 'content-type': 'application/json' }, body: JSON.stringify({ mobile: '9'.repeat(30000) }) });
    assert.equal(big.status, 413);
    assert.equal((await fetch(`${base}/healthz`)).status, 200, 'the server is still fine after an oversized body');
    const head = await fetch(`${base}/`, { method: 'HEAD' });
    assert.equal(head.status, 200);
  } finally { await new Promise((r) => server.close(r)); }
});

test('demo: refuses new customers past its cap instead of growing without limit, but lets existing ones in', async () => {
  const cfg = loadConfig({ SITE_URL: 'https://zenin.test', SESSION_SECRET: SECRET });
  const web = createWebApp({ cfg, gateway: createDemoGateway({ maxCustomers: 1 }), otp: createDemoOtp() });
  let cookie = '';
  const call = async (path, body) => web.handle({ method: 'POST', path, headers: { 'x-zenin': '1', 'content-type': 'application/json' }, rawBody: JSON.stringify(body) });
  const enter = async (m) => { await call('/api/otp/send', { mobile: m }); return call('/api/otp/verify', { mobile: m, code: DEMO_OTP }); };
  const first = mobile(3);
  assert.equal((await enter(first)).status, 200);
  const full = await enter(mobile(4));
  assert.deepEqual([full.status, JSON.parse(full.body).error], [503, 'busy']);
  assert.equal((await enter(first)).status, 200, 'the customer already in can still sign in');
  void cookie;
});
