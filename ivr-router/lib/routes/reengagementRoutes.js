import express from 'express';
import reengagementClient from '../llm/reengagementClient.js';

const router = express.Router();

// POST /api/reengagement/find-eligible
// Called by nightly job (02:00 UTC) to find users eligible under new rules
router.post('/find-eligible', async (req, res) => {
  try {
    const { hours = 24 } = req.body;

    if (hours < 1 || hours > 168) {
      return res.status(400).json({
        success: false,
        error: 'hours must be between 1 and 168'
      });
    }

    const result = await reengagementClient.findNewlyEligibleUsers(hours);

    if (!result.success) {
      return res.status(500).json({
        success: false,
        error: result.error
      });
    }

    res.json({
      success: true,
      newly_eligible_count: result.count,
      users: result.newly_eligible_users.slice(0, 10),  // Return first 10 for preview
      total_found: result.count,
      previous_rules_version: result.previous_rules_version,
      current_rules_version: result.current_rules_version
    });
  } catch (error) {
    console.error('[Reengagement] Find eligible error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// POST /api/reengagement/campaign
// Called to send re-engagement messages to newly-eligible users
router.post('/campaign', async (req, res) => {
  try {
    const { users = [] } = req.body;

    if (!users || users.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No users provided'
      });
    }

    const result = await reengagementClient.sendReengagementCampaign(users);

    if (!result.success) {
      return res.status(500).json({
        success: false,
        error: result.error
      });
    }

    res.json({
      success: true,
      message: 'Re-engagement campaign completed',
      results: result.results
    });
  } catch (error) {
    console.error('[Reengagement] Campaign error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// POST /api/reengagement/track-response
// Called when re-engaged user responds or applies again
router.post('/track-response', async (req, res) => {
  try {
    const { phone_number, response_outcome } = req.body;

    if (!phone_number) {
      return res.status(400).json({
        success: false,
        error: 'Missing phone_number'
      });
    }

    const result = await reengagementClient.trackReengagementResponse(
      phone_number,
      response_outcome || 'started_application'
    );

    if (!result.success) {
      return res.status(500).json({
        success: false,
        error: result.error
      });
    }

    res.json({
      success: true,
      message: 'Response tracked',
      outcome: response_outcome
    });
  } catch (error) {
    console.error('[Reengagement] Track response error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// GET /api/reengagement/metrics
// Fetch re-engagement campaign metrics
router.get('/metrics', async (req, res) => {
  try {
    const { hours = 24 } = req.query;

    const result = await reengagementClient.getReengagementMetrics(parseInt(hours));

    if (!result.success) {
      return res.status(500).json({
        success: false,
        error: result.error
      });
    }

    res.json({
      success: true,
      metrics: result.metrics
    });
  } catch (error) {
    console.error('[Reengagement] Metrics error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// GET /api/reengagement/events
// Fetch re-engagement event history for a user
router.get('/events/:phone_number', async (req, res) => {
  try {
    const { phone_number } = req.params;
    const { limit = 20 } = req.query;

    if (!phone_number) {
      return res.status(400).json({
        success: false,
        error: 'Missing phone_number'
      });
    }

    const { data, error } = require('../clients/supabaseClient.js').default
      .from('reengagement_events')
      .select('*')
      .eq('phone_number', phone_number)
      .order('created_at', { ascending: false })
      .limit(parseInt(limit));

    if (error) {
      console.error('[Reengagement] Events fetch error:', error.message);
      return res.status(500).json({
        success: false,
        error: error.message
      });
    }

    res.json({
      success: true,
      phone_number,
      events: data || [],
      count: (data || []).length
    });
  } catch (error) {
    console.error('[Reengagement] Events fetch error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default router;
