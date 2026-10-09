// The customer app. One screen at a time, driven by what the server says the customer's next step is (GET /api/me),
// so a customer who closes the app or switches phone resumes exactly where they were. No keys or loan data live in
// the browser: only a signed session cookie, and the page state below.
import { STRINGS } from './i18n.js';

const root = document.getElementById('root');
const S = {
  lang: 'en', cfg: null, me: null, screen: 'boot', form: {}, errors: {}, formError: '', busy: false, toast: '', sheet: null,
  checkStep: 0, quote: null, installEvt: null, otpHint: '',
};

// ---------------------------------------------------------------- helpers
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable: fine */ } },
};
const t = (k, v = {}) => String((STRINGS[S.lang] && STRINGS[S.lang][k]) ?? STRINGS.en[k] ?? k).replace(/\{(\w+)\}/g, (_, n) => (v[n] ?? ''));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = (n) => `₹${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(Number(n))}`;
const pct = (n) => `${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 1 }).format(Number(n))}%`;
const locale = () => (S.lang === 'hi' ? 'hi-IN' : 'en-IN');
const dateFmt = (iso) => new Date(`${String(iso).slice(0, 10)}T00:00:00`).toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: 'numeric' });
const daysUntil = (iso) => Math.round((new Date(`${String(iso).slice(0, 10)}T00:00:00`) - new Date(new Date().toDateString())) / 86_400_000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class ApiError extends Error { constructor(status, data) { super(data?.message || 'error'); this.status = status; this.data = data || {}; } }

async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method, credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-zenin': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    showToast(t('offline'));
    throw new ApiError(0, { message: t('offline') });
  }
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (res.status === 401 && path !== '/otp/verify') { S.me = null; S.form = {}; go('login'); throw new ApiError(401, data); }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

function showToast(msg) {
  S.toast = msg;
  render();
  setTimeout(() => { if (S.toast === msg) { S.toast = ''; render(); } }, 3500);
}

// ---------------------------------------------------------------- navigation
const FLOW = ['amount', 'consent', 'details', 'checking', 'offer', 'sign', 'bank', 'paid'];
function go(screen) {
  S.screen = screen; S.errors = {}; S.formError = ''; S.sheet = null;
  render();
  if (screen === 'amount') loadQuote();
  const h = root.querySelector('h1');
  if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: false }); }
}

function route(me) {
  S.me = me;
  const map = { start: 'amount', offer: 'offer', sign: 'sign', bank: 'bank', loan: 'loan', review: 'review', declined: 'declined', kyc_pending: 'kyc_pending', blocked: 'blocked' };
  if (S.form.amount === undefined) S.form.amount = Math.min(10000, me.cap);
  S.form.amount = Math.min(Math.max(S.form.amount, me.min_amount), me.cap);
  go(map[me.next] || 'amount');
}

async function refreshMe() { S.me = await api('/me'); return S.me; }

// ---------------------------------------------------------------- views
const field = ({ id, label, hint = '', type = 'text', value = '', attrs = '', error = '' }) => `
  <div class="field"><label for="${id}">${esc(label)}</label>
  <input id="${id}" name="${id}" type="${type}" value="${esc(value)}" ${attrs} data-bind="${id}" ${error ? 'aria-invalid="true"' : ''} aria-describedby="${id}-m">
  <div id="${id}-m">${hint ? `<span class="hint">${esc(hint)}</span>` : ''}${error ? `<div class="err" role="alert">${esc(error)}</div>` : ''}</div></div>`;

const select = ({ id, label, options, value, error = '', prefix }) => `
  <div class="field"><label for="${id}">${esc(label)}</label>
  <select id="${id}" name="${id}" data-bind="${id}" ${error ? 'aria-invalid="true"' : ''}>
    <option value="">${esc(t('choose'))}</option>
    ${options.map((o) => `<option value="${o}" ${value === o ? 'selected' : ''}>${esc(t(prefix + o))}</option>`).join('')}
  </select>${error ? `<div class="err" role="alert">${esc(error)}</div>` : ''}</div>`;

