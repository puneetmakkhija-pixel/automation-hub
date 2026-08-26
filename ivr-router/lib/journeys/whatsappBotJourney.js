import supabase from '../clients/supabaseClient.js';
import voiceIntegration from '../services/voiceIntegration.js';
import anantaClient from '../clients/anantaClient.js';

class WhatsAppBotJourney {
  constructor() {
    this.phases = [
      'greeting',
      'product_discovery',
      'eligibility_assessment',
      'application_form',
      'document_collection',
      'kyc_verification',
      'loan_approval',
      'completion'
    ];
  }

  async startJourney(phoneNumber, lenderId, userName = null) {
    try {
      // Initialize with lender voice profile
      const voiceInit = await voiceIntegration.initializeConversationWithVoice(
        lenderId,
        userName
      );

      if (!voiceInit.success) {
        return { success: false, error: 'Failed to load lender profile' };
      }

      // Create conversation state
      const { data: conversation, error: convError } = await supabase
        .from('conversation_state')
        .upsert({
          phone_number: phoneNumber,
          user_name: userName,
          current_phase: 'greeting',
          status: 'active',
          started_at: new Date().toISOString(),
          last_active_at: new Date().toISOString()
        })
        .select()
        .single();

      if (convError) {
        return { success: false, error: convError.message };
      }

      // Send greeting message via WhatsApp
      const greeting = voiceInit.greeting;
      const whatsappResult = await anantaClient.sendTextMessage(phoneNumber, greeting);

      if (!whatsappResult.success) {
        console.warn('[WhatsAppJourney] WhatsApp send failed:', whatsappResult.error);
      }

      return {
        success: true,
        conversation_id: conversation.id,
        phone_number: phoneNumber,
        lender_id: lenderId,
        current_phase: 'greeting',
        message: greeting,
        lender_name: voiceInit.lender_name,
        lender_benefits: voiceInit.context.key_benefits
      };
    } catch (error) {
      console.error('[WhatsAppJourney] Start error:', error.message);
      return { success: false, error: error.message };
    }
  }

  async handleUserMessage(phoneNumber, lenderId, userMessage) {
    try {
      // Get current conversation state
      const { data: conversation, error: convError } = await supabase
        .from('conversation_state')
        .select('*')
        .eq('phone_number', phoneNumber)
        .single();

      if (convError || !conversation) {
        return { success: false, error: 'Conversation not found' };
      }

      // Generate lender-aware response
      const response = await voiceIntegration.generateLenderAwareBotResponse(
        lenderId,
        userMessage
      );

      if (!response.success) {
        return response;
      }

      // Update conversation state
      await supabase
        .from('conversation_state')
        .update({
          last_active_at: new Date().toISOString(),
          form_data: {
            ...conversation.form_data,
            last_user_input: userMessage
          }
        })
        .eq('phone_number', phoneNumber);

      // Log conversation event
      await supabase
        .from('conversation_events')
        .insert({
          phone_number: phoneNumber,
          phase: conversation.current_phase,
          event_type: 'user_message',
          user_input: userMessage,
          bot_response: response.message,
          metadata: { lender_id: lenderId }
        });

      // Send response via WhatsApp
      const whatsappResult = await anantaClient.sendTextMessage(
        phoneNumber,
        response.message
      );

      return {
        success: true,
        message: response.message,
        whatsapp_sent: whatsappResult.success,
        conversation_id: conversation.id,
        current_phase: conversation.current_phase
      };
    } catch (error) {
      console.error('[WhatsAppJourney] Message handling error:', error.message);
      return { success: false, error: error.message };
    }
  }

  async transitionPhase(phoneNumber, newPhase) {
    try {
      if (!this.phases.includes(newPhase)) {
        return { success: false, error: `Invalid phase: ${newPhase}` };
      }

      const { data, error } = await supabase
        .from('conversation_state')
        .update({
          current_phase: newPhase,
          last_active_at: new Date().toISOString()
        })
        .eq('phone_number', phoneNumber)
        .select()
        .single();

      if (error) {
        return { success: false, error: error.message };
      }

      return {
        success: true,
        phone_number: phoneNumber,
        new_phase: newPhase,
        message: `Transitioning to ${newPhase} phase`
      };
    } catch (error) {
      console.error('[WhatsAppJourney] Phase transition error:', error.message);
      return { success: false, error: error.message };
    }
  }

