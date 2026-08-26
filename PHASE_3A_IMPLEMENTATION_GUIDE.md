# Phase 3a: WhatsApp Bot Infrastructure Implementation Guide

**Timeline:** 1 week | **Complexity:** Medium | **Open-Source:** Conversational Flow Engine + ZapToBox API

---

## Overview

Phase 3a establishes the foundational WhatsApp bot infrastructure:
1. **Ananta Webhook Receiver** - Listens for incoming WhatsApp messages
2. **Conversation State Management** - Tracks user progress through application flow
3. **State Machine** - Routes users between conversation phases
4. **Message Sender** - Responds via Ananta WhatsApp API

After Phase 3a, the bot infrastructure is ready for Phase 3b (conversation flows).

---

## Architecture

```
User sends WhatsApp message
    ↓
Ananta webhook → POST /webhooks/ananta/message
    ↓
Load conversation_state from Supabase
    ↓
Get current phase from state_machine
    ↓
Validate input (length, format, etc.)
    ↓
Call phase handler (e.g., handle_product_selection)
    ↓
Update conversation_state table
    ↓
Generate response message
    ↓
Send via Ananta: POST /api/ananta/send-message
    ↓
User receives message on WhatsApp
```

---

## Setup: Dependencies & Environment

### 1. Install NPM Packages

```bash
cd automation-hub/ivr-router
npm install express @supabase/supabase-js @anthropic-ai/sdk redis bullmq dotenv cors
npm install --save-dev nodemon typescript @types/node
```

### 2. Directory Structure

```
ivr-router/
├── lib/
│   ├── state-machine/
│   │   ├── conversationFlowEngine.js     (Phase state machine)
│   │   ├── phases.js                      (Phase definitions)
│   │   └── handlers.js                    (Phase handlers)
│   ├── webhook/
│   │   └── anantaWebhookHandler.js        (Webhook receiver)
│   ├── clients/
│   │   ├── anantaClient.js                (Ananta API client)
│   │   └── supabaseClient.js              (Supabase client)
│   └── routes/
│       └── whatsappBotRoutes.js           (Express routes)
├── jobs/
│   └── nightly-analysis.js                (Phase 3.5d - later)
├── index.js                               (Main app)
├── .env.example
└── package.json
```

### 3. Environment Variables (.env)

```bash
# Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGc...

# Ananta (WhatsApp)
ANANTA_API_KEY=your_ananta_api_key
ANANTA_API_TOKEN=your_ananta_api_token
ANANTA_API_SECRET_KEY=your_ananta_secret
ANANTA_BASE_URL=https://api.ananta.com

# Redis (for state caching)
REDIS_URL=redis://localhost:6379

# Claude API (Phase 3.5a - later)
CLAUDE_API_KEY=sk-ant-...

# Server
PORT=3000
NODE_ENV=development
```

---

## Database Setup: Conversation State Table

### 1. Create conversation_state Table

