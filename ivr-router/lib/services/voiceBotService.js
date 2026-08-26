import supabase from '../clients/supabaseClient.js';
import Anthropic from '@anthropic-ai/sdk';
import ivrRouter from '../ivr/ivrRouter.js';

const client = new Anthropic();

class VoiceBotService {
  constructor() {
    this.ivrRouter = ivrRouter;
  }

  async startVoiceSession(phoneNumber, lenderId, voiceBotId) {
    try {
      const botProfile = this.ivrRouter.getVoiceBotInfo(voiceBotId);
      if (!botProfile) {
        return { success: false, error: 'Voice bot profile not found' };
      }

      // Create voice session in database
      const { data: session, error: sessionError } = await supabase
        .from('voice_bot_sessions')
        .insert({
          phone_number: phoneNumber,
          lender_id: lenderId,
          voice_bot_id: voiceBotId,
          voice_name: botProfile.voice_name,
          status: 'active',
          started_at: new Date().toISOString(),
          last_interaction_at: new Date().toISOString()
        })
        .select()
        .single();

      if (sessionError) {
        console.error('[VoiceBotService] Session creation error:', sessionError.message);
      }

      return {
        success: true,
        session_id: session?.id,
        phone_number: phoneNumber,
        voice_bot_id: voiceBotId,
        voice_name: botProfile.voice_name,
        welcome_prompt: botProfile.ivr_prompts.welcome,
        tts_config: botProfile.tts_config
      };
    } catch (error) {
      console.error('[VoiceBotService] Start session error:', error.message);
      return { success: false, error: error.message };
    }
  }

  async processVoiceInput(phoneNumber, lenderId, voiceBotId, userSpeech) {
    try {
      const botProfile = this.ivrRouter.getVoiceBotInfo(voiceBotId);
      if (!botProfile) {
        return { success: false, error: 'Voice bot profile not found' };
      }

      // Generate context prompt based on bot personality
      const systemPrompt = this.buildSystemPrompt(botProfile, lenderId);

      // Use Claude to generate conversational response
      const message = await client.messages.create({
        model: process.env.CLAUDE_MODEL || 'claude-3-5-sonnet-20241022',
        max_tokens: 256,
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content: userSpeech
          }
        ]
      });

      const responseText = message.content[0].type === 'text' ? message.content[0].text : '';

      // Log interaction
      await supabase
        .from('voice_bot_interactions')
        .insert({
          phone_number: phoneNumber,
          lender_id: lenderId,
          voice_bot_id: voiceBotId,
          user_input: userSpeech,
          bot_response: responseText,
          created_at: new Date().toISOString()
        });

