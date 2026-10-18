// Healthchecks ping for a Railway cron. HEALTHCHECKS_PING_URL is
// https://<host>/ping/<project ping key>, set as a Railway variable (never in the repo).
// Unset = off. Never throws; 5 s cap. A run that never starts sends nothing, and
// Healthchecks alerts when the schedule + grace has passed (times there are UTC unless
// the check's timezone is set; IST = UTC + 5:30).
export async function pingHealthcheck(slug, error) {
  const base = process.env.HEALTHCHECKS_PING_URL?.trim().replace(/\/+$/, "");
  if (!base) return;
  try {
    await fetch(`${base}/${slug}${error ? "/fail" : ""}`, {
      method: "POST",
      body: error ? String(error).slice(0, 500) : undefined,
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // monitoring must never break the job
  }
}

// Runs fn, pings success or fail, and rethrows so the job's own exit code is unchanged.
export async function withHealthcheck(slug, fn) {
  try {
    const result = await fn();
    await pingHealthcheck(slug);
    return result;
  } catch (e) {
    await pingHealthcheck(slug, e instanceof Error ? e.message : e);
    throw e;
  }
}