```sql
-- In Supabase, run this SQL:

CREATE TABLE conversation_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- User identification
  phone_number VARCHAR(20) NOT NULL UNIQUE,
  user_name VARCHAR(255),
  application_id UUID REFERENCES crm.leads(id),
  
  -- Conversation flow
  current_phase VARCHAR(100) NOT NULL DEFAULT 'product_selection',
  -- Phases: product_selection → eligibility_check → lender_selection → form_personal → form_business → documents → kyc_verification → lender_submission → approval → completed
  
  -- Form data (JSONB for flexibility)
  form_data JSONB DEFAULT '{}'::jsonb,
  -- Example: {
  --   "product_type": "banking",
  --   "full_name": "Rajesh Kumar",
  --   "age": 35,
  --   "email": "rajesh@email.com",
  --   "business_type": "retail",
  --   "annual_income": 1800000,
  --   "loan_amount": 1200000,
  --   "tenure_months": 36
  -- }
  
  -- Document tracking
  document_status JSONB DEFAULT '{}'::jsonb,
  -- Example: {
  --   "brc": {"uploaded": true, "verified": false, "url": "s3://..."},
  --   "bank_statement": {"uploaded": false, "verified": false},
  --   "id_proof": {"uploaded": false, "verified": false}
  -- }
  
  -- Lender information
  eligible_lenders VARCHAR[] DEFAULT '{}',
  selected_lender VARCHAR,
  lender_assignment_id UUID,
  
  -- Timestamps
  started_at TIMESTAMP DEFAULT now(),
  last_active_at TIMESTAMP DEFAULT now(),
  completed_at TIMESTAMP,
  
  -- Metadata
  intent JSONB DEFAULT 'null'::jsonb, -- Phase 3.5a: Claude intent analysis
  rejection_logs JSONB DEFAULT '{}'::jsonb, -- Phase 3.5c: Track rejections
  
  -- Status
  status VARCHAR(50) DEFAULT 'active', -- active, completed, abandoned, failed
  error_message TEXT,
  
  CONSTRAINT valid_phase CHECK (current_phase IN (
    'product_selection', 'eligibility_check', 'lender_selection',
    'form_personal', 'form_business', 'documents',
    'kyc_verification', 'lender_submission', 'approval', 'completed'
  )),
  
  INDEX (phone_number),
  INDEX (current_phase),
  INDEX (status),
  INDEX (last_active_at)
);

-- Enable RLS (Row Level Security)
ALTER TABLE conversation_state ENABLE ROW LEVEL SECURITY;

-- Allow service role to read/write
CREATE POLICY "Allow service role" ON conversation_state
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
```

### 2. Create conversation_events Table (Audit Trail)

```sql
CREATE TABLE conversation_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number VARCHAR(20) NOT NULL REFERENCES conversation_state(phone_number),
  phase VARCHAR(100) NOT NULL,
  event_type VARCHAR(50), -- 'message_received', 'phase_change', 'validation_error', 'message_sent'
  user_input TEXT,
  bot_response TEXT,
  metadata JSONB DEFAULT 'null'::jsonb,
  created_at TIMESTAMP DEFAULT now(),
  
  INDEX (phone_number),
  INDEX (created_at)
);
```

---

## Code Implementation

### 1. Ananta Client (API Wrapper)

**File:** `lib/clients/anantaClient.js`

```javascript
const axios = require('axios');

class AnantaClient {
  constructor() {
    this.baseURL = process.env.ANANTA_BASE_URL;
    this.apiKey = process.env.ANANTA_API_KEY;
    this.apiToken = process.env.ANANTA_API_TOKEN;
    this.secretKey = process.env.ANANTA_API_SECRET_KEY;
    
    this.client = axios.create({
      baseURL: this.baseURL,
      headers: {
        'Api-Key': this.apiKey,
        'Api-Token': this.apiToken,
        'Content-Type': 'application/json'
      }
    });
  }
  
  /**
   * Send message via WhatsApp
   */
  async sendMessage(phone, messageType, content) {
    try {
      const payload = {
        phone: phone.replace(/[^0-9]/g, ''), // Ensure only digits
        message_type: messageType, // 'text', 'template', 'interactive', 'media'
        ...content
      };
      
      console.log(`[Ananta] Sending ${messageType} to ${phone}:`, payload);
      
      const response = await this.client.post('/messages/send', payload);
      
      console.log(`[Ananta] Message sent:`, response.data);
      return response.data;
    } catch (error) {
      console.error(`[Ananta] Error sending message:`, error.response?.data || error.message);
      throw error;
    }
  }
  
  /**
   * Send text message
   */
  async sendTextMessage(phone, text) {
    return this.sendMessage(phone, 'text', { text });
  }
  
  /**
   * Send interactive message (buttons)
   */
  async sendInteractiveMessage(phone, text, buttons) {
    return this.sendMessage(phone, 'interactive', {
      text,
      buttons: buttons.map((btn, idx) => ({
        id: `btn_${idx}`,
        title: btn.title
      }))
    });
  }
  
  /**
   * Send template message
   */
  async sendTemplateMessage(phone, templateName, params) {
    return this.sendMessage(phone, 'template', {
      template_name: templateName,
      parameters: params
    });
  }
  
  /**
   * Send media (document, image)
   */
  async sendMediaMessage(phone, mediaUrl, caption) {
    return this.sendMessage(phone, 'media', {
      media_url: mediaUrl,
      caption
    });
  }
  
  /**
   * Update user profile
   */
  async updateUserProfile(phone, profile) {
    try {
      const response = await this.client.put(`/customers/${phone}`, profile);
      return response.data;
    } catch (error) {
      console.error(`[Ananta] Error updating profile:`, error.response?.data);
      throw error;
    }
  }
  
  /**
   * Get user profile
   */
  async getUserProfile(phone) {
    try {
      const response = await this.client.get(`/customers/${phone}`);
      return response.data;
    } catch (error) {
      console.error(`[Ananta] Error fetching profile:`, error.response?.data);
      throw error;
    }
  }
}

module.exports = new AnantaClient();
```

