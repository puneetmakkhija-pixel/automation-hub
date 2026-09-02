import { createClient } from "@supabase/supabase-js";

/**
 * CRM Integration Client
 * Handles all communication between IVR Router and Business Loans CRM
 * Phase 1: Lead intake pipeline (voice → disposition → application creation)
 *
 * Schema note: `.schema("crm").from(...)` is the only form that reaches the crm
 * schema. `.from("crm.leads")` — which this file used until Sep 2026 — reads as
 * a literal table named "crm.leads" in public, which does not exist.
 *
 * Most methods below still do not work after that fix, because the columns they
 * name are not the columns crm.leads and crm.lead_events have. Only
 * healthCheck() is correct today. CRM_CLIENT_SCHEMA_GAPS.md records exactly
 * which column each method gets wrong, and what has to be decided before the
 * rest can be repaired. Do not assume a method here works because it returns.
 */
class CrmIntegrationClient {
  constructor() {
    this.supabaseUrl = process.env.CRM_SUPABASE_URL || process.env.SUPABASE_URL;
    this.supabaseServiceKey = process.env.CRM_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!this.supabaseUrl || !this.supabaseServiceKey) {
      console.warn("CRM Supabase credentials not configured. CRM integration disabled.");
      this.supabase = null;
      return;
    }

    this.supabase = createClient(this.supabaseUrl, this.supabaseServiceKey);
  }

  /**
   * PHASE 1: Intake Pipeline
   * Creates or updates an application in CRM when voice/chat disposition is captured
   * Called after: OBD voice call + Chatsense DTMF capture
   * Returns: application_id for tagging future WhatsApp/callbacks
   */
  async leadIntakeSyncFromVoice({
    phone,
    name,
    age,
    income,
    pincode,
    state,
    email,
    channel = "obd_voice",
    disposition = "contacted", // interested, callback, rejected, agent_connect
    callDuration = 0,
    dtmfChoice = null, // 1: learn_more, 2: agent_connect, 3: callback
    campaignId = null,
    batchId = null,
    ivrGreeting = null,
    customMetadata = {},
  }) {
    try {
      if (!this.supabase) {
        throw new Error("CRM Supabase not configured");
      }

      // Validate required fields
      if (!phone || !name) {
        throw new Error("Phone and name are required for lead intake");
      }

      // Call CRM RPC: lead_intake_sync
      // This RPC (in CRM Supabase) creates application record + returns application_id
      const { data, error } = await this.supabase.rpc("lead_intake_sync", {
        p_phone: phone,
        p_name: name,
        p_age: age || null,
        p_income: income || null,
        p_pincode: pincode || null,
        p_state: state || null,
        p_email: email || null,
        p_channel: channel,
        p_disposition: disposition,
        p_call_duration: callDuration,
        p_dtmf_choice: dtmfChoice,
        p_campaign_id: campaignId,
        p_batch_id: batchId,
        p_ivr_greeting: ivrGreeting,
        p_metadata: JSON.stringify(customMetadata),
      });

      if (error) {
        throw new Error(`RPC lead_intake_sync failed: ${error.message}`);
      }

      return {
        success: true,
        applicationId: data?.[0]?.application_id || data?.application_id,
        message: "Application created successfully",
        data,
      };
    } catch (error) {
      console.error(`Lead intake sync failed for ${phone}:`, error);
      return {
        success: false,
        error: error.message,
        phone,
      };
    }
  }

  /**
   * Update application with voice call metrics
   * Called after voice call completes
   */
  async updateApplicationWithCallMetrics({ applicationId, callMetrics = {} }) {
    try {
      if (!this.supabase || !applicationId) {
        throw new Error("Supabase not configured or applicationId missing");
      }

      const { data, error } = await this.supabase
        .schema("crm").from("leads")
        .update({
          call_duration: callMetrics.duration || null,
          call_disposition: callMetrics.disposition || null,
          dtmf_choice: callMetrics.dtmfChoice || null,
          answered: callMetrics.answered || false,
          call_recording_url: callMetrics.recordingUrl || null,
          updated_at: new Date().toISOString(),
        })
        .eq("application_id", applicationId);

      if (error) throw error;

      return {
        success: true,
        message: "Call metrics updated",
        data,
      };
    } catch (error) {
      console.error(`Update call metrics failed for ${applicationId}:`, error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Webhook: Log voice disposition in CRM audit trail
   * For compliance and analytics
   */
  async logVoiceDisposition({ applicationId, disposition, details = {} }) {
    try {
      if (!this.supabase) {
        throw new Error("Supabase not configured");
      }

      const { data, error } = await this.supabase.schema("crm").from("lead_events").insert({
        application_id: applicationId,
        event_type: "voice_disposition",
        event_data: JSON.stringify({
          disposition,
          ...details,
        }),
        created_at: new Date().toISOString(),
      });

      if (error) throw error;

      return {
        success: true,
        message: "Disposition logged",
      };
    } catch (error) {
      console.error(`Log disposition failed:`, error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Get application details from CRM
   * Used to fetch application state for follow-ups
   */
  async getApplication(applicationId) {
    try {
      if (!this.supabase) {
        throw new Error("Supabase not configured");
      }

      const { data, error } = await this.supabase
        .schema("crm").from("leads")
        .select("application_id, phone, name, stage, substage, eligible_lenders, best_lender, created_at")
        .eq("application_id", applicationId)
        .single();

      if (error) throw error;

      return {
        success: true,
        application: data,
      };
    } catch (error) {
      console.error(`Get application failed for ${applicationId}:`, error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Update application stage
   * Called when application advances (e.g., Documents received)
   */
  async updateApplicationStage({ applicationId, stage, substate = null }) {
    try {
      if (!this.supabase) {
        throw new Error("Supabase not configured");
      }

      const updateData = {
        stage,
        updated_at: new Date().toISOString(),
      };

      if (substate) {
        updateData.substage = substate;
      }

      const { data, error } = await this.supabase
        .schema("crm").from("leads")
        .update(updateData)
        .eq("application_id", applicationId);

      if (error) throw error;

      return {
        success: true,
        message: `Stage updated to ${stage}`,
        data,
      };
    } catch (error) {
      console.error(`Update stage failed for ${applicationId}:`, error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Health check: Verify CRM connectivity
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

      const { error } = await this.supabase.schema("crm").from("leads").select("count()", { count: "exact" }).limit(1);

      if (error) throw error;

      return {
        success: true,
        status: "connected",
        message: "CRM Supabase connected",
      };
    } catch (error) {
      return {
        success: false,
        status: "error",
        message: error.message,
      };
    }
  }
}

export default CrmIntegrationClient;