  async collectFormData(phoneNumber, formData) {
    try {
      const { data: conversation, error: convError } = await supabase
        .from('conversation_state')
        .select('form_data')
        .eq('phone_number', phoneNumber)
        .single();

      if (convError) {
        return { success: false, error: convError.message };
      }

      const updatedFormData = {
        ...conversation.form_data,
        ...formData,
        last_updated: new Date().toISOString()
      };

      const { data, error } = await supabase
        .from('conversation_state')
        .update({ form_data: updatedFormData })
        .eq('phone_number', phoneNumber)
        .select()
        .single();

      if (error) {
        return { success: false, error: error.message };
      }

      return {
        success: true,
        form_data: updatedFormData,
        fields_collected: Object.keys(formData).length
      };
    } catch (error) {
      console.error('[WhatsAppJourney] Form collection error:', error.message);
      return { success: false, error: error.message };
    }
  }

  async uploadDocument(phoneNumber, documentType, documentUrl) {
    try {
      const { data: conversation, error: convError } = await supabase
        .from('conversation_state')
        .select('document_status')
        .eq('phone_number', phoneNumber)
        .single();

      if (convError) {
        return { success: false, error: convError.message };
      }

      const updatedDocStatus = {
        ...conversation.document_status,
        [documentType]: {
          url: documentUrl,
          uploaded_at: new Date().toISOString(),
          status: 'pending_verification'
        }
      };

      const { data, error } = await supabase
        .from('conversation_state')
        .update({ document_status: updatedDocStatus })
        .eq('phone_number', phoneNumber)
        .select()
        .single();

      if (error) {
        return { success: false, error: error.message };
      }

      return {
        success: true,
        document_type: documentType,
        status: 'pending_verification',
        message: `${documentType} received and queued for verification`
      };
    } catch (error) {
      console.error('[WhatsAppJourney] Document upload error:', error.message);
      return { success: false, error: error.message };
    }
  }

  async completeApplication(phoneNumber, lenderId) {
    try {
      const { data, error } = await supabase
        .from('conversation_state')
        .update({
          current_phase: 'completion',
          status: 'completed',
          completed_at: new Date().toISOString()
        })
        .eq('phone_number', phoneNumber)
        .select()
        .single();

      if (error) {
        return { success: false, error: error.message };
      }

      // Send completion message
      const completionMsg = `Thank you for completing your application with us! We'll review your details and contact you shortly with next steps.`;
      await anantaClient.sendTextMessage(phoneNumber, completionMsg);

      return {
        success: true,
        message: 'Application completed successfully',
        phone_number: phoneNumber,
        lender_id: lenderId,
        completed_at: new Date().toISOString()
      };
    } catch (error) {
      console.error('[WhatsAppJourney] Completion error:', error.message);
      return { success: false, error: error.message };
    }
  }

  async getJourneyStatus(phoneNumber) {
    try {
      const { data: conversation, error } = await supabase
        .from('conversation_state')
        .select('*')
        .eq('phone_number', phoneNumber)
        .single();

      if (error) {
        return { success: false, error: 'Conversation not found' };
      }

      const { data: events } = await supabase
        .from('conversation_events')
        .select('event_type, created_at')
        .eq('phone_number', phoneNumber)
        .order('created_at', { ascending: false })
        .limit(10);

      return {
        success: true,
        phone_number: phoneNumber,
        status: conversation.status,
        current_phase: conversation.current_phase,
        form_data: conversation.form_data,
        documents: conversation.document_status,
        started_at: conversation.started_at,
        last_active: conversation.last_active_at,
        recent_events: events
      };
    } catch (error) {
      console.error('[WhatsAppJourney] Status error:', error.message);
      return { success: false, error: error.message };
    }
  }