### 2. Supabase Client

**File:** `lib/clients/supabaseClient.js`

```javascript
const { createClient } = require('@supabase/supabase-js');

class SupabaseClient {
  constructor() {
    this.supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
  }
  
  /**
   * Get or create conversation state
   */
  async getOrCreateConversationState(phone) {
    // Try to fetch existing state
    let { data, error } = await this.supabase
      .from('conversation_state')
      .select('*')
      .eq('phone_number', phone)
      .single();
    
    if (error && error.code === 'PGRST116') {
      // No record found, create new one
      const newState = {
        phone_number: phone,
        current_phase: 'product_selection',
        form_data: {},
        document_status: {},
        status: 'active'
      };
      
      const { data: created, error: createError } = await this.supabase
        .from('conversation_state')
        .insert([newState])
        .select()
        .single();
      
      if (createError) throw createError;
      return created;
    }
    
    if (error) throw error;
    return data;
  }
  
  /**
   * Update conversation state
   */
  async updateConversationState(phone, updates) {
    const { data, error } = await this.supabase
      .from('conversation_state')
      .update({
        ...updates,
        last_active_at: new Date()
      })
      .eq('phone_number', phone)
      .select()
      .single();
    
    if (error) throw error;
    return data;
  }
  
  /**
   * Move to next phase
   */
  async moveToPhase(phone, nextPhase, formDataUpdate = {}) {
    return this.updateConversationState(phone, {
      current_phase: nextPhase,
      form_data: { ...(await this.getConversationState(phone)).form_data, ...formDataUpdate }
    });
  }
  
  /**
   * Get current conversation state
   */
  async getConversationState(phone) {
    const { data, error } = await this.supabase
      .from('conversation_state')
      .select('*')
      .eq('phone_number', phone)
      .single();
    
    if (error) throw error;
    return data;
  }
  
  /**
   * Log conversation event
   */
  async logConversationEvent(phone, phase, eventType, userInput, botResponse, metadata = {}) {
    const { error } = await this.supabase
      .from('conversation_events')
      .insert([{
        phone_number: phone,
        phase,
        event_type: eventType,
        user_input: userInput,
        bot_response: botResponse,
        metadata
      }]);
    
    if (error) throw error;
  }
  
  /**
   * Get user's CRM lead record
   */
  async getLeadByPhone(phone) {
    const { data, error } = await this.supabase
      .from('crm.leads')
      .select('*')
      .eq('phone', phone)
      .single();
    
    if (error && error.code !== 'PGRST116') throw error;
    return data;
  }
  
  /**
   * Link conversation to CRM lead
   */
  async linkConversationToLead(phone, applicationId) {
    return this.updateConversationState(phone, {
      application_id: applicationId
    });
  }
}

module.exports = new SupabaseClient();
```

### 3. Phase Handlers

**File:** `lib/state-machine/handlers.js`

