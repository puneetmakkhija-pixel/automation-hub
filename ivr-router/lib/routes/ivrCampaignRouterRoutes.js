/**
 * IVR Campaign Router Routes
 * REST endpoints for dual-path campaign routing
 */

import express from 'express';
import IVRCampaignRouter from '../ivrCampaignRouter.js';
import logger from '../logging.js';

const router = express.Router();
let campaignRouter = null;

try {
  campaignRouter = new IVRCampaignRouter();
} catch (error) {
  console.warn('⚠️ IVR Campaign Router initialization failed:', error.message);
  console.warn('   IVR routing features will be unavailable until configuration is complete');
}

// ==================== Health Check ====================
router.get('/health', async (_req, res) => {
  try {
    res.json({
      success: true,
      service: 'ivr_campaign_router',
      status: 'healthy',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== Voice Disposition Handling ====================

/**
 * POST /api/router/voice-disposition
 * Handle voice call disposition (DTMF input)
 * Called when customer presses a digit during voice call
 *
 * Body: {
 *   phone: '919876543210',
 *   name: 'John Doe',
 *   callSid: 'call_xyz',
 *   dtmf: '1' (pressed digit),
 *   campaignId: 'camp_123',
 *   campaignType: 'path_a' or 'path_b',
 *   lenderId: 'poonawalla' (for path_b)
 * }
 */
router.post('/voice-disposition', async (req, res) => {
  try {
    if (!campaignRouter) {
      return res.status(503).json({
        success: false,
        error: 'IVR Campaign Router not initialized - Supabase configuration required',
      });
    }

    const { phone, name, callSid, dtmf, campaignId, campaignType, lenderId } = req.body;

    if (!phone || !callSid || !dtmf || !campaignId || !campaignType) {
      return res.status(400).json({
        success: false,
        error: 'phone, callSid, dtmf, campaignId, and campaignType are required',
      });
    }

    const result = await campaignRouter.handleVoiceDisposition({
      phone,
      name,
      callSid,
      dtmf,
      campaignId,
      campaignType,
      lenderId,
    });

    res.json(result);
  } catch (error) {
    logger.log('error', 'IVR_DISPOSITION_ERROR', `Voice disposition error: ${error.message}`, {
      error: error.message,
      type: 'api_error',
    });

    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ==================== Document Journey (Path A) ====================

/**
 * POST /api/router/document-journey
 * Manually trigger document journey for a customer
 *
 * Body: {
 *   phone: '919876543210',
 *   name: 'John Doe',
 *   campaignId: 'camp_123',
 *   lenderId: 'poonawalla',
 *   callSid: 'call_xyz' (optional)
 * }
 */
router.post('/document-journey', async (req, res) => {
  try {
    if (!campaignRouter) {
      return res.status(503).json({
        success: false,
        error: 'IVR Campaign Router not initialized - Supabase configuration required',
      });
    }

    const { phone, name, campaignId, lenderId, callSid } = req.body;

    if (!phone || !campaignId || !lenderId) {
      return res.status(400).json({
        success: false,
        error: 'phone, campaignId, and lenderId are required',
      });
    }

    const result = await campaignRouter._launchDocumentJourney(
      {
        phone,
        name,
        callSid: callSid || `manual_${Date.now()}`,
        campaignId,
        lenderId,
      },
      `manual_${Date.now()}_${phone}`
    );

    res.json(result);
  } catch (error) {
    logger.log('error', 'DOCUMENT_JOURNEY_ERROR', `Document journey error: ${error.message}`, {
      error: error.message,
      type: 'api_error',
    });

    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ==================== DIY Journey (Path B) ====================

/**
 * POST /api/router/diy-journey
 * Manually trigger DIY journey for a customer
 *
 * Body: {
 *   phone: '919876543210',
 *   name: 'John Doe',
 *   campaignId: 'camp_123',
 *   lenderId: 'poonawalla',
 *   callSid: 'call_xyz' (optional)
 * }
 */
router.post('/diy-journey', async (req, res) => {
  try {
    if (!campaignRouter) {
      return res.status(503).json({
        success: false,
        error: 'IVR Campaign Router not initialized - Supabase configuration required',
      });
    }

    const { phone, name, campaignId, lenderId, callSid } = req.body;

    if (!phone || !campaignId || !lenderId) {
      return res.status(400).json({
        success: false,
        error: 'phone, campaignId, and lenderId are required',
      });
    }

    const result = await campaignRouter._launchDIYJourney(
      {
        phone,
        name,
        callSid: callSid || `manual_${Date.now()}`,
        campaignId,
        lenderId,
      },
      `manual_${Date.now()}_${phone}`
    );

    res.json(result);
  } catch (error) {
    logger.log('error', 'DIY_JOURNEY_ERROR', `DIY journey error: ${error.message}`, {
      error: error.message,
      type: 'api_error',
    });

    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ==================== Lender Rejection Handling ====================

/**
 * POST /api/router/lender-rejection
 * Handle lender rejection webhook (triggers fallback logic)
 * Called by lender when application is rejected
 *
 * Body: {
 *   phone: '919876543210',
 *   campaignId: 'camp_123',
 *   rejectedLender: 'poonawalla',
 *   rejectionCode: 'CIBIL_LOW',
 *   rejectionReason: 'CIBIL score below minimum'
 * }
 */
router.post('/lender-rejection', async (req, res) => {
  try {
    if (!campaignRouter) {
      return res.status(503).json({
        success: false,
        error: 'IVR Campaign Router not initialized - Supabase configuration required',
      });
    }

    const { phone, campaignId, rejectedLender, rejectionCode, rejectionReason } = req.body;

    if (!phone || !campaignId || !rejectedLender) {
      return res.status(400).json({
        success: false,
        error: 'phone, campaignId, and rejectedLender are required',
      });
    }

    const result = await campaignRouter.handleLenderRejection({
      phone,
      campaignId,
      rejectedLender,
      rejectionCode,
      rejectionReason,
    });

    res.json(result);
  } catch (error) {
    logger.log('error', 'REJECTION_HANDLING_ERROR', `Rejection handling error: ${error.message}`, {
      error: error.message,
      type: 'api_error',
    });

    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ==================== Configuration ====================

/**
 * GET /api/router/config
 * Get campaign router configuration
 */
router.get('/config', (_req, res) => {
  try {
    if (!campaignRouter) {
      return res.status(503).json({
        success: false,
        error: 'IVR Campaign Router not initialized - Supabase configuration required',
      });
    }

    res.json({
      success: true,
      campaignConfig: campaignRouter.campaignConfig,
      supportedLenders: Object.keys(campaignRouter.lenderUTMs),
      lenderUTMs: campaignRouter.lenderUTMs,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

export default router;
