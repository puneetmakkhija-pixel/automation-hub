// Site configuration from the environment.
//
// Two modes:
//   demo (default)  runs the real decision engine and journey in memory with mock vendors. No real money, no real
//                   data, not indexed by search engines, and a banner on every page says so.
//   live            real customers. Refuses to start unless everything a lender must show to customers is filled in
//                   (see ORG_FIELDS) and every production dependency is wired. Today the live gateway and the OTP
//                   provider are not built, so live always refuses: that is deliberate, not a bug.

export const ORG_FIELDS = {
  LEGAL_ENTITY_NAME: 'legal name of the company that runs this site',
  LENDER_NAME: 'name of the regulated lender that makes the loan',
  LENDER_REGISTRATION: 'lender registration / licence details',
  REGISTERED_ADDRESS: 'registered office address',
  SUPPORT_EMAIL: 'customer support email',
  SUPPORT_PHONE: 'customer support phone',
  GRIEVANCE_OFFICER_NAME: 'grievance officer name',
  GRIEVANCE_OFFICER_EMAIL: 'grievance officer email',
  GRIEVANCE_OFFICER_PHONE: 'grievance officer phone',
  DATA_PROTECTION_CONTACT: 'data protection contact',
};

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

export function loadConfig(env = process.env) {
  const mode = String(env.ZENIN_MODE || 'demo').toLowerCase();
  if (!['demo', 'live'].includes(mode)) throw new Error(`ZENIN_MODE must be "demo" or "live", got "${mode}"`);
  const siteUrl = String(env.SITE_URL || 'https://zenincredit.com').replace(/\/+$/, '');
  const org = {};
  const missing = [];
  for (const k of Object.keys(ORG_FIELDS)) {
    const v = String(env[k] || '').trim();
    org[k] = v || null;
    if (!v) missing.push(k);
  }
  return {
    mode,
    brand: 'Zenin Credit',
    siteUrl,
    secure: siteUrl.startsWith('https://'),
    org,
    missing,
    // Set LEGAL_REVIEWED=1 only after the lender's compliance team has signed off the privacy notice, terms and grievance text.
    legalReviewed: env.LEGAL_REVIEWED === '1',
    sessionSecret: env.SESSION_SECRET || null,
    sessionHours: num(env.SESSION_HOURS, 2),
    // First-time customers may ask for up to this much. Repeat customers are limited by their limit.
    firstLoanMax: num(env.FIRST_LOAN_MAX, 10000),
    // How long what we know about a returning customer stays good. Past these, we ask again, and only for what is stale.
    kycValidDays: num(env.KYC_VALID_DAYS, 365),
    dataValidDays: num(env.DATA_VALID_DAYS, 90),
    bureauValidDays: num(env.BUREAU_VALID_DAYS, 30),
    offerValidDays: num(env.OFFER_VALID_DAYS, 7),
    // After a decline, no new application for this many days. Demo allows an immediate retry so people can try numbers.
    reapplyAfterDays: num(env.REAPPLY_AFTER_DAYS, mode === 'demo' ? 0 : 30),
    port: num(env.PORT, 3000),
  };
}

// Text for a field in a page: the value, or a visible marker while it is still missing.
export const orgText = (cfg, key) => cfg.org[key] ?? `[${ORG_FIELDS[key]}: to be added]`;

// Everything that must be true before real customers can use this site. Returns a list of problems.
export function liveProblems(cfg, { gatewayReady = false, otpReady = false } = {}) {
  const p = [];
  if (!cfg.sessionSecret || cfg.sessionSecret.length < 32) p.push('SESSION_SECRET must be set to a random value of at least 32 characters');
  if (!cfg.secure) p.push('SITE_URL must be an https address');
  for (const k of cfg.missing) p.push(`${k} is not set (${ORG_FIELDS[k]})`);
  if (!cfg.legalReviewed) p.push('LEGAL_REVIEWED=1 is not set: the privacy notice, terms and grievance text have not been signed off');
  if (!gatewayReady) p.push('the live gateway to the loan system is not built yet');
  if (!otpReady) p.push('no SMS OTP provider is configured');
  return p;
}
