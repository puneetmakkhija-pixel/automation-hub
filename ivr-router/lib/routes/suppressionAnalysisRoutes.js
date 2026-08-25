import express from 'express';
import suppressionAnalysisClient from '../llm/suppressionAnalysisClient.js';

const router = express.Router();

// POST /api/suppression/analyze
// Called by nightly job (01:00 UTC) to analyze rejections and generate rule recommendations
router.post('/analyze', async (req, res) => {
  try {
    const { hours = 24, lender_ids = [] } = req.body;

    if (hours < 1 || hours > 168) {
      return res.status(400).json({
        success: false,
        error: 'hours must be between 1 and 168'
      });
    }

    const result = await suppressionAnalysisClient.analyzeRejectionPatternsForRecalibration(
      hours,
      lender_ids
    );

    if (!result.success) {
      return res.status(500).json({
        success: false,
        error: result.error
      });
    }

    res.json({
      success: true,
      message: 'Suppression analysis completed',
      recommendation: result.recommendation,
      analysis_summary: result.analysis ? {
        total_rejections: result.analysis.total_rejections,
        top_rejection_reasons: result.analysis.top_rejection_reasons,
        rejection_by_category: result.analysis.rejection_by_category
      } : null
    });
  } catch (error) {
    console.error('[SuppressionAnalysis] Route error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// POST /api/suppression/apply-recommendation/:recommendation_id
// Called by ops team or automated process to apply a rule recommendation
router.post('/apply-recommendation/:recommendation_id', async (req, res) => {
  try {
    const { recommendation_id } = req.params;
    const { approve = true } = req.body;

    if (!recommendation_id) {
      return res.status(400).json({
        success: false,
        error: 'recommendation_id is required'
      });
    }

    const result = await suppressionAnalysisClient.applyRuleChanges(recommendation_id, approve);

    if (!result.success) {
      return res.status(500).json({
        success: false,
        error: result.error
      });
    }

    res.json({
      success: true,
      message: result.message,
      new_version: result.new_version
    });
  } catch (error) {
    console.error('[SuppressionAnalysis] Apply error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// GET /api/suppression/recommendations
// Fetch recent recommendations for ops review
router.get('/recommendations', async (req, res) => {
  try {
    const { status = 'pending_review', limit = 10 } = req.query;

    const query = require('../clients/supabaseClient.js').default
      .from('rule_recommendations')
      .select('*');

    if (status) {
      query.eq('status', status);
    }

    const { data, error } = await query
      .order('created_at', { ascending: false })
      .limit(parseInt(limit));

    if (error) {
      console.error('[SuppressionAnalysis] Fetch error:', error.message);
      return res.status(500).json({
        success: false,
        error: error.message
      });
    }

    res.json({
      success: true,
      recommendations: data || [],
      count: (data || []).length
    });
  } catch (error) {
    console.error('[SuppressionAnalysis] Fetch error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// GET /api/suppression/current-rules
// Fetch active eligibility rules
router.get('/current-rules', async (req, res) => {
  try {
    const { data, error } = require('../clients/supabaseClient.js').default
      .from('eligibility_rules')
      .select('*')
      .eq('active', true)
      .order('created_at', { ascending: false })
      .limit(1);

    if (error) {
      console.error('[SuppressionAnalysis] Rules fetch error:', error.message);
      return res.status(500).json({
        success: false,
        error: error.message
      });
    }

    res.json({
      success: true,
      rules: data?.[0] || null
    });
  } catch (error) {
    console.error('[SuppressionAnalysis] Rules fetch error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// GET /api/suppression/rule-history
// Fetch historical rules for audit trail
router.get('/rule-history', async (req, res) => {
  try {
    const { limit = 20 } = req.query;

    const { data, error } = require('../clients/supabaseClient.js').default
      .from('eligibility_rules')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(parseInt(limit));

    if (error) {
      console.error('[SuppressionAnalysis] History fetch error:', error.message);
      return res.status(500).json({
        success: false,
        error: error.message
      });
    }

    res.json({
      success: true,
      history: data || []
    });
  } catch (error) {
    console.error('[SuppressionAnalysis] History fetch error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default router;
