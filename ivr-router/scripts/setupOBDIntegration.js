#!/usr/bin/env node

/**
 * OBD API Complete Setup Script
 * Configures all OBD IVR capabilities:
 * - Call Routing & Call Connect
 * - DTMF Interactive Menus
 * - Voice Webhooks
 * - SMS/WhatsApp Webhooks
 * - Agent Groups
 * - Voice Prompts
 * - Contact Lists
 */

import OBDApiClient from '../lib/obdApiClient.js';
import dotenv from 'dotenv';

dotenv.config();

const obdClient = new OBDApiClient(
  process.env.OBD_BASE_URL || 'https://obdapi2.ivrsms.com',
  process.env.OBD_USERNAME,
  process.env.OBD_PASSWORD
);

const WEBHOOK_BASE_URL = process.env.OBD_WEBHOOK_URL || 'https://your-domain.com';
const SMS_WEBHOOK_BASE_URL = process.env.OBD_SMS_WEBHOOK_URL || 'https://your-domain.com';

// ==================== Configuration Objects ====================

const VOICE_WEBHOOKS = {
  campaignHangup: {
    name: 'Campaign Hangup Handler',
    url: `${WEBHOOK_BASE_URL}/webhooks/obd/hangup`,
    event: 'HANGUP',
    description: 'Triggered when a call ends/hangs up',
  },
  campaignCompletion: {
    name: 'Campaign Completion Handler',
    url: `${WEBHOOK_BASE_URL}/webhooks/obd/completion`,
    event: 'HANGUP',
    description: 'Triggered when campaign completes',
  },
  callConnectEvent: {
    name: 'Call Connect Event Handler',
    url: `${WEBHOOK_BASE_URL}/webhooks/obd/connect`,
    event: 'CALL_CONNECT',
    description: 'Triggered when call connects to agent',
  },
};

const SMS_WEBHOOKS = {
  whatsappNotification: {
    name: 'WhatsApp Campaign Notification',
    url: `${SMS_WEBHOOK_BASE_URL}/webhooks/sms/whatsapp`,
    requestType: 'WHATSAPP',
    smsText: 'Thank you for participating in our campaign',
    payload: JSON.stringify({
      user: 'your_user',
      pass: 'your_pass',
      whatsapptosend: [{
        from: '919XXXXXXXXX',
        to: '91{PHONE}',
        templateid: 'campaign_complete',
        smsgid: 'campaign_thank_you',
      }],
    }),
    description: 'Send WhatsApp notifications on campaign completion',
  },
  smsConfirmation: {
    name: 'SMS Confirmation Handler',
    url: `${SMS_WEBHOOK_BASE_URL}/webhooks/sms/confirmation`,
    requestType: 'GET',
    smsText: 'Your response has been recorded',
    payload: JSON.stringify({
      url: `${SMS_WEBHOOK_BASE_URL}/api/sms/confirm`,
      requestType: 'POST',
    }),
    description: 'Send SMS confirmations for DTMF selections',
  },
};

const AGENT_GROUPS = [
  {
    name: 'Sales Team',
    agents: [
      {
        agentNumber: '9185718XXXXX',
        agentName: 'Raj Kumar',
        agentType: 1, // Call Center Agent
      },
      {
        agentNumber: '9876543XXXXX',
        agentName: 'Priya Singh',
        agentType: 1,
      },
    ],
    description: 'Sales and lead generation team',
  },
  {
    name: 'Support Team',
    agents: [
      {
        agentNumber: '9988776655',
        agentName: 'Amit Patel',
        agentType: 1,
      },
      {
        agentNumber: '9876543210',
        agentName: 'Neha Gupta',
        agentType: 1,
      },
    ],
    description: 'Customer support and issue resolution',
  },
  {
    name: 'Billing Support',
    agents: [
      {
        agentNumber: '9123456789',
        agentName: 'Vikram Singh',
        agentType: 1,
      },
    ],
    description: 'Billing and payment support',
  },
];

// ==================== Setup Functions ====================

async function setupVoiceWebhooks() {
  console.log('\n========== Setting Up Voice Webhooks ==========');
  try {
    const existingWebhooks = await obdClient.getWebhooks();
    console.log(`Found ${existingWebhooks.length} existing webhooks`);

    for (const [key, webhook] of Object.entries(VOICE_WEBHOOKS)) {
      try {
        const result = await obdClient.addWebhook(
          webhook.name,
          webhook.url,
          webhook.event
        );
        console.log(`✓ Created webhook: ${webhook.name}`);
        console.log(`  Event: ${webhook.event}`);
        console.log(`  URL: ${webhook.url}`);
        console.log(`  Description: ${webhook.description}\n`);
      } catch (error) {
        console.log(`⚠ Webhook creation warning for ${webhook.name}: ${error.message}`);
      }
    }
  } catch (error) {
    console.error('✗ Error setting up voice webhooks:', error.message);
  }
}

