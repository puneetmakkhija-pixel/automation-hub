/**
 * BRE Shortlisting Routes
 * REST endpoints for daily base shortlisting engine
 */

import express from 'express';
import BREShortlistingEngine from '../bre_shortfiltering.js';
import logger from '../logging.js';

const router = express.Router();
const shortlistEngine = new BREShortlistingEngine();

// ==================== Health Check ====================
router.get('/health', async (_req, res) => {
  try {
    res.json({
      success: true,
      service: 'bre_shortlisting',
      status: 'healthy',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== Daily Shortlist Generation ====================

/**
 * POST /api/bre/run-daily-shortlist
 * Trigger daily shortlist generation
 *
 * Body: {
 *   targetDate: '2024-01-15' (optional, defaults to today),
 *   dailyLimit: 50000 (optional),
 *   lenders: ['poonawalla', 'hero_fincorp'] (optional),
 *   pincodes: ['110001', '110002', ...] (optional),
 * }
 */
router.post('/run-daily-shortlist', async (req, res) => {
  try {
    const { targetDate, dailyLimit = 50000, lenders = ['poonawalla', 'hero_fincorp'], pincodes = [] } = req.body;

    const result = await shortlistEngine.runDailyShortlist({
      targetDate,
      dailyLimit,
      lenders,
      pincodes,
    });

    res.json(result);
  } catch (error) {
    logger.log('error', 'BRE_ROUTE_ERROR', `Shortlist route error: ${error.message}`, {
      error: error.message,
      type: 'api_error',
    });

    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/bre/shortlist/:lender
 * Get pending shortlist for campaign dispatch
 *
 * Query params: limit=10000, status='pending'
 */
router.get('/shortlist/:lender', async (req, res) => {
  try {
    const { lender } = req.params;
    const { limit = 10000, status = 'pending' } = req.query;

    if (!lender) {
      return res.status(400).json({
        success: false,
        error: 'lender parameter is required',
      });
    }

    const result = await shortlistEngine.getShortlistForDispatch(lender, parseInt(limit), status);

    res.json(result);
  } catch (error) {
    logger.log('error', 'BRE_FETCH_ERROR', `Failed to fetch shortlist: ${error.message}`, {
      error: error.message,
      type: 'api_error',
    });

    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/bre/mark-dispatched
 * Mark shortlist records as dispatched for campaign
 *
 * Body: {
 *   phones: ['919876543210', '918765432109', ...],
 *   campaignId: 'camp_123'
 * }
 */
router.post('/mark-dispatched', async (req, res) => {
  try {
    const { phones, campaignId } = req.body;

    if (!phones || !Array.isArray(phones) || phones.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'phones array is required',
      });
    }

    if (!campaignId) {
      return res.status(400).json({
        success: false,
        error: 'campaignId is required',
      });
    }

    const result = await shortlistEngine.markAsDispatched(phones, campaignId);

    logger.log('info', 'BRE_MARK_DISPATCHED', `Marked ${phones.length} records as dispatched`, {
      campaignId,
      recordsMarked: phones.length,
      type: 'campaign_operation',
    });

    res.json(result);
  } catch (error) {
    logger.log('error', 'BRE_MARK_ERROR', `Failed to mark records: ${error.message}`, {
      error: error.message,
      type: 'api_error',
    });

    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/bre/config
 * Get BRE configuration and rules
 */
router.get('/config', (_req, res) => {
  try {
    res.json({
      success: true,
      breRules: shortlistEngine.breRules,
      supportedLenders: Object.keys(shortlistEngine.breRules),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

export default router;
