import { createClient } from "@supabase/supabase-js";

/**
 * CRM Integration Client
 * Voice/IVR side of the Business Loans CRM: look a lead up, record what a call
 * did to it, move its stage.
 *
 * Everything here is keyed on the LEAD, not on an application. crm.applications
 * exists but holds no rows, and nothing on the voice side can obtain an
 * application_id, so the methods below take a `ref` — either a numeric
 * crm.leads.id or a phone number — resolved by resolveLead().
 *
 * Tables, all confirmed against the live database:
 *   crm.leads        the book of business. stage and channel are enums;
 *                    LEAD_STAGES below is the full stage value set.
 *   crm.lead_events  append-only audit trail: lead_id plus an enum `type`, with
 *                    free text in `note`. A voice disposition is type 'call'.
 *   crm.pbx_calls    one row per call — duration, disposition, recording url —
 *                    keyed on the provider's own call id.
 *
 * `.schema("crm")` is required. `.from("crm.leads")` addresses a table named
 * literally "crm.leads" in public, which does not exist.
 */

/** crm.lead_stage — the enum on crm.leads.stage. */
const LEAD_STAGES = [
  "new",
  "contacted",
  "docs_pending",
  "docs_received",
  "digitap_submitted",
  "bre_review",
  "lender_assigned",
  "logged_in",
  "move_to_credit",
  "approved",
  "disbursed",
  "rejected",
  "dropped",
];

/** crm.lead_event_type — the enum on crm.lead_events.type. */
const LEAD_EVENT_TYPES = [
  "created",
  "stage_change",
  "call",
  "note",
  "doc_update",
  "status_sync",
  "assignment",
];

/** The columns crm.leads has that the voice side has any use for. */
const LEAD_COLUMNS =
  "id, channel, customer_name, phone, pincode, business_name, gst_no, pan, " +
  "stage, stage_substate, lender_id, lender_status, application_number, " +
  "client_reference_id, source, created_at, updated_at";

class CrmIntegrationClient {
  constructor() {
    this.supabaseUrl = process.env.CRM_SUPABASE_URL || process.env.SUPABASE_URL;
    this.supabaseServiceKey =
      process.env.CRM_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!this.supabaseUrl || !this.supabaseServiceKey) {
      console.warn("CRM Supabase credentials not configured. CRM integration disabled.");
      this.supabase = null;
      return;
    }

