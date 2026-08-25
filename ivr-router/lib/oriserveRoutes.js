/**
 * Oriserve Voice Agent API Routes
 * REST endpoints for triggering voice agent campaigns
 * - Trigger individual campaigns
 * - Bulk trigger with rate limiting
 * - Campaign management and status
 * - Webhook handling for call callbacks
 */

import express from 'express';
import OriserveVoiceClient from './oriserveVoiceClient.js';

const router = express.Router();

// Initialize Oriserve client from environment
let oriserveClient;
try {
  oriserveClient = new OriserveVoiceClient(
    process.env.ORISERVE_API_KEY,
    process.env.ORISERVE_BASE_URL,
    process.env.ORISERVE_WEBHOOK_URL
  );
} catch (error) {
  console.warn('Oriserve client initialization warning:', error.message);
}

// ==================== Health Check ====================

router.get('/health', async (req, res) => {
  if (!oriserveClient) {
    return res.json({
      success: false,
      message: 'Oriserve client not initialized',
      error: 'Missing ORISERVE_API_KEY',
    });
  }

  const health = await oriserveClient.healthCheck();
  res.json(health);
});

// ==================== Campaign Triggering ====================

/**
 * Trigger a single voice agent campaign
 * POST /api/oriserve/campaigns/trigger
 * Body: { campaign_id, mobile, metadata }
 */
router.post('/campaigns/trigger', async (req, res) => {
  try {
    if (!oriserveClient) {
      return res.status(503).json({
        success: false,
        error: 'Oriserve client not initialized - check ORISERVE_API_KEY',
      });
    }

    const { campaign_id, mobile, metadata = {} } = req.body;

    if (!campaign_id || !mobile) {
      return res.status(400).json({
        success: false,
        error: 'campaign_id and mobile are required',
      });
    }

    // Validate phone number
    const validation = oriserveClient.validatePhoneNumber(mobile);
    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        error: validation.error,
      });
    }

    const result = await oriserveClient.triggerCampaign({
      campaign_id,
      mobile: validation.formatted,
      metadata,
    });

    const statusCode = result.success ? 200 : 400;
    res.status(statusCode).json(result);
  } catch (error) {
    console.error('Campaign trigger error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * Trigger campaigns for multiple customers
 * POST /api/oriserve/campaigns/bulk-trigger
 * Body: { customers: [{campaign_id, mobile, metadata}], delayMs: 1000 }
 */
router.post('/campaigns/bulk-trigger', async (req, res) => {
  try {
    if (!oriserveClient) {
      return res.status(503).json({
        success: false,
        error: 'Oriserve client not initialized',
      });
    }

    const { customers, delayMs = 1000 } = req.body;

    if (!customers || !Array.isArray(customers) || customers.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'customers array is required and cannot be empty',
      });
    }

    const results = await oriserveClient.bulkTriggerCampaigns(customers, delayMs);

    res.json({
      success: true,
      ...results,
      message: `Bulk campaign triggering completed: ${results.successful} successful, ${results.failed} failed`,
    });
  } catch (error) {
    console.error('Bulk trigger error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * Get campaign status
 * GET /api/oriserve/campaigns/:campaignId/status
 */
router.get('/campaigns/:campaignId/status', async (req, res) => {
  try {
    if (!oriserveClient) {
      return res.status(503).json({
        success: false,
        error: 'Oriserve client not initialized',
      });
    }

    const { campaignId } = req.params;

    if (!campaignId) {
      return res.status(400).json({
        success: false,
        error: 'campaignId is required',
      });
    }

    const result = await oriserveClient.getCampaignStatus(campaignId);
    res.json(result);
  } catch (error) {
    console.error('Get campaign status error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * Cancel an active campaign
 * POST /api/oriserve/campaigns/:campaignCallId/cancel
 */
router.post('/campaigns/:campaignCallId/cancel', async (req, res) => {
  try {
    if (!oriserveClient) {
      return res.status(503).json({
        success: false,
        error: 'Oriserve client not initialized',
      });
    }

    const { campaignCallId } = req.params;

    if (!campaignCallId) {
      return res.status(400).json({
        success: false,
        error: 'campaignCallId is required',
      });
    }

    const result = await oriserveClient.cancelCampaign(campaignCallId);
    res.json(result);
  } catch (error) {
    console.error('Cancel campaign error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * List available campaigns
 * GET /api/oriserve/campaigns
 */
router.get('/campaigns', async (req, res) => {
  try {
    if (!oriserveClient) {
      return res.status(503).json({
        success: false,
        error: 'Oriserve client not initialized',
      });
    }

    const result = await oriserveClient.listCampaigns();
    res.json(result);
  } catch (error) {
    console.error('List campaigns error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ==================== Webhooks ====================

/**
 * Handle Oriserve campaign callbacks/webhooks
 * POST /webhooks/oriserve
 * Payload: { campaign_id, mobile, status, call_duration, result, metadata }
 */
router.post('/webhooks/oriserve', (req, res) => {
  try {
    const payload = req.body;

    console.log('📞 Oriserve Campaign Webhook:');
    console.log(`  Campaign: ${payload.campaign_id}`);
    console.log(`  Phone: ${payload.mobile}`);
    console.log(`  Status: ${payload.status}`);
    if (payload.call_duration) console.log(`  Duration: ${payload.call_duration}s`);
    if (payload.result) console.log(`  Result: ${payload.result}`);
    console.log(`  Time: ${new Date().toISOString()}`);

    // Return success response
    res.json({
      success: true,
      message: 'Webhook received and processed',
      data: {
        campaign_id: payload.campaign_id,
        mobile: payload.mobile,
        status: payload.status,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('Webhook processing error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ==================== Validation ====================

/**
 * Validate phone number format
 * POST /api/oriserve/validate/phone
 * Body: { phoneNumber }
 */
router.post('/validate/phone', (req, res) => {
  try {
    if (!oriserveClient) {
      return res.status(503).json({
        success: false,
        error: 'Oriserve client not initialized',
      });
    }

    const { phoneNumber } = req.body;

    if (!phoneNumber) {
      return res.status(400).json({
        success: false,
        error: 'phoneNumber is required',
      });
    }

    const validation = oriserveClient.validatePhoneNumber(phoneNumber);
    res.json({
      valid: validation.valid,
      phoneNumber,
      formatted: validation.formatted,
      error: validation.error,
    });
  } catch (error) {
    console.error('Phone validation error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

export default router;