      return {
        success: true,
        response: responseText,
        voice_bot_id: voiceBotId,
        voice_name: botProfile.voice_name,
        tts_config: botProfile.tts_config
      };
    } catch (error) {
      console.error('[VoiceBotService] Process input error:', error.message);
      return { success: false, error: error.message };
    }
  }

  buildSystemPrompt(botProfile, lenderId) {
    const lenderInfo = this.ivrRouter.getLenderInfo(lenderId);

    return `You are ${botProfile.voice_name}, a ${botProfile.voice_profile.tone} AI voice assistant for ${lenderInfo.lender_name}.

Your personality:
- Tone: ${botProfile.voice_profile.tone}
- Energy level: ${botProfile.voice_profile.energy}
- Pace: ${botProfile.voice_profile.pace}
- Always maintain a natural, conversational speech pattern suitable for voice calls

Company context:
- You represent ${lenderInfo.lender_name}
- Help users with loan applications and eligibility checks
- Be helpful, supportive, and professional

Communication guidelines:
- Keep responses concise (under 100 words for voice)
- Use simple, conversational language
- Ask one clear question at a time
- Be warm and encouraging
- If users mention WhatsApp, offer to transfer them there
- If they ask for a human, offer to connect them with a specialist

Your role is to make the user feel comfortable and guided through their loan inquiry process.`;
  }

  async handleUserIntent(phoneNumber, lenderId, voiceBotId, userSpeech) {
    try {
      const botProfile = this.ivrRouter.getVoiceBotInfo(voiceBotId);
      if (!botProfile) {
        return { success: false, error: 'Voice bot profile not found' };
      }

      // Detect intent from user speech
      const intent = this.detectIntent(userSpeech, botProfile);

      if (intent.type === 'transfer_whatsapp') {
        return {
          success: true,
          action: 'transfer_to_whatsapp',
          message: `Transferring you to WhatsApp so we can continue there. You'll receive a message shortly.`,
          phone_number: phoneNumber,
          lender_id: lenderId
        };
      }

      if (intent.type === 'transfer_human') {
        return {
          success: true,
          action: 'transfer_to_operator',
          message: `Connecting you with our specialist right now.`,
          phone_number: phoneNumber,
          lender_id: lenderId
        };
      }

      if (intent.type === 'eligibility_check') {
        return {
          success: true,
          action: 'eligibility_check',
          message: botProfile.ivr_prompts.eligibility_check,
          next_step: 'collect_user_data'
        };
      }

      if (intent.type === 'start_application') {
        return {
          success: true,
          action: 'start_application',
          message: 'Great! Let\'s get started with your application.',
          next_step: 'collect_personal_info'
        };
      }

      // Default: continue conversation
      return {
        success: true,
        action: 'continue_conversation',
        intent: intent.type
      };
    } catch (error) {
      console.error('[VoiceBotService] Intent handling error:', error.message);
      return { success: false, error: error.message };
    }
  }

  detectIntent(userSpeech, botProfile) {
    const speech = userSpeech.toLowerCase();

    const intents = {
      transfer_whatsapp: ['whatsapp', 'message', 'chat', 'text me', 'send message'],
      transfer_human: ['agent', 'operator', 'human', 'person', 'specialist', 'manager'],
      eligibility_check: ['eligible', 'qualify', 'check eligibility', 'am i eligible'],
      start_application: ['apply', 'application', 'start', 'begin', 'process'],
      loan_amount: ['how much', 'loan amount', 'amount', 'borrow'],
      interest_rate: ['rate', 'interest', 'cost', 'charge'],
      documents_needed: ['documents', 'papers', 'what do i need', 'required']
    };

    for (const [intentType, keywords] of Object.entries(intents)) {
      if (keywords.some(keyword => speech.includes(keyword))) {
        return { type: intentType, confidence: 0.8 };
      }
    }

    return { type: 'general_inquiry', confidence: 0.5 };
  }

  async endVoiceSession(phoneNumber, lenderId, voiceBotId, reason = 'completed') {
    try {
      const { error } = await supabase
        .from('voice_bot_sessions')
        .update({
          status: 'completed',
          ended_at: new Date().toISOString(),
          end_reason: reason
        })
        .eq('phone_number', phoneNumber)
        .eq('voice_bot_id', voiceBotId)
        .eq('status', 'active');

      if (error) {
        console.warn('[VoiceBotService] Session end warning:', error.message);
      }

      return {
        success: true,
        message: 'Voice session ended',
        phone_number: phoneNumber,
        reason
      };
    } catch (error) {
      console.error('[VoiceBotService] End session error:', error.message);
      return { success: false, error: error.message };
    }
  }

  async getSessionTranscript(phoneNumber, voiceBotId) {
    try {
      const { data: interactions, error } = await supabase
        .from('voice_bot_interactions')
        .select('*')
        .eq('phone_number', phoneNumber)
        .eq('voice_bot_id', voiceBotId)
        .order('created_at', { ascending: true });

      if (error) {
        return { success: false, error: error.message };
      }

      const transcript = interactions.map(i => ({
        user: i.user_input,
        bot: i.bot_response,
        timestamp: i.created_at
      }));

      return {
        success: true,
        phone_number: phoneNumber,
        voice_bot_id: voiceBotId,
        transcript,
        interaction_count: transcript.length
      };
    } catch (error) {
      console.error('[VoiceBotService] Transcript error:', error.message);
      return { success: false, error: error.message };
    }
  }
}

export default new VoiceBotService();