```javascript
const ananta = require('../clients/anantaClient');
const supabase = require('../clients/supabaseClient');

class PhaseHandlers {
  /**
   * PHASE 1: Product Selection
   * "Do you have a business bank account?"
   */
  static async handleProductSelection(state, userMessage) {
    const response = userMessage.trim().toLowerCase();
    
    if (response.includes('yes') || response.includes('1') || response.includes('banking')) {
      // User has bank account → Banking products (multiple lenders)
      await supabase.moveToPhase(state.phone_number, 'eligibility_check', {
        product_type: 'banking'
      });
      
      return {
        message: '✅ Great! Now let\'s check your eligibility.\n\nWhat\'s your business registration pincode? (e.g., 400001)',
        nextPhase: 'eligibility_check',
        messageType: 'text'
      };
    } else if (response.includes('no') || response.includes('2') || response.includes('non-banking')) {
      // No bank account → Non-banking products (Poonawala, Hero)
      await supabase.moveToPhase(state.phone_number, 'eligibility_check', {
        product_type: 'non_banking'
      });
      
      return {
        message: '✅ No problem! We have options for you too.\n\nWhat\'s your business registration pincode?',
        nextPhase: 'eligibility_check',
        messageType: 'text'
      };
    } else {
      // Invalid input
      return {
        message: '❌ Please reply:\n1️⃣ Yes, I have a bank account\n2️⃣ No, I don\'t have a bank account',
        nextPhase: 'product_selection',
        messageType: 'text',
        validation: { valid: false, reason: 'Invalid choice' }
      };
    }
  }
  
  /**
   * PHASE 2: Eligibility Check
   * Validate pincode, income, CIBIL score
   */
  static async handleEligibilityCheck(state, userMessage) {
    const pincode = userMessage.trim();
    
    // Validate pincode format
    if (!/^\d{6}$/.test(pincode)) {
      return {
        message: '❌ Invalid pincode. Please enter 6 digits (e.g., 400001)',
        nextPhase: 'eligibility_check',
        messageType: 'text',
        validation: { valid: false, reason: 'Invalid pincode format' }
      };
    }
    
    // TODO: Phase 2 integration - Check pincode serviceable
    // const isServiceable = await lenderRoutingClient.checkPincode(pincode);
    
    // For now, assume serviceable
    const isServiceable = true;
    
    if (!isServiceable) {
      return {
        message: `❌ Sorry, we don't serve pincode ${pincode} yet.\n\nTry another pincode or check back later.`,
        nextPhase: 'eligibility_check',
        messageType: 'text',
        validation: { valid: false, reason: 'Pincode not serviceable' }
      };
    }
    
    // Save pincode and move to income question
    await supabase.moveToPhase(state.phone_number, 'form_personal', {
      pincode: pincode
    });
    
    return {
      message: '✅ Pincode verified!\n\nWhat\'s your annual business income (in ₹)?\nExample: 1800000',
      nextPhase: 'form_personal',
      messageType: 'text'
    };
  }
  
  /**
   * PHASE 3: Lender Selection
   * Show eligible lenders with EMI comparison
   */
  static async handleLenderSelection(state, userMessage) {
    // TODO: Phase 2 integration - Get eligible lenders
    // const lenders = await lenderRoutingClient.checkEligibility({...state.form_data});
    
    // Mock data for now
    const eligibleLenders = [
      { name: 'Poonawala', minAmount: 100000, maxAmount: 2500000, rate: '12-18%', emi: 3200 },
      { name: 'Hero FinCorp', minAmount: 50000, maxAmount: 2000000, rate: '13-20%', emi: 3100 },
      { name: 'HDFC Jumbo', minAmount: 500000, maxAmount: 5000000, rate: '10-15%', emi: 3050 }
    ];
    
    // Parse user selection
    const choice = userMessage.trim().toUpperCase();
    const selectedLender = eligibleLenders.find(l => l.name.includes(choice) || choice === '1' || choice === '2' || choice === '3');
    
    if (!selectedLender) {
      const buttons = eligibleLenders.map((l, idx) => ({
        title: `${idx + 1}. ${l.name} @ ${l.rate} (EMI: ₹${l.emi})`
      }));
      
      return {
        message: '💰 Which lender would you prefer?',
        buttons,
        nextPhase: 'lender_selection',
        messageType: 'interactive',
        validation: { valid: false, reason: 'Invalid lender selection' }
      };
    }
    
    // Save selection and move to personal details
    await supabase.moveToPhase(state.phone_number, 'form_personal', {
      selected_lender: selectedLender.name,
      eligible_lenders: eligibleLenders.map(l => l.name)
    });
    
    return {
      message: `✅ Great choice! ${selectedLender.name} it is.\n\nNow let's complete your application.\n\n📝 What's your full name?`,
      nextPhase: 'form_personal',
      messageType: 'text'
    };
  }
  
  /**
   * PHASE 4: Personal Details
   */
  static async handlePersonalDetails(state, userMessage) {
    // TODO: Implement multi-step form (name → age → email → phone)
    // For now, simple single-step
    
    const name = userMessage.trim();
    
    // Validate name (min 3 chars, no numbers)
    if (name.length < 3 || /\d/.test(name)) {
      return {
        message: '❌ Please enter a valid name (minimum 3 characters, no numbers)',
        nextPhase: 'form_personal',
        messageType: 'text',
        validation: { valid: false, reason: 'Invalid name format' }
      };
    }
    
    await supabase.moveToPhase(state.phone_number, 'form_business', {
      full_name: name
    });
    
    return {
      message: `✅ Nice to meet you, ${name}!\n\n📊 What's your business type?\n1️⃣ Retail\n2️⃣ Manufacturing\n3️⃣ Services\n4️⃣ Import/Export\n5️⃣ Other`,
      nextPhase: 'form_business',
      messageType: 'text'
    };
  }
  
  /**
   * PHASE 5: Business Details
   */
  static async handleBusinessDetails(state, userMessage) {
    // TODO: Implement business form (type → tenure → income → amount → tenure)
    return {
      message: 'Business details form (coming in Phase 3b)',
      nextPhase: 'documents',
      messageType: 'text'
    };
  }
  
  /**
   * PHASE 6: Document Collection
   */
  static async handleDocuments(state, userMessage) {
    // TODO: Document upload handler
    return {
      message: 'Document upload handler (coming in Phase 3c)',
      nextPhase: 'kyc_verification',
      messageType: 'text'
    };
  }
  
  /**
   * PHASE 7: KYC Verification (Background Processing)
   */
  static async handleKYCVerification(state, userMessage) {
    // TODO: Background job for OCR, business verification, CIBIL fetch
    return {
      message: 'KYC verification (background processing)',
      nextPhase: 'lender_submission',
      messageType: 'text'
    };
  }
  
  /**
   * PHASE 8: Lender Submission & Status Tracking
   */
  static async handleLenderSubmission(state, userMessage) {
    // TODO: Submit to Phase 2 lender routing
    return {
      message: 'Lender submission (Phase 2 integration)',
      nextPhase: 'approval',
      messageType: 'text'
    };
  }
}

