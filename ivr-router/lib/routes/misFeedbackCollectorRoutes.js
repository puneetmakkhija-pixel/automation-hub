/**
 * MIS Feedback Collector Routes
 * REST endpoints for lender MIS report ingestion and processing
 */

import express from 'express';
import MISFeedbackCollector from '../misFeedbackCollector.js';
import logger from '../logging.js';

const router = express.Router();
let misCollector = null;

try {
  misCollector = new MISFeedbackCollector();
} catch (error) {
  console.warn('⚠️ MIS Feedback Collector initialization failed:', error.message);
  console.warn('   MIS feedback features will be unavailable until configuration is complete');
}

// Guard: Check if collector is available
router.use((req, res, next) => {
  if (!misCollector) {
    return res.status(503).json({
      success: false,
      error: 'MIS Feedback Collector not initialized - Supabase configuration required',
    });
  }
  next();
});

// ==================== Health Check ====================
router.get('/health', async (_req, res) => {
  try {
    res.json({
      success: true,
      service: 'mis_feedback_collector',
      status: 'healthy',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== MIS Report Ingestion ====================

/**
 * POST /api/mis/process-report
 * Process daily MIS report from lender
 *
 * Body: {
 *   source: 'poonawalla' or 'hero_fincorp',
 *   reportDate: '2024-01-15',
 *   records: [
 *     {
 *       phone: '919876543210',
 *       applicationId: 'poo_123',
 *       status: 'rejected',
 *       rejectionCode: 'CIBIL_LOW',
 *       rejectionReason: 'CIBIL score below minimum'
 *     },
 *     ...
 *   ]
 * }
 */
router.post('/process-report', async (req, res) => {
  try {
    const { source, reportDate, records } = req.body;

    if (!source) {
      return res.status(400).json({
        success: false,
        error: 'source is required (poonawalla, hero_fincorp, etc.)',
      });
    }

    if (!records || !Array.isArray(records)) {
      return res.status(400).json({
        success: false,
        error: 'records array is required',
      });
    }

    const result = await misCollector.processMISReport({
      source,
      reportDate: reportDate || new Date().toISOString().split('T')[0],
      records,
    });

    res.json(result);
  } catch (error) {
    logger.log('error', 'MIS_REPORT_ERROR', `MIS report processing error: ${error.message}`, {
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
 * POST /api/mis/webhook/poonawalla
 * Webhook endpoint for Poonawalla MIS reports
 * Can be called directly by Poonawalla's systems
 *
 * Body: Same as /process-report
 */
router.post('/webhook/poonawalla', async (req, res) => {
  try {
    // Optionally verify webhook signature here using POONAWALLA_MIS_SECRET

    const result = await misCollector.processMISReport({
      source: 'poonawalla',
      reportDate: req.body.reportDate || new Date().toISOString().split('T')[0],
      records: req.body.records || [],
    });

    res.json(result);
  } catch (error) {
    logger.log('error', 'POONAWALLA_WEBHOOK_ERROR', `Poonawalla webhook error: ${error.message}`, {
      error: error.message,
      type: 'webhook_error',
    });

    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/mis/webhook/hero-fincorp
 * Webhook endpoint for Hero FinCorp MIS reports
 */
router.post('/webhook/hero-fincorp', async (req, res) => {
  try {
    // Optionally verify webhook signature here using HERO_FINCORP_MIS_SECRET

    const result = await misCollector.processMISReport({
      source: 'hero_fincorp',
      reportDate: req.body.reportDate || new Date().toISOString().split('T')[0],
      records: req.body.records || [],
    });

    res.json(result);
  } catch (error) {
    logger.log('error', 'HERO_FINCORP_WEBHOOK_ERROR', `Hero FinCorp webhook error: ${error.message}`, {
      error: error.message,
      type: 'webhook_error',
    });

    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ==================== BRE Optimization & Analysis ====================

/**
 * GET /api/mis/bre-optimization-report/:reportDate
 * Generate BRE optimization report based on rejection data
 *
 * Example: GET /api/mis/bre-optimization-report/2024-01-15
 */
router.get('/bre-optimization-report/:reportDate', async (req, res) => {
  try {
    const { reportDate } = req.params;

    if (!reportDate) {
      return res.status(400).json({
        success: false,
        error: 'reportDate parameter is required (YYYY-MM-DD format)',
      });
    }

    const result = await misCollector.generateBREOptimizationReport(reportDate);

    res.json(result);
  } catch (error) {
    logger.log('error', 'BRE_REPORT_ERROR', `BRE optimization report error: ${error.message}`, {
      error: error.message,
      type: 'api_error',
    });

    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ==================== Customer Rejection History ====================

/**
 * GET /api/mis/customer/:phone/rejection-history
 * Get rejection history for a customer
 */
router.get('/customer/:phone/rejection-history', async (req, res) => {
  try {
    const { phone } = req.params;

    if (!phone) {
      return res.status(400).json({
        success: false,
        error: 'phone parameter is required',
      });
    }

    const result = await misCollector.getCustomerRejectionHistory(phone);

    res.json(result);
  } catch (error) {
    logger.log('error', 'CUSTOMER_HISTORY_ERROR', `Customer history error: ${error.message}`, {
      error: error.message,
      phone,
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
 * GET /api/mis/config
 * Get MIS collector configuration and rejection code mappings
 */
router.get('/config', (_req, res) => {
  try {
    res.json({
      success: true,
      rejectionCodeCategories: misCollector.rejectionCodeCategories,
      supportedLenders: Object.keys(misCollector.lenderMappings),
      lenderMappings: Object.entries(misCollector.lenderMappings).reduce((acc, [key, val]) => {
        acc[key] = { name: val.name }; // Don't expose secrets
        return acc;
      }, {}),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

export default router;
