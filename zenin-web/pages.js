// Website pages and the app shell, rendered on the server so every page works without JavaScript and search engines
// see real content. Wording that depends on who the lender is (names, registration, grievance officer) comes from the
// configuration; while a field is still missing it shows as a visible "[... to be added]" marker, never an invented value.
import { feeFor, repaymentFor, aprFor } from '../payday-engine/index.js';
import { orgText } from './config.js';

export const SITEMAP_PATHS = ['/', '/how-it-works', '/rates-and-charges', '/eligibility', '/faq', '/about', '/contact', '/grievance', '/fair-practices', '/privacy', '/terms'];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = (n) => `₹${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(n)}`;
const pct = (n) => `${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 1 }).format(n)}%`;

const MARK = '<svg class="mark" viewBox="0 0 32 32" aria-hidden="true" width="28" height="28"><circle cx="16" cy="16" r="11" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-dasharray="58 12" transform="rotate(-70 16 16)"/></svg>';

const NAV = [['/how-it-works', 'How it works'], ['/rates-and-charges', 'The bill'], ['/eligibility', 'Who can apply'], ['/faq', 'FAQ'], ['/contact', 'Help']];

function example(product, amount = 10000) {
  const days = Number(product.tenure_days);
  const apr = aprFor(product, amount, days);
  return { amount, days, fee: feeFor(product, amount), repay: repaymentFor(product, amount), aprSimple: apr.aprSimplePct, aprEff: apr.aprEffectivePct };
}

function layout({ cfg, product, title, description, path, body, draftLegal = false }) {
  const demo = cfg.mode === 'demo';
  const t = path === '/' ? `${cfg.brand}: short-term loans with the cost shown first` : `${title} | ${cfg.brand}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(t)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(cfg.siteUrl + (path === '/' ? '' : path))}">
${demo ? '<meta name="robots" content="noindex, nofollow">' : ''}
<meta property="og:title" content="${esc(t)}"><meta property="og:description" content="${esc(description)}"><meta property="og:type" content="website"><meta property="og:url" content="${esc(cfg.siteUrl + path)}">
<meta name="theme-color" content="#0e3b36">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icons/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icons/icon-192.png">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Anton&family=DM+Mono:wght@400;500&family=Hind:wght@400;500;600&display=swap">
<link rel="stylesheet" href="/css/site.css">
</head>
<body class="site">
<a class="skip" href="#main">Skip to content</a>
${demo ? '<div class="demo-bar" role="note"><strong>Demo.</strong> No real loans, no real money, and nothing you enter is kept. Please do not enter real PAN, bank or personal details.</div>' : ''}
<header class="top">
  <div class="wrap row">
    <a class="brand" href="/" aria-label="${esc(cfg.brand)} home">${MARK}<span>Zenin <b>Credit</b></span></a>
    <nav class="nav" aria-label="Main">${NAV.map(([h, l]) => `<a href="${h}"${h === path ? ' aria-current="page"' : ''}>${l}</a>`).join('')}</nav>
    <a class="btn small" href="/app">Check your offer</a>
    <details class="menu"><summary aria-label="Menu"><span></span></summary><div>${NAV.map(([h, l]) => `<a href="${h}">${l}</a>`).join('')}<a href="/app">Check your offer</a></div></details>
  </div>
</header>
<main id="main">
${draftLegal ? '<div class="wrap"><p class="draft" role="note"><strong>Draft.</strong> This text has not yet been reviewed by the lender\'s compliance team and must not be relied on until it is.</p></div>' : ''}
${body}
</main>
<footer class="foot">
  <div class="wrap">
    <div class="cols">
      <div><a class="brand" href="/">${MARK}<span>Zenin <b>Credit</b></span></a>
        <p class="muted">Short-term loans for salaried people in India.</p></div>
      <div><h2>Learn</h2><a href="/how-it-works">How it works</a><a href="/rates-and-charges">Rates and charges</a><a href="/eligibility">Who can apply</a><a href="/faq">FAQ</a></div>
      <div><h2>Help</h2><a href="/contact">Contact us</a><a href="/grievance">Grievance redressal</a><a href="/fair-practices">Fair practices</a></div>
      <div><h2>Legal</h2><a href="/privacy">Privacy notice</a><a href="/terms">Terms of use</a></div>
    </div>
    <p class="fine">${esc(cfg.brand)} is operated by ${esc(orgText(cfg, 'LEGAL_ENTITY_NAME'))}, registered office: ${esc(orgText(cfg, 'REGISTERED_ADDRESS'))}.
    Loans are made by ${esc(orgText(cfg, 'LENDER_NAME'))} (${esc(orgText(cfg, 'LENDER_REGISTRATION'))}).</p>
    <p class="fine">Borrow only what you can repay. Late repayment adds charges and can lower your credit score.</p>
  </div>
</footer>
<script src="/js/site.js" defer></script>
</body>
</html>`;
}

