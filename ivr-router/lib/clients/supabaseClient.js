import { createClient } from '@supabase/supabase-js';

class SupabaseClient {
  constructor() {
    this.supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
  }

  async getOrCreateConversationState(phone) {
    let { data, error } = await this.supabase
      .from('conversation_state')
      .select('*')
      .eq('phone_number', phone)
      .single();

    if (error && error.code === 'PGRST116') {
      const newState = {
        phone_number: phone,
        current_phase: 'product_selection',
        form_data: {},
        document_status: {},
        status: 'active'
      };

      const { data: created, error: createError } = await this.supabase
        .from('conversation_state')
        .insert([newState])
        .select()
        .single();

      if (createError) throw createError;
      return created;
    }

    if (error) throw error;
    return data;
  }

  async updateConversationState(phone, updates) {
    const { data, error } = await this.supabase
      .from('conversation_state')
      .update({
        ...updates,
        last_active_at: new Date()
      })
      .eq('phone_number', phone)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async moveToPhase(phone, nextPhase, formDataUpdate = {}) {
    const state = await this.getConversationState(phone);
    return this.updateConversationState(phone, {
      current_phase: nextPhase,
      form_data: { ...state.form_data, ...formDataUpdate }
    });
  }

  async getConversationState(phone) {
    const { data, error } = await this.supabase
      .from('conversation_state')
      .select('*')
      .eq('phone_number', phone)
      .single();

    if (error) throw error;
    return data;
  }

  async logConversationEvent(phone, phase, eventType, userInput, botResponse, metadata = {}) {
    const { error } = await this.supabase
      .from('conversation_events')
      .insert([{
        phone_number: phone,
        phase,
        event_type: eventType,
        user_input: userInput,
        bot_response: botResponse,
        metadata
      }]);

    if (error) throw error;
  }

  async getLeadByPhone(phone) {
    const { data, error } = await this.supabase
      .from('crm_leads')
      .select('*')
      .eq('phone', phone)
      .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data;
  }

  async linkConversationToLead(phone, applicationId) {
    return this.updateConversationState(phone, {
      application_id: applicationId
    });
  }
}

let instance = null;
try {
  instance = new SupabaseClient();
} catch (error) {
  console.warn('⚠️ Supabase client initialization failed:', error.message);
  console.warn('   Database features will be unavailable until configuration is complete');
}

export default instance;
