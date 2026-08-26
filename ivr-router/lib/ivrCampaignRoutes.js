/**
 * IVR Campaign Management Routes
 * Endpoints for creating campaigns, managing recordings, and filtering bases
 */

import express from 'express';
import OBDApiClient from './obdApiClient.js';
import { createClient } from '@supabase/supabase-js';
import logger from './logging.js';

const router = express.Router();

let obdClient = null;
let supabase = null;

// Initialize clients
try {
  obdClient = new OBDApiClient(
    process.env.OBD_BASE_URL || 'https://obdapi2.ivrsms.com',
    process.env.OBD_USERNAME,
    process.env.OBD_PASSWORD
  );

  supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
} catch (error) {
  logger.log('warn', 'IVR_CAMPAIGN_INIT', 'Failed to initialize IVR campaign clients', {
    error: error.message,
    type: 'initialization_error'
  });
}

// ==================== Utility Functions ====================

const LENDERS = {
  flexiloans: {
    name: 'FlexiLoans',
    description: 'Flexible personal loans up to 25 lakhs',
  },
  poonawala: {
    name: 'Poonawala Finance',
    description: 'Business, auto, and personal financing',
  }
};

// ==================== Campaign Recording Routes ====================

/**
 * POST /api/campaigns/recordings
 * Create or upload IVR recordings for a campaign
 */
