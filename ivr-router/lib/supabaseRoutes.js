/**
 * Supabase Database Routes
 * REST endpoints for customer data, campaigns, and webhooks
 */

import express from 'express';
import SupabaseClient from './supabaseClient.js';

const router = express.Router();

// Initialize Supabase client
let dbClient;
try {
  dbClient = new SupabaseClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
} catch (error) {
  console.warn('Supabase client initialization warning:', error.message);
}

// ==================== Health Check ====================

router.get('/health', async (req, res) => {
  if (!dbClient) {
    return res.json({
      success: false,
      message: 'Supabase client not initialized',
      error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY',
    });
  }

  const health = await dbClient.healthCheck();
  res.json(health);
});

// ==================== Customer Management ====================

/**
 * Create or update customer
 * POST /api/db/customers
 * Body: { phone, name, email, age, gender, state, maritalStatus, metadata }
 */
router.post('/customers', async (req, res) => {
  try {
    if (!dbClient) {
      return res.status(503).json({
        success: false,
        error: 'Supabase client not initialized',
      });
    }

    const customerData = req.body;

    if (!customerData.phone || !customerData.name) {
      return res.status(400).json({
        success: false,
        error: 'phone and name are required',
      });
    }

    const result = await dbClient.createCustomer(customerData);
    const statusCode = result.success ? 200 : 400;
    res.status(statusCode).json(result);
  } catch (error) {
    console.error('Create customer error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * Get customer by phone
 * GET /api/db/customers/:phone
 */
router.get('/customers/:phone', async (req, res) => {
  try {
    if (!dbClient) {
      return res.status(503).json({
        success: false,
        error: 'Supabase client not initialized',
      });
    }

    const { phone } = req.params;
    const result = await dbClient.getCustomer(phone);
    res.json(result);
  } catch (error) {
    console.error('Get customer error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * Search customers by criteria
 * POST /api/db/customers/search
 * Body: { state, ageMin, ageMax, gender, maritalStatus }
 */
router.post('/customers/search', async (req, res) => {
  try {
    if (!dbClient) {
      return res.status(503).json({
        success: false,
        error: 'Supabase client not initialized',
      });
    }

    const filters = req.body;
    const result = await dbClient.searchCustomers(filters);
    res.json(result);
  } catch (error) {
    console.error('Search customers error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * Bulk create customers
 * POST /api/db/customers/bulk
 * Body: { customers: [{phone, name, email, age, gender, state}] }
 */
router.post('/customers/bulk', async (req, res) => {
  try {
    if (!dbClient) {
      return res.status(503).json({
        success: false,
        error: 'Supabase client not initialized',
      });
    }

    const { customers } = req.body;

    if (!Array.isArray(customers) || customers.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'customers array is required',
      });
    }

    const result = await dbClient.bulkCreateCustomers(customers);
    res.json(result);
  } catch (error) {
    console.error('Bulk create customers error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ==================== Campaign Management ====================

/**
 * Create campaign
 * POST /api/db/campaigns
 * Body: { campaignName, campaignId, campaignType, channel, status, metadata }
 */
router.post('/campaigns', async (req, res) => {
  try {
    if (!dbClient) {
      return res.status(503).json({
        success: false,
        error: 'Supabase client not initialized',
      });
    }

    const campaignData = req.body;

    if (!campaignData.campaignName || !campaignData.campaignType) {
      return res.status(400).json({
        success: false,
        error: 'campaignName and campaignType are required',
      });
    }

    const result = await dbClient.createCampaign(campaignData);
    res.json(result);
  } catch (error) {
    console.error('Create campaign error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * Log campaign result
 * POST /api/db/campaigns/results
 * Body: { campaignId, phone, channel, status, result, metadata }
 */
router.post('/campaigns/results', async (req, res) => {
  try {
    if (!dbClient) {
      return res.status(503).json({
        success: false,
        error: 'Supabase client not initialized',
      });
    }

    const resultData = req.body;

    if (!resultData.campaignId || !resultData.phone || !resultData.channel) {
      return res.status(400).json({
        success: false,
        error: 'campaignId, phone, and channel are required',
      });
    }

    const result = await dbClient.logCampaignResult(resultData);
    res.json(result);
  } catch (error) {
    console.error('Log campaign result error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * Get campaign results
 * GET /api/db/campaigns/:campaignId/results
 */
router.get('/campaigns/:campaignId/results', async (req, res) => {
  try {
    if (!dbClient) {
      return res.status(503).json({
        success: false,
        error: 'Supabase client not initialized',
      });
    }

    const { campaignId } = req.params;
    const result = await dbClient.getCampaignResults(campaignId);
    res.json(result);
  } catch (error) {
    console.error('Get campaign results error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * Get campaign statistics
 * GET /api/db/campaigns/:campaignId/stats
 */
router.get('/campaigns/:campaignId/stats', async (req, res) => {
  try {
    if (!dbClient) {
      return res.status(503).json({
        success: false,
        error: 'Supabase client not initialized',
      });
    }

    const { campaignId } = req.params;
    const result = await dbClient.getCampaignStats(campaignId);
    res.json(result);
  } catch (error) {
    console.error('Get campaign stats error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ==================== Webhook Events ====================

/**
 * Log webhook event
 * POST /api/db/webhooks/log
 * Body: { source, eventData }
 */
router.post('/webhooks/log', async (req, res) => {
  try {
    if (!dbClient) {
      return res.status(503).json({
        success: false,
        error: 'Supabase client not initialized',
      });
    }

    const { source, eventData } = req.body;

    if (!source) {
      return res.status(400).json({
        success: false,
        error: 'source is required',
      });
    }

    const result = await dbClient.logWebhookEvent(source, eventData);
    res.json(result);
  } catch (error) {
    console.error('Log webhook event error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

export default router;
