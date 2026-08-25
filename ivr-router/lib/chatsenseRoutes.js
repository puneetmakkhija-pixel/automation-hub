/**
 * Chatsense API Routes
 * REST endpoints for sending WhatsApp templates, interactives, and flows
 * - Send templates, interactives, flows
 * - Bulk sending with rate limiting
 * - List available resources
 * - Webhook handling for delivery events
 */

import express from 'express';
import ChatsenseClient from './chatsenseClient.js';
import CrmIntegrationClient from './crmIntegrationClient.js';

const router = express.Router();

// Initialize Chatsense client from environment
let chatsenseClient;
try {
  chatsenseClient = new ChatsenseClient(
    process.env.CHATSENSE_API_KEY,
    process.env.CHATSENSE_BASE_URL
  );
} catch (error) {
  console.warn('Chatsense client initialization warning:', error.message);
}

// Initialize CRM Integration client (Phase 1: Lead Intake)
const crmClient = new CrmIntegrationClient();

// ==================== Health Check ====================

router.get('/health', async (req, res) => {
  if (!chatsenseClient) {
    return res.json({
      success: false,
      message: 'Chatsense client not initialized',
      error: 'Missing CHATSENSE_API_KEY',
    });
  }

  const health = await chatsenseClient.healthCheck();
  res.json(health);
});

// ==================== Listing Resources ====================

/**
 * List available templates
 * GET /api/chatsense/templates
 */
