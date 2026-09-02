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
t('poonawala not marked borrowed', ok.criteriaBorrowed===false && ok.criteriaSource==='poonawala');

// --- Hero: was rejecting everyone, now evaluates ---
const hero = await c.checkEligibility(clean,'herofincorp');
t('HERO clean applicant now ELIGIBLE (was always false)', hero.eligible===true);
t('hero flagged as borrowed', hero.criteriaBorrowed===true && hero.criteriaSource==='poonawala');
t('hero no longer returns "not yet implemented"', hero.reason===undefined, String(hero.reason));

// --- identical verdicts across lenders ---
const heroBad = await c.checkEligibility(bad,'herofincorp');
t('hero applies the same rules as poonawala',
  JSON.stringify(heroBad.hardRejects)===JSON.stringify(r.hardRejects));

// --- pincode gate still per-lender ---
const noPin = await c.checkEligibility({...clean, pincode:'999999'},'herofincorp');
t('hero unserviceable pincode rejected', noPin.eligible===false && noPin.reason==='Pincode not serviceable');

// --- aliases still route ---
for (const a of ['Hero','hero_fincorp','HeroFincorp']) {
  const x = await c.checkEligibility(clean, a);
  t(`alias "${a}" routes to hero criteria`, x.eligible===true && x.criteriaBorrowed===true);
}
const alias = await c.checkEligibility(clean,'Poonawalla');
t('alias "Poonawalla" routes to poonawala', alias.criteriaBorrowed===false);

// --- unknown lender still throws ---
let threw=false; try { await c.checkEligibility(clean,'randombank'); } catch { threw=true; }
t('unknown lender still throws', threw);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
