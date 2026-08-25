# OBD Campaign Automation Guide

Complete reference for automating all aspects of OBD IVR campaigns from end-to-end.

## What Can Be Automated?

### ✅ Fully Automatable
- [x] Contact list uploads (CSV/Excel)
- [x] Voice prompt uploads (WAV/MP3 files)
- [x] Agent group creation & configuration
- [x] Webhook setup (voice & SMS)
- [x] Campaign creation (all types)
- [x] Campaign scheduling
- [x] Campaign monitoring
- [x] Real-time event handling
- [x] Reports generation

### ✅ Semi-Automatable (With Input)
- [x] Multi-campaign orchestration
- [x] A/B testing campaign deployment
- [x] Staged rollout of campaigns
- [x] Conditional campaign branching

---

## Automation Scripts

### 1. Full Campaign Launcher

**File:** `scripts/launchFullCampaign.js`

**Usage:**
```bash
# Launch simple announcement
node scripts/launchFullCampaign.js simpleAnnouncement

# Launch DTMF interactive menu
node scripts/launchFullCampaign.js dtmfMenu

# Launch agent routing campaign
node scripts/launchFullCampaign.js callRouting
```

**6-Phase Workflow:**
1. **Upload Contact Lists** - Import customer phone numbers
2. **Upload Voice Prompts** - Add welcome, menu, thanks messages
3. **Create Agent Groups** - Setup sales, support, billing teams
4. **Configure Webhooks** - Setup event listeners
5. **Create Campaign** - Compose and schedule campaign
6. **Monitor Campaign** - Real-time stats and tracking

**Example: Complete Campaign End-to-End**
```javascript
const launcher = new CampaignLauncher();

// Phase 1: Upload contacts
const baseId = await launcher.uploadContactList(
  './data/contacts.csv',
  'Q3 2024 Customers'
);

// Phase 2: Upload voice prompts
const prompts = await launcher.uploadVoicePrompts({
  welcome: {
    filePath: './prompts/welcome.wav',
    fileName: 'welcome_q3',
    category: 'welcome'
  },
  menu: {
    filePath: './prompts/menu.wav',
    fileName: 'menu_options',
    category: 'menu'
  }
});

// Phase 3: Create agent groups
const groups = await launcher.createAgentGroups({
  sales: {
    groupName: 'Q3 Sales Team',
    agents: [
      { agentNumber: '919876543210', agentName: 'John Doe', agentType: 1 }
    ]
  }
});

// Phase 4: Setup webhooks
await launcher.setupWebhooks({
  voice: {
    hangup: { name: 'Hangup Handler', url: '...', event: 'HANGUP' }
  }
});

// Phase 5: Create campaign
const campaignId = await launcher.createCampaign({
  campaignName: 'Q3 Product Launch',
  campaignType: 'call-patch',
  baseId: baseId,
  agentGroups: groups,
  scheduleTime: '2024-09-01 10:00:00'
});

// Phase 6: Monitor
await launcher.monitorCampaign(300); // 5 minutes
```

### 2. Setup Script

**File:** `scripts/setupOBDIntegration.js`

**Usage:**
```bash
node scripts/setupOBDIntegration.js
```

**Automates:**
- Creates 3 default agent groups (Sales, Support, Billing)
- Configures all voice webhooks
- Configures SMS/WhatsApp webhooks
- Displays configuration guides

---

## API-Level Automation

### Direct API Calls

#### Create Campaign Programmatically

```javascript
import OBDApiClient from './lib/obdApiClient.js';

const client = new OBDApiClient(url, username, password);
await client.login();

// Create simple announcement
const campaign = await client.composeCampaign({
  campaignName: 'Automated Campaign',
  baseId: '152499',
  welcomePromptId: '954',
  thanksPromptId: '956',
  scheduleTime: '2024-09-01 10:00:00'
});

console.log('Campaign ID:', campaign.campaignId);
```

#### Upload Contact List

```javascript
const fs = require('fs');

const csvContent = fs.readFileSync('./contacts.csv');
const result = await client.uploadBaseFile(csvContent, 'Q3 Contacts');

console.log('Base ID:', result.baseId);
```

#### Upload Voice Prompt

```javascript
const wavContent = fs.readFileSync('./prompts/welcome.wav');
const result = await client.uploadVoiceFile(
  wavContent,
  'welcome_prompt',
  'welcome',
  'wav'
);

console.log('Prompt ID:', result.promptId);
```

#### Create Agent Group

```javascript
const result = await client.addAgentGroup('Sales Team', [
  {
    agentNumber: '919876543210',
    agentName: 'John Doe',
    agentType: 1
  }
]);

console.log('Group ID:', result.groupId);
```

#### Setup Webhooks

