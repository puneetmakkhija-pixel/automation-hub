import express from 'express';
import rejectionTrackingClient from '../llm/rejectionTrackingClient.js';

const router = express.Router();

// POST /api/rejections/capture
// Called by lenders or Phase 4 (Lender Submission) when application is rejected
router.post('/capture', async (req, res) => {
  try {
    const {
      phone_number,
      application_id,
      lender_id,
      rejection_reason,
      rejection_message,
      rejected_bureau_vars,
      rejected_demographic_vars
    } = req.body;

    if (!phone_number || !lender_id || !rejection_reason) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: phone_number, lender_id, rejection_reason'
      });
    }

    const result = await rejectionTrackingClient.captureRejection({
      phone_number,
      application_id,
      lender_id,
      rejection_reason,
      rejection_message,
      rejected_bureau_vars: rejected_bureau_vars || {},
      rejected_demographic_vars: rejected_demographic_vars || {}
    });

    if (!result.success) {
      return res.status(500).json({
        success: false,
        error: result.error
      });
    }

    res.json({
      success: true,
      message: result.message,
      data: result.data
    });
  } catch (error) {
    console.error('[RejectionTracking] Route error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// GET /api/rejections/by-lender/:lender_id
router.get('/by-lender/:lender_id', async (req, res) => {
  try {
    const { lender_id } = req.params;
    const { hours = 24 } = req.query;

    if (!lender_id) {
      return res.status(400).json({
        success: false,
        error: 'Missing lender_id'
      });
    }

    const result = await rejectionTrackingClient.getRejectionsByLender(lender_id, parseInt(hours));

    if (!result.success) {
      return res.status(500).json({
        success: false,
        error: result.error
      });
    }

    res.json(result);
  } catch (error) {
    console.error('[RejectionTracking] Query error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// GET /api/rejections/by-category/:category
router.get('/by-category/:category', async (req, res) => {
  try {
    const { category } = req.params;
    const { hours = 24 } = req.query;

    if (!category) {
      return res.status(400).json({
        success: false,
        error: 'Missing category'
      });
    }

    const result = await rejectionTrackingClient.getRejectionsByCategory(category, parseInt(hours));

    if (!result.success) {
      return res.status(500).json({
        success: false,
        error: result.error
      });
    }

    res.json(result);
  } catch (error) {
    console.error('[RejectionTracking] Query error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// GET /api/rejections/by-reason/:reason
router.get('/by-reason/:reason', async (req, res) => {
  try {
    const { reason } = req.params;
    const { hours = 24 } = req.query;

    if (!reason) {
      return res.status(400).json({
        success: false,
        error: 'Missing rejection reason'
      });
    }

    const result = await rejectionTrackingClient.getRejectionsByReason(reason, parseInt(hours));

    if (!result.success) {
      return res.status(500).json({
        success: false,
        error: result.error
      });
    }

    res.json(result);
  } catch (error) {
    console.error('[RejectionTracking] Query error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// POST /api/rejections/mark-engaged
// Called by Phase 3.5e (Re-engagement) when user is re-engaged after rejection
router.post('/mark-engaged', async (req, res) => {
  try {
    const { phone_number, reengagement_channel } = req.body;

    if (!phone_number) {
      return res.status(400).json({
        success: false,
        error: 'Missing phone_number'
      });
    }

    const result = await rejectionTrackingClient.markUserEngagedAgain(
      phone_number,
      reengagement_channel || 'whatsapp'
    );

    if (!result.success) {
      return res.status(500).json({
        success: false,
        error: result.error
      });
    }

    res.json({
      success: true,
      message: 'User marked as re-engaged'
    });
  } catch (error) {
    console.error('[RejectionTracking] Mark engaged error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// POST /api/rejections/record-response
// Called when re-engaged user responds or applies again
router.post('/record-response', async (req, res) => {
  try {
    const { phone_number, response_outcome } = req.body;

    if (!phone_number) {
      return res.status(400).json({
        success: false,
        error: 'Missing phone_number'
      });
    }

    const result = await rejectionTrackingClient.recordReengagementResponse(
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
      message: result.message,
      outcome: result.outcome
    });
  } catch (error) {
    console.error('[RejectionTracking] Record response error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default router;
