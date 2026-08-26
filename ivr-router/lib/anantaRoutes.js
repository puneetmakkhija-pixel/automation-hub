/**
 * Ananta API Routes
 * WhatsApp and customer data management endpoints
 * - Customer data synchronization and retrieval
 * - WhatsApp message sending and delivery tracking
 * - Campaign targeting by demographics
 * - Bulk operations with rate limiting
 */

import express from 'express';
import AnantaApiClient from './anantaApiClient.js';

const router = express.Router();

// Initialize Ananta client from environment
const anantaClient = new AnantaApiClient(
  process.env.ANANTA_BASE_URL || 'https://data-api.anantadot.com',
  process.env.ANANTA_API_TOKEN,
  process.env.ANANTA_API_SEC_KEY
);

// ==================== Health Check ====================

router.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'Ananta API integration healthy',
    timestamp: new Date().toISOString(),
  });
});

// ==================== Customer Management ====================

/**
 * Sync customer demographic data
 * POST /api/ananta/customers/sync
 * Body: { customers: [{mobile, state, city, pincode, age, dob, gender, marital_status, custom}] }
 */
router.post('/customers/sync', async (req, res) => {
  try {
    const { customers } = req.body;

    if (!customers || !Array.isArray(customers) || customers.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'customers array is required and cannot be empty',
      });
    }

    // Validate phone numbers
    const validationErrors = [];
    customers.forEach((customer, index) => {
      const validation = anantaClient.validatePhoneNumber(customer.mobile);
      if (!validation.valid) {
        validationErrors.push({
          index,
          phone: customer.mobile,
          error: validation.error,
        });
      }
    });

    if (validationErrors.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Phone number validation failed',
        details: validationErrors,
      });
    }

    const result = await anantaClient.sendCustomerData(customers);
    res.json(result);
  } catch (error) {
    console.error('Customer sync error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * Sync customers in bulk with batching
 * POST /api/ananta/customers/bulk-sync
 * Body: { customers: [...], batchSize: 100 }
 */
router.post('/customers/bulk-sync', async (req, res) => {
  try {
    const { customers, batchSize = 100 } = req.body;

    if (!customers || !Array.isArray(customers) || customers.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'customers array is required',
      });
    }

    const result = await anantaClient.bulkSyncCustomers(customers, batchSize);
    res.json(result);
  } catch (error) {
    console.error('Bulk sync error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * Get customer by phone number
 * GET /api/ananta/customers/:phone
 */
router.get('/customers/:phone', async (req, res) => {
  try {
    const { phone } = req.params;

    const validation = anantaClient.validatePhoneNumber(phone);
    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        error: validation.error,
      });
    }

    const result = await anantaClient.getCustomer(phone);
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
 * Search customers by demographic criteria
 * POST /api/ananta/customers/search
 * Body: { state, city, ageMin, ageMax, gender, maritalStatus, custom }
 */
router.post('/customers/search', async (req, res) => {
  try {
    const criteria = req.body;

    const result = await anantaClient.getCustomersByDemographics(criteria);
    res.json(result);
  } catch (error) {
    console.error('Customer search error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ==================== Campaign Segmentation ====================

/**
 * Create demographic segment
 * POST /api/ananta/segments
 * Body: { name, states, cities, ageMin, ageMax, genders, maritalStatuses, customAttributes }
 */
router.post('/segments', (req, res) => {
  try {
    const { name, states, cities, ageMin, ageMax, genders, maritalStatuses, customAttributes } = req.body;

    if (!name) {
      return res.status(400).json({
        success: false,
        error: 'Segment name is required',
      });
    }

    const segment = anantaClient.createDemographicSegment(name, {
      states,
      cities,
      ageMin,
      ageMax,
      genders,
      maritalStatuses,
      customAttributes,
    });

    res.json({
      success: true,
      segment,
      message: 'Segment created successfully',
    });
  } catch (error) {
    console.error('Segment creation error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * Segment customers by age groups
 * POST /api/ananta/segments/by-age
 * Body: { customers }
 */
router.post('/segments/by-age', (req, res) => {
  try {
    const { customers } = req.body;

    if (!customers || !Array.isArray(customers)) {
      return res.status(400).json({
        success: false,
        error: 'customers array is required',
      });
    }

    const segments = anantaClient.segmentByAge(customers);
    res.json({
      success: true,
      segments,
      message: 'Customers segmented by age',
    });
  } catch (error) {
    console.error('Age segmentation error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * Segment customers by state
 * POST /api/ananta/segments/by-state
 * Body: { customers }
 */
router.post('/segments/by-state', (req, res) => {
  try {
    const { customers } = req.body;

    if (!customers || !Array.isArray(customers)) {
      return res.status(400).json({
        success: false,
        error: 'customers array is required',
      });
    }

    const segments = anantaClient.segmentByState(customers);
    res.json({
      success: true,
      segments,
      message: 'Customers segmented by state',
    });
  } catch (error) {
    console.error('State segmentation error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * Segment customers by gender
 * POST /api/ananta/segments/by-gender
 * Body: { customers }
 */
router.post('/segments/by-gender', (req, res) => {
  try {
    const { customers } = req.body;

    if (!customers || !Array.isArray(customers)) {
      return res.status(400).json({
        success: false,
        error: 'customers array is required',
      });
    }

    const segments = anantaClient.segmentByGender(customers);
    res.json({
      success: true,
      segments,
      message: 'Customers segmented by gender',
    });
  } catch (error) {
    console.error('Gender segmentation error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ==================== WhatsApp Messaging ====================

/**
 * Send WhatsApp message to single customer
 * POST /api/ananta/messages/send
 * Body: { phoneNumber, templateId, messageText }
 */
router.post('/messages/send', async (req, res) => {
  try {
    const { phoneNumber, templateId, messageText = '' } = req.body;

    if (!phoneNumber || !templateId) {
      return res.status(400).json({
        success: false,
        error: 'phoneNumber and templateId are required',
      });
    }

    const validation = anantaClient.validatePhoneNumber(phoneNumber);
    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        error: validation.error,
      });
    }

    const result = await anantaClient.sendWhatsAppMessage(phoneNumber, templateId, messageText);
    res.json(result);
  } catch (error) {
    console.error('WhatsApp send error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * Send WhatsApp messages to customer segment
 * POST /api/ananta/messages/bulk-send
 * Body: { segment, templateId, messageText }
 */
router.post('/messages/bulk-send', async (req, res) => {
  try {
    const { segment, templateId, messageText = '' } = req.body;

    if (!segment || !Array.isArray(segment) || segment.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'segment array is required and cannot be empty',
      });
    }

    if (!templateId) {
      return res.status(400).json({
        success: false,
        error: 'templateId is required',
      });
    }

    const results = await anantaClient.bulkSendWhatsApp(segment, templateId, messageText);
    res.json({
      success: true,
      ...results,
      message: `Bulk WhatsApp sending completed: ${results.successful} successful, ${results.failed} failed`,
    });
  } catch (error) {
    console.error('Bulk WhatsApp send error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ==================== Delivery Tracking ====================

/**
 * Get delivery statistics for campaign
 * GET /api/ananta/campaigns/:campaignId/stats
 * Query: { startDate, endDate }
 */
router.get('/campaigns/:campaignId/stats', async (req, res) => {
  try {
    const { campaignId } = req.params;
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        error: 'startDate and endDate query parameters are required',
      });
    }

    const result = await anantaClient.getDeliveryStats(campaignId, startDate, endDate);
    res.json(result);
  } catch (error) {
    console.error('Delivery stats error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ==================== Webhooks ====================

/**
 * Handle Ananta delivery webhooks
 * POST /webhooks/ananta
 * Payload: { account_number, phone, status, msgid, date, template, campaign_date }
 */
router.post('/webhooks/ananta', (req, res) => {
  try {
    const payload = req.body;

    // Parse webhook payload
    const webhookData = anantaClient.parseDeliveryWebhook(payload);

    console.log('📨 Ananta Delivery Webhook:');
    console.log(`  Phone: ${webhookData.phoneNumber}`);
    console.log(`  Status: ${webhookData.deliveryStatus}`);
    console.log(`  Message ID: ${webhookData.messageId}`);
    console.log(`  Delivered: ${webhookData.deliveredAt}`);
    console.log(`  Template: ${webhookData.template}`);
    console.log(`  Time: ${webhookData.timestamp}`);

    // Return success response to Ananta
    res.json({
      success: true,
      message: 'Webhook received and processed',
      data: webhookData,
    });
  } catch (error) {
    console.error('Webhook processing error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ==================== Validation Endpoints ====================

/**
 * Validate phone number
 * POST /api/ananta/validate/phone
 * Body: { phoneNumber }
 */
router.post('/validate/phone', (req, res) => {
  try {
    const { phoneNumber } = req.body;

    if (!phoneNumber) {
      return res.status(400).json({
        success: false,
        error: 'phoneNumber is required',
      });
    }

    const validation = anantaClient.validatePhoneNumber(phoneNumber);
    res.json(validation);
  } catch (error) {
    console.error('Phone validation error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * Validate age
 * POST /api/ananta/validate/age
 * Body: { age }
 */
router.post('/validate/age', (req, res) => {
  try {
    const { age } = req.body;

    if (age === undefined || age === null) {
      return res.status(400).json({
        success: false,
        error: 'age is required',
      });
    }

    const isValid = anantaClient.validateAge(age);
    res.json({
      valid: isValid,
      age,
      error: !isValid ? 'Age must be between 1 and 120' : null,
    });
  } catch (error) {
    console.error('Age validation error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * Validate gender code
 * POST /api/ananta/validate/gender
 * Body: { gender }
 */
router.post('/validate/gender', (req, res) => {
  try {
    const { gender } = req.body;

    if (gender === undefined || gender === null) {
      return res.status(400).json({
        success: false,
        error: 'gender is required',
      });
    }

    const isValid = anantaClient.validateGender(gender);
    res.json({
      valid: isValid,
      gender,
      error: !isValid ? 'Gender must be 1 (Male), 2 (Female), 3 (Others), or 4 (Prefer not to say)' : null,
    });
  } catch (error) {
    console.error('Gender validation error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * Validate marital status code
 * POST /api/ananta/validate/marital-status
 * Body: { status }
 */
router.post('/validate/marital-status', (req, res) => {
  try {
    const { status } = req.body;

    if (status === undefined || status === null) {
      return res.status(400).json({
        success: false,
        error: 'status is required',
      });
    }

    const isValid = anantaClient.validateMaritalStatus(status);
    res.json({
      valid: isValid,
      status,
      error: !isValid ? 'Marital status must be 1 (Married), 2 (Single), 3 (Divorced), 4 (Widowed), or 5 (Others)' : null,
    });
  } catch (error) {
    console.error('Marital status validation error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

export default router;
