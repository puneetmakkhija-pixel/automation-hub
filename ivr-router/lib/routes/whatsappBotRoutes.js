import express from 'express';
import AnantaWebhookHandler from '../webhook/anantaWebhookHandler.js';
import SupabaseClient from '../supabaseClient.js';

const router = express.Router();
let supabase = null;

try {
  supabase = new SupabaseClient();
} catch (error) {
  console.warn('⚠️ Supabase client initialization failed:', error.message);
  console.warn('   WhatsApp bot features will be unavailable until configuration is complete');
}

router.post('/webhooks/ananta/message', async (req, res) => {
  await AnantaWebhookHandler.handleMessage(req, res);
});

router.get('/health/bot', (req, res) => {
  res.json({ status: 'ok', service: 'whatsapp-bot' });
});

router.get('/debug/state/:phone', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(503).json({
        success: false,
        error: 'Supabase client not initialized - database configuration required',
      });
    }
    const state = await supabase.getConversationState(req.params.phone);
    res.json(state);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/debug/events/:phone', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(503).json({
        success: false,
        error: 'Supabase client not initialized - database configuration required',
      });
    }
    const { data, error } = await supabase.supabase
      .from('conversation_events')
      .select('*')
      .eq('phone_number', req.params.phone)
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
