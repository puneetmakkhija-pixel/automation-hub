/**
 * Which send failures a retry can fix, and which are the same answer twice.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * On 16 Sep 2026 Meta paused the press-1 template for low quality. Every send
 * failed, and the failure handler did what it does for a timeout: dropped the
 * dedupe key and answered 502, which is the IVR panel's signal to retry. The
 * panel retried twice more. Each retry rebuilt the same message, spent another
 * paid API call, and was given the same rejection.
 *
 *   16 Sep   1,405 attempts    893 people   640 delivered
 *   17 Sep   2,151 attempts    724 people     0 delivered   2.97 attempts each
 *
 * Two thirds of the 17th's calls were spent asking a question that had already
 * been answered. A paused template is not a blip: it stays paused until
 * somebody changes it in the WABA console, and no number of retries is
 * somebody.
 *
 * ── Reading the code ──────────────────────────────────────────────────────
 *
 * Ananta does not pass Meta's code through as its own. Every Meta rejection
 * arrives as Ananta code 1353 with the real one wrapped in the message:
 *
 *   {"code":"1353","status":"false",
 *    "message":"(#132015) Template is temporarily unavailable to use because
 *               it was paused due to low quality."}
 *
 * So 1353 on its own means only "Meta said no" and cannot decide anything —
 * it is the code on every rejection, retryable or not. The one that matters is
 * inside the parentheses, which is why this parses the message rather than
 * trusting the envelope.
 */

/** Meta writes its own code into the message as "(#132015) ...". */
const META_CODE = /\(#(\d{3,6})\)/;

/**
 * Meta's code for this rejection, or null when the message carries none.
 *
 * Takes the whole response body, because Ananta puts the text in `message` and
 * axios sometimes hands us a bare string instead.
 */
export function metaErrorCode(detail) {
  if (detail === null || detail === undefined) return null;
  const text =
    typeof detail === "string"
      ? detail
      : String(detail.message ?? detail.error ?? detail.detail ?? "");
  const found = text.match(META_CODE);
  return found ? found[1] : null;
}

/**
 * Rejections that name the TEMPLATE. Another template may still work, so these
 * are the ones worth falling back on; everything else is about the account or
 * the request and would fail identically whichever template carried it.
 */
const TEMPLATE_META = new Set([
  "132000", // number of parameters does not match the template
  "132001", // template name does not exist in the translation
  "132005", // translated text too long
  "132007", // format character policy violation
  "132012", // parameter format mismatch
  "132015", // paused for low quality
  "132016", // disabled for low quality
  "132068", // flow is blocked
  "132069", // flow is throttled
]);

/**
 * Ananta's own refusals that no retry changes. 1310 already had a dedicated
 * log line in the route saying exactly this — "the panel will retry this on
 * every call and every retry fails the same way" — but the code went on to
 * invite that retry anyway.
 */
const PERMANENT_ANANTA = new Set([
  "1301", // api_key missing
  "1304", // IP not whitelisted
  "1310", // api_key invalid
  "1324", // template not approved
]);

/** Is this rejection about the template itself? */
export function isTemplateFailure(detail) {
  const meta = metaErrorCode(detail);
  if (meta && TEMPLATE_META.has(meta)) return true;
  return String(detail?.code ?? "") === "1324";
}

/**
 * Would sending this exact request again get the same answer?
 *
 * Deliberately a closed list rather than "anything that is not a timeout".
 * Getting this wrong in the permanent direction drops a customer who could
 * have been reached, so an unrecognised failure stays retryable — the same
 * default the route had before this existed.
 */
export function isPermanentFailure(detail) {
  if (isTemplateFailure(detail)) return true;
  return PERMANENT_ANANTA.has(String(detail?.code ?? ""));
}

/**
 * The templates to try for a digit, best first.
 *
 * IVR_DTMF_TEMPLATES has always been {"1": "<id>"} and still is. A list —
 * {"1": ["<primary>", "<standby>"]} or "<primary>,<standby>" — lets a paused
 * primary fall through to a standby instead of the caller getting nothing,
 * which is the whole of what went wrong on the 16th and 17th.
 *
 * Only a template-level rejection advances the list. An invalid API key must
 * not burn through every template the operator has.
 */
export function templateCandidates(entry) {
  const list = Array.isArray(entry) ? entry : String(entry ?? "").split(",");
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const id = String(raw ?? "").trim();
    // A duplicate would spend a second paid call on an answer already given.
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}
