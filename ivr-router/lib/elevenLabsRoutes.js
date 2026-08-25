/**
 * Eleven Labs Voice Generation Routes
 * REST endpoints for text-to-speech and voice generation
 */

import express from 'express';
import ElevenLabsClient from './elevenLabsClient.js';

const router = express.Router();

// Initialize Eleven Labs client
let voiceClient;
try {
  voiceClient = new ElevenLabsClient(
    process.env.ELEVEN_LABS_API_KEY,
    process.env.ELEVEN_LABS_BASE_URL
  );
} catch (error) {
  console.warn('Eleven Labs client initialization warning:', error.message);
}

// ==================== Health Check ====================

router.get('/health', async (req, res) => {
  if (!voiceClient) {
    return res.json({
      success: false,
      message: 'Eleven Labs client not initialized',
      error: 'Missing ELEVEN_LABS_API_KEY',
    });
  }

  const health = await voiceClient.healthCheck();
  res.json(health);
});

// ==================== Voice Management ====================

/**
 * List available voices
 * GET /api/voice/voices
 */
router.get('/voices', async (req, res) => {
  try {
    if (!voiceClient) {
      return res.status(503).json({
        success: false,
        error: 'Eleven Labs client not initialized',
      });
    }

    const result = await voiceClient.listVoices();
    res.json(result);
  } catch (error) {
    console.error('List voices error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * Get voice details
 * GET /api/voice/voices/:voiceId
 */
router.get('/voices/:voiceId', async (req, res) => {
  try {
    if (!voiceClient) {
      return res.status(503).json({
        success: false,
        error: 'Eleven Labs client not initialized',
      });
    }

    const { voiceId } = req.params;
    const result = await voiceClient.getVoice(voiceId);
    res.json(result);
  } catch (error) {
    console.error('Get voice error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * Get predefined voice presets
 * GET /api/voice/presets
 */
router.get('/presets', (req, res) => {
  if (!voiceClient) {
    return res.status(503).json({
      success: false,
      error: 'Eleven Labs client not initialized',
    });
  }

  const presets = voiceClient.getPredefinedVoices();
  res.json({
    success: true,
    presets,
    timestamp: new Date().toISOString(),
  });
});

// ==================== Text-to-Speech ====================

/**
 * Convert text to speech
 * POST /api/voice/tts
 * Body: { text, voiceId, stability, similarityBoost }
 * Returns: MP3 audio file
 */
router.post('/tts', async (req, res) => {
  try {
    if (!voiceClient) {
      return res.status(503).json({
        success: false,
        error: 'Eleven Labs client not initialized',
      });
    }

    const { text, voiceId, stability, similarityBoost } = req.body;

    if (!text) {
      return res.status(400).json({
        success: false,
        error: 'text is required',
      });
    }

    const result = await voiceClient.textToSpeech({
      text,
      voiceId,
      stability,
      similarityBoost,
    });

    if (result.success && result.audio) {
      res.set('Content-Type', 'audio/mpeg');
      res.set('Content-Length', result.audio.byteLength);
      res.send(Buffer.from(result.audio));
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    console.error('TTS error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * Create IVR menu audio
 * POST /api/voice/ivr-menu
 * Body: { menuTitle, options: [{digit, label}], voiceId }
 * Returns: MP3 audio file
 */
router.post('/ivr-menu', async (req, res) => {
  try {
    if (!voiceClient) {
      return res.status(503).json({
        success: false,
        error: 'Eleven Labs client not initialized',
      });
    }

    const { menuTitle, options, voiceId } = req.body;

    if (!menuTitle || !Array.isArray(options) || options.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'menuTitle and options array are required',
      });
    }

    const result = await voiceClient.createIVRMenu({
      menuTitle,
      options,
      voiceId,
    });

    if (result.success && result.audio) {
      res.set('Content-Type', 'audio/mpeg');
      res.set('Content-Length', result.audio.byteLength);
      res.send(Buffer.from(result.audio));
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    console.error('IVR menu error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * Generate personalized greeting
 * POST /api/voice/greeting
 * Body: { customerName, loanAmount, voiceId }
 * Returns: MP3 audio file
 */
router.post('/greeting', async (req, res) => {
  try {
    if (!voiceClient) {
      return res.status(503).json({
        success: false,
        error: 'Eleven Labs client not initialized',
      });
    }

    const { customerName, loanAmount, voiceId } = req.body;

    if (!customerName) {
      return res.status(400).json({
        success: false,
        error: 'customerName is required',
      });
    }

    const result = await voiceClient.generatePersonalizedGreeting({
      customerName,
      loanAmount,
      voiceId,
    });

    if (result.success && result.audio) {
      res.set('Content-Type', 'audio/mpeg');
      res.set('Content-Length', result.audio.byteLength);
      res.send(Buffer.from(result.audio));
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    console.error('Generate greeting error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ==================== User Account ====================

/**
 * Get user information and subscription
 * GET /api/voice/user
 */
router.get('/user', async (req, res) => {
  try {
    if (!voiceClient) {
      return res.status(503).json({
        success: false,
        error: 'Eleven Labs client not initialized',
      });
    }

    const result = await voiceClient.getUserInfo();
    res.json(result);
  } catch (error) {
    console.error('Get user info error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

export default router;
