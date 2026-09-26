import { createHash } from "node:crypto";

/**
 * Which bot a caller is assigned to, when the two are being compared.
 *
 * Until now the choice was all-or-nothing: OUR_BOT_PRESS_ENABLED put every
 * eligible press on our bot (up to its daily cap) and nothing on Oriserve, so
 * the two could only ever be compared across different days, different bases
 * and different hours. BOT_SPLIT_MODE=split replaces that switch with an A/B
 * split in which both bots take the same traffic at the same time.
 *
 * ── Deterministic, by mobile ────────────────────────────────────────────────
 *
 * The arm is a hash of the ten-digit mobile, not a coin flip per press. The
 * IVR panel retries and callers press 1 on more than one campaign, and a coin
 * flip would put one person in both arms: called by both bots, and counted in
 * both. A hash puts every press from one person in one arm, forever, across
 * restarts and replicas, with no table to keep in sync.
 *
 * BOT_SPLIT_SALT reshuffles everyone. Change it only to start a new experiment:
 * the people who were in one arm are then spread over both, and the analysis of
 * the old split has to stop at the date it changed.
 *
 * ── Two independent draws ──────────────────────────────────────────────────
 *
 * The arm and, inside our arm, the voice variant (A or B) each hash the mobile
 * with their own label. Deriving the variant from the same bytes as the arm
 * would correlate them — the variant would be partly a function of which side
 * of the arm threshold a mobile fell — and B would not be comparable with A.
 *
 * Pure, and all of it reads its env from an argument, so the split is testable
 * without a network or a database.
 */

/** Share of eligible callers our bot takes, 0-100. Unparseable means the default. */
const DEFAULT_OURS_PCT = 50;

export function splitModeOn(env = process.env) {
  return String(env.BOT_SPLIT_MODE ?? "").trim().toLowerCase() === "split";
}

export function splitSalt(env = process.env) {
  return String(env.BOT_SPLIT_SALT ?? "").trim() || "v1";
}

export function oursPct(env = process.env) {
  const raw = String(env.BOT_SPLIT_OURS_PCT ?? "").trim();
  if (!raw) return DEFAULT_OURS_PCT;
  const n = Number(raw);
  // Same rule as OUR_BOT_DAILY_CAP: a typo must not silently become 0% or 100%.
  // 0 and 100 are real instructions and survive.
  return Number.isInteger(n) && n >= 0 && n <= 100 ? n : DEFAULT_OURS_PCT;
}

/** Ten digits, or null. */
function ten(raw) {
  const digits = String(raw ?? "").replace(/\D/g, "");
  const t = digits.length > 10 ? digits.slice(-10) : digits;
  return t.length === 10 ? t : null;
}

/** First four bytes of sha256(salt:label:mobile10), as an unsigned integer. */
function draw(label, mobile10, env) {
  const h = createHash("sha256").update(`${splitSalt(env)}:${label}:${mobile10}`).digest();
  return h.readUInt32BE(0);
}

/**
 * 'ours' | 'oriserve', or null when there is no ten-digit mobile to hash.
 * Mod 100 over 32 bits is uniform to well under 0.0001%.
 */
export function armFor(mobile, env = process.env) {
  const m = ten(mobile);
  if (!m) return null;
  return draw("arm", m, env) % 100 < oursPct(env) ? "ours" : "oriserve";
}

/** 'A' | 'B', independent of the arm draw. Null without a usable mobile. */
export function voiceVariantFor(mobile, env = process.env) {
  const m = ten(mobile);
  if (!m) return null;
  return draw("voice", m, env) % 2 === 0 ? "A" : "B";
}