```javascript
// Voice webhook
await client.addWebhook(
  'Campaign Handler',
  'https://your-domain.com/webhooks/obd',
  'HANGUP'
);

// SMS webhook
await client.addSmsWebhook(
  'WhatsApp Notification',
  'https://media.sendmsg.in/mediasend',
  'WHATSAPP',
  'Thank you',
  JSON.stringify({...})
);
```

---

## REST API Endpoints

All automation can also be driven via HTTP requests:

### Create Campaign
```bash
curl -X POST http://localhost:3000/api/obd/campaigns/call-patch \
  -H "Content-Type: application/json" \
  -d '{
    "campaignName": "Auto Campaign",
    "baseId": "152499",
    "welcomePromptId": "954",
    "menuPromptId": "955",
    "menuWaitTime": 5,
    "agentGroups": [
      {"groupId": "4", "agentDtmf": "1", "groupName": "Sales"}
    ],
    "scheduleTime": "2024-09-01 10:00:00"
  }'
```

### Monitor Campaign
```bash
curl -X POST http://localhost:3000/api/obd/campaigns/analyze \
  -H "Content-Type: application/json" \
  -d '{
    "startDate": "2024-09-01",
    "endDate": "2024-09-02",
    "campaignName": "All",
    "campaignType": "All"
  }'
```

### Control Campaign
```bash
# Pause
curl -X POST http://localhost:3000/api/obd/campaigns/12345/pause

# Resume
curl -X POST http://localhost:3000/api/obd/campaigns/12345/resume

# Stop
curl -X POST http://localhost:3000/api/obd/campaigns/12345/stop
```

---

## Webhook Event Automation

### Auto-Process Events

```javascript
import { routeWebhookEvent } from './lib/webhookHandlers.js';

// Automatically route and handle any webhook event
const result = routeWebhookEvent('HANGUP', {
  campaignId: '12345',
  phoneNumber: '919876543210',
  callDuration: 45,
  // ...
});
```

### Event Types You Can Automate

| Event | Triggers | Auto-Response |
|-------|----------|----------------|
| HANGUP | Call ends | Log, store metrics |
| CALL_CONNECT | Agent picks up | Notify, track connection |
| DTMF_INPUT | Customer presses key | Route, log selection |
| NO_ANSWER | Call unanswered | Retry, failover |
| CAMPAIGN_COMPLETE | Campaign finishes | Generate report, notify |
| SMS_DELIVERY | SMS sent | Update status, track |
| WHATSAPP_DELIVERY | WhatsApp sent | Update status, track |
| SMS_REPLY | Customer replies | Process, route to queue |

---

## Advanced Automation Scenarios

### Scenario 1: Multi-Wave Campaign Launch

```javascript
async function launchMultiWave() {
  const waves = [
    { delay: 0, contacts: 'wave1.csv', name: 'Wave 1' },
    { delay: 3600, contacts: 'wave2.csv', name: 'Wave 2' },
    { delay: 7200, contacts: 'wave3.csv', name: 'Wave 3' },
  ];

  for (const wave of waves) {
    const scheduledTime = new Date(Date.now() + wave.delay * 1000);
    
    const launcher = new CampaignLauncher();
    const baseId = await launcher.uploadContactList(wave.contacts, wave.name);
    
    await launcher.createCampaign({
      campaignName: `Q3 Campaign - ${wave.name}`,
      baseId,
      scheduleTime: scheduledTime.toISOString(),
      // ... other config
    });
    
    console.log(`✓ Launched ${wave.name} at ${scheduledTime}`);
  }
}
```

### Scenario 2: Dynamic Agent Routing

```javascript
async function setupDynamicRouting() {
  const launcher = new CampaignLauncher();
  
  // Create groups based on availability
  const agentGroups = {
    primary: {
      groupName: 'Primary Sales',
      agents: await fetchAvailableAgents('SALES', 'PRIMARY')
    },
    backup: {
      groupName: 'Backup Sales',
      agents: await fetchAvailableAgents('SALES', 'BACKUP')
    }
  };
  
  await launcher.createAgentGroups(agentGroups);
  
  // Create campaign with dynamic groups
  await launcher.createCampaign({
    campaignName: 'Smart Routing Campaign',
    agentGroups: [
      { key: 'primary', agentDtmf: '1', groupName: 'Primary' },
      { key: 'backup', agentDtmf: '2', groupName: 'Backup' }
    ]
  });
}
```

### Scenario 3: A/B Testing