module.exports = PhaseHandlers;
```

### 4. Webhook Handler (Main Logic)

**File:** `lib/webhook/anantaWebhookHandler.js`

```javascript
const ananta = require('../clients/anantaClient');
const supabase = require('../clients/supabaseClient');
const PhaseHandlers = require('../state-machine/handlers');

class AnantaWebhookHandler {
  /**
   * Main webhook handler
   * Called when user sends WhatsApp message
   */
  static async handleMessage(req, res) {
    try {
      const { phone, message_text: userMessage, message_type } = req.body;
      
      console.log(`[Webhook] Message from ${phone}: ${userMessage}`);
      
      // Validate input
      if (!phone || !userMessage) {
        return res.status(400).json({ error: 'Missing phone or message_text' });
      }
      
      // Get or create conversation state
      const state = await supabase.getOrCreateConversationState(phone);
      console.log(`[State] Current phase: ${state.current_phase}`);
      
      // Get handler for current phase
      const phaseHandler = PhaseHandlers[`handle${this.capitalizePhase(state.current_phase)}`];
      if (!phaseHandler) {
        throw new Error(`No handler for phase: ${state.current_phase}`);
      }
      
      // Call phase handler
      const result = await phaseHandler(state, userMessage);
      
      // Log event
      await supabase.logConversationEvent(
        phone,
        state.current_phase,
        'message_received',
        userMessage,
        result.message,
        { validation: result.validation }
      );
      
      // Send response via Ananta
      await this.sendResponse(phone, result);
      
      // Check for abandonment (optional: if inactive for 2 hours)
      await this.checkAbandonment(phone, state);
      
      res.json({ success: true, phase: result.nextPhase });
    } catch (error) {
      console.error('[Webhook] Error:', error);
      
      // Send error message to user
      const phone = req.body.phone;
      await ananta.sendTextMessage(
        phone,
        '❌ Sorry, something went wrong. Please try again or reply HELP.'
      );
      
      res.status(500).json({ error: error.message });
    }
  }
  