const kv = (rows) => `<dl class="kv panel">${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
const btn = (label, act, cls = '', extra = '') => `<button class="btn block ${cls}" type="button" data-act="${act}" ${extra} ${S.busy ? 'disabled' : ''}>${esc(label)}</button>`;
const ghost = (label, act) => `<button class="btn block ghost" type="button" data-act="${act}" ${S.busy ? 'disabled' : ''}>${esc(label)}</button>`;
const termsRows = (o) => [
  [t('youReceive'), inr(o.amount)], [t('fee'), inr(o.fee)], [t('youRepay', { days: o.tenureDays }), `<strong>${inr(o.repayment)}</strong>`],
  [t('aprSimple'), pct(o.aprSimplePct)], [t('aprEff'), pct(o.aprEffectivePct)],
];

const SCREENS = {
  boot: () => ({ body: `<p class="muted">${esc(t('loading'))}</p>` }),

  login: () => ({
    body: `<h1>${esc(t('loginTitle'))}</h1><p class="muted">${esc(t('loginSub'))}</p>
      ${field({ id: 'mobile', label: t('mobileLabel'), hint: t('mobileHint'), type: 'tel', value: S.form.mobile || '', attrs: 'inputmode="numeric" autocomplete="tel-national" maxlength="14"', error: S.errors.mobile })}
      ${S.cfg?.demo ? `<p class="fine">${esc(t('demoTip', { otp: S.cfg.demo.otp }))}</p>` : ''}
      ${S.formError ? `<div class="err" role="alert">${esc(S.formError)}</div>` : ''}`,
    foot: btn(t('sendCode'), 'send-code'),
  }),

  otp: () => ({
    body: `<h1>${esc(t('otpTitle'))}</h1><p class="muted">${esc(t('otpSub', { mobile: `+91 ${S.form.mobile}` }))}</p>
      ${field({ id: 'code', label: t('codeLabel'), type: 'text', value: S.form.code || '', attrs: 'inputmode="numeric" autocomplete="one-time-code" maxlength="6" class="code"', error: S.errors.code })}
      ${S.formError ? `<div class="err" role="alert">${esc(S.formError)}</div>` : ''}
      <button class="linkbtn" type="button" data-act="send-code">${esc(t('resend'))}</button>
      <button class="linkbtn" type="button" data-act="change-number">${esc(t('changeNumber'))}</button>`,
    foot: btn(t('verify'), 'verify'),
  }),

  amount: () => {
    const me = S.me; const q = S.quote;
    return {
      body: `<h1>${esc(me.is_repeat ? t('welcomeBack') + '. ' + t('amountTitle') : t('amountTitle'))}</h1><p class="muted">${esc(t('amountSub', { cap: inr(me.cap) }))}</p>
        <div class="amount-pick"><output id="amount-out" for="amount">${inr(S.form.amount)}</output>
        <input id="amount" type="range" min="${me.min_amount}" max="${me.cap}" step="500" value="${S.form.amount}" data-amount aria-label="${esc(t('amountTitle'))}"></div>
        <div id="quote">${q ? kv(termsRows(q)) : ''}</div>
        <p class="fine">${esc(t('amountNote'))}</p>`,
      foot: btn(t('cont'), 'amount-next'),
    };
  },

  consent: () => {
    const req = ['kyc', 'credit_bureau', 'terms'];
    const c = S.form.consents || {};
    return {
      body: `<h1>${esc(t('consentTitle'))}</h1><p class="muted">${esc(t('consentSub'))}</p>
        ${req.map((p) => `<label class="check"><input type="checkbox" data-consent="${p}" ${c[p] ? 'checked' : ''}><span><strong>${esc(t('c_' + p))}</strong><small>${esc(t('c_' + p + '_d'))}</small></span></label>`).join('')}
        <p class="fine"><a href="/privacy" target="_blank" rel="noopener">${esc(t('privacy'))}</a> · <a href="/terms" target="_blank" rel="noopener">${esc(t('terms'))}</a></p>
        ${S.formError ? `<div class="err" role="alert">${esc(S.formError)}</div>` : ''}`,
      foot: btn(t('agreeContinue'), 'consent-next', '', req.every((p) => c[p]) ? '' : 'disabled'),
    };
  },

  details: () => {
    const f = S.form; const e = S.errors;
    return {
      body: `<h1>${esc(t('detailsTitle'))}</h1><p class="muted">${esc(t('detailsSub'))}</p>
        ${field({ id: 'monthly_salary', label: t('salaryLabel'), value: f.monthly_salary || '', attrs: 'inputmode="numeric" autocomplete="off"', error: e.monthly_salary })}
        ${select({ id: 'employer_type', label: t('employerLabel'), options: ['govt_psu', 'listed_large', 'mnc', 'sme_registered', 'startup', 'unknown', 'informal'], value: f.employer_type, error: e.employer_type, prefix: 'emp_' })}
        ${field({ id: 'months_with_employer', label: t('monthsLabel'), value: f.months_with_employer || '', attrs: 'inputmode="numeric" autocomplete="off"', error: e.months_with_employer })}
        ${select({ id: 'residence', label: t('residenceLabel'), options: ['owned', 'family', 'rented_long', 'rented_short', 'none'], value: f.residence, error: e.residence, prefix: 'res_' })}
        ${select({ id: 'purpose', label: t('purposeLabel'), options: ['medical', 'bills', 'education', 'travel', 'family', 'other'], value: f.purpose, error: e.purpose, prefix: 'pur_' })}
        ${field({ id: 'pan', label: t('panLabel'), hint: t('panHint'), value: f.pan || '', attrs: 'autocomplete="off" autocapitalize="characters" maxlength="10" style="text-transform:uppercase"', error: e.pan })}
        ${S.formError ? `<div class="err" role="alert">${esc(S.formError)}</div>` : ''}`,
      foot: btn(t('getOffer'), 'apply'),
    };
  },

  checking: () => {
    const steps = [t('ck1'), t('ck2'), t('ck3')];
    return {
      body: `<h1>${esc(t('checkingTitle'))}</h1><p class="muted">${esc(t('checkingSub'))}</p>
        <div class="checking" aria-live="polite">${steps.map((s, i) => `<div class="${i < S.checkStep ? 'done' : i === S.checkStep ? 'run' : ''}"><span class="dot">${i < S.checkStep ? '✓' : ''}</span>${esc(s)}</div>`).join('')}</div>
        <p class="fine">${esc(t('keepOpen'))}</p>`,
    };
  },

  offer: () => {
    const o = S.me.offer;
    return {
      body: `<span class="badge ok">${esc(t('approved'))}</span><h1>${esc(t('offerTitle'))}</h1><p class="muted">${esc(t('offerSub'))}</p>
        <div class="money-card"><span class="label">${esc(t('borrow'))}</span><span class="big">${inr(o.amount)}</span></div>
        ${kv([...termsRows(o), [t('lateCharge'), esc(t('lateChargeVal', { pct: o.lateChargePctPerDay }))]])}
        <p class="fine">${esc(t('dueRule', { days: o.tenureDays }))}</p>`,
      foot: btn(t('acceptOffer'), 'accept', 'money') + ghost(t('notNow'), 'not-now'),
    };
  },

  saved: () => ({
    body: `<h1>${esc(t('savedTitle'))}</h1><p class="muted">${esc(t('savedSub'))}</p>`,
    foot: ghost(t('signOut'), 'logout'),
  }),

  review: () => ({
    body: `<span class="badge info">${esc(t('reference'))}: ${esc(S.me.application?.reference || '')}</span><h1>${esc(t('reviewTitle'))}</h1><p class="muted">${esc(t('reviewSub'))}</p>`,
    foot: ghost(t('refresh'), 'refresh') + ghost(t('signOut'), 'logout'),
  }),

  declined: () => ({
    body: `<h1>${esc(t('declinedTitle'))}</h1><p class="muted">${esc(t('declinedSub'))}</p>
      ${S.me.declined_until ? `<p>${esc(t('tryAfter', { date: dateFmt(S.me.declined_until) }))}</p>` : ''}
      <div class="panel"><p class="fine">${esc(t('declinedHelp'))}</p><a href="/contact" target="_blank" rel="noopener">${esc(t('contactUs'))}</a></div>`,
    foot: (S.me.next === 'start' ? btn(t('applyAgain'), 'apply-again') : '') + ghost(t('signOut'), 'logout'),
  }),

  kyc_pending: () => ({
    body: `<h1>${esc(t('kycPendingTitle'))}</h1><p class="muted">${esc(t('kycPendingSub'))}</p>`,
    foot: ghost(t('refresh'), 'refresh') + ghost(t('signOut'), 'logout'),
  }),

  blocked: () => ({
    body: `<h1>${esc(t('blockedTitle'))}</h1><p class="muted">${esc(t('blockedSub'))}</p><a href="/contact" target="_blank" rel="noopener">${esc(t('contactUs'))}</a>`,
    foot: ghost(t('signOut'), 'logout'),
  }),

  sign: () => {
    const o = S.me.offer; const f = S.form;
    return {
      body: `<h1>${esc(t('signTitle'))}</h1><p class="muted">${esc(t('signSub'))}</p>
        ${kv([...termsRows(o), [t('lateCharge'), esc(t('lateChargeVal', { pct: o.lateChargePctPerDay }))]])}
        <label class="check"><input type="checkbox" data-signagree ${f.signAgree ? 'checked' : ''}><span>${esc(t('agreeBox'))}</span></label>
        ${field({ id: 'signCode', label: t('signCodeLabel'), value: f.signCode || '', attrs: 'inputmode="numeric" autocomplete="one-time-code" maxlength="6" class="code"', error: S.errors.signCode })}
        ${S.cfg?.demo ? `<p class="fine">${esc(t('demoSign', { code: S.cfg.demo.sign_code }))}</p>` : ''}
        ${S.formError ? `<div class="err" role="alert">${esc(S.formError)}</div>` : ''}`,
      foot: btn(t('signBtn'), 'sign', '', f.signAgree ? '' : 'disabled'),
    };
  },

  bank: () => {
    const f = S.form; const e = S.errors; const o = S.me.offer;
    return {
      body: `<h1>${esc(t('bankTitle'))}</h1><p class="muted">${esc(t('bankSub'))}</p>
        ${field({ id: 'acct_name', label: t('nameLabel'), value: f.acct_name || '', attrs: 'autocomplete="name"', error: e.name })}
        ${field({ id: 'acct_number', label: t('accLabel'), value: f.acct_number || '', attrs: 'inputmode="numeric" autocomplete="off"', error: e.number })}
        ${field({ id: 'acct_ifsc', label: t('ifscLabel'), value: f.acct_ifsc || '', attrs: 'autocomplete="off" autocapitalize="characters" maxlength="11" style="text-transform:uppercase"', error: e.ifsc })}
        <p class="fine">${esc(t('notStored'))}</p>
        ${S.formError ? `<div class="err" role="alert">${esc(S.formError)}</div>` : ''}`,
      foot: btn(t('sendMoney', { amount: inr(o.amount) }), 'disburse', 'money'),
    };
  },

  processing: () => ({
    body: `<h1>${esc(t('processingTitle'))}</h1><p class="muted">${esc(t('processingSub'))}</p>`,
    foot: btn(t('refresh'), 'refresh'),
  }),

  paid: () => ({
    body: `<div class="tick" aria-hidden="true">✓</div><h1>${esc(t('paidTitle', { amount: inr(S.paid?.amount) }))}</h1><p class="muted">${esc(t('paidSub', { date: S.paid?.due ? dateFmt(S.paid.due) : '' }))}</p>`,
    foot: btn(t('seeLoan'), 'see-loan'),
  }),

  loan: () => {
    const l = S.me.loan; const left = daysUntil(l.due_date);
    return {
      body: `<h1>${esc(t('loanTitle'))}</h1>
        <div class="money-card"><span class="label">${esc(t('amountDue'))}</span><span class="big">${inr(l.outstanding)}</span><span class="label">${esc(t('dueOn', { date: dateFmt(l.due_date) }))}</span></div>
        ${kv([[t('borrowed'), inr(l.principal)], [t('status'), `<span class="badge ${l.status === 'overdue' ? 'bad' : 'ok'}">${esc(t(l.status === 'overdue' ? 'st_overdue' : 'st_active'))}</span>`], [left >= 0 ? t('daysLeft', { n: left }) : t('overdueBy', { n: l.days_overdue }), '']])}`,
      foot: btn(t('repayNow'), 'repay', 'money'),
    };
  },

  pay: () => {
    const l = S.me.loan;
    return {
      body: `<h1>${esc(t('payTitle', { amount: inr(l.outstanding) }))}</h1><p class="muted">${esc(t('paySub'))}</p>
        ${S.cfg?.mode === 'demo' ? `<p class="fine">${esc(t('payDemo'))}</p>` : ''}${S.formError ? `<div class="err" role="alert">${esc(S.formError)}</div>` : ''}`,
      foot: btn(t('payNow', { amount: inr(l.outstanding) }), 'pay-now', 'money') + ghost(t('back'), 'see-loan'),
    };
  },

  repaid: () => ({
    body: `<div class="tick" aria-hidden="true">✓</div><h1>${esc(t('repaidTitle'))}</h1><p class="muted">${esc(t('repaidSub'))}</p>`,
    foot: btn(t('borrowAgain'), 'borrow-again') + ghost(t('done'), 'logout'),
  }),
};

// ---------------------------------------------------------------- shell
function sheetHtml() {
  if (!S.sheet) return '';
  let inner = '';
  if (S.sheet === 'menu') {
    inner = `<button class="btn block ghost" data-act="open-history">${esc(t('history'))}</button>
      <button class="btn block ghost" data-act="open-perms">${esc(t('permissions'))}</button>
      ${S.installEvt ? `<button class="btn block ghost" data-act="install">${esc(t('install'))}</button>` : ''}
      <a class="btn block ghost" href="/privacy" target="_blank" rel="noopener">${esc(t('privacy'))}</a>
      <a class="btn block ghost" href="/contact" target="_blank" rel="noopener">${esc(t('help'))}</a>
      <button class="btn block" data-act="logout">${esc(t('signOut'))}</button>`;
  } else if (S.sheet === 'history') {
    const h = S.me?.history || [];
    inner = `<h2>${esc(t('histTitle'))}</h2>${h.length ? `<div class="list">${h.map((x) => `<div class="item"><span>${inr(x.amount)} · ${esc(x.disbursed_at ? dateFmt(x.disbursed_at) : '')}</span><span class="badge info">${esc(t('st_' + x.status))}</span></div>`).join('')}</div>` : `<p class="muted">${esc(t('noLoans'))}</p>`}
      <button class="btn block ghost" data-act="close-sheet">${esc(t('close'))}</button>`;
  } else if (S.sheet === 'perms') {
    const c = S.me?.consents || [];
    inner = `<h2>${esc(t('permTitle'))}</h2><p class="muted">${esc(t('permSub'))}</p>
      ${c.length ? `<div class="list">${c.map((p) => `<div class="item"><span>${esc(t('p_' + p))}</span><button class="linkbtn" data-act="withdraw" data-purpose="${esc(p)}">${esc(t('withdraw'))}</button></div>`).join('')}</div>` : `<p class="muted">${esc(t('none'))}</p>`}
      <button class="btn block ghost" data-act="close-sheet">${esc(t('close'))}</button>`;
  }
  return `<div class="sheet" data-act="close-sheet-bg"><div role="dialog" aria-modal="true">${inner}</div></div>`;
}

function render() {
  const view = (SCREENS[S.screen] || SCREENS.boot)();
  const idx = FLOW.indexOf(S.screen);
  const signedIn = !!S.me;
  document.documentElement.lang = S.lang;
  root.innerHTML = `<div class="shell">
    <header class="appbar"><a class="brand" href="/app"><svg viewBox="0 0 32 32" width="24" height="24" aria-hidden="true"><circle cx="16" cy="16" r="11" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-dasharray="58 12" transform="rotate(-70 16 16)"/></svg><span>${esc(t('brand'))}</span></a>
      <div class="tools"><button class="chip" data-act="lang" data-lang="en" aria-pressed="${S.lang === 'en'}">EN</button><button class="chip" data-act="lang" data-lang="hi" aria-pressed="${S.lang === 'hi'}" lang="hi">हिं</button>
      ${signedIn ? `<button class="chip" data-act="open-menu" aria-label="${esc(t('menu'))}">☰</button>` : ''}</div></header>
    ${S.cfg?.mode === 'demo' ? `<div class="demo-strip" role="note">${esc(t('demoStrip'))}</div>` : ''}
    ${idx >= 0 ? `<div class="progress" aria-hidden="true">${FLOW.slice(0, 8).map((_, i) => `<i class="${i <= idx ? 'on' : ''}"></i>`).join('')}</div>` : ''}
    <main class="screen" id="screen">${view.body}</main>
    ${view.foot ? `<div class="footbar">${view.foot}</div>` : ''}
    ${S.toast ? `<div class="toast" role="status">${esc(S.toast)}</div>` : ''}
    ${sheetHtml()}
  </div>`;
}

// ---------------------------------------------------------------- actions
const digits = (s) => String(s ?? '').replace(/\D/g, '');

async function guarded(fn) {
  if (S.busy) return;
  S.busy = true; S.formError = ''; render();
  try { await fn(); } catch (e) {
    if (e instanceof ApiError && e.status !== 401 && e.status !== 0) {
      S.errors = e.data.fields || {};
      S.formError = e.data.fields ? t('e_check') : (e.data.message || t('e_generic'));
    }
  } finally { S.busy = false; render(); }
}

function openSheet(name) {
  S.sheet = name; render();
  const first = root.querySelector('.sheet button, .sheet a');
  if (first) first.focus();
}

const ACTIONS = {
  lang(el) { S.lang = el.dataset.lang; store.set('zenin_lang', S.lang); render(); },
  'open-menu'() { openSheet('menu'); },
  'open-history'() { openSheet('history'); },
  'open-perms'() { openSheet('perms'); },
  'close-sheet'() { S.sheet = null; render(); },
  async install() { const e = S.installEvt; S.installEvt = null; S.sheet = null; render(); if (e) { e.prompt(); await e.userChoice; } },
  logout() { return guarded(async () => { try { await api('/logout', { method: 'POST' }); } catch { /* already signed out */ } S.me = null; S.form = {}; go('login'); }); },

  'send-code'() {
    return guarded(async () => {
      const m = digits(S.form.mobile).replace(/^91(?=\d{10}$)/, '');
      if (!/^[6-9]\d{9}$/.test(m)) { S.errors = { mobile: t('mobileHint') }; return; }
      S.form.mobile = m;
      await api('/otp/send', { method: 'POST', body: { mobile: m } });
      S.form.code = '';
      go('otp'); showToast(t('codeSent'));
    });
  },
  'change-number'() { S.form.code = ''; go('login'); },
  verify() {
    return guarded(async () => {
      const code = digits(S.form.code);
      if (code.length !== 6) { S.errors = { code: t('codeLabel') }; return; }
      const me = await api('/otp/verify', { method: 'POST', body: { mobile: S.form.mobile, code } });
      S.form.code = '';
      route(me);
    });
  },

  'amount-next'() { go(S.me.missing_consents.length ? 'consent' : 'details'); },
  'consent-next'() {
    return guarded(async () => {
      await api('/consents', { method: 'POST', body: { purposes: ['kyc', 'credit_bureau', 'terms'] } });
      await refreshMe();
      go('details');
    });
  },
  async apply() {
    const f = S.form;
    if (S.busy) return;
    S.busy = true; S.errors = {}; S.formError = '';
    go('checking');
    S.checkStep = 0; render();
    const timer = setInterval(() => { if (S.screen === 'checking' && S.checkStep < 2) { S.checkStep += 1; render(); } }, 700);
    try {
      const [r] = await Promise.all([
        api('/applications', { method: 'POST', body: {
          amount: S.form.amount, monthly_salary: digits(f.monthly_salary), employer_type: f.employer_type, months_with_employer: digits(f.months_with_employer),
          residence: f.residence, purpose: f.purpose, pan: String(f.pan || '').toUpperCase(),
        } }),
        sleep(2200),
      ]);
      S.checkStep = 3; render(); await sleep(250);
      await refreshMe();
      route(S.me);
      if (r.decision === 'review' || r.decision === 'declined' || r.decision === 'kyc_pending') go(r.decision);
    } catch (e) {
      go('details');
      if (e instanceof ApiError && e.status !== 401 && e.status !== 0) {
        S.errors = e.data.fields || {};
        S.formError = e.data.fields ? t('e_check') : (e.data.message || t('e_generic'));
      }
    } finally { clearInterval(timer); S.busy = false; render(); }
  },

  accept() { return guarded(async () => { await api(`/applications/${S.me.application.id}/accept`, { method: 'POST' }); await refreshMe(); go('sign'); }); },
  'not-now'() { go('saved'); },
  'apply-again'() { go('amount'); },
  refresh() { return guarded(async () => { route(await refreshMe()); }); },
  sign() {
    return guarded(async () => {
      await api(`/applications/${S.me.application.id}/sign`, { method: 'POST', body: { code: digits(S.form.signCode) } });
      await refreshMe();
      go('bank');
    });
  },
  disburse() {
    return guarded(async () => {
      const f = S.form;
      const amount = S.me.offer.amount;
      const r = await api(`/applications/${S.me.application.id}/disburse`, { method: 'POST', body: { account: { name: f.acct_name, number: f.acct_number, ifsc: String(f.acct_ifsc || '').toUpperCase() } } });
      S.form.acct_number = ''; S.form.acct_name = ''; S.form.acct_ifsc = '';
      if (r.status === 'paid') { S.paid = { amount, due: r.due_date }; await refreshMe(); go('paid'); } else go('processing');
    });
  },
  'see-loan'() { return guarded(async () => { route(await refreshMe()); }); },
  repay() { go('pay'); },
  'pay-now'() {
    return guarded(async () => {
      const r = await api('/loan/pay', { method: 'POST' });
      if (r.status === 'link') { window.location.assign(r.payment_url); return; }
      await refreshMe();
      go('repaid');
    });
  },
  'borrow-again'() { return guarded(async () => { route(await refreshMe()); }); },
  withdraw(el) {
    return guarded(async () => { await api('/consents/revoke', { method: 'POST', body: { purpose: el.dataset.purpose } }); await refreshMe(); S.sheet = 'perms'; });
  },
};

root.addEventListener('click', (e) => {
  const bg = e.target.closest('[data-act="close-sheet-bg"]');
  if (bg && e.target === bg) { ACTIONS['close-sheet'](); return; }
  const el = e.target.closest('[data-act]');
  if (!el || el.dataset.act === 'close-sheet-bg') return;
  const fn = ACTIONS[el.dataset.act];
  if (fn) { e.preventDefault(); fn(el); }
});

root.addEventListener('input', (e) => {
  const el = e.target;
  if (el.matches('[data-amount]')) {
    S.form.amount = Number(el.value);
    document.getElementById('amount-out').textContent = inr(S.form.amount);
    clearTimeout(S.qt); S.qt = setTimeout(loadQuote, 120);
    return;
  }
  if (el.matches('[data-bind]')) {
    let v = el.value;
    if (el.id === 'code' || el.id === 'signCode') v = digits(v).slice(0, 6);
    if (el.id === 'mobile') v = v.replace(/[^\d+\s-]/g, '');
    if (el.id === 'pan' || el.id === 'acct_ifsc') v = v.toUpperCase();
    if (v !== el.value) el.value = v;
    S.form[el.id] = v;
    if (S.errors[el.id]) { delete S.errors[el.id]; const m = document.getElementById(`${el.id}-m`); if (m) m.querySelector('.err')?.remove(); el.removeAttribute('aria-invalid'); }
  }
});
root.addEventListener('change', (e) => {
  const el = e.target;
  if (el.matches('[data-consent]')) { S.form.consents = { ...(S.form.consents || {}), [el.dataset.consent]: el.checked }; render(); }
  if (el.matches('[data-signagree]')) { S.form.signAgree = el.checked; render(); }
  if (el.matches('select[data-bind]')) S.form[el.id] = el.value;
});
root.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('input[data-bind]')) {
    const primary = root.querySelector('.footbar .btn:not(.ghost)');
    if (primary && !primary.disabled) { e.preventDefault(); primary.click(); }
  }
});
// Escape closes the menu from anywhere: after a re-render focus sits on the page, not inside the app root
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.sheet) ACTIONS['close-sheet'](); });

async function loadQuote() {
  try {
    const q = await fetch(`/api/quote?amount=${S.form.amount}`, { credentials: 'same-origin' });
    if (!q.ok) return;
    S.quote = await q.json();
    const box = document.getElementById('quote');
    if (box && S.screen === 'amount') box.innerHTML = kv(termsRows(S.quote));
  } catch { /* offline: keep the last quote */ }
}

window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.installEvt = e; });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

// ---------------------------------------------------------------- start
(async function boot() {
  S.lang = store.get('zenin_lang') === 'hi' ? 'hi' : 'en';
  render();
  try {
    S.cfg = await (await fetch('/api/config')).json();
    S.form.amount = Math.min(10000, S.cfg.first_loan_max);
    try {
      const r = await fetch('/api/me', { credentials: 'same-origin' });
      if (r.ok) { route(await r.json()); await loadQuote(); return; }
    } catch { /* not signed in */ }
    go('login');
  } catch {
    showToast(t('offline'));
  }
})();
