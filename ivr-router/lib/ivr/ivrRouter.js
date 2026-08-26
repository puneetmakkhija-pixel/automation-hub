import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class IVRRouter {
  constructor() {
    this.voiceBots = new Map();
    this.lenderConfig = new Map();
    this.initializeVoiceBots();
  }

  initializeVoiceBots() {
    try {
      const voicesDir = path.join(__dirname, '../../config/voices');

      // Load voice bot profiles (Ori for Flexiloans only)
      const botFiles = fs.readdirSync(voicesDir).filter(f =>
        f.includes('voice-bot') && f.endsWith('.json')
      );

      botFiles.forEach(file => {
        const filePath = path.join(voicesDir, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        const profile = JSON.parse(content);

        this.voiceBots.set(profile.voice_bot_id, profile);

        if (!this.lenderConfig.has(profile.lender_id)) {
          this.lenderConfig.set(profile.lender_id, {
            lender_name: profile.lender_name,
            voice_bot_id: profile.voice_bot_id,
            voice_name: profile.voice_name,
            has_voice_bot: true
          });
        }
      });

      // Add Poonawala config (no voice bot)
      if (!this.lenderConfig.has('poonawala')) {
        this.lenderConfig.set('poonawala', {
          lender_name: 'Poonawala Fincorp',
          has_voice_bot: false,
          journey_url: 'https://instant-pocket-loan.poonawallafincorp.com/?utm_DSA_Code=PKA00192&UTM_Partner_Name=BuddyLoan&UTM_Partner_Medium=BDLParameter&UTM_Partner_AgentCode=IVRSMS&UTM_Partner_ReferenceID=PK2002'
        });
      }

      console.log(`[IVRRouter] Initialized ${this.voiceBots.size} voice bots`);
    } catch (error) {
      console.error('[IVRRouter] Initialization error:', error.message);
    }
  }

  async handleIncomingCall(phoneNumber, lenderId, dtmfInput = null) {
    try {
      const voiceBot = this.lenderConfig.get(lenderId);
      if (!voiceBot) {
        return { success: false, error: `Lender configuration not found: ${lenderId}` };
      }

      // If DTMF "1" is pressed, route to voice bot
      if (dtmfInput === '1') {
        return await this.routeToVoiceBot(phoneNumber, lenderId, voiceBot);
      }

      // Default: present main menu
      return this.presentMainMenu(lenderId, voiceBot);
    } catch (error) {
      console.error('[IVRRouter] Incoming call error:', error.message);
      return { success: false, error: error.message };
    }
  }

  async routeToVoiceBot(phoneNumber, lenderId, voiceBot) {
    try {
      const botProfile = this.voiceBots.get(voiceBot.voice_bot_id);
      if (!botProfile) {
        return { success: false, error: 'Voice bot profile not found' };
      }

      return {
        success: true,
        route: 'voice_bot',
        phone_number: phoneNumber,
        lender_id: lenderId,
        voice_bot_id: voiceBot.voice_bot_id,
        voice_name: voiceBot.voice_name,
        welcome_prompt: botProfile.ivr_prompts.welcome,
        tts_config: botProfile.tts_config,
        navigation_shortcuts: botProfile.navigation_shortcuts,
        ivr_context: {
          lender_name: voiceBot.lender_name,
          channel: 'voice_ivr',
          voice_type: 'ai_voice'
        },
        next_action: 'play_welcome_and_listen'
      };
    } catch (error) {
      console.error('[IVRRouter] Voice bot routing error:', error.message);
      return { success: false, error: error.message };
    }
  }

  async routeToWhatsAppBot(phoneNumber, lenderId) {
    try {
      const lenderConfig = this.lenderConfig.get(lenderId);
      if (!lenderConfig) {
        return { success: false, error: 'Lender configuration not found' };
      }

      const response = {
        success: true,
        route: 'whatsapp_bot',
        phone_number: phoneNumber,
        lender_id: lenderId,
        message: `You're being transferred to WhatsApp. Look for a message from ${lenderConfig.lender_name}!`,
        next_action: 'send_whatsapp_greeting'
      };

      // For Poonawala, include journey URL for web redirect
      if (lenderId === 'poonawala' && lenderConfig.journey_url) {
        response.journey_url = lenderConfig.journey_url;
        response.message = `Click or tap this link to continue your loan journey: ${lenderConfig.journey_url}`;
        response.next_action = 'send_whatsapp_journey_link';
      }

      return response;
    } catch (error) {
      console.error('[IVRRouter] WhatsApp routing error:', error.message);
      return { success: false, error: error.message };
    }
  }

  presentMainMenu(lenderId, voiceBot) {
    const hasVoiceBot = voiceBot?.has_voice_bot || false;

    let lenderGreeting;
    let options;

    if (lenderId === 'flexiloans') {
      lenderGreeting = "Welcome to Flexiloans! Press 1 to start your loan application with Ori, press 2 for WhatsApp, or stay on the line to speak with our specialist.";
      options = {
        1: {
          action: 'voice_bot',
          description: 'Start application with Ori (AI voice assistant)',
          voice_bot_id: voiceBot.voice_bot_id
        },
        2: {
          action: 'whatsapp_bot',
          description: 'Continue on WhatsApp',
          prompt: 'Transferring you to WhatsApp...'
        },
        0: {
          action: 'operator',
          description: 'Speak with human agent'
        }
      };
    } else {
      // Poonawala - no voice bot
      lenderGreeting = "Welcome to Poonawala Fincorp. Press 1 to continue on WhatsApp, or remain on the line to speak with our advisor.";
      options = {
        1: {
          action: 'whatsapp_bot',
          description: 'Continue on WhatsApp',
          prompt: 'Transferring you to WhatsApp...'
        },
        0: {
          action: 'operator',
          description: 'Speak with human agent'
        }
      };
    }

    return {
      success: true,
      route: 'main_menu',
      lender_id: lenderId,
      menu_prompt: lenderGreeting,
      options,
      timeout_seconds: 30,
      next_action: 'wait_for_dtmf'
    };
  }

  async handleDTMFInput(phoneNumber, lenderId, dtmfKey) {
    try {
      const lenderConfig = this.lenderConfig.get(lenderId);
      if (!lenderConfig) {
        return { success: false, error: 'Lender configuration not found' };
      }

      switch (dtmfKey) {
        case '1':
          // Press 1: Route to voice bot for Flexiloans, WhatsApp for Poonawala
          if (lenderConfig.has_voice_bot) {
            const voiceBot = this.lenderConfig.get(lenderId);
            return await this.routeToVoiceBot(phoneNumber, lenderId, voiceBot);
          } else {
            return await this.routeToWhatsAppBot(phoneNumber, lenderId);
          }

        case '2':
          // Press 2: Route to WhatsApp bot (Flexiloans only)
          if (lenderConfig.has_voice_bot) {
            return await this.routeToWhatsAppBot(phoneNumber, lenderId);
          } else {
            return {
              success: false,
              error: `Invalid input: ${dtmfKey}`,
              retry: true,
              message: 'Invalid option. Press 1 for WhatsApp or 0 for operator'
            };
          }

        case '0':
          // Return to main menu
          return this.presentMainMenu(lenderId, lenderConfig);

        default:
          return {
            success: false,
            error: `Invalid input: ${dtmfKey}`,
            retry: true,
            message: lenderConfig.has_voice_bot
              ? 'Please press 1 for voice assistant or 2 for WhatsApp'
              : 'Please press 1 for WhatsApp or 0 for operator'
          };
      }
    } catch (error) {
      console.error('[IVRRouter] DTMF handling error:', error.message);
      return { success: false, error: error.message };
    }
  }

  async transferToOperator(phoneNumber, lenderId) {
    try {
      const voiceBot = this.lenderConfig.get(lenderId);
      if (!voiceBot) {
        return { success: false, error: 'Lender configuration not found' };
      }

      return {
        success: true,
        route: 'human_operator',
        phone_number: phoneNumber,
        lender_id: lenderId,
        transfer_message: `Thank you for calling ${voiceBot.lender_name}. Connecting you with our specialist...`,
        next_action: 'queue_to_operator'
      };
    } catch (error) {
      console.error('[IVRRouter] Operator transfer error:', error.message);
      return { success: false, error: error.message };
    }
  }

  async handleCallTimeout(phoneNumber, lenderId) {
    try {
      const voiceBot = this.lenderConfig.get(lenderId);
      if (!voiceBot) {
        return { success: false, error: 'Lender configuration not found' };
      }

      return {
        success: true,
        route: 'callback',
        phone_number: phoneNumber,
        lender_id: lenderId,
        callback_message: `No input received. We'll send you a WhatsApp message shortly with a link to continue your application.`,
        next_action: 'end_call_and_send_whatsapp'
      };
    } catch (error) {
      console.error('[IVRRouter] Timeout handler error:', error.message);
      return { success: false, error: error.message };
    }
  }

  getVoiceBotInfo(voiceBotId) {
    return this.voiceBots.get(voiceBotId);
  }

  getAllVoiceBots() {
    return Array.from(this.voiceBots.values());
  }

  getLenderInfo(lenderId) {
    return this.lenderConfig.get(lenderId);
  }

  async handleVoiceInput(phoneNumber, lenderId, voiceInput) {
    try {
      // This would integrate with speech-to-text and then route accordingly
      const voiceBot = this.lenderConfig.get(lenderId);
      if (!voiceBot) {
        return { success: false, error: 'Lender configuration not found' };
      }

      const inputLower = voiceInput.toLowerCase();

      // Simple keyword matching for routing
      if (inputLower.includes('whatsapp') || inputLower.includes('message') || inputLower.includes('chat')) {
        return await this.routeToWhatsAppBot(phoneNumber, lenderId);
      }

      if (inputLower.includes('voice') || inputLower.includes('call') || inputLower.includes('speak')) {
        return await this.routeToVoiceBot(phoneNumber, lenderId, voiceBot);
      }

      if (inputLower.includes('operator') || inputLower.includes('agent') || inputLower.includes('human')) {
        return await this.transferToOperator(phoneNumber, lenderId);
      }

      // Default: continue with voice bot
      return {
        success: true,
        route: 'voice_bot',
        phone_number: phoneNumber,
        user_input: voiceInput,
        understood: true
      };
    } catch (error) {
      console.error('[IVRRouter] Voice input handling error:', error.message);
      return { success: false, error: error.message };
    }
  }
}

export default new IVRRouter();