async function setupSmsWebhooks() {
  console.log('\n========== Setting Up SMS/WhatsApp Webhooks ==========');
  try {
    const existingSmsWebhooks = await obdClient.getSmsWebhooks();
    console.log(`Found ${existingSmsWebhooks.length} existing SMS webhooks`);

    for (const [key, webhook] of Object.entries(SMS_WEBHOOKS)) {
      try {
        const result = await obdClient.addSmsWebhook(
          webhook.name,
          webhook.url,
          webhook.requestType,
          webhook.smsText,
          webhook.payload
        );
        console.log(`✓ Created SMS webhook: ${webhook.name}`);
        console.log(`  Type: ${webhook.requestType}`);
        console.log(`  URL: ${webhook.url}`);
        console.log(`  Description: ${webhook.description}\n`);
      } catch (error) {
        console.log(`⚠ SMS webhook creation warning for ${webhook.name}: ${error.message}`);
      }
    }
  } catch (error) {
    console.error('✗ Error setting up SMS webhooks:', error.message);
  }
}

async function setupAgentGroups() {
  console.log('\n========== Setting Up Agent Groups ==========');
  try {
    const existingGroups = await obdClient.getAgentGroups();
    console.log(`Found ${existingGroups.length} existing agent groups\n`);

    for (const group of AGENT_GROUPS) {
      try {
        const result = await obdClient.addAgentGroup(group.name, group.agents);
        console.log(`✓ Created agent group: ${group.name}`);
        console.log(`  Description: ${group.description}`);
        console.log(`  Agents: ${group.agents.length}`);
        group.agents.forEach(agent => {
          console.log(`    - ${agent.agentName} (${agent.agentNumber})`);
        });
        console.log();
      } catch (error) {
        console.log(`⚠ Agent group creation warning for ${group.name}: ${error.message}`);
      }
    }
  } catch (error) {
    console.error('✗ Error setting up agent groups:', error.message);
  }
}

async function displayDtmfConfiguration() {
  console.log('\n========== DTMF Configuration Reference ==========');
  console.log(`
DTMF Interactive Menu Setup:

1. MAIN MENU (welcomePromptId: 954)
   "Welcome to our service. Press 1 for Sales, 2 for Support, 3 for Billing"

   Menu Configuration:
   - menuPromptId: 955
   - menuWaitTime: 5 seconds
   - rePrompt: 2 (repeat menu twice if no input)
   - noInputPromptId: 957 ("Sorry, we didn't hear you")
   - wrongInputPromptId: 958 ("That's not a valid option")

2. ROUTING LOGIC
   Press 1 → Route to Sales Team (Agent Group 4)
   Press 2 → Route to Support Team (Agent Group 5)
   Press 3 → Route to Billing Support (Agent Group 6)

3. DTMF FLOW
   - Call initiates with welcomePromptId
   - Wait for DTMF input (5 seconds)
   - Play menuPromptId for menu options
   - Process DTMF input (1, 2, or 3)
   - Route to appropriate agent group OR repeat menu

4. API ENDPOINT
   POST /api/obd/campaigns/dtmf

   Body:
   {
     "campaignName": "Interactive Menu Campaign",
     "baseId": "152499",
     "welcomePromptId": "954",
     "menuPromptId": "955",
     "noInputPromptId": "957",
     "wrongInputPromptId": "958",
     "thanksPromptId": "956",
     "dtmf": "1|2|3",
     "menuWaitTime": 5,
     "rePrompt": 2,
     "scheduleTime": "2024-08-25 10:00:00",
     "smsDtmfApi": "{...}"
   }
`);
}

async function displayCallConnectConfiguration() {
  console.log('\n========== Call Connect (Call Patch) Configuration ==========');
  console.log(`
Call Routing Setup:

1. AGENT GROUPS
   The following agent groups are available for routing:
`);

  try {
    const groups = await obdClient.getAgentGroups();
    groups.forEach(group => {
      console.log(`   Group ID: ${group.groupId} - ${group.groupName}`);
      if (group.agents) {
        group.agents.forEach(agent => {
          console.log(`     • ${agent.agentName}: ${agent.agentNumber}`);
        });
      }
    });
  } catch (error) {
    console.log(`   (Use manual group configuration above)`);
  }

  console.log(`
2. CALL CONNECT FLOW
   a) Inbound call triggers IVR
   b) Play welcome message
   c) Play menu options
   d) Collect DTMF input
   e) Route to agent group based on DTMF:
      - DTMF "1" → Sales Team
      - DTMF "2" → Support Team
      - DTMF "3" → Billing Support
   f) Agent connects to caller
   g) Webhook triggers on call completion

3. API ENDPOINT
   POST /api/obd/campaigns/call-patch

   Body:
   {
     "campaignName": "Agent Routing Campaign",
     "baseId": "152499",
     "welcomePromptId": "954",
     "menuPromptId": "955",
     "noInputPromptId": "957",
     "wrongInputPromptId": "958",
     "thanksPromptId": "956",
     "menuWaitTime": 5,
     "rePrompt": 2,
     "agentGroups": [
       {
         "groupId": "4",
         "agentDtmf": "1",
         "groupName": "Sales Team"
       },
       {
         "groupId": "5",
         "agentDtmf": "2",
         "groupName": "Support Team"
       },
       {
         "groupId": "6",
         "agentDtmf": "3",
         "groupName": "Billing Support"
       }
     ],
     "scheduleTime": "2024-08-25 10:00:00",
     "callPatchSuccessMessage": "{...}"
   }

4. WEBHOOK EVENTS
   - CALL_CONNECT: Agent successfully connected
   - HANGUP: Call ended
   - NO_ANSWER: Call not answered
`);
}

