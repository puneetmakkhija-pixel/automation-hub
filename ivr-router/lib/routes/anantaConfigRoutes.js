/**
 * Ananta WhatsApp Configuration Routes
 * Endpoints for managing Ananta WhatsApp credentials and templates
 */

import express from 'express';
import { createClient } from '@supabase/supabase-js';
import logger from '../logging.js';

const router = express.Router();

// Initialize Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
let supabase = null;

if (supabaseUrl && supabaseServiceRoleKey) {
  supabase = createClient(supabaseUrl, supabaseServiceRoleKey);
}

// ==================== GET: Get Ananta configuration ====================
router.get('/config', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(503).json({
        success: false,
        error: 'Supabase not configured',
      });
    }

    const { data, error } = await supabase
      .from('ananta_config')
      .select('*')
      .single();

    if (error && error.code !== 'PGRST116') {
      throw new Error(`Supabase query failed: ${error.message}`);
    }

    // If no config exists, return defaults
    const config = data || {
      api_key: process.env.ANANTA_API_KEY || '',
      api_token: process.env.ANANTA_API_TOKEN || '',
      phone_number: process.env.ANANTA_PHONE_NUMBER || '',
      status: 'configured',
      webhook_url: `${process.env.WEBHOOK_BASE_URL || 'https://ivr-voice-bot-system-production.up.railway.app'}/webhooks/ananta`,
    };

    return res.json({
      success: true,
      data: config,
    });
  } catch (error) {
    logger.log('error', 'ANANTA_CONFIG_GET_ERROR', `Failed to get Ananta config: ${error.message}`, {
      error: error.message,
      type: 'ananta_error',
    });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ==================== POST: Save/Update Ananta configuration ====================
router.post('/config', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(503).json({
        success: false,
        error: 'Supabase not configured',
      });
    }

    const { apiKey, apiToken, phoneNumber, status } = req.body;

    if (!apiKey) {
      return res.status(400).json({
        success: false,
        error: 'apiKey is required',
      });
    }

    // Check if config exists
    const { data: existing } = await supabase
      .from('ananta_config')
      .select('id')
      .single();

    let result;
    if (existing) {
      // Update existing
      result = await supabase
        .from('ananta_config')
        .update({
          api_key: apiKey,
          api_token: apiToken || '',
          phone_number: phoneNumber || '',
          status: status || 'configured',
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id)
        .select()
        .single();
    } else {
      // Create new
      result = await supabase
        .from('ananta_config')
        .insert({
          api_key: apiKey,
          api_token: apiToken || '',
          phone_number: phoneNumber || '',
          status: status || 'configured',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .select()
        .single();
    }

    const { error } = result;
    if (error) {
      throw new Error(`Failed to save config: ${error.message}`);
    }

    logger.log('info', 'ANANTA_CONFIG_SAVED', 'Ananta configuration updated', {
      status: status || 'configured',
      type: 'ananta_management',
    });

    return res.json({
      success: true,
      data: result.data,
      message: 'Ananta configuration saved successfully',
    });
  } catch (error) {
    logger.log('error', 'ANANTA_CONFIG_SAVE_ERROR', `Failed to save Ananta config: ${error.message}`, {
      error: error.message,
      type: 'ananta_error',
    });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ==================== GET: List WhatsApp message templates ====================
router.get('/templates', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(503).json({
        success: false,
        error: 'Supabase not configured',
      });
    }

    const { data, error } = await supabase
      .from('whatsapp_templates')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Supabase query failed: ${error.message}`);
    }

    logger.log('info', 'WHATSAPP_TEMPLATES_LIST', `Retrieved ${data?.length || 0} templates`, {
      count: data?.length || 0,
      type: 'template_management',
    });

    return res.json({
      success: true,
      data: data || [],
      count: data?.length || 0,
    });
  } catch (error) {
    logger.log('error', 'WHATSAPP_TEMPLATES_ERROR', `Failed to list templates: ${error.message}`, {
      error: error.message,
      type: 'template_error',
    });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ==================== POST: Create WhatsApp template ====================
router.post('/templates', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(503).json({
        success: false,
        error: 'Supabase not configured',
      });
    }

    const { name, message, lenderId, type } = req.body;

    if (!name || !message) {
      return res.status(400).json({
        success: false,
        error: 'name and message are required',
      });
    }

    const templateId = `tpl_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const { data, error } = await supabase
      .from('whatsapp_templates')
      .insert({
        id: templateId,
        name,
        message,
        lender_id: lenderId || null,
        type: type || 'generic',
        status: 'active',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create template: ${error.message}`);
    }

    logger.log('info', 'WHATSAPP_TEMPLATE_CREATED', `Template created: ${name}`, {
      templateId,
      name,
      type: 'template_management',
    });

    return res.status(201).json({
      success: true,
      data,
      message: `Template "${name}" created successfully`,
    });
  } catch (error) {
    logger.log('error', 'WHATSAPP_TEMPLATE_ERROR', `Failed to create template: ${error.message}`, {
      error: error.message,
      type: 'template_error',
    });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ==================== DELETE: Delete template ====================
router.delete('/templates/:templateId', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(503).json({
        success: false,
        error: 'Supabase not configured',
      });
    }

    const { templateId } = req.params;

    const { error } = await supabase
      .from('whatsapp_templates')
      .delete()
      .eq('id', templateId);

    if (error) {
      throw new Error(`Failed to delete template: ${error.message}`);
    }

    logger.log('info', 'WHATSAPP_TEMPLATE_DELETED', `Template deleted: ${templateId}`, {
      templateId,
      type: 'template_management',
    });

    return res.json({
      success: true,
      message: 'Template deleted successfully',
    });
  } catch (error) {
    logger.log('error', 'WHATSAPP_TEMPLATE_DELETE_ERROR', `Failed to delete template: ${error.message}`, {
      error: error.message,
      type: 'template_error',
    });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

export default router;
