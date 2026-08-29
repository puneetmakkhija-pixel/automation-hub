/**
 * Lenders Management Routes
 * Endpoints for managing lenders and their configurations
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

// ==================== GET: List all active Lenders ====================
router.get('/', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(503).json({
        success: false,
        error: 'Supabase not configured',
      });
    }

    const { data, error } = await supabase
      .from('lenders')
      .select('*')
      .eq('status', 'active')
      .order('name', { ascending: true });

    if (error) {
      throw new Error(`Supabase query failed: ${error.message}`);
    }

    logger.log('info', 'LENDERS_LIST', `Retrieved ${data?.length || 0} active lenders`, {
      count: data?.length || 0,
      type: 'lender_management',
    });

    return res.json({
      success: true,
      data: data || [],
      count: data?.length || 0,
    });
  } catch (error) {
    logger.log('error', 'LENDERS_LIST_ERROR', `Failed to list lenders: ${error.message}`, {
      error: error.message,
      type: 'lender_error',
    });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ==================== GET: Get specific Lender ====================
router.get('/:lenderId', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(503).json({
        success: false,
        error: 'Supabase not configured',
      });
    }

    const { lenderId } = req.params;

    const { data, error } = await supabase
      .from('lenders')
      .select('*')
      .eq('lender_id', lenderId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({
          success: false,
          error: 'Lender not found',
        });
      }
      throw new Error(`Supabase query failed: ${error.message}`);
    }

    return res.json({
      success: true,
      data,
    });
  } catch (error) {
    logger.log('error', 'LENDER_GET_ERROR', `Failed to get lender: ${error.message}`, {
      error: error.message,
      type: 'lender_error',
    });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ==================== POST: Create new Lender ====================
router.post('/', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(503).json({
        success: false,
        error: 'Supabase not configured',
      });
    }

    const { lenderId, name, description, webhookUrl, minLoan, maxLoan, status = 'active' } = req.body;

    if (!lenderId || !name) {
      return res.status(400).json({
        success: false,
        error: 'lenderId and name are required',
      });
    }

    const { data, error } = await supabase
      .from('lenders')
      .insert({
        lender_id: lenderId,
        name,
        description,
        webhook_url: webhookUrl,
        min_loan: minLoan,
        max_loan: maxLoan,
        status,
      })
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create lender: ${error.message}`);
    }

    logger.log('info', 'LENDER_CREATED', `Lender created: ${name}`, {
      lenderId,
      name,
      type: 'lender_management',
    });

    return res.status(201).json({
      success: true,
      data,
      message: `Lender "${name}" created successfully`,
    });
  } catch (error) {
    logger.log('error', 'LENDER_CREATE_ERROR', `Failed to create lender: ${error.message}`, {
      error: error.message,
      type: 'lender_error',
    });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ==================== PUT: Update Lender ====================
router.put('/:lenderId', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(503).json({
        success: false,
        error: 'Supabase not configured',
      });
    }

    const { lenderId } = req.params;
    const updateData = req.body;

    const { data, error } = await supabase
      .from('lenders')
      .update({
        ...updateData,
        updated_at: new Date().toISOString(),
      })
      .eq('lender_id', lenderId)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to update lender: ${error.message}`);
    }

    logger.log('info', 'LENDER_UPDATED', `Lender updated: ${lenderId}`, {
      lenderId,
      type: 'lender_management',
    });

    return res.json({
      success: true,
      data,
    });
  } catch (error) {
    logger.log('error', 'LENDER_UPDATE_ERROR', `Failed to update lender: ${error.message}`, {
      error: error.message,
      type: 'lender_error',
    });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ==================== DELETE: Delete Lender ====================
router.delete('/:lenderId', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(503).json({
        success: false,
        error: 'Supabase not configured',
      });
    }

    const { lenderId } = req.params;

    const { error } = await supabase
      .from('lenders')
      .delete()
      .eq('lender_id', lenderId);

    if (error) {
      throw new Error(`Failed to delete lender: ${error.message}`);
    }

    logger.log('info', 'LENDER_DELETED', `Lender deleted: ${lenderId}`, {
      lenderId,
      type: 'lender_management',
    });

    return res.json({
      success: true,
      message: 'Lender deleted successfully',
    });
  } catch (error) {
    logger.log('error', 'LENDER_DELETE_ERROR', `Failed to delete lender: ${error.message}`, {
      error: error.message,
      type: 'lender_error',
    });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

export default router;
