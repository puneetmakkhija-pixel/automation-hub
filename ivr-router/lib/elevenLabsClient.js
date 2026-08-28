/**
 * Eleven Labs Text-to-Speech and Voice Generation Client
 * Convert text to natural-sounding speech for IVR menus and notifications
 *
 * Features:
 *   - Text-to-speech (TTS) for IVR menus and prompts
 *   - Voice cloning for personalized messages
 *   - Multiple voice profiles
 *   - Audio generation with streaming support
 *
 * Environment Variables:
 *   ELEVEN_LABS_API_KEY - Your Eleven Labs API key
 *   ELEVEN_LABS_BASE_URL - API base URL (optional, defaults to production)
 *
 * Usage:
 *   import ElevenLabsClient from './elevenLabsClient.js';
 *   const voiceClient = new ElevenLabsClient(process.env.ELEVEN_LABS_API_KEY);
 *
 *   // Text to speech
 *   const audio = await voiceClient.textToSpeech({
 *     text: 'Welcome to BuddyLoan. Press 1 for loan status.',
 *     voiceId: 'EXAVITQu4vr4xnSDxMaL', // default voice
 *     stability: 0.5
 *   });
 *
 *   // List available voices
 *   const voices = await voiceClient.listVoices();
 */

class ElevenLabsError extends Error {
  constructor(message, statusCode, response) {
    super(message);
    this.name = 'ElevenLabsError';
    this.statusCode = statusCode;
    this.response = response;
  }
}

class ElevenLabsClient {
  constructor(apiKey, baseUrl, timeout = 30000) {
    this.apiKey = apiKey || process.env.ELEVEN_LABS_API_KEY;
    this.baseUrl = baseUrl || process.env.ELEVEN_LABS_BASE_URL || 'https://api.elevenlabs.io/v1';
    this.timeout = timeout;

    if (!this.apiKey) {
      throw new ElevenLabsError(
        'Missing ELEVEN_LABS_API_KEY environment variable',
        null,
        null
      );
    }

    // Default voice IDs
    this.defaultVoices = {
      rachel: 'EXAVITQu4vr4xnSDxMaL',
      clyde: 'iP95p4xoKVk53Go1tcWO',
      domi: 'AZnzlk1mvXvSRwSDtXLj',
      sky: 'core',
      bella: 'EXAVITQu4vr4xnSDxMaL',
    };
  }

  /**
   * Make API request to Eleven Labs
   */
  async makeRequest(method, path, body = null, headers = {}) {
    const url = `${this.baseUrl}${path}`;
    const defaultHeaders = {
      'xi-api-key': this.apiKey,
      'Content-Type': 'application/json',
      ...headers,
    };

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const response = await fetch(url, {
        method,
        headers: defaultHeaders,
        body: body ? JSON.stringify(body) : null,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      let data;
      const contentType = response.headers.get('content-type');

      if (contentType && contentType.includes('application/json')) {
        data = await response.json();
      } else if (method === 'GET' && contentType && contentType.includes('audio')) {
        // Return audio buffer for TTS
        data = await response.arrayBuffer();
      } else {
        data = { raw_text: await response.text() };
      }

      if (!response.ok) {
        throw new ElevenLabsError(
          `${method} ${path} failed with HTTP ${response.status}`,
          response.status,
          data
        );
      }

      return data;
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new ElevenLabsError(
          `Request timeout after ${this.timeout}ms`,
          null,
          null
        );
      }
      if (error instanceof ElevenLabsError) {
        throw error;
      }
      throw new ElevenLabsError(
        `Network error: ${error.message}`,
        null,
        null
      );
    }
  }

