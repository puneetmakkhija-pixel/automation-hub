// Canonical lender and vendor names for the finance tracker, taken from the seeded rows in crm.fin_*
// (the names the Lender x Month report and the payables view group on). Mail subjects are free text
// ("Muthoot Fincorp BL July 2026 | DSA"); a name that cannot be matched is kept as written and flagged
// needs_check, never silently stored as a new lender.

export const LENDERS = [
  "ABCL - BL", "ABCL - STUL", "Aye Finance", "Bajaj Finance - BL", "Bajaj Finance - ONDC", "BharatPe", "Bright Loans",
  "CASHe", "Credilio", "Credit Saison", "CreditSea", "DMI Finance", "Fibe", "Flexiloans", "FlexSalary", "Godrej Capital - BL",
  "Hero FinCorp", "IDFC First Bank", "InCred", "Indifi", "Kissht + Ring", "Lendingkart", "LendingPlate", "MoneyView", "mPokket",
  "Muthoot Fincorp - BL", "My Money Bazaar", "Olyv (SmartCoin)", "PayRupik", "Poonawalla Fincorp - BL", "Poonawalla Fincorp - LAP",
  "Poonawalla Fincorp - Prime PL", "Poonawalla Fincorp - STBL (Mktg)", "Poonawalla Fincorp - STPL", "Prefr (EU + Open Market)",
  "Protium", "Ram Fincorp", "Ring Web", "Rule Mudra", "Rupee112 / Bharat Loans / Loan112 / ROT", "Rupezi", "SBI Card",
  "Tata Capital", "Tata Capital - LAP", "Truefund", "Unity SFB", "Zype",
];

export const VENDORS = [
  { name: "A2Z Financial Solutions", category: "DSA / Lending partner" },
  { name: "Brimming Grace Capital Pvt Ltd", category: "DSA / Lending partner" },
  { name: "Computer Rental Services", category: "Office & IT" },
  { name: "Cube Finserv", category: "DSA / Lending partner" },
  { name: "Dynexus Partners", category: "DSA / Lending partner" },
  { name: "Earth Digital Network Technology (EDNT)", category: "Office & IT" },
  { name: "I2 Fintech Pvt Ltd", category: "DSA / Lending partner" },
  { name: "Office Electricity + Common Area (landlord)", category: "Office & IT" },
  { name: "Poonawalla Fincorp (BL raising)", category: "Receivable (BL to raise)" },
];

// Words that carry no identity: months, years, mail boilerplate, company suffixes.
const NOISE = new Set([
  "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
  "january", "february", "march", "april", "june", "july", "august", "september", "october", "november", "december",
  "bill", "closure", "dsa", "re", "fw", "fwd", "pvt", "ltd", "private", "limited", "the", "and", "invoice", "invoices",
]);

/** Lower-case identity tokens of a free-text name. */
export function tokens(s) {
  return String(s ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !NOISE.has(t) && !/^(20)?\d{2}$/.test(t));
}

/**
 * The ways a canonical name may appear in a subject, as token sets: the name without its bracket, the name with
 * it, each "/" part, the part before a "+", and a single bracketed brand word ("SmartCoin", "EDNT"). A single-word
 * alternative shorter than 4 letters is dropped: it would match noise.
 */
export function aliasesOf(name) {
  const paren = (name.match(/\(([^)]*)\)/) || [])[1] || "";
  const base = name.replace(/\([^)]*\)/, " ");
  const alts = [tokens(base), tokens(name)];
  for (const part of base.split("/")) alts.push(tokens(part));
  if (base.includes("+")) alts.push(tokens(base.split("+")[0]));
  const pt = tokens(paren);
  if (pt.length === 1 && pt[0].length >= 4) alts.push(pt);
  const seen = new Set();
  return alts.filter((a) => {
    if (!a.length || (a.length === 1 && a[0].length < 4)) return false;
    const k = a.join(" ");
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function bestMatch(raw, entries) {
  const have = new Set(tokens(raw));
  if (!have.size) return null;
  let best = [];
  let size = 0;
  for (const e of entries) {
    for (const alt of e.alts) {
      if (!alt.every((t) => have.has(t))) continue;
      if (alt.length > size) { size = alt.length; best = [e]; }
      else if (alt.length === size && !best.includes(e)) best.push(e);
    }
  }
  return best.length === 1 ? best[0] : null; // a tie between two names is "unknown", not a guess
}

const LENDER_ENTRIES = LENDERS.map((name) => ({ name, alts: aliasesOf(name) }));
const VENDOR_ENTRIES = VENDORS.map((v) => ({ ...v, alts: aliasesOf(v.name) }));

/** Canonical lender name for a subject fragment, or null. */
export const matchLender = (raw) => bestMatch(raw, LENDER_ENTRIES)?.name ?? null;
/** { name, category } for a vendor / subject fragment, or null. */
export const matchVendor = (raw) => {
  const e = bestMatch(raw, VENDOR_ENTRIES);
  return e ? { name: e.name, category: e.category } : null;
};
