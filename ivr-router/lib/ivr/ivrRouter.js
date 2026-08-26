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

      // Add Poonawala config (no voice bot, with fallback)
      if (!this.lenderConfig.has('poonawala')) {
        this.lenderConfig.set('poonawala', {
          lender_name: 'Poonawala Fincorp',
          has_voice_bot: false,
          journey_url: 'https://instant-pocket-loan.poonawallafincorp.com/?utm_DSA_Code=PKA00192&UTM_Partner_Name=BuddyLoan&UTM_Partner_Medium=BDLParameter&UTM_Partner_AgentCode=IVRSMS&UTM_Partner_ReferenceID=PK2002',
          fallback_url: 'https://loans.apps.herofincorp.com/en/personal-loan?af_xp=custom&source_caller=ui&pid=Buddyloan&utm_medium=588&utm_campaignid=IVRSMS&is_retargeting=true&utm_source=partnership_BDL&shortlink=qtuldaei&utm_campaign=Buddyloan&af_reengagement_window=30d&c=Buddyloan_ACQ_08052025&referrer=af_tranid=Jog5Tb-3i0OzCfrWRkQShg&utm_source=partnership_BDL&af_android_url=https://loans.apps.herofincorp.com/en/personal-loan&utm_campaign=Buddyloan&c=Buddyloan_ACQ_08052025&pid=Buddyloan&af_ios_url=https://loans.apps.herofincorp.com/en/personal-loan'
        });
      }

      console.log(`[IVRRouter] Initialized ${this.voiceBots.size} voice bots`);
    } catch (error) {
      console.error('[IVRRouter] Initialization error:', error.message);
    }
  }

  async handleIncomingCall(phoneNumber, lenderId, dtmfInput = null) {
    try {
      const lenderConfig = this.lenderConfig.get(lenderId);
      if (!lenderConfig) {
        return { success: false, error: `Lender configuration not found: ${lenderId}` };
      }

      // If DTMF "1" is pressed, route to both voice bot AND WhatsApp
      if (dtmfInput === '1') {
        return await this.routeToDualChannels(phoneNumber, lenderId, lenderConfig);
      }

      // Default: present main menu
      return this.presentMainMenu(lenderId, lenderConfig);
    } catch (error) {
      console.error('[IVRRouter] Incoming call error:', error.message);
      return { success: false, error: error.message };
    }
  }

  async routeToDualChannels(phoneNumber, lenderId, lenderConfig) {
    try {
      if (lenderConfig.has_voice_bot) {
        // Flexiloans: Route to both Ori voice bot and WhatsApp
        const botProfile = this.voiceBots.get(lenderConfig.voice_bot_id);
        if (!botProfile) {
          return { success: false, error: 'Voice bot profile not found' };
        }

        return {
          success: true,
          route: 'dual_channels',
          phone_number: phoneNumber,
          lender_id: lenderId,
          channels: [
            {
              channel: 'voice_bot',
              voice_bot_id: lenderConfig.voice_bot_id,
              voice_name: lenderConfig.voice_name,
              welcome_prompt: botProfile.ivr_prompts.welcome,
              tts_config: botProfile.tts_config,
              navigation_shortcuts: botProfile.navigation_shortcuts,
              next_action: 'play_welcome_and_listen'
            },
            {
              channel: 'whatsapp_bot',
              message: `You're connected to ${lenderConfig.lender_name}! You can speak with ${lenderConfig.voice_name} or chat with us on WhatsApp.`,
              next_action: 'send_whatsapp_greeting'
            }
          ],
          ivr_context: {
            lender_name: lenderConfig.lender_name,
            dual_channel: true
          }
        };
      } else {
        // Poonawala: Route to pre-qualified offer + WhatsApp with journey link
        return {
          success: true,
          route: 'dual_channels',
          phone_number: phoneNumber,
          lender_id: lenderId,
          channels: [
            {
              channel: 'ivr_offer',
              message: `You have a pre-qualified offer from ${lenderConfig.lender_name}`,
              next_action: 'announce_offer'
            },
            {
              channel: 'whatsapp_bot',
              journey_url: lenderConfig.journey_url,
              fallback_url: lenderConfig.fallback_url,
              message: `You have a pre-qualified offer! Click here to complete your application: ${lenderConfig.journey_url}`,
              next_action: 'send_whatsapp_journey_link'
            }
          ],
          ivr_context: {
            lender_name: lenderConfig.lender_name,
            dual_channel: true,
            pre_qualified: true
          }
        };
      }
    } catch (error) {
      console.error('[IVRRouter] Dual channel routing error:', error.message);
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

      // For Poonawala, include journey URL and fallback for web redirect
      if (lenderId === 'poonawala') {
        response.journey_url = lenderConfig.journey_url;
        response.fallback_url = lenderConfig.fallback_url;
        response.message = `You have a pre-qualified offer! Click or tap this link to complete your loan application: ${lenderConfig.journey_url}`;
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
      lenderGreeting = "Welcome to Flexiloans! Press 1 to connect with Ori and WhatsApp, or stay on the line to speak with our specialist.";
      options = {
        1: {
          action: 'dual_channels',
          description: 'Connect with Ori voice bot and WhatsApp simultaneously',
          voice_bot_id: voiceBot.voice_bot_id
        },
        0: {
          action: 'operator',
          description: 'Speak with human agent'
        }
      };
    } else {
      // Poonawala - pre-qualified offer flow with dual channels
      lenderGreeting = "You have a pre-qualified offer from Poonawala Fincorp for an instant personal loan. Press 1 to accept and receive your offer via WhatsApp, or remain on the line to speak with our specialist.";
      options = {
        1: {
          action: 'dual_channels',
          description: 'Accept pre-qualified offer and connect via WhatsApp',
          prompt: 'Sending you the offer details...'
        },
        0: {
          action: 'operator',
          description: 'Speak with specialist'
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
          // Press 1: Route to dual channels (voice bot + WhatsApp for Flexiloans, offer + WhatsApp for Poonawala)
          return await this.routeToDualChannels(phoneNumber, lenderId, lenderConfig);

        case '2':
          // Press 2: Only valid for Flexiloans (WhatsApp only without voice bot)
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
