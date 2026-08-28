import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const client = new Anthropic();

class VoiceManager {
  constructor() {
    this.voiceProfiles = new Map();
    this.initializeVoices();
  }

  initializeVoices() {
    try {
      const voicesDir = path.join(__dirname, '../../config/voices');
      if (!fs.existsSync(voicesDir)) {
        console.warn('[VoiceManager] Voices directory not found');
        return;
      }

      const files = fs.readdirSync(voicesDir).filter(f => f.endsWith('.json'));
      files.forEach(file => {
        const filePath = path.join(voicesDir, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        const profile = JSON.parse(content);
        this.voiceProfiles.set(profile.lender_id, profile);
      });

      console.log(`[VoiceManager] Loaded ${this.voiceProfiles.size} voice profiles`);
    } catch (error) {
      console.error('[VoiceManager] Initialization error:', error.message);
    }
  }

  getVoiceProfile(lenderId) {
    return this.voiceProfiles.get(lenderId);
  }

  getAvailableVoices() {
    return Array.from(this.voiceProfiles.keys());
  }

  async generateResponse(lenderId, templateName, variables = {}) {
    try {
      const profile = this.getVoiceProfile(lenderId);
      if (!profile) {
        return { success: false, error: `Voice profile not found for lender: ${lenderId}` };
      }

      const template = profile.common_responses[templateName];
      if (!template) {
        return { success: false, error: `Template '${templateName}' not found` };
      }

      // Replace variables in template
      let response = template;
      Object.entries(variables).forEach(([key, value]) => {
        response = response.replace(`{{${key}}}`, value);
      });

      return {
        success: true,
        response,
        lender_id: lenderId,
        lender_name: profile.lender_name,
        voice_config: profile.tts_config,
        template_name: templateName
      };
    } catch (error) {
      console.error('[VoiceManager] Response generation error:', error.message);
      return { success: false, error: error.message };
    }
  }

  async generatePersonalizedGreeting(lenderId, userName = null) {
    try {
      const profile = this.getVoiceProfile(lenderId);
      if (!profile) {
        return { success: false, error: `Voice profile not found for lender: ${lenderId}` };
      }

      const greetings = profile.greeting_variants;
      const baseGreeting = greetings[Math.floor(Math.random() * greetings.length)];

      // If user name provided, make it more personal
      let personalizedGreeting = baseGreeting;
      if (userName) {
        personalizedGreeting = `Hi ${userName}! ${baseGreeting}`;
      }

      return {
        success: true,
        greeting: personalizedGreeting,
        lender_id: lenderId,
        lender_name: profile.lender_name
      };
    } catch (error) {
      console.error('[VoiceManager] Greeting generation error:', error.message);
      return { success: false, error: error.message };
    }
  }

  async generateLenderContextPrompt(lenderId) {
    try {
      const profile = this.getVoiceProfile(lenderId);
      if (!profile) {
        return null;
      }

      return `You are an IVR assistant for ${profile.lender_name}.
Your tone should be ${profile.voice_profile.tone} and measured.
Our product: ${profile.product_description}
Key benefits: ${profile.key_benefits.join(', ')}

When responding, use the established tone and benefits of ${profile.lender_name}.
Keep responses concise and professional.`;
    } catch (error) {
      console.error('[VoiceManager] Context prompt error:', error.message);
      return null;
    }
  }

  async generateMessageWithVoice(lenderId, userMessage) {
    try {
      const profile = this.getVoiceProfile(lenderId);
      if (!profile) {
        return { success: false, error: `Voice profile not found for lender: ${lenderId}` };
      }

      const contextPrompt = await this.generateLenderContextPrompt(lenderId);
      if (!contextPrompt) {
        return { success: false, error: 'Could not generate context prompt' };
      }

      const message = await client.messages.create({
        model: process.env.CLAUDE_MODEL || 'claude-3-5-sonnet-20241022',
        max_tokens: 256,
        system: contextPrompt,
        messages: [
          {
            role: 'user',
            content: userMessage
          }
        ]
      });

      const responseText = message.content[0].type === 'text' ? message.content[0].text : '';

      return {
        success: true,
        message: responseText,
        lender_id: lenderId,
        lender_name: profile.lender_name,
        voice_config: profile.tts_config,
        tone: profile.voice_profile.tone,
        pace: profile.voice_profile.pace
      };
    } catch (error) {
      console.error('[VoiceManager] Message generation error:', error.message);
      return { success: false, error: error.message };
    }
  }

  getLenderProfile(lenderId) {
    const profile = this.getVoiceProfile(lenderId);
    if (!profile) return null;

    return {
      lender_id: profile.lender_id,
      lender_name: profile.lender_name,
      description: profile.product_description,
      benefits: profile.key_benefits,
      tone: profile.voice_profile.tone,
      language: profile.metadata.language,
      timezone: profile.metadata.timezone
    };
  }
}

export default new VoiceManager();