router.get('/templates', async (req, res) => {
  try {
    if (!chatsenseClient) {
      return res.status(503).json({
        success: false,
        error: 'Chatsense client not initialized - check CHATSENSE_API_KEY',
      });
    }

    const result = await chatsenseClient.listTemplates();
    res.json(result);
  } catch (error) {
    console.error('List templates error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * List available interactives
 * GET /api/chatsense/interactives
 */
router.get('/interactives', async (req, res) => {
  try {
    if (!chatsenseClient) {
      return res.status(503).json({
        success: false,
        error: 'Chatsense client not initialized',
      });
    }

    const result = await chatsenseClient.listInteractives();
    res.json(result);
  } catch (error) {
    console.error('List interactives error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * List available flows
 * GET /api/chatsense/flows
 */
router.get('/flows', async (req, res) => {
  try {
    if (!chatsenseClient) {
      return res.status(503).json({
        success: false,
        error: 'Chatsense client not initialized',
      });
    }

    const result = await chatsenseClient.listFlows();
    res.json(result);
  } catch (error) {
    console.error('List flows error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * List webhooks
 * GET /api/chatsense/webhooks
 */
router.get('/webhooks', async (req, res) => {
  try {
    if (!chatsenseClient) {
      return res.status(503).json({
        success: false,
        error: 'Chatsense client not initialized',
      });
    }

    const result = await chatsenseClient.listWebhooks();
    res.json(result);
  } catch (error) {
    console.error('List webhooks error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ==================== Send Messages ====================

/**
 * Send WhatsApp template message
 * POST /api/chatsense/templates/send
 * Body: { phone, customerName, templateName, language }
 */
router.post('/templates/send', async (req, res) => {
  try {
    if (!chatsenseClient) {
      return res.status(503).json({
        success: false,
        error: 'Chatsense client not initialized',
      });
    }

    const { phone, customerName, templateName, language } = req.body;

    if (!phone || !customerName || !templateName) {
      return res.status(400).json({
        success: false,
        error: 'phone, customerName, and templateName are required',
      });
    }

    const result = await chatsenseClient.sendTemplate({
      phone,
      customerName,
      templateName,
      language,
    });

    const statusCode = result.success ? 200 : 400;
    res.status(statusCode).json(result);
  } catch (error) {
    console.error('Send template error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * Send WhatsApp interactive message
 * POST /api/chatsense/interactives/send
 * Body: { phone, interactiveId }
 */
router.post('/interactives/send', async (req, res) => {
  try {
    if (!chatsenseClient) {
      return res.status(503).json({
        success: false,
        error: 'Chatsense client not initialized',
      });
    }

    const { phone, interactiveId } = req.body;

    if (!phone || !interactiveId) {
      return res.status(400).json({
        success: false,
        error: 'phone and interactiveId are required',
      });
    }

    const result = await chatsenseClient.sendInteractive({
      phone,
      interactiveId,
    });

    const statusCode = result.success ? 200 : 400;
    res.status(statusCode).json(result);
  } catch (error) {
    console.error('Send interactive error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * Send WhatsApp flow message
 * POST /api/chatsense/flows/send
 * Body: { phone, flowId, headerText, bodyText, footerText, ctaText }
 */
router.post('/flows/send', async (req, res) => {
  try {
    if (!chatsenseClient) {
      return res.status(503).json({
        success: false,
        error: 'Chatsense client not initialized',
      });
    }

    const { phone, flowId, headerText, bodyText, footerText, ctaText } = req.body;

    if (!phone || !flowId || !headerText || !bodyText) {
      return res.status(400).json({
        success: false,
        error: 'phone, flowId, headerText, and bodyText are required',
      });
    }

    const result = await chatsenseClient.sendFlow({
      phone,
      flowId,
      headerText,
      bodyText,
      footerText,
      ctaText,
    });

    const statusCode = result.success ? 200 : 400;
    res.status(statusCode).json(result);
  } catch (error) {
    console.error('Send flow error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ==================== Bulk Sending ====================

/**
 * Bulk send templates to multiple customers
 * POST /api/chatsense/templates/bulk-send
 * Body: { customers: [{phone, customerName}], templateName, delayMs }
 */
router.post('/templates/bulk-send', async (req, res) => {
  try {
    if (!chatsenseClient) {
      return res.status(503).json({
        success: false,
        error: 'Chatsense client not initialized',
      });
    }

    const { customers, templateName, delayMs = 1000 } = req.body;

    if (!customers || !Array.isArray(customers) || customers.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'customers array and templateName are required',
      });
    }

    if (!templateName) {
      return res.status(400).json({
        success: false,
        error: 'templateName is required',
      });
    }

    const results = await chatsenseClient.bulkSendTemplate(
      customers,
      templateName,
      delayMs
    );

    res.json({
      success: true,
      ...results,
      message: `Bulk send completed: ${results.successful} successful, ${results.failed} failed`,
    });
  } catch (error) {
    console.error('Bulk send error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ==================== Voice Disposition Webhook (Phase 1) ====================

/**
 * Handle voice disposition capture from Chatsense
 * PHASE 1: Lead Intake Pipeline
 * Called after: OBD voice call + DTMF capture
 * Triggers: lead_intake_sync in CRM
 *
 * POST /api/chatsense/voice-disposition
 * Payload: {
 *   phone: "919876543210",
 *   name: "Rajesh Kumar",
 *   age: 32,
 *   income: 500000,
 *   pincode: "400001",
 *   state: "Maharashtra",
 *   email: "rajesh@email.com",
 *   disposition: "interested",
 *   callDuration: 45,
 *   dtmfChoice: 1,
 *   callSid: "call_12345",
 *   campaignId: "poonawala_stpl_batch_1724095200000_1"
 * }
 */
router.post('/voice-disposition', async (req, res) => {
  try {
    const {
      phone, name, age, income, pincode, state, email,
      disposition, callDuration, dtmfChoice,
      callSid, campaignId, batchId, metadata
    } = req.body;

    // Validate required fields
    if (!phone || !name || !disposition) {
      return res.status(400).json({
        success: false,
        error: 'phone, name, and disposition are required',
      });
    }

    console.log(`[Chatsense] Voice disposition for ${phone}: ${disposition} (call: ${callSid})`);

    // PHASE 1: Call CRM lead intake
    const crmResult = await crmClient.leadIntakeSyncFromVoice({
      phone,
      name,
      age,
      income,
      pincode,
      state,
      email,
      channel: 'obd_voice',
      disposition,
      callDuration,
      dtmfChoice,
      campaignId,
      batchId,
      ivrGreeting: null,
      customMetadata: {
        callSid,
        ...metadata
      }
    });

    // Log the disposition in CRM audit trail
    if (crmResult.success && crmResult.applicationId) {
      await crmClient.logVoiceDisposition({
        applicationId: crmResult.applicationId,
        disposition,
        details: {
          callSid,
          callDuration,
          dtmfChoice,
          campaignId,
        }
      });
    }

    res.status(crmResult.success ? 201 : 400).json({
      ...crmResult,
      source: 'chatsense_voice_disposition',
      webhook: 'voice_disposition'
    });

  } catch (error) {
    console.error('Voice disposition webhook error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ==================== Webhooks ====================

/**
 * Handle Chatsense message delivery webhooks
 * POST /webhooks/chatsense
 * Payload: { phone, status, messageId, timestamp, templateName }
 */
router.post('/webhooks/chatsense', (req, res) => {
  try {
    const payload = req.body;

    console.log('💬 Chatsense Webhook:');
    console.log(`  Phone: ${payload.phone}`);
    console.log(`  Status: ${payload.status}`);
    if (payload.messageId) console.log(`  Message ID: ${payload.messageId}`);
    if (payload.templateName) console.log(`  Template: ${payload.templateName}`);
    console.log(`  Time: ${new Date().toISOString()}`);

    res.json({
      success: true,
      message: 'Webhook received and processed',
      data: {
        phone: payload.phone,
        status: payload.status,
        messageId: payload.messageId,
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

export default router;