  async redirectToExternalJourney(phoneNumber, lenderId, journeyUrl, fallbackUrl = null) {
    try {
      const { data: conversation, error: convError } = await supabase
        .from('conversation_state')
        .select('*')
        .eq('phone_number', phoneNumber)
        .single();

      if (convError) {
        return { success: false, error: convError.message };
      }

      // Update conversation state to mark as transferred to external journey
      await supabase
        .from('conversation_state')
        .update({
          status: 'transferred_to_external',
          current_phase: 'external_journey',
          last_active_at: new Date().toISOString(),
          form_data: {
            ...conversation.form_data,
            primary_url: journeyUrl,
            fallback_url: fallbackUrl
          }
        })
        .eq('phone_number', phoneNumber);

      // Log the redirect event
      await supabase
        .from('conversation_events')
        .insert({
          phone_number: phoneNumber,
          phase: conversation.current_phase,
          event_type: 'redirected_to_external_journey',
          metadata: { lender_id: lenderId, journey_url: journeyUrl, fallback_url: fallbackUrl }
        });

      // Send WhatsApp message with journey link
      const message = `Complete your loan journey here: ${journeyUrl}`;
      await anantaClient.sendTextMessage(phoneNumber, message);

      return {
        success: true,
        message: 'User redirected to external journey',
        phone_number: phoneNumber,
        lender_id: lenderId,
        journey_url: journeyUrl,
        fallback_url: fallbackUrl,
        whatsapp_sent: true
      };
    } catch (error) {
      console.error('[WhatsAppJourney] Redirect error:', error.message);
      return { success: false, error: error.message };
    }
  }

  async handleRejectionWithFallback(phoneNumber, lenderId, fallbackUrl) {
    try {
      const { data: conversation, error: convError } = await supabase
        .from('conversation_state')
        .select('*')
        .eq('phone_number', phoneNumber)
        .single();

      if (convError) {
        return { success: false, error: convError.message };
      }

      // Update conversation state
      await supabase
        .from('conversation_state')
        .update({
          status: 'rejected',
          current_phase: 'rejection_fallback',
          last_active_at: new Date().toISOString()
        })
        .eq('phone_number', phoneNumber);

      // Log rejection and fallback
      await supabase
        .from('conversation_events')
        .insert({
          phone_number: phoneNumber,
          phase: conversation.current_phase,
          event_type: 'rejection_with_fallback',
          metadata: { lender_id: lenderId, fallback_url: fallbackUrl }
        });

      // Send WhatsApp message with fallback offer
      const message = `We have another great offer for you! Click here to explore: ${fallbackUrl}`;
      await anantaClient.sendTextMessage(phoneNumber, message);

      return {
        success: true,
        message: 'Rejection handled with fallback offer',
        phone_number: phoneNumber,
        lender_id: lenderId,
        fallback_url: fallbackUrl,
        whatsapp_sent: true
      };
    } catch (error) {
      console.error('[WhatsAppJourney] Rejection fallback error:', error.message);
      return { success: false, error: error.message };
    }
  }

  async abandonJourney(phoneNumber, reason = 'user_initiated') {
    try {
      const { data, error } = await supabase
        .from('conversation_state')
        .update({
          status: 'abandoned',
          last_active_at: new Date().toISOString()
        })
        .eq('phone_number', phoneNumber)
        .select()
        .single();

      if (error) {
        return { success: false, error: error.message };
      }

      // Log abandonment
      await supabase
        .from('conversation_events')
        .insert({
          phone_number: phoneNumber,
          phase: data.current_phase,
          event_type: 'journey_abandoned',
          metadata: { reason }
        });

      return {
        success: true,
        message: 'Journey abandoned',
        phone_number: phoneNumber,
        reason
      };
    } catch (error) {
      console.error('[WhatsAppJourney] Abandon error:', error.message);
      return { success: false, error: error.message };
    }
  }
}

export default new WhatsAppBotJourney();
