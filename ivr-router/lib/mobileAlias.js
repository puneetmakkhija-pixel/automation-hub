/**
 * The customer's mobile, transformed so the affiliate never sees it.
 *
 * The Poonawalla link is an affiliate URL: sub_id1 and loop_id travel through
 * whistleloop, a publisher account and every redirect in between, and whatever
 * we put there lands in all of their logs permanently. A mobile number is PII.
 * It does not go in.
 *
 *   masked = (mobile + IVR_ALIAS_KEY) mod 10^10
 *   alias  = base36(masked), zero-padded to 7
 *
 * Reversible EXACTLY, and reversible with a spreadsheet formula rather than a
 * database — which is the whole point. Reconciliation happens against the
 * lender's MIS, in Excel, by someone with no Supabase login:
 *
 *   =TEXT(MOD(DECIMAL(UPPER(RIGHT(A2,7)),36)-$B$1,10^10),"0000000000")
 *
 * A mobile is < 10^10, so (n + K) - K mod 10^10 is n for every n. It is a
 * bijection on Z/10^10, so two mobiles can never collide on one alias.
 *
 * Seven characters, always: 36^6 = 2,176,782,336 < 10^10 <= 36^7.
 *
 * ABOUT 1 IN 5 ALIASES STARTS WITH "0" (any masked below 36^6). If a spreadsheet
 * reads that column as a number it eats the zero and decodes to the WRONG
 * mobile — which is why the URL keeps the literal `alias_` prefix in front of
 * it, and why the MIS column must be formatted as Text.
 *
 * WHAT THIS IS NOT: encryption. One known (mobile, alias) pair gives up the key
 * by subtraction, and that key decodes every alias ever sent. It keeps the
 * number out of third-party logs; it will not withstand someone who wants it.
 * If that matters more than spreadsheet recon, use {{customer_id}} instead —
 * opaque, unguessable, already on the send log — and reconcile by joining
 * whatsapp_messages rather than by formula.
 *
 * Returns "" for anything that is not a ten-digit mobile. Callers should treat
 * that as a configuration failure rather than sending a tracking id that cannot
 * be reconciled.
 */
export const ALIAS_MOD = 10_000_000_000;

export function aliasFor(mobile) {
  const digits = String(mobile ?? "").replace(/\D/g, "").slice(-10);
  if (digits.length !== 10) return "";

  const n = Number(digits);
  if (!Number.isSafeInteger(n)) return "";

  // Trimmed, floored and reduced. A key pasted with a trailing newline must not
  // become a different key than the one in the spreadsheet, and reducing it mod
  // 10^10 first keeps the sum inside Number's safe range whatever gets set.
  const raw = Math.floor(Number((process.env.IVR_ALIAS_KEY || "0").trim()));
  const key = (Number.isSafeInteger(raw) ? raw : 0) % ALIAS_MOD;

  const masked = (((n + key) % ALIAS_MOD) + ALIAS_MOD) % ALIAS_MOD;
  return masked.toString(36).padStart(7, "0");
}