async function displayWebhookConfiguration() {
  console.log('\n========== Webhook Event Handlers ==========');
  console.log(`
VOICE WEBHOOKS:
${JSON.stringify(Object.values(VOICE_WEBHOOKS), null, 2)}

SMS/WHATSAPP WEBHOOKS:
${JSON.stringify(Object.values(SMS_WEBHOOKS), null, 2)}

WEBHOOK PAYLOAD EXAMPLES:

1. HANGUP Event:
{
  "campaignId": "12345",
  "campaignName": "Sales Campaign",
  "phoneNumber": "919876543210",
  "callDuration": 45,
  "dialStatus": "ANSWER",
  "callResult": "HANGUP"
}

2. CALL_CONNECT Event:
{
  "campaignId": "12345",
  "agentNumber": "9185718XXXXX",
  "agentName": "Raj Kumar",
  "phoneNumber": "919876543210",
  "callDuration": 120,
  "status": "CONNECTED"
}

3. SMS Delivery Event:
{
  "phoneNumber": "919876543210",
  "messageId": "msg_123456",
  "status": "DELIVERED",
  "timestamp": "2024-08-25T10:30:00Z"
}
`);
}

async function displayQuickStartGuide() {
  console.log('\n========== Quick Start Guide ==========');
  console.log(`
STEP 1: Upload Contact List
POST /api/obd/bases/upload
- Form data with CSV/Excel file of phone numbers

STEP 2: Upload Voice Prompts
POST /api/obd/voices/upload
- Upload welcome, menu, thanks, no-input, wrong-input prompts
- Note the returned promptIds

STEP 3: Create Campaign (Choose Type)

A. Simple IVR (Announcements):
POST /api/obd/campaigns/simple-ivr
{
  "campaignName": "Product Announcement",
  "baseId": "152499",
  "welcomePromptId": "954",
  "thanksPromptId": "956",
  "scheduleTime": "2024-08-25 10:00:00"
}

B. DTMF (Interactive Menu):
POST /api/obd/campaigns/dtmf
{
  "campaignName": "Support Menu",
  "baseId": "152499",
  "welcomePromptId": "954",
  "menuPromptId": "955",
  "dtmf": "1|2|3",
  "menuWaitTime": 5,
  "rePrompt": 2,
  "scheduleTime": "2024-08-25 10:00:00"
}

C. Call Patch (Agent Routing):
POST /api/obd/campaigns/call-patch
{
  "campaignName": "Agent Routing",
  "baseId": "152499",
  "menuPromptId": "955",
  "menuWaitTime": 5,
  "agentGroups": [
    {"groupId": "4", "agentDtmf": "1", "groupName": "Sales"}
  ],
  "scheduleTime": "2024-08-25 10:00:00"
}

STEP 4: Monitor Campaign
GET /api/obd/campaigns/analyze
{
  "startDate": "2024-08-01",
  "endDate": "2024-08-25",
  "campaignName": "All"
}

STEP 5: Handle Webhooks
Listen on:
- /webhooks/obd (voice events)
- /webhooks/sms (SMS/WhatsApp events)
`);
}

// ==================== Main Execution ====================

async function runSetup() {
  try {
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║   OBD IVR API - Complete Integration Setup                  ║');
    console.log('║   Configuring: Call Routing, DTMF, Webhooks, Agents         ║');
    console.log('╚════════════════════════════════════════════════════════════╝');

    // Authenticate
    console.log('\n[Step 1/5] Authenticating with OBD API...');
    await obdClient.login();
    console.log('✓ Authentication successful\n');

    // Setup agent groups
    console.log('[Step 2/5] Setting up agent groups for call routing...');
    await setupAgentGroups();

    // Setup voice webhooks
    console.log('[Step 3/5] Configuring voice event webhooks...');
    await setupVoiceWebhooks();

    // Setup SMS webhooks
    console.log('[Step 4/5] Configuring SMS/WhatsApp webhooks...');
    await setupSmsWebhooks();

    // Display configuration guides
    console.log('[Step 5/5] Displaying configuration references...');
    await displayDtmfConfiguration();
    await displayCallConnectConfiguration();
    await displayWebhookConfiguration();
    await displayQuickStartGuide();

    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║   ✓ Setup Complete                                         ║');
    console.log('║   Your OBD IVR integration is ready!                        ║');
    console.log('║   Next: Upload voice files and contact lists               ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');

  } catch (error) {
    console.error('\n✗ Setup failed:', error.message);
    process.exit(1);
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runSetup();
}

export {
  setupVoiceWebhooks,
  setupSmsWebhooks,
  setupAgentGroups,
  displayDtmfConfiguration,
  displayCallConnectConfiguration,
  displayWebhookConfiguration,
  displayQuickStartGuide,
};
