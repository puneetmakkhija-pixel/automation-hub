# OBD IVR API Setup Guide

This guide explains how to configure and use the OBD IVR SMS API integration with the automation hub.

## Overview

The OBD API integration provides a complete IVR (Interactive Voice Response) solution with support for:
- Voice file management (prompts/greetings)
- Contact list uploads
- Multiple campaign types (Simple IVR, DTMF, Call Patch)
- Webhook management
- SMS/WhatsApp integration
- Agent group management
- Campaign analytics and reporting

## Setup Instructions

### 1. Environment Configuration

Create a `.env` file in the `ivr-router` directory with your OBD API credentials:

```env
PORT=3000

# OBD API Configuration
OBD_BASE_URL=https://obdapi2.ivrsms.com
OBD_USERNAME=your_username
OBD_PASSWORD=your_password

# Webhook URLs (for OBD to send callbacks)
OBD_WEBHOOK_URL=https://your-domain.com/webhooks/obd
OBD_SMS_WEBHOOK_URL=https://your-domain.com/webhooks/sms

# Logging
LOG_LEVEL=info
```

### 2. Install Dependencies

```bash
cd ivr-router
npm install
```

### 3. Start the Server

```bash
npm start
```

The server will start on the configured PORT and make the OBD API available at `/api/obd`.

## API Endpoints

### Authentication

**Login to OBD API:**
```
POST /api/obd/auth/login
```

Returns userId and authentication token.

### Voice Files Management

**Upload voice file:**
```
POST /api/obd/voices/upload
Content-Type: multipart/form-data

{
  "fileName": "welcome_prompt",
  "promptCategory": "welcome",  // welcome, menu, thanks, noinput, wronginput
  "fileType": "wav"  // wav, mp3
}
```

**List voice files:**
```
GET /api/obd/voices
```

### Base Files Management

**Upload contact list:**
```
POST /api/obd/bases/upload
Content-Type: multipart/form-data

{
  "baseName": "customer_list_2024"
}
```

### Campaign Management

#### Simple IVR Campaign
Outbound call with voice prompts, no DTMF input required.

```
POST /api/obd/campaigns/simple-ivr

{
  "campaignName": "Welcome Campaign",
  "baseId": "152499",
  "welcomePromptId": "954",
  "menuPromptId": "955",
  "thanksPromptId": "956",
  "scheduleTime": "2024-08-25 16:15:41"
}
```

#### DTMF Campaign
Interactive campaign with DTMF (keypad) input.

```
POST /api/obd/campaigns/dtmf

{
  "campaignName": "Support Menu",
  "baseId": "152499",
  "menuPromptId": "955",
  "dtmf": "1",  // Valid DTMF input
  "menuWaitTime": 5,
  "rePrompt": 2,
  "scheduleTime": "2024-08-25 16:15:41"
}
```

#### Call Patch Campaign
Routes calls to agents based on DTMF selection.

```
POST /api/obd/campaigns/call-patch

{
  "campaignName": "Agent Routing",
  "baseId": "152499",
  "menuPromptId": "955",
  "menuWaitTime": 5,
  "agentGroups": [
    {
      "groupId": "4",
      "agentDtmf": "1",
      "groupName": "Support Team"
    }
  ],
  "scheduleTime": "2024-08-25 16:15:41"
}
```

**Pause campaign:**
```
POST /api/obd/campaigns/:campaignId/pause
```

**Resume campaign:**
```
POST /api/obd/campaigns/:campaignId/resume
```

**Stop campaign:**
```
POST /api/obd/campaigns/:campaignId/stop
```

**Analyze campaign:**
```
POST /api/obd/campaigns/analyze

{
  "startDate": "2024-08-01",
  "endDate": "2024-08-25",
  "campaignName": "All",
  "campaignType": "All",
  "username": ""
}
```

### Webhook Management

**Create webhook:**
```
POST /api/obd/webhooks

{
  "webhookName": "Campaign Hangup Handler",
  "url": "https://your-domain.com/webhooks/obd",
  "event": "HANGUP"
}
```

**List webhooks:**
```
GET /api/obd/webhooks
```

**Update webhook:**
```
PUT /api/obd/webhooks/:webhookId

{
  "webhookName": "Updated Handler",
  "url": "https://your-domain.com/webhooks/obd",
  "event": "HANGUP"
}
```

**Delete webhook:**
```
DELETE /api/obd/webhooks/:webhookId
```

### SMS/WhatsApp Webhook Management

**Create SMS webhook:**
```
POST /api/obd/sms-webhooks

{
  "webhookName": "WhatsApp Notification",
  "url": "https://media.sendmsg.in/mediasend",
  "requestType": "WHATSAPP",
  "smsText": "",
  "payload": "{...}"
}
```

**List SMS webhooks:**
```
GET /api/obd/sms-webhooks
```

**Get SMS webhook details:**
```
GET /api/obd/sms-webhooks/:webhookId
```