    this.supabase = createClient(this.supabaseUrl, this.supabaseServiceKey);
  }

  /** The crm schema, or a thrown error if the client was never configured. */
  crm() {
    if (!this.supabase) {
      throw new Error("CRM Supabase not configured");
    }
    return this.supabase.schema("crm");
  }

  /**
   * Last ten digits, which is how phone numbers compare across this CRM: the
   * same subscriber arrives as 9876543210, 919876543210 or +91 98765 43210
   * depending on which door they came through.
   */
  static phone10(value) {
    return String(value || "").replace(/\D/g, "").slice(-10);
  }

  /**
   * Resolve a lead from either a numeric crm.leads.id or a phone number.
   *
   * A phone can match more than one lead — the same person applying twice — so
   * the most recently updated one wins and matchCount comes back with it,
   * rather than the caller silently receiving an arbitrary row.
   */
  async resolveLead(ref) {
    if (ref === undefined || ref === null || ref === "") {
      return { success: false, error: "a lead id or phone number is required" };
    }

    try {
      const asId = String(ref).trim();

      if (/^\d+$/.test(asId) && asId.length <= 12) {
        const { data, error } = await this.crm()
          .from("leads")
          .select(LEAD_COLUMNS)
          .eq("id", asId)
          .maybeSingle();
        if (error) throw new Error(error.message);
        if (data) return { success: true, lead: data, matched: "id", matchCount: 1 };
      }

      const phone = CrmIntegrationClient.phone10(ref);
      if (phone.length !== 10) {
        return { success: false, error: `No lead for ${ref}` };
      }

      const { data, error } = await this.crm()
        .from("leads")
        .select(LEAD_COLUMNS)
        .like("phone", `%${phone}`)
        .order("updated_at", { ascending: false })
        .limit(5);
      if (error) throw new Error(error.message);

      if (!data || data.length === 0) {
        return { success: false, error: `No lead for ${ref}` };
      }

      return { success: true, lead: data[0], matched: "phone", matchCount: data.length };
    } catch (error) {
      console.error(`Resolve lead failed for ${ref}:`, error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Read a lead.
   */
  async getLead(ref) {
    return this.resolveLead(ref);
  }

  /**
   * Append a voice disposition to the lead's audit trail.
   *
   * crm.lead_events takes an enum `type` and free text in `note`, so the
   * disposition and any extra detail are serialised into the note rather than
   * invented as columns. `id` is GENERATED ALWAYS and created_at defaults, so
   * neither is supplied.
   */
  async logVoiceDisposition({ ref, disposition, details = {}, type = "call" }) {
    if (!disposition) {
      return { success: false, error: "disposition is required" };
    }
    if (!LEAD_EVENT_TYPES.includes(type)) {
      return {
        success: false,
        error: `Invalid event type "${type}". One of: ${LEAD_EVENT_TYPES.join(", ")}`,
      };
    }

    const found = await this.resolveLead(ref);
    if (!found.success) return found;

    try {
      const note = Object.keys(details).length
        ? `${disposition} — ${JSON.stringify(details)}`
        : String(disposition);

      const { error } = await this.crm()
        .from("lead_events")
        .insert({ lead_id: found.lead.id, type, note });
      if (error) throw new Error(error.message);

      return { success: true, leadId: found.lead.id, type, message: "Disposition logged" };
    } catch (error) {
      console.error(`Log disposition failed for ${ref}:`, error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Record the call itself in crm.pbx_calls.
   *
   * Call metrics have no home on crm.leads — no duration, disposition or
   * recording columns exist there — and this is the table built for them. It is
   * keyed on the provider's own call id, so a redelivered callback updates that
   * call's row instead of adding a second one.
   */
  async recordVoiceCall({ ref, providerCallId, provider = "oriserve", metrics = {} }) {
    if (!providerCallId) {
      return { success: false, error: "providerCallId is required — it is the primary key" };
    }

    const found = await this.resolveLead(ref);
    if (!found.success) return found;

    try {
      const duration = Number.parseInt(metrics.duration ?? metrics.durationSec, 10);
      const talk = Number.parseInt(metrics.talkSeconds ?? metrics.talkSec, 10);

      const { error } = await this.crm()
        .from("pbx_calls")
        .upsert(
          {
            provider_call_id: String(providerCallId),
            provider,
            direction: metrics.direction || "outbound",
            customer_number: found.lead.phone || null,
            duration_sec: Number.isFinite(duration) ? duration : null,
            talk_sec: Number.isFinite(talk) ? talk : null,
            disposition: metrics.disposition || null,
            recording_url: metrics.recordingUrl || null,
            lead_id: found.lead.id,
            raw: metrics,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "provider_call_id" }
        );
      if (error) throw new Error(error.message);

      return {
        success: true,
        leadId: found.lead.id,
        providerCallId: String(providerCallId),
        message: "Call recorded",
      };
    } catch (error) {
      console.error(`Record call failed for ${providerCallId}:`, error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Move a lead's stage, and leave the transition in the audit trail.
   *
   * The lead is read first so the event can carry the stage it came from:
   * crm.lead_events has from_stage/to_stage, and filling only one of them
   * throws away what the table exists to record.
   */
  async updateLeadStage({ ref, stage, substate = null }) {
    if (!stage) {
      return { success: false, error: "stage is required" };
    }
    if (!LEAD_STAGES.includes(stage)) {
      return {
        success: false,
        error: `Invalid stage "${stage}". One of: ${LEAD_STAGES.join(", ")}`,
      };
    }

    const found = await this.resolveLead(ref);
    if (!found.success) return found;

    const fromStage = found.lead.stage;
    const fromSubstate = found.lead.stage_substate;

    try {
      const update = { stage, updated_at: new Date().toISOString() };
      if (substate !== null) update.stage_substate = substate;

      const { error } = await this.crm().from("leads").update(update).eq("id", found.lead.id);
      if (error) throw new Error(error.message);

      // The stage has moved by this point. A failed audit row is reported
      // rather than thrown, so losing the event does not read as a failed move.
      const { error: eventError } = await this.crm().from("lead_events").insert({
        lead_id: found.lead.id,
        type: "stage_change",
        from_stage: fromStage,
        to_stage: stage,
        from_substate: fromSubstate,
        to_substate: substate,
      });

      return {
        success: true,
        leadId: found.lead.id,
        from: fromStage,
        to: stage,
        eventLogged: !eventError,
        eventError: eventError ? eventError.message : undefined,
        message: `Stage moved from ${fromStage} to ${stage}`,
      };
    } catch (error) {
      console.error(`Update stage failed for ${ref}:`, error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Health check: can we reach the crm schema at all.
   */
  async healthCheck() {
    try {
      if (!this.supabase) {
        return {
          success: false,
          status: "not_configured",
          message: "CRM Supabase credentials not configured",
        };
      }

      const { error } = await this.crm().from("leads").select("id").limit(1);
      if (error) throw new Error(error.message);

      return { success: true, status: "connected", message: "CRM Supabase connected" };
    } catch (error) {
      return { success: false, status: "error", message: error.message };
    }
  }
}

export { LEAD_STAGES, LEAD_EVENT_TYPES };
export default CrmIntegrationClient;
