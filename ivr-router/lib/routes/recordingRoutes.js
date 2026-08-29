/**
 * Recording Management Routes
 * Endpoints for uploading, listing, and managing IVR recordings
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

// ==================== GET: List all recordings ====================
router.get('/', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(503).json({
        success: false,
        error: 'Supabase not configured',
      });
    }

    const { data, error } = await supabase
      .from('ivr_recordings')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Supabase query failed: ${error.message}`);
    }

    logger.log('info', 'RECORDINGS_LIST', `Retrieved ${data?.length || 0} recordings`, {
      count: data?.length || 0,
      type: 'recording_management',
    });

    return res.json({
      success: true,
      data: data || [],
      count: data?.length || 0,
    });
  } catch (error) {
    logger.log('error', 'RECORDINGS_LIST_ERROR', `Failed to list recordings: ${error.message}`, {
      error: error.message,
      type: 'recording_error',
    });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ==================== POST: Create/Save recording metadata ====================
router.post('/', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(503).json({
        success: false,
        error: 'Supabase not configured',
      });
    }

    const { name, description, language, duration, url, fileSize } = req.body;

    if (!name || !url) {
      return res.status(400).json({
        success: false,
        error: 'name and url are required',
      });
    }

    const recordingId = `rec_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const { data, error } = await supabase
      .from('ivr_recordings')
      .insert({
        id: recordingId,
        name,
        description,
        language: language || 'en',
        duration: duration || 0,
        url,
        file_size: fileSize || 0,
        status: 'active',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create recording: ${error.message}`);
    }

    logger.log('info', 'RECORDING_CREATED', `Recording saved: ${name}`, {
      recordingId,
      name,
      type: 'recording_management',
    });

    return res.status(201).json({
      success: true,
      data,
      message: `Recording "${name}" saved successfully`,
    });
  } catch (error) {
    logger.log('error', 'RECORDING_CREATE_ERROR', `Failed to create recording: ${error.message}`, {
      error: error.message,
      type: 'recording_error',
    });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ==================== GET: Get specific recording ====================
router.get('/:recordingId', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(503).json({
        success: false,
        error: 'Supabase not configured',
      });
    }

    const { recordingId } = req.params;

    const { data, error } = await supabase
      .from('ivr_recordings')
      .select('*')
      .eq('id', recordingId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({
          success: false,
          error: 'Recording not found',
        });
      }
      throw new Error(`Supabase query failed: ${error.message}`);
    }

    return res.json({
      success: true,
      data,
    });
  } catch (error) {
    logger.log('error', 'RECORDING_GET_ERROR', `Failed to get recording: ${error.message}`, {
      error: error.message,
      type: 'recording_error',
    });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ==================== DELETE: Delete recording ====================
router.delete('/:recordingId', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(503).json({
        success: false,
        error: 'Supabase not configured',
      });
    }

    const { recordingId } = req.params;

    const { error } = await supabase
      .from('ivr_recordings')
      .delete()
      .eq('id', recordingId);

    if (error) {
      throw new Error(`Failed to delete recording: ${error.message}`);
    }

    logger.log('info', 'RECORDING_DELETED', `Recording deleted: ${recordingId}`, {
      recordingId,
      type: 'recording_management',
    });

    return res.json({
      success: true,
      message: 'Recording deleted successfully',
    });
  } catch (error) {
    logger.log('error', 'RECORDING_DELETE_ERROR', `Failed to delete recording: ${error.message}`, {
      error: error.message,
      type: 'recording_error',
    });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

export default router;
