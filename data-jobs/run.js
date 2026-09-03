// Default entry point for the Railway service rooted at data-jobs (currently
// named `jobs`, restart policy NEVER, no cron schedule).
//
// WHAT THIS USED TO BE, AND WHY IT WAS WORSE THAN NOTHING
//
// It was a stub that selected from a table called `_placeholder` and treated
// PGRST205 — PostgREST's "table not found" — as success, on the reasoning that
// the table did not exist yet. So the service deployed green, logged "done.
// rows touched: 0", and did nothing, while suppressing the single error code
// that tells you a client is pointed at a database that does not have what you
// expect.
//
// That is not hypothetical. On 02 Sep 2026 the serviceable_pincodes migration
// was applied to the Supabase project ggpkzlxxhqlyfhdaczij on the assumption
// that a service inside a Railway project called "Automation Hub" talks to the
// automation-hub database. It does not: SUPABASE_URL here resolves to
// ymdkcaedwnnhszhzirli (smecircle). ivr-router/lib/pincodeGatingClient.js reads
// SUPABASE_URL too, so it never saw the new tables, and the 100% reject rate
// the migration was written to fix stayed live for a day. The only visible
// symptom was PGRST205 — the code this file was written to ignore.
//
// WHAT IT DOES NOW
//
// It answers "which database is this service actually attached to?" and exits.
// No writes, no schema assumptions, no invented work. If a real recurring job
// belongs here later, it replaces the marked section below; the target report
// should stay, because it costs one round trip and it is the fact that is
// expensive to be wrong about.

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error("[data-jobs] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  process.exit(1);
}

// https://<ref>.supabase.co -> <ref>
const urlRef = (() => {
  try {
    return new URL(url).hostname.split(".")[0];
  } catch {
    return null;
  }
})();

// A Supabase key is a JWT whose payload names the project it is valid for and
// the role it carries. Both are public claims; the signature is the secret.
const claims = (() => {
  try {
    return JSON.parse(Buffer.from(key.split(".")[1], "base64").toString());
  } catch {
    return {};
  }
})();

console.log(`[data-jobs] SUPABASE_URL project = ${urlRef ?? "unparseable"}`);
console.log(`[data-jobs] key project = ${claims.ref ?? "not-a-jwt"} role = ${claims.role ?? "unknown"}`);

// A URL and key naming different projects is the failure that surfaces as
// "table not found" rather than as the misconfiguration it is. Say so plainly
// instead of letting the first write invent a more confusing explanation.
if (urlRef && claims.ref && urlRef !== claims.ref) {
  console.error(
    `[data-jobs] MISMATCH: URL points at ${urlRef} but the key is issued for ${claims.ref}. ` +
      `Reads return nothing and writes fail as "table not found".`
  );
  process.exit(1);
}

if (claims.role && claims.role !== "service_role") {
  console.error(
    `[data-jobs] key role is "${claims.role}", not service_role. ` +
      `With RLS enabled and no policies this reads as an empty table rather than as a permission error.`
  );
  process.exit(1);
}

// Prove the credentials actually reach that project. The PostgREST root returns
// the API description, so this needs no table to exist and stays correct
// whatever schema the project happens to have.
const res = await fetch(`${url}/rest/v1/`, {
  headers: { apikey: key, Authorization: `Bearer ${key}` },
});

if (!res.ok) {
  console.error(`[data-jobs] cannot reach ${urlRef}: HTTP ${res.status} ${res.statusText}`);
  process.exit(1);
}

console.log(`[data-jobs] reachable, credentials accepted`);

// ---- a real recurring job goes here; there is none today ----

console.log("[data-jobs] no scheduled work defined; exiting 0");