  /**
   * Convert text to speech
   *
   * @param {Object} options - TTS options
   * @param {string} options.text - Text to convert
   * @param {string} options.voiceId - Voice ID (default: Rachel)
   * @param {number} options.stability - Stability (0-1, default: 0.5)
   * @param {number} options.similarityBoost - Similarity boost (0-1, default: 0.75)
   * @param {string} options.modelId - Model ID (default: eleven_monolingual_v1)
   * @returns {Promise<Buffer>} Audio data in MP3 format
   */
  async textToSpeech(options) {
    const {
      text,
      voiceId = this.defaultVoices.rachel,
      stability = 0.5,
      similarityBoost = 0.75,
      modelId = 'eleven_monolingual_v1',
    } = options;

    if (!text) {
      throw new ElevenLabsError('text is required', null, null);
    }

    const payload = {
      text,
      model_id: modelId,
      voice_settings: {
        stability,
        similarity_boost: similarityBoost,
      },
    };

    try {
      const audioBuffer = await this.makeRequest(
        'POST',
        `/text-to-speech/${voiceId}`,
        payload,
        { 'Content-Type': 'application/json' }
      );

      return {
        success: true,
        audio: audioBuffer,
        voiceId,
        textLength: text.length,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      console.error('Text to speech error:', error.message);
      return {
        success: false,
        error: error.message,
        statusCode: error.statusCode,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * List available voices
   */
  async listVoices() {
    try {
      const response = await this.makeRequest('GET', '/voices');

      return {
        success: true,
        voices: response.voices || [],
        count: response.voices?.length || 0,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      console.error('List voices error:', error.message);
      return {
        success: false,
        error: error.message,
        voices: [],
        count: 0,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Get voice details
   */
  async getVoice(voiceId) {
    if (!voiceId) {
      throw new ElevenLabsError('voiceId is required', null, null);
    }

    try {
      const response = await this.makeRequest('GET', `/voices/${voiceId}`);

      return {
        success: true,
        voice: response,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      console.error('Get voice error:', error.message);
      return {
        success: false,
        error: error.message,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Get user information and subscription
   */
  async getUserInfo() {
    try {
      const response = await this.makeRequest('GET', '/user');

      return {
        success: true,
        user: response,
        subscription: response.subscription,
        characterCount: response.character_count,
        characterLimit: response.character_limit,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      console.error('Get user info error:', error.message);
      return {
        success: false,
        error: error.message,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Create IVR menu audio with multiple options
   */
  async createIVRMenu(options) {
    const { menuTitle, options: menuOptions, voiceId = this.defaultVoices.rachel } = options;

    if (!menuTitle || !Array.isArray(menuOptions) || menuOptions.length === 0) {
      throw new ElevenLabsError('menuTitle and options array are required', null, null);
    }

    try {
      // Create combined text for IVR menu
      let menuText = menuTitle + '. ';
      menuOptions.forEach((opt) => {
        menuText += `Press ${opt.digit} for ${opt.label}. `;
      });

      const audioBuffer = await this.makeRequest(
        'POST',
        `/text-to-speech/${voiceId}`,
        {
          text: menuText,
          model_id: 'eleven_monolingual_v1',
          voice_settings: {
            stability: 0.7,
            similarity_boost: 0.75,
          },
        },
        { 'Content-Type': 'application/json' }
      );

      return {
        success: true,
        audio: audioBuffer,
        menuText,
        optionCount: menuOptions.length,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      console.error('Create IVR menu error:', error.message);
      return {
        success: false,
        error: error.message,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Generate personalized greeting
   */
  async generatePersonalizedGreeting(options) {
    const { customerName, loanAmount, voiceId = this.defaultVoices.rachel } = options;

    if (!customerName) {
      throw new ElevenLabsError('customerName is required', null, null);
    }

    try {
      let text = `Hello ${customerName}. `;
      if (loanAmount) {
        text += `We have a special loan offer for ${loanAmount} rupees. `;
      }
      text += 'Press 1 to learn more or press 2 to speak with an agent.';

      const audioBuffer = await this.makeRequest(
        'POST',
        `/text-to-speech/${voiceId}`,
        {
          text,
          model_id: 'eleven_monolingual_v1',
          voice_settings: {
            stability: 0.6,
            similarity_boost: 0.8,
          },
        },
        { 'Content-Type': 'application/json' }
      );

      return {
        success: true,
        audio: audioBuffer,
        text,
        customerName,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      console.error('Generate greeting error:', error.message);
      return {
        success: false,
        error: error.message,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Health check - verify API connectivity and quota
   */
  async healthCheck() {
    try {
      const response = await this.getUserInfo();

      if (response.success) {
        const quotaUsage = response.characterCount / response.characterLimit;
        return {
          success: true,
          status: 'healthy',
          quotaUsage: Math.round(quotaUsage * 100),
          charactersRemaining: response.characterLimit - response.characterCount,
          timestamp: new Date().toISOString(),
        };
      }

      throw new Error('Failed to get user info');
    } catch (error) {
      return {
        success: false,
        status: 'unhealthy',
        error: error.message,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Get predefined voice presets
   */
  getPredefinedVoices() {
    return {
      rachel: {
        id: this.defaultVoices.rachel,
        name: 'Rachel',
        description: 'Friendly American accent',
        gender: 'female',
      },
      clyde: {
        id: this.defaultVoices.clyde,
        name: 'Clyde',
        description: 'Friendly American accent',
        gender: 'male',
      },
      domi: {
        id: this.defaultVoices.domi,
        name: 'Domi',
        description: 'Authoritative voice',
        gender: 'male',
      },
    };
  }
}

export default ElevenLabsClient;