function calculator(product) {
  const min = Number(product.min_amount);
  const max = Number(product.max_amount);
  const e = example(product);
  return `<div class="calc tape" data-calc data-min="${min}" data-max="${max}">
  <span class="stamp" aria-hidden="true">Example</span>
  <div class="rc-head">Zenin Credit</div>
  <div class="rc-sub">Your bill · ${e.days}-day loan</div>
  <hr class="dash">
  <div class="calc-head"><label for="calc-amount">How much do you need?</label><output id="calc-out" for="calc-amount">${inr(e.amount)}</output></div>
  <input id="calc-amount" type="range" min="${min}" max="${max}" step="500" value="${e.amount}">
  <div class="calc-scale"><span>${inr(min)}</span><span>${inr(max)}</span></div>
  <hr class="dash">
  <dl class="kv">
    <div><dt>You receive</dt><dd id="calc-receive">${inr(e.amount)}</dd></div>
    <div><dt>Fee</dt><dd id="calc-fee">${inr(e.fee)}</dd></div>
    <div><dt>You repay after ${e.days} days</dt><dd id="calc-repay"><strong>${inr(e.repay)}</strong></dd></div>
    <div><dt>Yearly cost, simple</dt><dd id="calc-apr-simple">${pct(e.aprSimple)}</dd></div>
    <div><dt>Yearly cost, compounded</dt><dd id="calc-apr-eff">${pct(e.aprEff)}</dd></div>
  </dl>
  <hr class="dash">
  <p class="fine">Example terms for illustration. Your offer depends on your details. You always see the final bill before you accept.</p>
  <a class="btn block" href="/app">Check my offer</a>
</div>`;
}