```javascript
async function runABTest() {
  const launcher1 = new CampaignLauncher();
  const launcher2 = new CampaignLauncher();
  
  // Campaign A - Aggressive messaging
  const campaignA = await launcher1.createCampaign({
    campaignName: 'Campaign A - Aggressive',
    welcomePromptId: 'aggressiveWelcome',
    scheduleTime: getScheduleTime()
  });
  
  // Campaign B - Soft messaging
  const campaignB = await launcher2.createCampaign({
    campaignName: 'Campaign B - Soft',
    welcomePromptId: 'softWelcome',
    scheduleTime: getScheduleTime()
  });
  
  console.log(`A/B Test Started:`);
  console.log(`Campaign A: ${campaignA}`);
  console.log(`Campaign B: ${campaignB}`);
  
  // Compare results
  setTimeout(() => compareResults(campaignA, campaignB), 3600000); // After 1 hour
}
```

### Scenario 4: Real-Time Event Processing

```javascript
import { routeWebhookEvent } from './lib/webhookHandlers.js';

// Setup webhook listener
app.post('/webhooks/obd', (req, res) => {
  const { eventType, payload } = req.body;
  
  // Auto-process
  const result = routeWebhookEvent(eventType, payload);
  
  // Trigger actions
  if (eventType === 'CAMPAIGN_COMPLETE') {
    generateReport(payload.campaignId);
    notifyManagement(payload);
    archiveData(payload);
  }
  
  if (eventType === 'DTMF_INPUT' && payload.dtmfInput === '2') {
    escalateToSupport(payload);
  }
  
  res.json({ success: true, processed: result });
});
```

---

## Automation Best Practices

### 1. Rate Limiting
```javascript
// Queue campaigns to avoid API throttling
const queue = [];
for (const campaign of campaigns) {
  queue.push(campaign);
  if (queue.length >= 5) {
    await Promise.all(queue.map(c => createCampaign(c)));
    queue.length = 0;
    await sleep(5000); // 5 second delay
  }
}
```

### 2. Error Handling & Retry
```javascript
async function retryWithBackoff(fn, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i < maxRetries - 1) {
        const delay = Math.pow(2, i) * 1000; // Exponential backoff
        console.log(`Retry ${i + 1} after ${delay}ms`);
        await sleep(delay);
      } else {
        throw error;
      }
    }
  }
}
```

### 3. Logging & Monitoring
```javascript
// Log all automation events
logger.info('Campaign Created', {
  campaignId,
  campaignName,
  baseId,
  agentGroups,
  timestamp: new Date()
});

// Monitor metrics
metrics.record('campaigns.created', 1);
metrics.record('campaigns.scheduled', 1);
metrics.record('contacts.uploaded', contactCount);
```

### 4. Idempotency
```javascript
// Ensure campaigns aren't duplicated
async function createCampaignSafe(config) {
  const existing = await client.findCampaign(config.campaignName);
  if (existing) {
    console.log('Campaign already exists:', existing.campaignId);
    return existing.campaignId;
  }
  return await client.composeCampaign(config);
}
```

---

## Command-Line Examples

### Example 1: Quick Campaign Launch
```bash
node scripts/launchFullCampaign.js callRouting
```

### Example 2: Setup Everything
```bash
node scripts/setupOBDIntegration.js
```

### Example 3: Custom Script
```javascript
// campaigns.js
import { CampaignLauncher } from './scripts/launchFullCampaign.js';

const launcher = new CampaignLauncher();
await launcher.uploadContactList('./data/contacts.csv', 'Q3');
await launcher.createCampaign({/* ... */});
```

```bash
node campaigns.js
```

---

## Integration with CI/CD

### GitHub Actions Example
```yaml
name: Auto-Launch Campaign

on:
  push:
    branches: [main]
  schedule:
    - cron: '0 8 * * MON' # Every Monday at 8 AM

jobs:
  launch:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - uses: actions/setup-node@v2
      - run: npm install
      - env:
          OBD_USERNAME: ${{ secrets.OBD_USERNAME }}
          OBD_PASSWORD: ${{ secrets.OBD_PASSWORD }}
        run: node scripts/launchFullCampaign.js callRouting
```

---

## Summary

**What Can Be Automated:**
✅ Contact uploads  
✅ Voice prompt uploads  
✅ Agent group setup  
✅ Webhook configuration  
✅ Campaign creation  
✅ Campaign scheduling  
✅ Campaign monitoring  
✅ Event handling  
✅ Report generation  

**Scripts Available:**
1. `scripts/launchFullCampaign.js` - 6-phase end-to-end automation
2. `scripts/setupOBDIntegration.js` - Quick setup script
3. `lib/obdApiClient.js` - 25+ automation methods
4. `lib/webhookHandlers.js` - 14+ event handlers

**Usage:**
```bash
# Full campaign launch
node scripts/launchFullCampaign.js callRouting

# Or via API
curl -X POST http://localhost:3000/api/obd/campaigns/call-patch -d '{...}'

# Or programmatically
import { CampaignLauncher } from './scripts/launchFullCampaign.js';
```

Everything is fully automatable and production-ready! 🚀
