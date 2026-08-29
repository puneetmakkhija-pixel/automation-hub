/**
 * WhatsApp Chatbot Flow Routes
 * Endpoints for tracking and managing WhatsApp conversation flow
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

// ==================== GET: Active conversations ====================
router.get('/conversations', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(503).json({
        success: false,
        error: 'Supabase not configured',
      });
    }

    const { data, error } = await supabase
      .from('whatsapp_conversations')
      .select('*')
      .eq('status', 'active')
      .order('last_message_at', { ascending: false })
      .limit(100);

    if (error) {
      throw new Error(`Supabase query failed: ${error.message}`);
    }

    logger.log('info', 'WHATSAPP_CONVERSATIONS_LIST', `Retrieved ${data?.length || 0} active conversations`, {
      count: data?.length || 0,
      type: 'chatbot_flow',
    });

    return res.json({
      success: true,
      data: data || [],
      count: data?.length || 0,
    });
  } catch (error) {
    logger.log('error', 'WHATSAPP_CONVERSATIONS_ERROR', `Failed to list conversations: ${error.message}`, {
      error: error.message,
      type: 'chatbot_error',
    });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ==================== GET: Specific conversation thread ====================
router.get('/conversations/:phone', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(503).json({
        success: false,
        error: 'Supabase not configured',
      });
    }

    const { phone } = req.params;

    // Get conversation metadata
    const { data: conversation, error: convError } = await supabase
      .from('whatsapp_conversations')
      .select('*')
      .eq('phone_number', phone)
      .single();

    if (convError && convError.code !== 'PGRST116') {
      throw new Error(`Failed to get conversation: ${convError.message}`);
    }

    // Get conversation messages
    const { data: messages, error: msgError } = await supabase
      .from('whatsapp_messages')
      .select('*')
      .eq('phone_number', phone)
      .order('created_at', { ascending: false })
      .limit(50);

    if (msgError) {
      throw new Error(`Failed to get messages: ${msgError.message}`);
    }

    // Get document collection status
    const { data: documents, error: docError } = await supabase
      .from('whatsapp_documents')
      .select('*')
      .eq('phone_number', phone);

    if (docError) {
      throw new Error(`Failed to get documents: ${docError.message}`);
    }

    return res.json({
      success: true,
      data: {
        conversation: conversation || null,
        messages: messages || [],
        documents: documents || [],
      },
    });
  } catch (error) {
    logger.log('error', 'WHATSAPP_CONVERSATION_ERROR', `Failed to get conversation: ${error.message}`, {
      error: error.message,
      type: 'chatbot_error',
    });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ==================== GET: Chatbot flow statistics ====================
router.get('/stats', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(503).json({
        success: false,
        error: 'Supabase not configured',
      });
    }

    // Total active conversations
    const { count: activeCount } = await supabase
      .from('whatsapp_conversations')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'active');

    // Total completed conversations
    const { count: completedCount } = await supabase
      .from('whatsapp_conversations')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'completed');

    // Total messages sent
    const { count: totalMessages } = await supabase
      .from('whatsapp_messages')
      .select('*', { count: 'exact', head: true });

    // Documents collected
    const { count: documentsCollected } = await supabase
      .from('whatsapp_documents')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'verified');

    logger.log('info', 'WHATSAPP_STATS', 'WhatsApp flow statistics retrieved', {
      activeConversations: activeCount,
      completedConversations: completedCount,
      totalMessages: totalMessages,
      documentsCollected: documentsCollected,
      type: 'chatbot_analytics',
    });

    return res.json({
      success: true,
      data: {
        activeConversations: activeCount || 0,
        completedConversations: completedCount || 0,
        totalMessages: totalMessages || 0,
        documentsCollected: documentsCollected || 0,
      },
    });
  } catch (error) {
    logger.log('error', 'WHATSAPP_STATS_ERROR', `Failed to get stats: ${error.message}`, {
      error: error.message,
      type: 'chatbot_error',
    });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ==================== GET: Document collection status ====================
router.get('/documents/status/:phone', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(503).json({
        success: false,
        error: 'Supabase not configured',
      });
    }

    const { phone } = req.params;

    const { data, error } = await supabase
      .from('whatsapp_documents')
      .select('*')
      .eq('phone_number', phone)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to get documents: ${error.message}`);
    }

    // Calculate collection progress
    const documentTypes = {
      pan: data.find(d => d.document_type === 'PAN') || null,
      aadhar: data.find(d => d.document_type === 'AADHAR') || null,
      bank_statement: data.find(d => d.document_type === 'BANK_STATEMENT') || null,
    };

    const progress = {
      total: 3,
      collected: Object.values(documentTypes).filter(d => d && d.status === 'verified').length,
      pending: Object.values(documentTypes).filter(d => !d || d.status !== 'verified').length,
    };

    return res.json({
      success: true,
      data: {
        documents: documentTypes,
        progress,
      },
    });
  } catch (error) {
    logger.log('error', 'WHATSAPP_DOCUMENTS_ERROR', `Failed to get documents: ${error.message}`, {
      error: error.message,
      type: 'chatbot_error',
    });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ==================== POST: Log message ====================
router.post('/messages', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(503).json({
        success: false,
        error: 'Supabase not configured',
      });
    }

    const { phone, message, direction, type, metadata } = req.body;

    if (!phone || !message) {
      return res.status(400).json({
        success: false,
        error: 'phone and message are required',
      });
    }

    const { data, error } = await supabase
      .from('whatsapp_messages')
      .insert({
        phone_number: phone,
        message,
        direction: direction || 'inbound',
        type: type || 'text',
        metadata: metadata || {},
        created_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to log message: ${error.message}`);
    }

    logger.log('info', 'WHATSAPP_MESSAGE_LOGGED', `Message logged for ${phone}`, {
      phone: phone.slice(-4),
      direction,
      type: 'chatbot_message',
    });

    return res.status(201).json({
      success: true,
      data,
    });
  } catch (error) {
    logger.log('error', 'WHATSAPP_MESSAGE_ERROR', `Failed to log message: ${error.message}`, {
      error: error.message,
      type: 'chatbot_error',
    });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

export default router;