  /**
   * Send response via Ananta
   */
  static async sendResponse(phone, result) {
    const { message, messageType, buttons } = result;
    
    if (messageType === 'interactive' && buttons) {
      await ananta.sendInteractiveMessage(phone, message, buttons);
    } else if (messageType === 'text') {
      await ananta.sendTextMessage(phone, message);
    } else {
      await ananta.sendTextMessage(phone, message);
    }
    
    // Log sent event
    await supabase.logConversationEvent(
      phone,
      result.nextPhase,
      'message_sent',
      null,
      message,
      { messageType }
    );
  }
  
  /**
   * Check for user abandonment (2-hour inactivity)
   */
  static async checkAbandonment(phone, state) {
    const now = new Date();
    const lastActive = new Date(state.last_active_at);
    const inactiveMinutes = (now - lastActive) / (1000 * 60);
    
    if (inactiveMinutes > 120 && state.status === 'active') {
      // Send re-engagement prompt
      const completionPercent = this.estimateCompletion(state.current_phase);
      
      await ananta.sendTextMessage(
        phone,
        `👋 Still interested?\n\nYou're ${completionPercent}% through your application. Takes just 2 minutes to finish!\n\nReply YES to continue.`
      );
    }
  }
  
  /**
   * Estimate completion percentage based on phase
   */
  static estimateCompletion(phase) {
    const phases = {
      'product_selection': 10,
      'eligibility_check': 20,
      'lender_selection': 30,
      'form_personal': 50,
      'form_business': 60,
      'documents': 80,
      'kyc_verification': 85,
      'lender_submission': 90,
      'approval': 100
    };
    return phases[phase] || 10;
  }
  
  /**
   * Capitalize phase name for handler lookup
   */
  static capitalizePhase(phase) {
    return phase
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join('');
  }
}

module.exports = AnantaWebhookHandler;
```

### 5. Express Routes

**File:** `lib/routes/whatsappBotRoutes.js`

```javascript
const express = require('express');
const router = express.Router();
const AnantaWebhookHandler = require('../webhook/anantaWebhookHandler');

/**
 * Webhook: Receive message from Ananta
 */
router.post('/webhooks/ananta/message', async (req, res) => {
  await AnantaWebhookHandler.handleMessage(req, res);
});

/**
 * Health check
 */
router.get('/health/bot', (req, res) => {
  res.json({ status: 'ok', service: 'whatsapp-bot' });
});

/**
 * Get conversation state (for testing/debugging)
 */
