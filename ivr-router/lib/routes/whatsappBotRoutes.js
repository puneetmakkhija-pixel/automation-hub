import express from 'express';
import AnantaWebhookHandler from '../webhook/anantaWebhookHandler.js';
import { verifyWebhookSecret } from '../middleware/verifyWebhookSecret.js';

// There are two Supabase clients in this repo and they are NOT interchangeable:
//
//   ../clients/supabaseClient.js  a ready-made singleton exposing `.supabase`,
//                                 owning the conversation_state /
//                                 conversation_events methods. This one.
//   ../supabaseClient.js          a class exposing `.client`, owning the
//                                 customer / campaign methods. No conversation
//                                 methods at all.
//
// This file used to construct the second and then call the first's API, so both
// debug routes below threw on every request. The singleton is what
// anantaWebhookHandler and whatsappBotJourney use, which is what these routes
// are meant to be inspecting.
//
// It is null when SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are unset — it logs
// that once itself — so the guards below stay.
import supabase from '../clients/supabaseClient.js';

const router = express.Router();

// Inbound customer messages — this drives the conversation journey and writes
// conversation_state / conversation_events, so it is the endpoint that most
// needs authenticating. Gated on ANANTA_WEBHOOK_SECRET; unauthenticated while
// that variable is unset (see lib/middleware/verifyWebhookSecret.js).
router.post(
  '/webhooks/ananta/message',
  verifyWebhookSecret('ANANTA_WEBHOOK_SECRET', 'ANANTA_MESSAGE'),
  async (req, res) => {
    await AnantaWebhookHandler.handleMessage(req, res);
  }
);

router.get('/health/bot', (req, res) => {
  res.json({ status: 'ok', service: 'whatsapp-bot' });
});

// The two debug routes below return a customer's conversation contents for any
// phone number given. They were unauthenticated, and until PR #21 they threw on
// every request, so nothing had ever been served from them — worth closing
// before they start working.
//
// failClosed: unlike the webhooks, an unset secret must NOT leave these open.
// They accept ?token=<secret> as well as the header, so a browser can reach
// them; that puts the secret in access logs and history, which is the accepted
// cost of a debug route being usable from a URL bar.
const requireSecret = verifyWebhookSecret('ANANTA_WEBHOOK_SECRET', 'BOT_DEBUG', {
  failClosed: true,
});

router.get('/debug/state/:phone', requireSecret, async (req, res) => {
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

router.get('/debug/events/:phone', requireSecret, async (req, res) => {
  try {
    if (!supabase) {
      return res.status(503).json({
        success: false,
        error: 'Supabase client not initialized - database configuration required',
      });
    }
    // created_at defaults to NOW(), which is transaction-start time, so several
    // events written in one transaction share a timestamp and their order is
    // undefined. id breaks the tie in insertion order.
    const { data, error } = await supabase.supabase
      .from('conversation_events')
      .select('*')
      .eq('phone_number', req.params.phone)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(20);

    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
