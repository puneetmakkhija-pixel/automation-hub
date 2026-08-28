import express from 'express';
import applicationPushClient from '../llm/applicationPushClient.js';
import intentGenerationClient from '../llm/intentGenerationClient.js';

const router = express.Router();

// POST /api/push/send-application-push
router.post('/send-application-push', async (req, res) => {
  try {
    const { phone_number, user_profile } = req.body;

    if (!phone_number || !user_profile) {
      return res.status(400).json({
        success: false,
        error: 'Missing phone_number or user_profile'
      });
    }

    // Retrieve user's intent (generated in Phase 3.5a)
    const userIntent = await intentGenerationClient.getUserIntent(phone_number);

    if (!userIntent) {
      return res.status(400).json({
        success: false,
        error: 'No intent found for user. Run Phase 3.5a first.'
      });
    }

    // Send personalized push via all channels
    const pushResult = await applicationPushClient.sendPersonalizedApplicationPush(
      phone_number,
      userIntent,
      user_profile
    );

    if (!pushResult.success) {
      return res.status(500).json({
        success: false,
        error: 'Failed to send push via any channel'
      });
    }

    res.json({
      success: true,
      push_event: pushResult.push_event,
      message: pushResult.message
    });
  } catch (error) {
    console.error('[AppPush] Route error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// POST /api/push/track-engagement
router.post('/track-engagement', async (req, res) => {
  try {
    const { phone_number, event_type, metadata } = req.body;

    if (!phone_number || !event_type) {
      return res.status(400).json({
        success: false,
        error: 'Missing phone_number or event_type'
      });
    }

    const result = await applicationPushClient.trackPushEngagement(
      phone_number,
      event_type,
      metadata || {}
    );

    res.json({
      success: result.success,
      message: result.success ? 'Engagement tracked' : 'Failed to track engagement'
    });
  } catch (error) {
    console.error('[AppPush] Engagement tracking error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// GET /api/push/events/:phone_number
router.get('/events/:phone_number', async (req, res) => {
  try {
    const { phone_number } = req.params;

    if (!phone_number) {
      return res.status(400).json({
        success: false,
        error: 'Missing phone_number'
      });
    }

    // Return push events for this user
    // This would typically query the push_events table
    // For now, return a placeholder
    res.json({
      success: true,
      message: 'Push events endpoint - implementation pending'
    });
  } catch (error) {
    console.error('[AppPush] Query error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default router;
