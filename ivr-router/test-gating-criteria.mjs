/**
 * Hero FinCorp gates on Poonawalla's criteria, and Poonawalla still gates
 * exactly as it did.
 *
 *   node test-gating-criteria.mjs
 *
 * No framework, same as test-obd-guard.mjs: plain node, plain asserts,
 * self-contained, no credentials and no network — validatePincode is stubbed.
 *
 * What this holds, in one sentence: sharing one evaluator between two lenders
 * did not move Poonawalla's answers. The first assertion compares the full
 * hard-reject list against the strings the previous per-lender implementation
 * produced, character for character, because those strings reach the applicant
 * and are stored in gating_logs — a silent rewording would be a silent change
 * to why someone was declined.
 *
 * Hero's side is the other half: its engine returned "not yet implemented" and
 * rejected every applicant, so its 15,227 pincodes did nothing. It now returns
 * real verdicts, carrying criteriaBorrowed so a pass is never mistaken for
 * Hero's own approval.
 */

import PincodeGatingClient from './lib/pincodeGatingClient.js';

// Stub the DB: serviceable for both lenders except 999999.
const c = Object.create(PincodeGatingClient.prototype);
c.validatePincode = async (pin) => ({ valid: String(pin) !== '999999' });

const clean = { pincode:'110003', age:35, income:600000, cibilScore:780, hunterScore:900,
  dpdData:{dpdLatest6m:0,dpdLatest12m:0}, bureauVintage:60, derogFlags:[], currentOverdue:false,
  liveLoans:1, enquiriesCount:0, mfiStatus:'none', mobileInBureau:true, panInBureau:true, dualPan:false };

let pass=0, fail=0;
const t=(n,cond,extra='')=>{ (cond?pass++:fail++); console.log((cond?'ok   ':'FAIL ')+n+(cond?'':'  <-- '+extra)); };

// --- Poonawalla reject strings must be exactly what they were before ---
const bad = { ...clean, age:60, income:100000, cibilScore:700, hunterScore:800,
  bureauVintage:6, liveLoans:5, enquiriesCount:3, currentOverdue:true, dualPan:true,
  mobileInBureau:false, mfiStatus:'active', derogFlags:['Write-off'], dpdData:{dpdLatest6m:1,dpdLatest12m:45} };
const r = await c.checkEligibility(bad, 'poonawala');
const expected = [
  'Age not in range 24-55','Annual income < 3 lakh','CIBIL Score < 720','Hunter Score < 850',
  'Current overdue present - automatic reject','0+ DPD in Latest 6 Months',
  '30+ DPD in Latest 12 Months (Bureau)','Bureau vintage < 12 months',
  'Derog flags present: Write-off','Live unsecured loans > 3',
  'Unsecured enquiries in last 1 day >= 3','Active or recent MFI tradeline',
  'Mobile number or PAN not available in bureau','Dual PAN not allowed'];
t('poonawala reject strings byte-identical to previous implementation',
  JSON.stringify(r.hardRejects)===JSON.stringify(expected), JSON.stringify(r.hardRejects));
t('poonawala soft reject unchanged',
  JSON.stringify(r.softRejects)===JSON.stringify(['Bureau vintage <= 24 months (soft negative)']));

// --- Poonawalla happy path ---
const ok = await c.checkEligibility(clean,'poonawala');
t('poonawala clean applicant eligible', ok.eligible===true);
t('poonawala criteria attributed to the Feb 2026 mail', /02 Feb 2026/.test(ok.criteriaSource));

// --- Hero: was rejecting everyone, now evaluates ---
// --- Hero now runs its OWN criteria, not Poonawalla's ---
const heroClean = { pincode:'110003', age:30, employmentType:'Salaried', monthlySalary:40000,
  cibilScore:760, newToCredit:false, activeUnsecuredPl:2, decile:4, unsecTradelines1m:1,
  unsecTradelines3m:1, stpl3m:0, dpdData:{maxDpd3m:0,maxDpd12m:0,maxDpd24m:0}, derogFlags:[],
  foirPct:40, maxOverdueOverall:0, maxOverdueCreditCard:0, unsecEnquiries6mAbove50k:1,
  enquiries3mTotal:1, enquiries3mUnsecured:1, incredPlWithinYears:9 };
const hero = await c.checkEligibility(heroClean,'herofincorp');
t('HERO clean applicant eligible', hero.eligible===true, JSON.stringify(hero.hardRejects));
t('hero attributed to its own Revised Policy Cuts sheet', /Revised Policy Cuts/.test(hero.criteriaSource));
t('hero no longer returns "not yet implemented"', hero.reason===undefined, String(hero.reason));

