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

/**
 * The model every call here renders with unless told otherwise.
 *
 * eleven_monolingual_v1 was the default in three places and ElevenLabs has
 * RETIRED it:
 *
 *   "The models eleven_monolingual_v1 and eleven_multilingual_v1 have been
 *    deprecated and are no longer available. Please migrate to a newer TTS
 *    model such as eleven_v3, eleven_multilingual_v2, or eleven_flash_v2_5."
 *
 * So /api/voice/tts, /api/voice/ivr-menu and /api/voice/greeting have all been
 * answering HTTP 400 for every caller, in every language. #84 fixed the
 * campaign by passing a model explicitly and left the default — and the three
 * endpoints that rely on it — exactly as broken as before.
 *
 * ONE constant, because three copies of a model id is how one of them gets
 * left behind, which is the whole story above.
 *
 * v2 rather than flash: nothing here is realtime. These render a file and hand
 * it over, so latency buys nothing and the better pronunciation is worth having.
 */
export const DEFAULT_MODEL_ID = 'eleven_multilingual_v2';

/** Models ElevenLabs has retired. Sending one is an HTTP 400, always. */
export const RETIRED_MODEL_IDS = Object.freeze([
  'eleven_monolingual_v1',
  'eleven_multilingual_v1',
]);

class ElevenLabsError extends Error {
  constructor(message, statusCode, response) {
    super(message);
    this.name = 'ElevenLabsError';
    this.statusCode = statusCode;
    this.response = response;
  }
}

/**
 * What ElevenLabs actually said, folded into one line.
 *
 * `${method} ${path} failed with HTTP 400` names the request and nothing about
 * the reason, and the reason is the whole message: a wrong model, a voice the
 * key cannot use, a quota. The body carries it; the error already captured the
 * body and then threw it away at the point a human reads the failure. The
 * dialler upload learned this same lesson in the same week.
 */
export function describeElevenLabsFailure(error) {
  const base = error?.message ?? String(error);
  const body = error?.response;
  if (body === null || body === undefined || Buffer.isBuffer(body)) return base;

  const detail = body.detail ?? body;
  let said;
  if (typeof detail === "string") {
    said = detail;
  } else if (Array.isArray(detail)) {
    // FastAPI validation errors arrive as a list of {loc, msg, type}.
    said = detail.map((d) => d?.msg ?? JSON.stringify(d)).join("; ");
  } else if (detail && typeof detail === "object") {
    said = detail.message ?? detail.status ?? JSON.stringify(detail);
  } else {
    said = String(detail);
  }

  said = String(said).trim();
  // Truncated: this line ends up in an HTTP response body and a log, and an
  // unbounded upstream string in either is its own small problem.
  if (said.length > 300) said = `${said.slice(0, 300)}…`;
  return said ? `${base}: ${said}` : base;
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
      } else if (contentType && contentType.includes('audio')) {
        // Audio comes back as BYTES, never text.
        //
        // This used to also require method === 'GET'. Text-to-speech is a POST,
        // so its audio/mpeg response never matched, fell through to the text
        // branch below, and the MP3 was read as UTF-8 — which does not
        // round-trip binary. The campaign then uploaded the mangled result to
        // the dialler, which rejected it with an error that named nothing.
        //
        // A Buffer rather than an ArrayBuffer: every consumer here hands this
        // to FormData or writes it to disk, and both want Buffer.
        data = Buffer.from(await response.arrayBuffer());
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
   * @param {string} options.modelId - Model ID (default: DEFAULT_MODEL_ID)
   * @returns {Promise<Buffer>} Audio data in MP3 format
   */
  async textToSpeech(options) {
    const {
      text,
      voiceId = this.defaultVoices.rachel,
      stability = 0.5,
      similarityBoost = 0.75,
      modelId = DEFAULT_MODEL_ID,
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
      const described = describeElevenLabsFailure(error);
      console.error('Text to speech error:', described);
      return {
        success: false,
        error: described,
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
    const {
      menuTitle,
      options: menuOptions,
      voiceId = this.defaultVoices.rachel,
      modelId = DEFAULT_MODEL_ID,
    } = options;

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
          model_id: modelId,
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
    const {
      customerName,
      loanAmount,
      voiceId = this.defaultVoices.rachel,
      modelId = DEFAULT_MODEL_ID,
    } = options;

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
          model_id: modelId,
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
