import express from 'express';
import intentGenerationClient from '../llm/intentGenerationClient.js';

const router = express.Router();

// POST /api/llm/generate-intent
router.post('/generate-intent', async (req, res) => {
  try {
    const { phone_number, user_profile } = req.body;

    if (!phone_number || !user_profile) {
      return res.status(400).json({
        success: false,
        error: 'Missing phone_number or user_profile'
      });
    }

    // Generate intent via Claude API
    const intentResult = await intentGenerationClient.generateIntent(user_profile);

    if (!intentResult.valid) {
      return res.status(500).json({
        success: false,
        error: intentResult.error
      });
    }

    // Store intent in Supabase
    const storageResult = await intentGenerationClient.storeIntent(phone_number, intentResult);

    if (!storageResult.valid) {
      console.error('[IntentGeneration] Failed to store intent:', storageResult.error);
      // Continue anyway - return the generated intent even if storage failed
    }

    res.json({
      success: true,
      intent: intentResult
    });
  } catch (error) {
    console.error('[IntentGeneration] Route error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// GET /api/llm/user-intent/:phone_number
router.get('/user-intent/:phone_number', async (req, res) => {
  try {
    const { phone_number } = req.params;

    if (!phone_number) {
      return res.status(400).json({
        success: false,
        error: 'Missing phone_number'
      });
    }

    const userIntent = await intentGenerationClient.getUserIntent(phone_number);

    if (!userIntent) {
      return res.status(404).json({
        success: false,
        error: 'No intent found for this user'
      });
    }

    res.json({
      success: true,
      intent: userIntent
    });
  } catch (error) {
    console.error('[IntentGeneration] Retrieval error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default router;
