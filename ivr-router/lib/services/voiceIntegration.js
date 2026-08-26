import voiceManager from './voiceManager.js';

class VoiceIntegration {
  constructor() {
    this.voiceManager = voiceManager;
  }

  async initializeConversationWithVoice(lenderId, userName = null) {
    try {
      // Get voice profile
      const profile = this.voiceManager.getVoiceProfile(lenderId);
      if (!profile) {
        return { success: false, error: 'Lender voice profile not found' };
      }

      // Generate personalized greeting
      const greetingResult = await this.voiceManager.generatePersonalizedGreeting(
        lenderId,
        userName
      );

      if (!greetingResult.success) {
        return greetingResult;
      }

      // Get lender profile for context
      const lenderProfile = this.voiceManager.getLenderProfile(lenderId);

      return {
        success: true,
        greeting: greetingResult.greeting,
        lender_profile: lenderProfile,
        voice_tone: profile.voice_profile.tone,
        voice_pace: profile.voice_profile.pace,
        tts_config: profile.tts_config,
        context: {
          product_description: profile.product_description,
          key_benefits: profile.key_benefits,
          timezone: profile.metadata.timezone
        }
      };
    } catch (error) {
      console.error('[VoiceIntegration] Initialization error:', error.message);
      return { success: false, error: error.message };
    }
  }

  async generateLenderAwareBotResponse(lenderId, userMessage, conversationContext = {}) {
    try {
      // Check if we have a template match
      const templateMatch = this.matchTemplate(userMessage);
      if (templateMatch) {
        const templateResult = await this.voiceManager.generateResponse(
          lenderId,
          templateMatch.template,
          templateMatch.variables
        );
        if (templateResult.success) {
          return templateResult;
        }
      }

      // Fall back to Claude with lender context
      return await this.voiceManager.generateMessageWithVoice(lenderId, userMessage);
    } catch (error) {
      console.error('[VoiceIntegration] Response error:', error.message);
      return { success: false, error: error.message };
    }
  }

  matchTemplate(userMessage) {
    const lowerMessage = userMessage.toLowerCase();

    // Pattern matching for common queries
    if (
      lowerMessage.includes('eligible') ||
      lowerMessage.includes('check eligibility') ||
      lowerMessage.includes('do i qualify')
    ) {
      return { template: 'eligibility_check', variables: {} };
    }

    if (
      lowerMessage.includes('approved') ||
      lowerMessage.includes('qualification')
    ) {
      return { template: 'approval', variables: { amount: 'your profile' } };
    }

    if (
      lowerMessage.includes('rejected') ||
      lowerMessage.includes('denied')
    ) {
      return { template: 'rejection', variables: { days: '30' } };
    }

    if (
      lowerMessage.includes('document') ||
      lowerMessage.includes('what do i need')
    ) {
      return { template: 'document_request', variables: { documents: 'ID, income proof, address proof' } };
    }

    if (
      lowerMessage.includes('rate') ||
      lowerMessage.includes('interest') ||
      lowerMessage.includes('cost')
    ) {
      return { template: 'rate_inquiry', variables: { rate: '9.99' } };
    }

    if (
      lowerMessage.includes('process') ||
      lowerMessage.includes('how long')
    ) {
      return { template: 'processing', variables: {} };
    }

    if (
      lowerMessage.includes('complete') ||
      lowerMessage.includes('done') ||
      lowerMessage.includes('approved')
    ) {
      return { template: 'completion', variables: {} };
    }

    return null;
  }

  async generateHandoffMessage(lenderId) {
    try {
      const profile = this.voiceManager.getVoiceProfile(lenderId);
      if (!profile) {
        return { success: false, error: 'Lender profile not found' };
      }

      return {
        success: true,
        message: profile.handoff_script,
        lender_id: lenderId,
        lender_name: profile.lender_name
      };
    } catch (error) {
      console.error('[VoiceIntegration] Handoff error:', error.message);
      return { success: false, error: error.message };
    }
  }

  async handleConversationError(lenderId, errorType = 'unclear_input') {
    try {
      const profile = this.voiceManager.getVoiceProfile(lenderId);
      if (!profile) {
        return { success: false, error: 'Lender profile not found' };
      }

      const errorResponse = profile.error_handling[errorType] || profile.error_handling.unclear_input;

      return {
        success: true,
        message: errorResponse,
        lender_id: lenderId,
        error_type: errorType
      };
    } catch (error) {
      console.error('[VoiceIntegration] Error handling failed:', error.message);
      return { success: false, error: error.message };
    }
  }

  getAvailableLenderVoices() {
    const voices = [];
    this.voiceManager.getAvailableVoices().forEach(lenderId => {
      const profile = this.voiceManager.getLenderProfile(lenderId);
      if (profile) {
        voices.push(profile);
      }
    });
    return voices;
  }

  async buildSystemPromptForLender(lenderId) {
    const contextPrompt = await this.voiceManager.generateLenderContextPrompt(lenderId);
    return contextPrompt;
  }
}

export default new VoiceIntegration();