const sections = {
  '/': ({ cfg, product }) => {
    const e = example(product);
    return {
      title: 'Home',
      description: 'Short-term loans for salaried people. See the bill before you borrow. Apply on your phone.',
      body: `
<section class="hero"><div class="wrap grid2">
  <div>
    <p class="eyebrow">Short-term loans for salaried people</p>
    <h1>See the <span class="hl">bill</span> before you borrow.</h1>
    <p class="lead">Borrow ${inr(product.min_amount)} to ${inr(product.max_amount)} for ${product.tenure_days} days. Every loan comes with an itemised bill: what you get, what it costs, what you pay back and when. You read it first. You decide after.</p>
    <p class="cta-row"><a class="btn" href="/app">Check your offer</a><a class="btn ghost" href="/how-it-works">How it works</a></p>
    <ul class="ticks"><li>Apply on your phone, with your PAN</li><li>Checking your offer takes a few minutes</li><li>Saying no costs you nothing</li></ul>
  </div>
  ${calculator(product)}
</div></section>

<section class="band"><div class="wrap">
  <h2>How it works</h2>
  <p class="fine">Four lines on the bill. No fifth line.</p>
  <ol class="steps">
    <li><b>Tell us a little</b><span>Mobile number, PAN, and a few details about your job.</span></li>
    <li><b>Read your bill</b><span>Amount, fee, total to repay, due date and yearly cost.</span></li>
    <li><b>Sign, receive</b><span>Sign online. The money is sent to your own bank account.</span></li>
    <li><b>Pay the total</b><span>One payment on the due date, by UPI, net banking or card.</span></li>
  </ol>
</div></section>

<section><div class="wrap grid2">
  <div><h2>The fine print, in big print</h2>
    <p class="lead">On ${inr(e.amount)} for ${e.days} days you pay a fee of ${inr(e.fee)}, so you repay ${inr(e.repay)}. See <a href="/rates-and-charges">the bill</a> for how we calculate it.</p>
    <p>A short loan costs far more per year than a bank loan, because the fee is charged on a few weeks, not twelve months. We show the yearly figure so you can compare. If you can wait for payday, wait. A cheaper option is usually better.</p></div>
  <div class="tape promises">
    <div class="t">Our promises</div>
    <hr class="dash">
    <div>[x] One fee, shown before you accept</div>
    <div>[x] One repayment, no hidden instalments</div>
    <div>[x] Late charge shown in advance: ${esc(product.penalty_per_day_pct)}% of overdue, per day</div>
    <div>[x] We ask before using your data</div>
    <div>[x] A clear no, never silence</div>
    <div>[x] Leave at any step, free</div>
    <div>[x] A named grievance officer</div>
  </div>
</div></section>

<section class="yellowband"><div class="wrap">
  <h2>Read the bill first.</h2>
  <p class="cta-row center"><a class="btn" href="/app">Check your offer</a></p>
</div></section>`,
    };
  },

  '/how-it-works': ({ product }) => ({
    title: 'How it works',
    description: 'From first tap to repayment: what you need, what we check, and what happens at each step.',
    body: `<section><div class="wrap narrow"><div class="tape">
<h1>How it works</h1>
<p class="lead">Five steps, all on your phone. You can stop at any step.</p>
<h2>1. Verify your mobile number</h2><p>We send a 6-digit code to confirm the number is yours.</p>
<h2>2. Give your permission</h2><p>We ask separately for each thing we need: checking your identity, reading your credit report, and accepting the terms. You can say no, but we cannot offer a loan without them.</p>
<h2>3. Tell us about your job</h2><p>Your take-home salary, employer type, how long you have worked there, where you live, and your PAN. We use this and your credit report to decide.</p>
<h2>4. See your offer</h2><p>If we can offer a loan, you see the amount, fee, total to repay, repayment period and yearly cost. If we cannot, we tell you plainly, and you can ask us about the decision.</p>
<h2>5. Sign, receive, repay</h2><p>You sign the agreement online, enter your bank account details, and the money is sent to your own account. Repay the full amount on the due date. Repaying on time can raise your limit for next time.</p>
<h2>What you need</h2>
<ul><li>An Indian mobile number</li><li>Your PAN</li><li>A bank account in your own name</li><li>Your salary details</li></ul>
<p class="cta-row"><a class="btn" href="/app">Check your offer</a></p>
</div></div></section>`,
  }),

  '/rates-and-charges': ({ cfg, product }) => {
    const e = example(product);
    return {
      title: 'The bill: rates and charges',
      description: 'The fee, repayment, late charge and yearly cost of a loan, with a calculator.',
      body: `<section><div class="wrap grid2">
<div class="tape">
<h1>The bill</h1>
<p class="lead">One fee, one repayment. You see the exact figures before you accept.</p>
<table class="tbl"><tbody>
<tr><th scope="row">Loan amount</th><td>${inr(product.min_amount)} to ${inr(product.max_amount)} (new customers start lower)</td></tr>
<tr><th scope="row">Repayment period</th><td>${product.tenure_days} days, one repayment</td></tr>
<tr><th scope="row">Fee</th><td>${product.fee_type === 'flat' ? inr(product.fee_value) : `${esc(product.fee_value)}% of the amount`}. You receive the full amount and repay the amount plus the fee.</td></tr>
<tr><th scope="row">Late charge</th><td>${esc(product.penalty_per_day_pct)}% of the overdue amount for each day late. It does not compound.</td></tr>
<tr><th scope="row">Taxes and other charges</th><td>Any tax or charge that applies is shown in the key facts before you accept. [To be confirmed by the lender's compliance team]</td></tr>
</tbody></table>
<h2>Example</h2>
<p>You borrow ${inr(e.amount)} and receive ${inr(e.amount)}. After ${e.days} days you repay ${inr(e.repay)}: the amount plus a fee of ${inr(e.fee)}.</p>
<h2>What the yearly cost means</h2>
<p>The yearly cost shows what the fee would be over a year, so you can compare with other loans. We show it two ways:</p>
<ul><li><b>Simple, ${pct(e.aprSimple)}:</b> the fee divided by the amount, scaled up to 365 days.</li><li><b>Compounded, ${pct(e.aprEff)}:</b> the same, assuming you borrowed again on the same terms and the fee built on itself.</li></ul>
<p>Both are high because the fee covers a few weeks. Please borrow only if you are sure you can repay on the due date.</p>
</div>
${calculator(product)}
</div></section>`,
    };
  },

  '/eligibility': () => ({
    title: 'Who can apply',
    description: 'What you need to apply, and what we check before offering a loan.',
    body: `<section><div class="wrap narrow"><div class="tape">
<h1>Who can apply</h1>
<p class="lead">We offer loans to salaried people in India who can repay on the due date.</p>
<h2>You will need</h2>
<ul><li>To be salaried, with a regular monthly income</li><li>An Indian mobile number in your name</li><li>A PAN</li><li>A bank account in your own name</li><li>No other loan open with us</li></ul>
<p class="muted">Age limits and minimum income are set by the lender. [To be confirmed by the lender]</p>
<h2>What we check</h2>
<p>With your permission we verify your identity and look at your credit report. We also use what you tell us about your job. These decide whether we can offer a loan and how much.</p>
<h2>If we say no</h2>
<p>You will see a clear message, not a silent rejection. You can ask us about the decision and for a copy of the report we used. See <a href="/grievance">grievance redressal</a>.</p>
<h2>Repeat customers</h2>
<p>If you repay on time, your limit can go up. If you repay late, it can go down. You do not need to verify your identity again.</p>
<p class="cta-row"><a class="btn" href="/app">Check your offer</a></p>
</div></div></section>`,
  }),

  '/faq': ({ product }) => {
    const qa = [
      ['How much can I borrow?', `From ${inr(product.min_amount)} up to ${inr(product.max_amount)}. New customers start with a lower limit, and the limit can rise when you repay on time.`],
      ['How long do I have to repay?', `${product.tenure_days} days, in one payment. The exact due date is shown when the money is sent.`],
      ['What does it cost?', 'A single fee, shown in rupees and as a yearly percentage before you accept. See rates and charges.'],
      ['Will checking my offer affect my credit score?', 'With your permission we look at your credit report. This may be recorded as an enquiry on your report. Taking a loan and repaying late can lower your score.'],
      ['How do I repay?', 'By UPI, net banking or debit card, using a secure payment link from the app.'],
      ['What if I repay late?', `A late charge of ${product.penalty_per_day_pct}% of the overdue amount applies for each day late. Late payment can lower your credit score and limit.`],
      ['Can I repay early?', 'Yes, you can repay any time before the due date. The fee stays the same for the period, because it is fixed up front.'],
      ['Why was I declined?', 'We look at your credit report and your details. If we say no, you can ask us about the decision. See grievance redressal.'],
      ['Who gives the loan?', 'The loan is made by the regulated lender named in the footer of every page and in your agreement.'],
      ['Is my data safe?', 'We ask permission for each use, share data only with partners who help us make and collect the loan, and do not store your bank account number on this site. See the privacy notice.'],
      ['I cannot repay on time. What do I do?', 'Contact us before the due date. Please do not take another loan to repay this one.'],
    ];
    return {
      title: 'FAQ',
      description: 'Answers about amounts, cost, repayment, late payment and your data.',
      body: `<section><div class="wrap narrow"><div class="tape"><h1>Frequently asked questions</h1>
${qa.map(([q, a]) => `<details class="qa"><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('')}
<p class="muted">More questions? <a href="/contact">Contact us</a>.</p></div></div></section>`,
    };
  },

  '/about': ({ cfg }) => ({
    title: 'About',
    description: `About ${cfg.brand}.`,
    body: `<section><div class="wrap narrow"><div class="tape"><h1>About ${esc(cfg.brand)}</h1>
<p class="lead">We make short-term borrowing clear: the cost first, in plain words, with a person to talk to.</p>
<p>${esc(cfg.brand)} is operated by ${esc(orgText(cfg, 'LEGAL_ENTITY_NAME'))}. Loans are made by ${esc(orgText(cfg, 'LENDER_NAME'))} (${esc(orgText(cfg, 'LENDER_REGISTRATION'))}).</p>
<h2>What we believe</h2>
<ul><li>You should know the full cost before you say yes.</li><li>A short loan is a tool for a gap, not a habit.</li><li>If it goes wrong, you deserve a quick, respectful answer.</li></ul></div></div></section>`,
  }),

  '/contact': ({ cfg }) => ({
    title: 'Contact',
    description: 'How to reach support.',
    body: `<section><div class="wrap narrow"><div class="tape"><h1>Contact us</h1>
<table class="tbl"><tbody>
<tr><th scope="row">Email</th><td>${esc(orgText(cfg, 'SUPPORT_EMAIL'))}</td></tr>
<tr><th scope="row">Phone</th><td>${esc(orgText(cfg, 'SUPPORT_PHONE'))}</td></tr>
<tr><th scope="row">Address</th><td>${esc(orgText(cfg, 'REGISTERED_ADDRESS'))}</td></tr>
</tbody></table>
<p>For a complaint, see <a href="/grievance">grievance redressal</a>. We will never ask for your PIN, password or card number by phone, SMS or email.</p></div></div></section>`,
  }),

  '/grievance': ({ cfg }) => ({
    title: 'Grievance redressal',
    description: 'How to complain, who handles it, and where to go if you are not satisfied.',
    draftLegal: !cfg.legalReviewed,
    body: `<section><div class="wrap narrow"><div class="tape"><h1>Grievance redressal</h1>
<p class="lead">If something is wrong, tell us. We will look into it and reply in writing.</p>
<h2>Step 1: contact support</h2>
<p>Email ${esc(orgText(cfg, 'SUPPORT_EMAIL'))} or call ${esc(orgText(cfg, 'SUPPORT_PHONE'))}. Give your registered mobile number and what happened.</p>
<h2>Step 2: the grievance officer</h2>
<table class="tbl"><tbody>
<tr><th scope="row">Name</th><td>${esc(orgText(cfg, 'GRIEVANCE_OFFICER_NAME'))}</td></tr>
<tr><th scope="row">Email</th><td>${esc(orgText(cfg, 'GRIEVANCE_OFFICER_EMAIL'))}</td></tr>
<tr><th scope="row">Phone</th><td>${esc(orgText(cfg, 'GRIEVANCE_OFFICER_PHONE'))}</td></tr>
</tbody></table>
<p>If support has not solved it, write to the grievance officer. Time to reply: [to be set by the lender's compliance team].</p>
<h2>Step 3: the regulator</h2>
<p>If you are not satisfied with the answer, or do not get one in time, you may be able to complain to the Reserve Bank of India through its complaint portal (cms.rbi.org.in). [Wording and time limits to be confirmed by the lender's compliance team]</p></div></div></section>`,
  }),

  '/fair-practices': ({ cfg }) => ({
    title: 'Fair practices',
    description: 'How we aim to lend responsibly and treat customers fairly.',
    draftLegal: !cfg.legalReviewed,
    body: `<section><div class="wrap narrow"><div class="tape"><h1>Fair practices</h1>
<p class="lead">What you can expect from us.</p>
<ul>
<li><b>Clear cost.</b> The fee, total repayment, due date, late charge and yearly cost are shown before you accept.</li>
<li><b>Your choice.</b> You can leave at any step. Nothing is charged for checking an offer.</li>
<li><b>Permission first.</b> We ask before we check your identity, read your credit report or share your data.</li>
<li><b>A real reason.</b> If we decline, we say so plainly and you can ask about the decision.</li>
<li><b>Respect.</b> If you fall behind, we will contact you politely and tell you your options.</li>
<li><b>No pressure to borrow again.</b> A new loan is never needed to repay an old one.</li>
</ul>
<p>Detailed collection and recovery conduct will be published here once agreed with the lender. [To be added]</p></div></div></section>`,
  }),

  '/privacy': ({ cfg }) => ({
    title: 'Privacy notice',
    description: 'What data we collect, why, who we share it with, and your rights.',
    draftLegal: !cfg.legalReviewed,
    body: `<section><div class="wrap narrow"><div class="tape"><h1>Privacy notice</h1>
<p class="muted">Version v1-draft</p>
<h2>What we collect</h2>
<ul><li>Your mobile number and the permissions you give</li><li>PAN and identity check results (we keep only a scrambled copy and the last 4 characters of your PAN)</li><li>Job and income details you enter</li><li>Your credit report, with your permission</li><li>Your bank account details, used only to send the money, and not kept by this site</li><li>Loan, repayment and payment records</li></ul>
<h2>Why we use it</h2>
<p>To verify who you are, decide on your loan, send and collect money, meet legal duties, prevent fraud, and help you if something goes wrong.</p>
<h2>Who we share it with</h2>
<p>The lender, credit bureaus, identity-check and e-sign providers, and payment partners, only as needed to make and collect your loan or as the law requires. We do not sell your data.</p>
<h2>Your rights</h2>
<p>You can ask to see, correct or delete your data, and you can withdraw a permission at any time in the app. Withdrawing may mean we cannot offer you a loan. Some records must be kept as the law requires. Retention period: [to be set by the lender's compliance team].</p>
<h2>Contact</h2>
<p>${esc(orgText(cfg, 'DATA_PROTECTION_CONTACT'))}</p></div></div></section>`,
  }),

  '/terms': ({ cfg }) => ({
    title: 'Terms of use',
    description: 'The terms for using this website and app.',
    draftLegal: !cfg.legalReviewed,
    body: `<section><div class="wrap narrow"><div class="tape"><h1>Terms of use</h1>
<p class="muted">Version v1-draft. These terms cover this website and app. A loan is governed by the separate loan agreement you sign.</p>
<h2>Using the site</h2><p>Give true information. Keep your sign-in codes private. Do not misuse the site or try to reach what is not yours.</p>
<h2>No offer until you sign</h2><p>Checking an offer is not a promise of a loan. A loan exists only when you have signed the agreement and the money has been sent.</p>
<h2>Responsibility</h2><p>The information on public pages is general. Your offer, and the agreement you sign, are what apply to you.</p>
<h2>Changes</h2><p>We may update these terms. The version in force is shown on this page.</p>
<p class="muted">Governing law and dispute terms: [to be added by the lender's legal team]</p></div></div></section>`,
  }),
};

export function renderPage(cfg, product, path) {
  const f = sections[path];
  if (!f) return null;
  const s = f({ cfg, product });
  return layout({ cfg, product, path, title: s.title, description: s.description, body: s.body, draftLegal: s.draftLegal });
}

export function renderNotFound(cfg) {
  return layout({ cfg, product: { tenure_days: 30 }, path: '/404', title: 'Page not found', description: 'Page not found',
    body: '<section><div class="wrap narrow"><div class="tape"><h1>We could not find that page</h1><p class="lead">The link may be old. Try the <a href="/">home page</a> or <a href="/contact">contact us</a>.</p></div></div></section>' });
}

export function renderAppShell(cfg) {
  const demo = cfg.mode === 'demo';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(cfg.brand)} app</title>
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#0e3b36">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icons/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icons/icon-192.png">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Anton&family=DM+Mono:wght@400;500&family=Hind:wght@400;500;600&display=swap">
<link rel="stylesheet" href="/css/site.css">
</head>
<body class="appbody" data-mode="${demo ? 'demo' : 'live'}">
<div id="root"><noscript><p class="pad">This app needs JavaScript. Our <a href="/">website</a> works without it.</p></noscript></div>
<script type="module" src="/js/app.js"></script>
</body>
</html>`;
}
