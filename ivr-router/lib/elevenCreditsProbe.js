import SupabaseClient from "./supabaseClient.js";

/**
 * Read the ElevenLabs credit balance and write it where crm.stage_health reads it.
 *
 * Why: on 5 Oct 2026 the plan ran out of credits at 18:04 IST and every bot call failed instantly (0 seconds, no message) until the plan renewed
 * at 10:00 IST the next day: 225 calls and about 16 hours of silent outage. Nothing said credits were low beforehand. The dashboard check
 * `elevenlabs_credits` (migration stage_health_elevenlabs_credits_and_instant_failures) turns this reading into ok / warn / crit.
 *
 * One row, key `elevenlabs_credits`, in crm.service_probe. A failed read is written too, as {error}, so the check says "could not read"
 * rather than quietly going stale. Never throws: it runs at the end of a scheduled job whose real work must not be lost to it.
 *
 * Uses GET /v1/user/subscription. `character_count` / `character_limit` are the plan's credits; `allowed_to_extend_character_limit` is true
 * when usage-based billing is on, which is the difference between "calls stop at zero" and "calls keep going and the overage is billed".
 */
export async function probeElevenCredits(deps = {}) {
  const apiKey = deps.apiKey ?? process.env.ELEVEN_LABS_API_KEY;
  if (!apiKey) return { ok: false, reason: "not_configured" };
  const baseUrl = deps.baseUrl ?? process.env.ELEVEN_LABS_BASE_URL ?? "https://api.elevenlabs.io/v1";
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ? deps.now() : Date.now();

  let body;
  try {
    const res = await fetchImpl(`${baseUrl}/user/subscription`, { headers: { "xi-api-key": apiKey } });
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      body = { error: `HTTP ${res.status}${text ? `: ${text.slice(0, 160)}` : ""}` };
    } else {
      const s = JSON.parse(text);
      const used = Number(s.character_count);
      const limit = Number(s.character_limit);
      if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) {
        body = { error: "subscription answer has no usable character_count / character_limit" };
      } else {
        const remaining = Math.max(0, limit - used);
        body = {
          tier: typeof s.tier === "string" ? s.tier : null,
          used,
          limit,
          remaining,
          pct_left: Math.round((1000 * remaining) / limit) / 10,
          reset_unix: Number.isFinite(Number(s.next_character_count_reset_unix)) ? Number(s.next_character_count_reset_unix) : null,
          can_extend: s.allowed_to_extend_character_limit === true,
          status: typeof s.status === "string" ? s.status : null,
        };
      }
    }
  } catch (error) {
    body = { error: String(error?.message ?? error).slice(0, 200) };
  }

  try {
    const sb = deps.sb ?? new SupabaseClient().client.schema("crm");
    const { error } = await sb
      .from("service_probe")
      .upsert({ key: "elevenlabs_credits", body, updated_at: new Date(now).toISOString() }, { onConflict: "key" });
    if (error) return { ok: false, reason: `write failed: ${error.message}`, body };
  } catch (error) {
    return { ok: false, reason: `write threw: ${String(error?.message ?? error)}`, body };
  }
  return { ok: !body.error, body };
}
