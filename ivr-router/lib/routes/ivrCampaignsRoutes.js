/**
 * IVR Campaigns Management Routes
 * Endpoints for creating, listing, launching, and managing IVR campaigns
 * Used by dashboard for campaign CRUD operations
 */

import express from 'express';
import { createClient } from '@supabase/supabase-js';
import logger from '../logging.js';
import AnantaWhatsAppService from '../services/anantaWhatsAppService.js';

const router = express.Router();

// Initialize Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
let supabase = null;

if (supabaseUrl && supabaseServiceRoleKey) {
  supabase = createClient(supabaseUrl, supabaseServiceRoleKey);
}

// ==================== GET: List all IVR Campaigns ====================
router.get('/', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(503).json({
        success: false,
        error: 'Supabase not configured',
      });
    }

    const { data, error } = await supabase
      .from('ivr_campaigns')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Supabase query failed: ${error.message}`);
    }

    logger.log('info', 'IVR_CAMPAIGNS_LIST', `Retrieved ${data?.length || 0} IVR campaigns`, {
      count: data?.length || 0,
      type: 'campaign_management',
    });

    return res.json({
      success: true,
      data: data || [],
      count: data?.length || 0,
    });
  } catch (error) {
    logger.log('error', 'IVR_CAMPAIGNS_LIST_ERROR', `Failed to list IVR campaigns: ${error.message}`, {
      error: error.message,
      type: 'campaign_error',
    });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ==================== POST: Create new IVR Campaign ====================
router.post('/', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(503).json({
        success: false,
        error: 'Supabase not configured',
      });
    }

    const {
      name,
      leadCount,
      ivrConfig,
      dtmfOptions,
      oriVoiceBot,
      status = 'draft',
    } = req.body;

    if (!name || !leadCount || !ivrConfig || !dtmfOptions) {
      return res.status(400).json({
        success: false,
        error: 'name, leadCount, ivrConfig, and dtmfOptions are required',
      });
    }

    const campaignId = `ivr_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const { data, error } = await supabase
      .from('ivr_campaigns')
      .insert({
        id: campaignId,
        name,
        lead_count: leadCount,
        ivr_config: ivrConfig,
        dtmf_options: dtmfOptions,
        ori_voice_bot: oriVoiceBot,
        status,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create campaign: ${error.message}`);
    }

    logger.log('info', 'IVR_CAMPAIGN_CREATED', `IVR Campaign created: ${name}`, {
      campaignId,
      name,
      leadCount,
      status,
      type: 'campaign_management',
    });

    return res.status(201).json({
      success: true,
      data,
      message: `IVR Campaign "${name}" created successfully`,
    });
  } catch (error) {
    logger.log('error', 'IVR_CAMPAIGN_CREATE_ERROR', `Failed to create IVR campaign: ${error.message}`, {
      error: error.message,
      type: 'campaign_error',
    });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ==================== GET: Get specific IVR Campaign ====================
router.get('/:campaignId', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(503).json({
        success: false,
        error: 'Supabase not configured',
      });
    }

    const { campaignId } = req.params;

    const { data, error } = await supabase
      .from('ivr_campaigns')
      .select('*')
      .eq('id', campaignId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({
          success: false,
          error: 'Campaign not found',
        });
      }
      throw new Error(`Supabase query failed: ${error.message}`);
    }

    return res.json({
      success: true,
      data,
    });
  } catch (error) {
    logger.log('error', 'IVR_CAMPAIGN_GET_ERROR', `Failed to get IVR campaign: ${error.message}`, {
      error: error.message,
      type: 'campaign_error',
    });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ==================== POST: Launch IVR Campaign ====================
router.post('/:campaignId/launch', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(503).json({
        success: false,
        error: 'Supabase not configured',
      });
    }

    const { campaignId } = req.params;

    // Get campaign
    const { data: campaign, error: getError } = await supabase
      .from('ivr_campaigns')
      .select('*')
      .eq('id', campaignId)
      .single();

    if (getError || !campaign) {
      return res.status(404).json({
        success: false,
        error: 'Campaign not found',
      });
    }

    // Update campaign status to active
    const { data, error } = await supabase
      .from('ivr_campaigns')
      .update({
        status: 'active',
        launched_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', campaignId)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to launch campaign: ${error.message}`);
    }

    // Log launch event
    logger.log('info', 'IVR_CAMPAIGN_LAUNCHED', `IVR Campaign launched: ${campaign.name}`, {
      campaignId,
      campaignName: campaign.name,
      leadCount: campaign.lead_count,
      launchedAt: new Date().toISOString(),
      type: 'campaign_launch',
    });

    return res.json({
      success: true,
      data,
      message: `IVR Campaign "${campaign.name}" launched successfully`,
    });
  } catch (error) {
    logger.log('error', 'IVR_CAMPAIGN_LAUNCH_ERROR', `Failed to launch IVR campaign: ${error.message}`, {
      campaignId: req.params.campaignId,
      error: error.message,
      type: 'campaign_error',
    });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ==================== GET: Campaign Status ====================
router.get('/:campaignId/status', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(503).json({
        success: false,
        error: 'Supabase not configured',
      });
    }

    const { campaignId } = req.params;

    // Get campaign
    const { data: campaign, error: getError } = await supabase
      .from('ivr_campaigns')
      .select('*')
      .eq('id', campaignId)
      .single();

    if (getError || !campaign) {
      return res.status(404).json({
        success: false,
        error: 'Campaign not found',
      });
    }

    // Get campaign metrics
    const { data: metrics, error: metricsError } = await supabase
      .from('ivr_campaign_metrics')
      .select('*')
      .eq('campaign_id', campaignId);

    if (metricsError) {
      console.warn('Failed to fetch campaign metrics:', metricsError.message);
    }

    return res.json({
      success: true,
      data: {
        campaign,
        metrics: metrics || [],
      },
    });
  } catch (error) {
    logger.log('error', 'IVR_CAMPAIGN_STATUS_ERROR', `Failed to get campaign status: ${error.message}`, {
      error: error.message,
      type: 'campaign_error',
    });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ==================== PUT: Update IVR Campaign ====================
router.put('/:campaignId', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(503).json({
        success: false,
        error: 'Supabase not configured',
      });
    }

    const { campaignId } = req.params;
    const updateData = req.body;

    // Don't allow status changes via PUT (use launch endpoint)
    delete updateData.status;
    delete updateData.launched_at;
    delete updateData.created_at;

    const { data, error } = await supabase
      .from('ivr_campaigns')
      .update({
        ...updateData,
        updated_at: new Date().toISOString(),
      })
      .eq('id', campaignId)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to update campaign: ${error.message}`);
    }

    logger.log('info', 'IVR_CAMPAIGN_UPDATED', `IVR Campaign updated: ${campaignId}`, {
      campaignId,
      type: 'campaign_management',
    });

    return res.json({
      success: true,
      data,
    });
  } catch (error) {
    logger.log('error', 'IVR_CAMPAIGN_UPDATE_ERROR', `Failed to update IVR campaign: ${error.message}`, {
      error: error.message,
      type: 'campaign_error',
    });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ==================== DELETE: Delete IVR Campaign ====================
router.delete('/:campaignId', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(503).json({
        success: false,
        error: 'Supabase not configured',
      });
    }

    const { campaignId } = req.params;

    const { error } = await supabase
      .from('ivr_campaigns')
      .delete()
      .eq('id', campaignId);

    if (error) {
      throw new Error(`Failed to delete campaign: ${error.message}`);
    }

    logger.log('info', 'IVR_CAMPAIGN_DELETED', `IVR Campaign deleted: ${campaignId}`, {
      campaignId,
      type: 'campaign_management',
    });

    return res.json({
      success: true,
      message: 'Campaign deleted successfully',
    });
  } catch (error) {
    logger.log('error', 'IVR_CAMPAIGN_DELETE_ERROR', `Failed to delete IVR campaign: ${error.message}`, {
      error: error.message,
      type: 'campaign_error',
    });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ==================== POST: Handle DTMF Press Event ====================
router.post('/:campaignId/dtmf', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(503).json({
        success: false,
        error: 'Supabase not configured',
      });
    }

    const { campaignId } = req.params;
    const { phone, name, leadId, dtmfPress } = req.body;

    if (!phone || !dtmfPress) {
      return res.status(400).json({
        success: false,
        error: 'phone and dtmfPress are required',
      });
    }

    // Get campaign
    const { data: campaign, error: getError } = await supabase
      .from('ivr_campaigns')
      .select('*')
      .eq('id', campaignId)
      .single();

    if (getError || !campaign) {
      return res.status(404).json({
        success: false,
        error: 'Campaign not found',
      });
    }

    const dtmfOptions = campaign.dtmf_options;
    let eventType = null;
    let whatsappResult = null;

    // Handle DTMF Press 1 - Interested in product/lender
    if (dtmfPress === '1' && dtmfOptions?.press1) {
      eventType = 'dtmf_press_1';

      // Send WhatsApp if configured
      if (dtmfOptions.press1.whatsapp_provider === 'ananta') {
        const message = dtmfOptions.press1.whatsapp_message ||
          AnantaWhatsAppService.formatFlexiLoansMessage({ phone, name: name || 'User' }, campaignId);

        whatsappResult = await AnantaWhatsAppService.sendMessage({
          phone,
          message,
          campaignId,
          leadId: leadId || `lead_${campaignId}_${phone}`,
        });

        logger.log('info', 'DTMF_PRESS_1_WHATSAPP_SENT', `WhatsApp sent for DTMF Press 1`, {
          campaignId,
          phone: phone.slice(-4),
          whatsappProvider: 'ananta',
          success: whatsappResult.success,
          type: 'dtmf_event',
        });
      }

      // Update metrics (get current value, increment, and update)
      const { data: metricsData } = await supabase
        .from('ivr_campaign_metrics')
        .select('dtmf_press_1_count, whatsapp_sent_count')
        .eq('campaign_id', campaignId)
        .single();

      if (metricsData) {
        await supabase
          .from('ivr_campaign_metrics')
          .update({ dtmf_press_1_count: (metricsData.dtmf_press_1_count || 0) + 1 })
          .eq('campaign_id', campaignId);

        if (whatsappResult?.success) {
          await supabase
            .from('ivr_campaign_metrics')
            .update({ whatsapp_sent_count: (metricsData.whatsapp_sent_count || 0) + 1 })
            .eq('campaign_id', campaignId);
        }
      }
    }
    // Handle DTMF Press 2 - Not Interested / Do Not Disturb
    else if (dtmfPress === '2' && dtmfOptions?.press2) {
      eventType = 'dtmf_press_2';

      // Update metrics
      const { data: metricsData } = await supabase
        .from('ivr_campaign_metrics')
        .select('dtmf_press_2_count')
        .eq('campaign_id', campaignId)
        .single();

      if (metricsData) {
        await supabase
          .from('ivr_campaign_metrics')
          .update({ dtmf_press_2_count: (metricsData.dtmf_press_2_count || 0) + 1 })
          .eq('campaign_id', campaignId);
      }

      if (dtmfOptions.press2.action === 'mark_dnd') {
        logger.log('info', 'DTMF_PRESS_2_MARK_DND', `Lead marked as DND`, {
          campaignId,
          phone: phone.slice(-4),
          type: 'dtmf_event',
        });
      }
    }
    // No response
    else {
      eventType = 'dtmf_no_response';
      const { data: metricsData } = await supabase
        .from('ivr_campaign_metrics')
        .select('dtmf_no_response_count')
        .eq('campaign_id', campaignId)
        .single();

      if (metricsData) {
        await supabase
          .from('ivr_campaign_metrics')
          .update({ dtmf_no_response_count: (metricsData.dtmf_no_response_count || 0) + 1 })
          .eq('campaign_id', campaignId);
      }
    }

    // Log event
    await supabase
      .from('ivr_campaign_events')
      .insert({
        campaign_id: campaignId,
        phone_number: phone,
        event_type: eventType,
        dtmf_input: dtmfPress,
        metadata: {
          leadId: leadId || `lead_${campaignId}_${phone}`,
          leadName: name,
          whatsappResult,
        },
      });

    logger.log('info', 'DTMF_EVENT_LOGGED', `DTMF event logged: ${eventType}`, {
      campaignId,
      eventType,
      phone: phone.slice(-4),
      type: 'dtmf_event',
    });

    return res.json({
      success: true,
      eventType,
      whatsappResult,
      message: `DTMF Press ${dtmfPress} handled successfully`,
    });
  } catch (error) {
    logger.log('error', 'DTMF_EVENT_ERROR', `Failed to handle DTMF event: ${error.message}`, {
      error: error.message,
      campaignId: req.params.campaignId,
      type: 'dtmf_error',
    });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

export default router;
