import ananta from '../clients/anantaClient.js';
import supabase from '../clients/supabaseClient.js';
import PhaseHandlers from '../state-machine/handlers.js';

class AnantaWebhookHandler {
  static async handleMessage(req, res) {
    try {
      const { phone, message_text: userMessage, message_type } = req.body;

      console.log(`[Webhook] Message from ${phone}: ${userMessage}`);

      if (!phone || !userMessage) {
        return res.status(400).json({ error: 'Missing phone or message_text' });
      }

      const state = await supabase.getOrCreateConversationState(phone);
      console.log(`[State] Current phase: ${state.current_phase}`);

      const phaseHandler = PhaseHandlers[`handle${this.capitalizePhase(state.current_phase)}`];
      if (!phaseHandler) {
        throw new Error(`No handler for phase: ${state.current_phase}`);
      }

      const result = await phaseHandler(state, userMessage);

      await supabase.logConversationEvent(
        phone,
        state.current_phase,
        'message_received',
        userMessage,
        result.message,
        { validation: result.validation }
      );

      await this.sendResponse(phone, result);

      await this.checkAbandonment(phone, state);

      res.json({ success: true, phase: result.nextPhase });
    } catch (error) {
      console.error('[Webhook] Error:', error);

      const phone = req.body.phone;
      if (phone) {
        await ananta.sendTextMessage(
          phone,
          '❌ Sorry, something went wrong. Please try again or reply HELP.'
        );
      }

      res.status(500).json({ error: error.message });
    }
  }

  static async sendResponse(phone, result) {
    const { message, messageType, buttons } = result;

    if (messageType === 'interactive' && buttons) {
      await ananta.sendInteractiveMessage(phone, message, buttons);
    } else if (messageType === 'text') {
      await ananta.sendTextMessage(phone, message);
    } else {
      await ananta.sendTextMessage(phone, message);
    }

    await supabase.logConversationEvent(
      phone,
      result.nextPhase,
      'message_sent',
      null,
      message,
      { messageType }
    );
  }

  static async checkAbandonment(phone, state) {
    const now = new Date();
    const lastActive = new Date(state.last_active_at);
    const inactiveMinutes = (now - lastActive) / (1000 * 60);

    if (inactiveMinutes > 120 && state.status === 'active') {
      const completionPercent = this.estimateCompletion(state.current_phase);

      await ananta.sendTextMessage(
        phone,
        `👋 Still interested?\n\nYou're ${completionPercent}% through your application. Takes just 2 minutes to finish!\n\nReply YES to continue.`
      );
    }
  }

  static estimateCompletion(phase) {
    const phases = {
      'product_selection': 10,
      'eligibility_check': 20,
      'lender_selection': 30,
      'form_personal': 50,
      'form_business': 60,
      'documents': 80,
      'kyc_verification': 85,
      'lender_submission': 90,
      'approval': 100
    };
    return phases[phase] || 10;
  }

  static capitalizePhase(phase) {
    return phase
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join('');
  }
}

export default AnantaWebhookHandler;