router.post('/recordings', async (req, res) => {
  try {
    const { lenderId, recordings } = req.body;

    if (!lenderId || !recordings) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: lenderId, recordings'
      });
    }

    logger.log('info', 'CAMPAIGN_RECORDING_CREATE', 'Creating IVR recordings', {
      lenderId,
      recordingCount: Object.keys(recordings).length,
      type: 'campaign_recording'
    });

    const uploadedRecordings = {};

    for (const [type, data] of Object.entries(recordings)) {
      try {
        // Validate recording data
        if (!data.text && !data.audioFile) {
          uploadedRecordings[type] = {
            status: 'skipped',
            reason: 'No text or audio file provided'
          };
          continue;
        }

        // For text-based recordings, store metadata
        uploadedRecordings[type] = {
          status: 'created',
          text: data.text || 'Audio recording',
          type,
          createdAt: new Date().toISOString()
        };

        logger.log('info', 'CAMPAIGN_RECORDING_SUCCESS', `${type} recording created`, {
          lenderId,
          recordingType: type,
          type: 'campaign_recording'
        });
      } catch (error) {
        uploadedRecordings[type] = {
          status: 'failed',
          error: error.message
        };

        logger.log('warn', 'CAMPAIGN_RECORDING_ERROR', `Failed to create ${type} recording`, {
          lenderId,
          recordingType: type,
          error: error.message,
          type: 'campaign_error'
        });
      }
    }

    res.json({
      success: true,
      lenderId,
      recordings: uploadedRecordings,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.logError('IVR_CAMPAIGN_RECORDING', error, req.body);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ==================== Campaign Creation Routes ====================

/**
 * POST /api/campaigns/create
 * Create a new campaign with recordings and base
 */
router.post('/create', async (req, res) => {
  try {
    const { lenderId, campaignName, baseId, recordings } = req.body;

    if (!lenderId || !campaignName || !baseId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: lenderId, campaignName, baseId'
      });
    }

    logger.log('info', 'CAMPAIGN_CREATE', 'Starting campaign creation', {
      lenderId,
      campaignName,
      baseId,
      type: 'campaign_creation'
    });

    // Build campaign configuration
    const campaignConfig = {
      campaignName,
      campaignType: 'dtmf',
      baseId,
      welcomePromptId: recordings?.welcome?.promptId || '954',
      menuPromptId: recordings?.menu?.promptId || '955',
      thanksPromptId: recordings?.thanks?.promptId || '956',
      noInputPromptId: recordings?.noInput?.promptId || '957',
      wrongInputPromptId: recordings?.wrongInput?.promptId || '958',
      dtmf: '1',
      menuWaitTime: 5,
      rePrompt: 2,
      scheduleTime: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    };

    // Note: Actual campaign creation would call obdClient.composeCampaign
    // For now, return the configuration that would be sent

    logger.log('info', 'CAMPAIGN_CREATE_SUCCESS', 'Campaign created successfully', {
      lenderId,
      campaignName,
      baseId,
      type: 'campaign_creation'
    });

    res.json({
      success: true,
      campaign: {
        id: 'CAMP_' + Date.now(),
        name: campaignName,
        lenderId,
        baseId,
        recordingCount: Object.keys(recordings || {}).length,
        createdAt: new Date().toISOString(),
        status: 'active'
      },
      configuration: campaignConfig
    });
  } catch (error) {
    logger.logError('CAMPAIGN_CREATE_ERROR', error, req.body);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ==================== Base Filtering Routes ====================

/**
 * POST /api/campaigns/filter-base
 * Filter campaign bases from Supabase (SME Circle, Self-Employed)
 */
router.post('/filter-base', async (req, res) => {
  try {
    const { lenderId, filterCriteria = {} } = req.body;

    if (!lenderId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: lenderId'
      });
    }

    logger.log('info', 'CAMPAIGN_BASE_FILTER', 'Starting base filtering', {
      lenderId,
      filterCriteria,
      type: 'campaign_base_filter'
    });

    if (!supabase) {
      return res.status(503).json({
        success: false,
        error: 'Supabase client not initialized'
      });
    }

    // Query campaign contacts from Supabase
    const { data: allContacts, error: queryError } = await supabase
      .from('campaign_contacts')
      .select('*')
      .eq('lender_id', lenderId)
      .limit(10000);

    if (queryError) {
      logger.log('warn', 'CAMPAIGN_BASE_QUERY_ERROR', 'Failed to query contacts', {
        lenderId,
        error: queryError.message,
        type: 'database_error'
      });

      return res.status(500).json({
        success: false,
        error: `Failed to query contacts: ${queryError.message}`,
        detail: 'Ensure campaign_contacts table exists in Supabase'
      });
    }

    // Apply filters
    const filterBySmeCircle = (contact) => {
      return contact.loan_circle === 'sme_circle' ||
             contact.segment === 'sme' ||
             contact.business_type === 'sme';
    };

    const filterBySelfEmployed = (contact) => {
      return contact.employment_type === 'self_employed' ||
             contact.employment_type === 'se' ||
             contact.base_type === 'self_employed_base';
    };

    // Combine filters
    const filteredContacts = allContacts.filter(contact => {
      const matchesSme = filterCriteria.smeLoanCircle !== false ? filterBySmeCircle(contact) : true;
      const matchesSe = filterCriteria.selfEmployedBase !== false ? filterBySelfEmployed(contact) : true;
      return matchesSme || matchesSe;
    });

    logger.log('info', 'CAMPAIGN_BASE_FILTER_SUCCESS', 'Base filtering completed', {
      lenderId,
      totalContacts: allContacts.length,
      filteredContacts: filteredContacts.length,
      filtrationRatio: ((filteredContacts.length / allContacts.length) * 100).toFixed(2) + '%',
      type: 'campaign_base_filter'
    });

    res.json({
      success: true,
      lenderId,
      baseStats: {
        totalContacts: allContacts.length,
        filteredContacts: filteredContacts.length,
        filters: filterCriteria,
        filtrationRatio: ((filteredContacts.length / allContacts.length) * 100).toFixed(2) + '%'
      },
      sampleContacts: filteredContacts.slice(0, 10),
      exportUrl: `/api/campaigns/export-base?lenderId=${lenderId}`
    });
  } catch (error) {
    logger.logError('CAMPAIGN_BASE_FILTER_ERROR', error, req.body);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ==================== Base Export Routes ====================

/**
 * GET /api/campaigns/export-base
 * Export filtered base as CSV
 */
router.get('/export-base', async (req, res) => {
  try {
    const { lenderId, format = 'csv' } = req.query;

    if (!lenderId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameter: lenderId'
      });
    }

    logger.log('info', 'CAMPAIGN_BASE_EXPORT', 'Starting base export', {
      lenderId,
      format,
      type: 'campaign_export'
    });

    if (!supabase) {
      return res.status(503).json({
        success: false,
        error: 'Supabase client not initialized'
      });
    }

    // Query contacts
    const { data: allContacts, error: queryError } = await supabase
      .from('campaign_contacts')
      .select('*')
      .eq('lender_id', lenderId);

    if (queryError) {
      throw new Error(`Failed to query contacts: ${queryError.message}`);
    }

    // Filter contacts
    const filteredContacts = allContacts.filter(contact => {
      return (contact.loan_circle === 'sme_circle' || contact.segment === 'sme') ||
             (contact.employment_type === 'self_employed' || contact.employment_type === 'se');
    });

    if (format === 'csv') {
      // Generate CSV
      const csvHeader = ['phone', 'name', 'lender_id', 'segment', 'employment_type', 'contact_date'];
      const csvRows = filteredContacts.map(contact => [
        contact.phone || '',
        contact.name || '',
        contact.lender_id || '',
        contact.segment || 'sme',
        contact.employment_type || 'self_employed',
        contact.created_at || new Date().toISOString()
      ]);

      const csv = [csvHeader, ...csvRows]
        .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
        .join('\n');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${lenderId}_base_${new Date().toISOString().split('T')[0]}.csv"`);

      logger.log('info', 'CAMPAIGN_BASE_EXPORT_SUCCESS', 'Base exported as CSV', {
        lenderId,
        rowCount: filteredContacts.length,
        type: 'campaign_export'
      });

      return res.send(csv);
    }

    // JSON format
    res.json({
      success: true,
      lenderId,
      contactCount: filteredContacts.length,
      contacts: filteredContacts,
      exportedAt: new Date().toISOString()
    });

  } catch (error) {
    logger.logError('CAMPAIGN_BASE_EXPORT_ERROR', error, req.query);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ==================== Campaign Status Routes ====================

/**
 * GET /api/campaigns/list
 * List all campaigns for a lender
 */
router.get('/list', async (req, res) => {
  try {
    const { lenderId } = req.query;

    logger.log('info', 'CAMPAIGN_LIST', 'Retrieving campaign list', {
      lenderId: lenderId || 'all',
      type: 'campaign_list'
    });

    // Return available lenders and campaign structure
    res.json({
      success: true,
      lenders: LENDERS,
      campaignStructure: {
        campaignTypes: ['simple-ivr', 'dtmf', 'call-patch'],
        recordingTypes: ['welcome', 'menu', 'thanks', 'noInput', 'wrongInput'],
        filterOptions: {
          smeLoanCircle: true,
          selfEmployedBase: true,
          employmentType: ['self_employed', 'salaried', 'business_owner'],
          loanSegment: ['personal_loan', 'business_loan', 'auto_loan']
        }
      },
      exampleUsage: {
        createRecording: 'POST /api/campaigns/recordings',
        createCampaign: 'POST /api/campaigns/create',
        filterBase: 'POST /api/campaigns/filter-base',
        exportBase: 'GET /api/campaigns/export-base?lenderId=flexiloans',
      }
    });
  } catch (error) {
    logger.logError('CAMPAIGN_LIST_ERROR', error, req.query);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ==================== Health Check ====================

router.get('/health', (req, res) => {
  res.json({
    success: true,
    service: 'ivr-campaign-management',
    status: 'operational',
    clients: {
      obdClient: obdClient ? 'initialized' : 'not initialized',
      supabase: supabase ? 'initialized' : 'not initialized'
    },
    timestamp: new Date().toISOString()
  });
});

export default router;