// --- Hero's REVISED cuts are the ones in force ---
t('hero accepts age 57 (revised 21-58; live 18-55 would reject)',
  (await c.checkEligibility({...heroClean, age:57},'herofincorp')).eligible===true);
t('hero rejects age 20 (below revised floor of 21)',
  (await c.checkEligibility({...heroClean, age:20},'herofincorp')).hardRejects.includes('Age not in range 21-58'));
t('hero accepts salary 16000 (revised >=15000; live >=20000 would reject)',
  (await c.checkEligibility({...heroClean, monthlySalary:16000},'herofincorp')).eligible===true);
t('hero accepts CIBIL 727 (revised >=725; live >=730 would reject)',
  (await c.checkEligibility({...heroClean, cibilScore:727},'herofincorp')).eligible===true);
t('hero rejects CIBIL 724',
  (await c.checkEligibility({...heroClean, cibilScore:724},'herofincorp')).hardRejects.includes('CIBIL Score < 725'));

// --- Hero-only rules Poonawalla never had ---
t('hero rejects >5 active PL at decile 3+',
  (await c.checkEligibility({...heroClean, activeUnsecuredPl:6, decile:3},'herofincorp')).hardRejects.some(x=>x.includes('active PL at decile')));
t('hero allows 6 active PL BELOW decile 3 (rule is decile-conditional)',
  (await c.checkEligibility({...heroClean, activeUnsecuredPl:6, decile:2},'herofincorp')).eligible===true);
t('hero FOIR band: 50% fails at 18k salary (cap 45%)',
  (await c.checkEligibility({...heroClean, monthlySalary:18000, foirPct:50},'herofincorp')).hardRejects.some(x=>x.includes('FOIR')));
t('hero FOIR band: 50% passes at 40k salary (cap 70%)',
  (await c.checkEligibility({...heroClean, monthlySalary:40000, foirPct:50},'herofincorp')).eligible===true);
t('hero rejects new-to-credit',
  (await c.checkEligibility({...heroClean, newToCredit:true},'herofincorp')).hardRejects.includes('New to credit not allowed'));
t('hero rejects InCred PL within 3 years',
  (await c.checkEligibility({...heroClean, incredPlWithinYears:2},'herofincorp')).hardRejects.some(x=>x.includes('InCred')));
t('hero enquiry rule only bites below score 750',
  (await c.checkEligibility({...heroClean, cibilScore:800, unsecEnquiries6mAbove50k:9},'herofincorp')).eligible===true);
t('hero enquiry rule bites at score 740',
  (await c.checkEligibility({...heroClean, cibilScore:740, unsecEnquiries6mAbove50k:9},'herofincorp')).hardRejects.some(x=>x.includes('unsecured enquiries over 50k')));

// --- a missing field is skipped, not scored either way ---
const partial = {...heroClean}; delete partial.foirPct; delete partial.stpl3m;
const pr2 = await c.checkEligibility(partial,'herofincorp');
t('missing inputs are recorded in checksSkipped, not failed',
  pr2.eligible===true && pr2.checksSkipped.includes('foir') && pr2.checksSkipped.includes('stpl3m'),
  JSON.stringify(pr2.checksSkipped));

// --- the two lenders are no longer the same policy ---
t('hero and poonawala are now genuinely different policies',
  JSON.stringify((await c.checkEligibility(bad,'herofincorp')).hardRejects)!==JSON.stringify(r.hardRejects));

// --- pincode gate still per-lender ---
const noPin = await c.checkEligibility({...heroClean, pincode:'999999'},'herofincorp');
t('hero unserviceable pincode rejected', noPin.eligible===false && noPin.reason==='Pincode not serviceable');

// --- aliases still route ---
for (const a of ['Hero','hero_fincorp','HeroFincorp']) {
  const x = await c.checkEligibility(heroClean, a);
  t(`alias "${a}" routes to hero criteria`, x.eligible===true && /Revised Policy Cuts/.test(x.criteriaSource));
}
const alias = await c.checkEligibility(clean,'Poonawalla');
t('alias "Poonawalla" routes to poonawala', /02 Feb 2026/.test(alias.criteriaSource));

// --- unknown lender still throws ---
let threw=false; try { await c.checkEligibility(clean,'randombank'); } catch { threw=true; }
t('unknown lender still throws', threw);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
