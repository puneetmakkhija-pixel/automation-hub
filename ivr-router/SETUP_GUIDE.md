# OBD IVR API - Complete Setup Guide

This guide walks you through setting up all OBD IVR capabilities: Call Connect, DTMF Interactive Menus, Webhooks, Agent Routing, and more.

## Table of Contents
1. [Quick Start](#quick-start)
2. [Call Connect Setup](#call-connect-setup)
3. [DTMF Interactive Menu Setup](#dtmf-setup)
4. [Webhook Configuration](#webhooks)
5. [Agent Group Management](#agent-groups)
6. [Testing](#testing)
7. [Troubleshooting](#troubleshooting)

---

## Quick Start

### 1. Prerequisites
```bash
# Install dependencies
npm install

# Create .env file with OBD credentials
cp .env.example .env
```

### 2. Configure Environment
Edit `.env`:
```env
OBD_BASE_URL=https://obdapi2.ivrsms.com
OBD_USERNAME=your_username
OBD_PASSWORD=your_password
OBD_WEBHOOK_URL=https://your-domain.com
OBD_SMS_WEBHOOK_URL=https://your-domain.com
PORT=3000
```

### 3. Run Complete Setup
```bash
# This sets up all agent groups, webhooks, and displays configuration
node scripts/setupOBDIntegration.js
```

### 4. Start Server
```bash
npm start
```

The server is now running on `http://localhost:3000`.

---

## Call Connect Setup

**Call Connect** (Call Patch) routes incoming calls to specific agents based on customer DTMF input.

### Architecture
```
Customer calls → IVR welcome message
                 ↓
            Menu prompt plays
                 ↓
         Customer presses DTMF (1, 2, 3)
                 ↓
        Route to appropriate agent group
                 ↓
           Agent answers call
                 ↓
         Webhook notification sent
```

### Create Call Connect Campaign

**Endpoint:** `POST /api/obd/campaigns/call-patch`

**Request:**
```json
{
  "campaignName": "Customer Service Routing",
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
  "location": "{\"locationList\":[{\"locationId\":1,\"locationName\":\"Mumbai\"}]}"
}
```

### Agent Group IDs
Before creating campaigns, set up agent groups:

**Endpoint:** `POST /api/obd/agent-groups`

**Request:**
```json
{
  "groupName": "Sales Team",
  "agents": [
    {
      "agentNumber": "9185718XXXXX",
      "agentName": "Raj Kumar",
      "agentType": 1
    },
    {
      "agentNumber": "9876543XXXXX",
      "agentName": "Priya Singh",
      "agentType": 1
    }
  ]
}
```

### Monitor Call Routing
```bash
# Check campaign status
curl -X POST http://localhost:3000/api/obd/campaigns/analyze \
  -H "Content-Type: application/json" \
  -d '{
    "startDate": "2024-08-01",
    "endDate": "2024-08-25",
    "campaignName": "All",
    "campaignType": "All"
  }'
```

---

## DTMF Setup

**DTMF** (Dual-Tone Multi-Frequency) enables interactive voice menus where customers press keypad buttons.

### DTMF Flow

```
1. Customer hears welcome message
   "Welcome to Customer Support"
   
2. Customer hears menu prompt
   "Press 1 for Sales, 2 for Support, 3 for Billing"
   
3. System waits for DTMF input (5 seconds)
   
4a. If valid DTMF (1, 2, or 3)
    → Route to agent OR process accordingly
    
4b. If no input
    → Play "noInputPrompt"
    → Repeat menu (up to 2 times)
    
4c. If invalid DTMF (4, 5, *, #, etc.)
    → Play "wrongInputPrompt"
    → Repeat menu
```

### Create DTMF Campaign

**Endpoint:** `POST /api/obd/campaigns/dtmf`

**Request:**
```json
{
  "campaignName": "Interactive Support Menu",
  "baseId": "152499",
  "welcomePromptId": "954",
  "menuPromptId": "955",
  "noInputPromptId": "957",
  "wrongInputPromptId": "958",
  "thanksPromptId": "956",
  "dtmf": "1",
  "menuWaitTime": 5,
  "rePrompt": 2,
  "scheduleTime": "2024-08-25 10:00:00",
  "smsDtmfApi": "{\"url\":\"https://your-api.com/dtmf\",\"requestType\":\"POST\"}"
}
```

### DTMF Prompt Requirements

Required voice prompts:
| Prompt Type | Description | Duration |
|-------------|-------------|----------|
| Welcome | Initial greeting | < 10s |
| Menu | Options (Press 1, 2, 3) | < 15s |
| NoInput | "We didn't hear you" | < 5s |
| WrongInput | "Invalid option" | < 5s |
| Thanks | Closing message | < 10s |

### Upload Voice Prompts

**Endpoint:** `POST /api/obd/voices/upload`

**Request (multipart/form-data):**
```bash
curl -X POST http://localhost:3000/api/obd/voices/upload \
  -F "waveFile=@welcome.wav" \
  -F "fileName=welcome_prompt" \
  -F "promptCategory=welcome" \
  -F "fileType=wav"
```

### Test DTMF Response

When a caller presses a key, the webhook sends:
```json
{
  "eventType": "DTMF_INPUT",
  "payload": {
    "campaignId": "12345",
    "phoneNumber": "919876543210",
    "dtmfInput": "1",
    "dtmfDescription": "Customer selected Sales",
    "menuLevel": 1,
    "timestamp": "2024-08-25T10:30:00Z"
  }
}
```

---

## Webhooks

**Webhooks** allow your system to receive real-time notifications of campaign events.

### Webhook Types

#### 1. Voice Call Webhooks

**Supported Events:**
- `HANGUP` - Call ended
- `CALL_CONNECT` - Agent connected
- `DTMF_INPUT` - Customer pressed a key
- `NO_ANSWER` - Call unanswered
- `CAMPAIGN_START` - Campaign started
- `CAMPAIGN_COMPLETE` - Campaign finished

**Endpoint:** `/webhooks/obd`

**Example Hangup Event:**
```json
{
  "eventType": "HANGUP",
  "payload": {
    "campaignId": "12345",
    "campaignName": "Sales Campaign",
    "phoneNumber": "919876543210",
    "callDuration": 45,
    "dialStatus": "ANSWER",
    "callResult": "HANGUP",
    "dtmfReceived": "2",
    "timestamp": "2024-08-25T10:30:00Z"
  }
}
```

#### 2. SMS/WhatsApp Webhooks

**Supported Events:**
- `SMS_DELIVERY` - SMS delivered
- `WHATSAPP_DELIVERY` - WhatsApp delivered/read
- `SMS_REPLY` - Customer replied to SMS

**Endpoint:** `/webhooks/sms`

**Example WhatsApp Delivery:**
```json
{
  "eventType": "WHATSAPP_DELIVERY",
  "payload": {
    "phoneNumber": "919876543210",
    "messageId": "msg_123456",
    "status": "DELIVERED",
    "templateId": "campaign_complete",
    "deliveryTime": "2024-08-25T10:30:05Z",
    "timestamp": "2024-08-25T10:30:05Z"
  }
}
```

### Create Webhook

**Endpoint:** `POST /api/obd/webhooks`

**Request:**
```json
{
  "webhookName": "Campaign Completion Handler",
  "url": "https://your-domain.com/webhooks/obd",
  "event": "HANGUP"
}
```

### Create SMS Webhook

**Endpoint:** `POST /api/obd/sms-webhooks`

**Request:**
```json
{
  "webhookName": "WhatsApp Notification",
  "url": "https://media.sendmsg.in/mediasend",
  "requestType": "WHATSAPP",
  "smsText": "Thank you for your response",
  "payload": "{\"user\":\"your_user\",\"pass\":\"your_pass\",\"whatsapptosend\":[{\"from\":\"919XXXXXXXXX\",\"to\":\"91{PHONE}\",\"templateid\":\"thank_you\"}]}"
}
```

### Webhook Event Handlers (Built-in)

The following handlers are automatically called:

```javascript
import * as handlers from './lib/webhookHandlers.js';

// Example: Route an event
const result = handlers.routeWebhookEvent('HANGUP', hangupPayload);

// Or use specific handlers
handlers.handleHangupEvent(payload);
handlers.handleCallConnectEvent(payload);
handlers.handleDtmfEvent(payload);
handlers.handleWhatsappDeliveryEvent(payload);
```

### Webhook Security

1. **Verify URL Accessibility:**
```bash
curl https://your-domain.com/webhooks/obd
# Should return 404 or 405, not 403/500
```

2. **Log Webhooks:**
Check console/logs for webhook events
```
[2024-08-25T10:30:00Z] Webhook: HANGUP
📞 HANGUP Event:
  Campaign: Sales Campaign (ID: 12345)
  Phone: 919876543210
  Duration: 45s
  Status: ANSWER
```

3. **Retry Strategy:**
OBD API retries failed webhooks up to 3 times with exponential backoff.

---

## Agent Groups

**Agent Groups** organize agents for call routing.

### Create Agent Group

**Endpoint:** `POST /api/obd/agent-groups`

**Request:**
```json
{
  "groupName": "Sales Team",
  "agents": [
    {
      "agentNumber": "9185718XXXXX",
      "agentName": "Raj Kumar",
      "agentType": 1
    },
    {
      "agentNumber": "9876543XXXXX",
      "agentName": "Priya Singh",
      "agentType": 1
    }
  ]
}
```

### List Agent Groups

**Endpoint:** `GET /api/obd/agent-groups`

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "groupId": "4",
      "groupName": "Sales Team",
      "agents": [
        {
          "agentNumber": "9185718XXXXX",
          "agentName": "Raj Kumar",
          "agentType": 1
        }
      ]
    }
  ]
}
```

### Update Agent Group

**Endpoint:** `PUT /api/obd/agent-groups/:groupId`

**Request:**
```json
{
  "groupName": "Sales Team - Updated",
  "agents": [...]
}
```

### Delete Agent Group

**Endpoint:** `DELETE /api/obd/agent-groups/:groupId`

---

## Testing

### 1. Test Authentication

```bash
curl -X POST http://localhost:3000/api/obd/auth/login
```

**Response:**
```json
{
  "success": true,
  "data": {
    "userId": "user123",
    "role": "admin"
  }
}
```

### 2. Test Campaign Creation

```bash
curl -X POST http://localhost:3000/api/obd/campaigns/simple-ivr \
  -H "Content-Type: application/json" \
  -d '{
    "campaignName": "Test Campaign",
    "baseId": "152499",
    "welcomePromptId": "954",
    "thanksPromptId": "956",
    "scheduleTime": "2024-08-25 14:00:00"
  }'
```

### 3. Test Webhook Locally

```bash
# Simulate a webhook event
curl -X POST http://localhost:3000/webhooks/obd \
  -H "Content-Type: application/json" \
  -d '{
    "eventType": "HANGUP",
    "payload": {
      "campaignId": "12345",
      "campaignName": "Test Campaign",
      "phoneNumber": "919876543210",
      "callDuration": 45,
      "dialStatus": "ANSWER",
      "callResult": "HANGUP"
    }
  }'
```

### 4. Integration Test Script

```bash
# Run the complete setup and test script
node scripts/setupOBDIntegration.js
```

---

## Troubleshooting

### Issue: "Authentication failed"
**Solution:** Verify credentials in `.env`
```env
OBD_USERNAME=your_correct_username
OBD_PASSWORD=your_correct_password
```

### Issue: "Webhook not receiving events"
**Solution:** 
1. Verify webhook URL is publicly accessible
```bash
curl https://your-domain.com/webhooks/obd
```

2. Check firewall rules allow inbound traffic
3. Review OBD API logs for webhook delivery status

### Issue: "DTMF input not detected"
**Solution:**
1. Verify `menuWaitTime` is sufficient (minimum 3 seconds)
2. Test voice prompt plays correctly
3. Check phone supports DTMF (some VoIP may not)
4. Try different DTMF values (1-9, *, #)

### Issue: "Campaign won't start"
**Solution:**
1. Verify `scheduleTime` is in future
2. Ensure `baseId` exists and has valid contacts
3. Check all required `promptIds` are uploaded
4. Verify campaign type matches endpoint

### Issue: "Agent not receiving calls"
**Solution:**
1. Verify agent group exists: `GET /api/obd/agent-groups`
2. Check agent phone numbers are valid
3. Confirm agent status is available (not busy)
4. Test agent group manually in OBD dashboard

### Debug Mode

Enable detailed logging:
```bash
LOG_LEVEL=debug npm start
```

### Check Logs

```bash
# View webhook events
grep "Webhook:" server.log

# View errors
grep "Error:" server.log

# View campaign events
grep "Campaign" server.log
```

---

## Best Practices

### Voice Prompts
- Keep under 30 seconds
- Use clear, professional audio
- Record in WAV format
- Test with multiple phone types

### DTMF Configuration
- Set `menuWaitTime` to at least 5 seconds
- Use `rePrompt: 2` for resilience
- Include clear "press 1, 2, 3" instructions
- Test with real phones, not just simulators

### Webhooks
- Implement idempotency (handle duplicate events)
- Return 200 OK quickly, process async
- Log all events for debugging
- Implement exponential backoff for retries

### Agent Management
- Keep agent numbers validated
- Monitor agent availability
- Route to agent groups, not individuals
- Test failover scenarios

### Campaign Scheduling
- Schedule at least 10 minutes in advance
- Avoid peak hours for initial testing
- Monitor first batch of calls
- Have escalation plan if issues occur

---

## Support

For detailed API documentation, see:
- `OBD_API_SETUP.md` - Complete API reference
- `examples/obdCampaignExamples.js` - Working examples
- `lib/obdApiClient.js` - Client implementation

For OBD API support, contact IVRSMS support team.
