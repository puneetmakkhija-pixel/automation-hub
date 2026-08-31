import crypto from "crypto";

/**
 * Shared-secret verification for inbound webhooks.
 *
 * Why a shared secret and not an HMAC signature:
 * Ananta does not sign inbound webhooks. Their authentication is Api-Key /
 * Api-Token headers on OUTBOUND calls only, and nothing in their integration
 * documents a signing header or digest on the requests they send us.
 * ("Implement webhook signature verification" in ANANTA_INTEGRATION_GUIDE.md is
 * an unimplemented recommendation, not a description of an Ananta feature.)
 * Verifying an HMAC they never send would reject every genuine webhook.
 *
 * A shared secret works with any provider that lets you set the webhook URL or
 * add a header, and is checked here in constant time. If Ananta later adds real
 * request signing, this is the place to add it alongside.
 *
 * The secret is accepted three ways, so it works whatever the provider allows:
 *   1. X-Webhook-Secret: <secret>
 *   2. Authorization: Bearer <secret>
 *   3. ?token=<secret>        (for providers that only accept a URL)
 *
 * ROLLOUT — this fails OPEN when unconfigured, deliberately.
 * If the env var is unset the request is allowed and a warning is logged, so
 * deploying this cannot break live traffic before the provider is configured.
 * Set the variable to switch enforcement on. A misconfigured secret would
 * otherwise silently drop customer conversations, which is worse than the
 * status quo it replaces.
 */

function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  // Hash both sides first so the comparison is always over equal-length input.
  const ah = crypto.createHash("sha256").update(ab).digest();
  const bh = crypto.createHash("sha256").update(bb).digest();
  return crypto.timingSafeEqual(ah, bh);
}

function presentedSecret(req) {
  const header = req.get("x-webhook-secret");
  if (header) return header;

  const auth = req.get("authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();

  if (req.query && typeof req.query.token === "string") return req.query.token;

  return null;
}

/**
 * @param {string} envVar name of the env var holding the expected secret
 * @param {string} label  used in logs to identify the webhook
 */
export function verifyWebhookSecret(envVar, label) {
  let warned = false;

  return function verify(req, res, next) {
    const expected = process.env[envVar];

    if (!expected) {
      if (!warned) {
        // Once per process, not per request — this would otherwise be the
        // noisiest line in the log.
        console.warn(
          `[${label}] ${envVar} is not set — webhook is UNAUTHENTICATED and ` +
            `accepting any caller. Set ${envVar} here and at the provider to enforce.`
        );
        warned = true;
      }
      return next();
    }

    const presented = presentedSecret(req);

    if (!presented || !timingSafeEqual(presented, expected)) {
      console.warn(
        `[${label}] Rejected webhook: ${presented ? "bad" : "missing"} secret ` +
          `(ip=${req.ip}, path=${req.path})`
      );
      // 401 rather than 403: the caller may retry with a credential.
      // No detail in the body — it would help an attacker distinguish cases.
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    return next();
  };
}

export default verifyWebhookSecret;