**Update SMS webhook:**
```
PUT /api/obd/sms-webhooks/:webhookId

{
  "webhookName": "Updated Webhook",
  "url": "https://media.sendmsg.in/mediasend",
  "requestType": "WHATSAPP",
  "smsText": "",
  "payload": "{...}"
}
```

### Reports

**Generate report:**
```
POST /api/obd/reports/:campaignId/generate

{
  "reportType": "full"
}
```

**Download reports:**
```
GET /api/obd/reports/download
```

### Agent Groups

**Create agent group:**
```
POST /api/obd/agent-groups

{
  "groupName": "Support Team",
  "agents": [
    {
      "agentNumber": "9185718XXXXX",
      "agentName": "John Doe",
      "agentType": 1  // 0 = Normal, 1 = Call Center
    }
  ]
}
```

**List agent groups:**
```
GET /api/obd/agent-groups
```

**Get agent group:**
```
GET /api/obd/agent-groups/:groupId
```

**Update agent group:**
```
PUT /api/obd/agent-groups/:groupId

{
  "groupName": "Updated Team",
  "agents": [...]
}
```

**Delete agent group:**
```
DELETE /api/obd/agent-groups/:groupId
```

## Campaign Types

### Simple IVR (Template ID: 0)
- Basic outbound call with voice prompts
- No DTMF input required
- Good for announcements, notifications

### DTMF (Template ID: 1)
- Interactive menu with DTMF input
- Requires menuPromptId
- Must specify menuWaitTime and rePrompt

### Call Patch (Template ID: 2)
- Routes calls to agents
- Requires agentRows with agent group details
- DTMF input determines routing

### Custom IVR (Template ID: 3)
- Custom IVR flow

### TTS Variants (Template IDs: 7, 8, 9)
- Text-to-speech versions of Simple IVR, DTMF, and Call Patch

## Prompt Categories

- `welcome`: Initial greeting prompt
- `menu`: Main menu prompt with options
- `thanks`: Thank you/closing prompt
- `noinput`: Played when user doesn't provide input
- `wronginput`: Played when invalid DTMF received

## Examples

### Example 1: Create a Simple Announcement Campaign

```javascript
POST /api/obd/campaigns/simple-ivr

{
  "campaignName": "Product Launch Announcement",
  "baseId": "152499",
  "welcomePromptId": "954",
  "thanksPromptId": "956",
  "scheduleTime": "2024-08-28 10:00:00"
}
```

### Example 2: Create an Interactive Support Menu

```javascript
POST /api/obd/campaigns/dtmf

{
  "campaignName": "Customer Support Menu",
  "baseId": "152499",
  "welcomePromptId": "954",
  "menuPromptId": "955",
  "noInputPromptId": "957",
  "wrongInputPromptId": "958",
  "dtmf": "1",
  "menuWaitTime": 5,
  "rePrompt": 2,
  "scheduleTime": "2024-08-28 10:00:00",
  "smsSuccessApi": "{\"url\":\"https://your-api.com/sms\",\"requestType\":\"GET\"}"
}
```

### Example 3: Create an Agent Routing Campaign

```javascript
POST /api/obd/campaigns/call-patch

{
  "campaignName": "Sales Agent Routing",
  "baseId": "152499",
  "welcomePromptId": "954",
  "menuPromptId": "955",
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
    }
  ],
  "scheduleTime": "2024-08-28 10:00:00"
}
```

## Response Format

All endpoints return JSON responses with the following format:

```json
{
  "success": true,
  "message": "Operation description",
  "data": {
    // Response data
  }
}
```

Or on error:

```json
{
  "success": false,
  "error": "Error description"
}
```

## Error Codes

- `200`: Request completed successfully
- `400`: Invalid request parameters
- `401`: Authentication failed
- `404`: Resource not found
- `500`: Internal server error

## Integration with Webhooks

The OBD API sends webhooks to your configured URLs for campaign events:

**OBD Webhook (voice events):**
- Event: Campaign hangup, call completion
- Endpoint: `POST /webhooks/obd`

**SMS Webhook (SMS/WhatsApp events):**
- Event: Message delivery, user response
- Endpoint: `POST /webhooks/sms`

## Best Practices

1. **Voice Files**: Keep prompt duration under 30 seconds
2. **Contact Lists**: Validate phone numbers before upload
3. **Scheduling**: Schedule campaigns at least 10 minutes in advance
4. **Webhooks**: Always verify webhook authenticity before processing
5. **Retries**: Configure appropriate retry intervals (10-30 seconds recommended)
6. **Agent Groups**: Test agent routing before production campaigns

## Troubleshooting

- **Authentication Error**: Verify username/password in .env file
- **Campaign Not Starting**: Check schedule time is in the future
- **Webhook Not Receiving Events**: Verify URL is publicly accessible
- **Poor Audio Quality**: Ensure voice files are in WAV format with proper bitrate

## Support

For more information, refer to the OBD API documentation included in the PDF or contact IVRSMS support.