router.get('/debug/state/:phone', async (req, res) => {
  try {
    const supabase = require('../clients/supabaseClient');
    const state = await supabase.getConversationState(req.params.phone);
    res.json(state);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get conversation events (audit trail)
 */
router.get('/debug/events/:phone', async (req, res) => {
  try {
    const supabase = require('../clients/supabaseClient');
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

module.exports = router;
```

### 6. Main App (index.js)

**File:** `index.js`

```javascript
require('dotenv').config();
const express = require('express');
const cors = require('cors');

const whatsappBotRoutes = require('./lib/routes/whatsappBotRoutes');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'ivr-router' });
});

// Routes
app.use('/api', whatsappBotRoutes);
app.use('/api/crm', require('./lib/routes/crmIntegrationRoutes')); // Phase 1
app.use('/api/routing', require('./lib/routes/lenderRoutingRoutes')); // Phase 2

// Error handling
app.use((err, req, res, next) => {
  console.error('[Error]', err);
  res.status(500).json({ error: err.message });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ IVR Router running on port ${PORT}`);
});
```

---

## Testing Phase 3a

### 1. Unit Tests

**File:** `test/phase3a.test.js`

```javascript
const AnantaWebhookHandler = require('../lib/webhook/anantaWebhookHandler');
const supabase = require('../lib/clients/supabaseClient');

describe('Phase 3a: WhatsApp Bot Infrastructure', () => {
  
  test('Creates new conversation state on first message', async () => {
    const phone = '+919999999999';
    const req = { body: { phone, message_text: 'Hi' } };
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
    
    await AnantaWebhookHandler.handleMessage(req, res);
    
    const state = await supabase.getConversationState(phone);
    expect(state.current_phase).toBe('product_selection');
    expect(state.status).toBe('active');
  });
  
  test('Handles product selection (banking)', async () => {
    const phone = '+919999999999';
    const handlers = require('../lib/state-machine/handlers');
    const state = { phone_number: phone, current_phase: 'product_selection' };
    
    const result = await handlers.handleProductSelection(state, 'Yes');
    
    expect(result.nextPhase).toBe('eligibility_check');
    expect(result.message).toContain('pincode');
  });
  
  test('Rejects invalid pincode', async () => {
    const handlers = require('../lib/state-machine/handlers');
    const state = { phone_number: '+919999999999', current_phase: 'eligibility_check' };
    
    const result = await handlers.handleEligibilityCheck(state, 'abc');
    
    expect(result.validation.valid).toBe(false);
    expect(result.nextPhase).toBe('eligibility_check');
  });
  
  test('Accepts valid pincode', async () => {
    const handlers = require('../lib/state-machine/handlers');
    const state = { phone_number: '+919999999999', current_phase: 'eligibility_check' };
    
    const result = await handlers.handleEligibilityCheck(state, '400001');
    
    expect(result.nextPhase).toBe('form_personal');
  });
});
```

### 2. Manual Testing Checklist

- [ ] **Webhook Receiver**
  - [ ] POST /webhooks/ananta/message with valid payload → Returns 200 + { success: true }
  - [ ] POST /webhooks/ananta/message with missing phone → Returns 400
  - [ ] POST /webhooks/ananta/message creates conversation_state record

- [ ] **State Machine**
  - [ ] User message → Current phase handler called
  - [ ] Handler returns { message, nextPhase, messageType }
  - [ ] State updated: current_phase = nextPhase
  - [ ] Event logged to conversation_events table

- [ ] **Message Flow (Product Selection)**
  - [ ] User sends "Hi" → Bot asks: "Do you have business bank account?"
  - [ ] User sends "Yes" → Bot asks: "What's your pincode?"
  - [ ] User sends "400001" → Bot asks: "What's your annual income?"

- [ ] **Error Handling**
  - [ ] Invalid input → Bot rejects with clear message
  - [ ] Network error → Bot sends: "❌ Something went wrong..."
  - [ ] Database error → Supabase connection logged

- [ ] **State Persistence**
  - [ ] Close WhatsApp, reopen → Conversation continues from last phase
  - [ ] Same phone, new browser → Loads same conversation_state

### 3. Integration Test with Real Ananta

```bash
# 1. Set up .env with real Ananta credentials
ANANTA_API_KEY=your_real_key
ANANTA_API_TOKEN=your_real_token
ANANTA_BASE_URL=https://api.ananta.com

# 2. Start server
npm start

# 3. Send test message via cURL (simulate webhook)
curl -X POST http://localhost:3000/api/webhooks/ananta/message \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "+919999999999",
    "message_text": "Hi",
    "message_type": "text"
  }'

# 4. Check response
# Expected: { "success": true, "phase": "product_selection" }

# 5. Verify in Ananta dashboard
# User should receive WhatsApp message: "Do you have business bank account?"
```

---

## Deployment Checklist

### Pre-Deployment
- [ ] All environment variables set in `.env`
- [ ] Supabase tables created (conversation_state + conversation_events)
- [ ] Ananta API credentials tested
- [ ] Redis connection configured
- [ ] Unit tests passing: `npm test`
- [ ] Manual testing completed

### Deployment Steps

**1. Deploy to Staging**
```bash
git checkout -b deploy/phase3a
git add PHASE_3A_IMPLEMENTATION_GUIDE.md
git commit -m "Deploy Phase 3a: WhatsApp bot infrastructure"
git push origin deploy/phase3a

# Create PR for review
# Once approved, merge to main
```

**2. Deploy to Production**
```bash
# Pull latest
git pull origin main

# Install dependencies
npm install

# Start server (via PM2)
pm2 start index.js --name "ivr-router"
pm2 logs ivr-router

# Verify health check
curl http://localhost:3000/health
# Expected: { "status": "ok", "service": "ivr-router" }

# Monitor logs
tail -f /var/log/ivr-router.log
```

**3. Ananta Webhook Configuration**
- Go to Ananta dashboard
- Set webhook URL: `https://your-domain.com/api/webhooks/ananta/message`
- Select events: `message.received`
- Test webhook

### Post-Deployment Monitoring
- [ ] Webhook receiving messages ✅
- [ ] conversation_state table populating ✅
- [ ] conversation_events audit trail logging ✅
- [ ] Ananta messages sending successfully ✅
- [ ] No errors in logs ✅

---

## Troubleshooting

### Issue: Webhook Not Receiving Messages
**Solution:**
1. Check Ananta webhook URL is correct
2. Verify firewall allows inbound traffic on port 3000
3. Check logs: `pm2 logs ivr-router`
4. Test webhook: `curl http://localhost:3000/api/health`

### Issue: Supabase Connection Error
**Solution:**
1. Verify SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env
2. Check Supabase project is active
3. Test connection: `curl http://localhost:3000/api/debug/state/test`

### Issue: Messages Not Sending Back to WhatsApp
**Solution:**
1. Check ANANTA_API_KEY and credentials
2. Verify phone number format (+91...)
3. Check Ananta account has sufficient balance
4. Review Ananta API response in logs

### Issue: State Not Updating
**Solution:**
1. Check conversation_state table has INSERT permissions
2. Verify phone_number format is consistent
3. Check for UNIQUE constraint violations
4. Review Supabase RLS policies

---

## Next Steps: Phase 3b

Once Phase 3a is complete and tested:

1. Extend PhaseHandlers with multi-step forms
   - Personal details: name → age → email → phone
   - Business details: type → tenure → income → amount → tenure

2. Add validation logic for each field
   - Name: min 3 chars, no numbers
   - Age: 18-75, numeric
   - Email: valid email format
   - Income: numeric, ≥ minimum per lender
   - Loan amount: within lender range, affordability check

3. Integrate Phase 2 lenderRoutingClient
   - checkEligibility() → Get eligible lenders
   - Get EMI calculations for each lender

4. Add error handling & re-engagement triggers
   - Validation errors → Retry with tips
   - 2-hour inactivity → Resume prompt
   - Lender rejection → Fallback chain

---

**Phase 3a Status:** Ready for Implementation | **Estimated Time:** 3-5 days with open-source infrastructure

