import express from 'express';
import AnantaWebhookHandler from '../webhook/anantaWebhookHandler.js';
import supabase from '../clients/supabaseClient.js';

const router = express.Router();

router.post('/webhooks/ananta/message', async (req, res) => {
  await AnantaWebhookHandler.handleMessage(req, res);
});

router.get('/health/bot', (req, res) => {
  res.json({ status: 'ok', service: 'whatsapp-bot' });
});

router.get('/debug/state/:phone', async (req, res) => {
  try {
    const state = await supabase.getConversationState(req.params.phone);
    res.json(state);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/debug/events/:phone', async (req, res) => {
  try {
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
