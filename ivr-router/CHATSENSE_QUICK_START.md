# Chatsense WhatsApp Integration - Quick Start

Complete guide to send WhatsApp templates, interactives, and flows using Chatsense Public API.

## 1. Get Your Credentials

1. **Go to Chatsense Dashboard:**
   - Visit https://app.chatsense.com
   - Login with your account

2. **Navigate to API Keys:**
   - Click "Settings" → "API Keys" or "Integrations"
   - You'll see:
     - `CHATSENSE_API_KEY` - Your company-scoped API key
     - Copy this value for authentication

3. **Never commit these to git** - use environment variables

## 2. Set Up Environment Variables

Create a `.env` file (never commit to git):

```bash
# Chatsense API Credentials
CHATSENSE_API_KEY=your_api_key_from_dashboard
CHATSENSE_BASE_URL=https://api.chatsense.com/api/v1/public
CHATSENSE_WEBHOOK_URL=https://your-domain.com/webhooks/chatsense
```

## 3. List Available Resources

### Get All Templates

```bash
curl -X GET http://localhost:3000/api/chatsense/templates \
  -H "Content-Type: application/json"
```

### Get All Interactives

```bash
curl -X GET http://localhost:3000/api/chatsense/interactives \
  -H "Content-Type: application/json"
```

### Get All Flows

```bash
curl -X GET http://localhost:3000/api/chatsense/flows \
  -H "Content-Type: application/json"
```

### Get Configured Webhooks

```bash
curl -X GET http://localhost:3000/api/chatsense/webhooks \
  -H "Content-Type: application/json"
```

## 4. Send WhatsApp Messages

### Send Template Message

```bash
curl -X POST http://localhost:3000/api/chatsense/templates/send \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "919876543210",
    "customerName": "John Doe",
    "templateName": "welcome_template",
    "language": "en_US"
  }'
```

**Response:**
```json
{
  "success": true,
  "phone": "919876543210",
  "templateName": "welcome_template",
  "messageId": "msg_123456",
  "timestamp": "2026-08-25T13:30:00Z"
}
```

### Send Interactive Message

```bash
curl -X POST http://localhost:3000/api/chatsense/interactives/send \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "919876543210",
    "interactiveId": "interactive_789"
  }'
```

### Send Flow Message

```bash
curl -X POST http://localhost:3000/api/chatsense/flows/send \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "919876543210",
    "flowId": "flow_456",
    "headerText": "Application Form",
    "bodyText": "Please complete your loan application",
    "footerText": "BuddyLoan",
    "ctaText": "Open Form"
  }'
```

## 5. Bulk Send to Multiple Customers

### Bulk Send Templates

```bash
curl -X POST http://localhost:3000/api/chatsense/templates/bulk-send \
  -H "Content-Type: application/json" \
  -d '{
    "customers": [
      {
        "phone": "919876543210",
        "customerName": "John Doe"
      },
      {
        "phone": "919876543211",
        "customerName": "Jane Smith"
      }
    ],
    "templateName": "loan_offer_notification",
    "delayMs": 1000
  }'
```

**Response:**
```json
{
  "success": true,
  "successful": 2,
  "failed": 0,
  "message": "Bulk send completed: 2 successful, 0 failed",
  "messages": [
    {
      "phone": "919876543210",
      "status": "sent",
      "messageId": "msg_123"
    },
    {
      "phone": "919876543211",
      "status": "sent",
      "messageId": "msg_124"
    }
  ]
}
```

## 6. Integration with IVR Router

### Configuration

Add to `.env`:

```bash
CHATSENSE_API_KEY=your_api_key_from_dashboard
CHATSENSE_BASE_URL=https://api.chatsense.com/api/v1/public
CHATSENSE_WEBHOOK_URL=https://your-domain.com/webhooks/chatsense
```

### Use in Routes

```javascript
import ChatsenseClient from './lib/chatsenseClient.js';

// Initialize client (reads from env variables)
const client = new ChatsenseClient();

// Send template
await client.sendTemplate({
  phone: '919876543210',
  customerName: 'John Doe',
  templateName: 'welcome_template',
  language: 'en_US'
});

// Send interactive
await client.sendInteractive({
  phone: '919876543210',
  interactiveId: 'interactive_id'
});

// Send flow
await client.sendFlow({
  phone: '919876543210',
  flowId: 'flow_id',
  headerText: 'Form Title',
  bodyText: 'Please fill out this form'
});

// Bulk send
const customers = [
  { phone: '919876543210', customerName: 'John Doe' },
  { phone: '919876543211', customerName: 'Jane Smith' }
];
await client.bulkSendTemplate(customers, 'template_name', 1000);
```

## 7. Common Workflows

### Workflow 1: Post-Call Follow-up

```bash
# 1. OBD IVR campaign runs and customer calls
# Call connects to agent and completes

# 2. Send Chatsense follow-up message
curl -X POST http://localhost:3000/api/chatsense/templates/send \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "919876543210",
    "customerName": "John Doe",
    "templateName": "call_followup_template"
  }'

# 3. Track delivery via webhook
# POST /webhooks/chatsense receives delivery status
```

### Workflow 2: Multi-Channel Campaign

```bash
# 1. Send voice campaign via OBD
curl -X POST http://localhost:3000/api/obd/campaigns/compose \
  -H "Content-Type: application/json" \
  -d '{
    "campaignName": "Loan Offer Campaign",
    "script": "We have a special loan offer for you...",
    "callbackUrl": "https://your-domain.com/webhooks/obd"
  }'

# 2. Send WhatsApp template via Chatsense
curl -X POST http://localhost:3000/api/chatsense/templates/send \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "919876543210",
    "customerName": "John Doe",
    "templateName": "loan_offer_followup"
  }'

# 3. Send interactive flow for application
curl -X POST http://localhost:3000/api/chatsense/flows/send \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "919876543210",
    "flowId": "loan_application_flow",
    "headerText": "Apply for Loan",
    "bodyText": "Start your application in 2 minutes"
  }'

# 4. Send Oriserve voice agent for objection handling
curl -X POST http://localhost:3000/api/oriserve/campaigns/trigger \
  -H "Content-Type: application/json" \
  -d '{
    "campaign_id": "campaign_123",
    "mobile": "+919876543210",
    "metadata": { "customer_name": "John Doe", "source": "chatsense_flow" }
  }'
```

### Workflow 3: Template Validation

```javascript
// Check if specific template exists
const templates = await client.listTemplates();
const welcomeTemplate = templates.templates.find(
  t => t.template_name === 'welcome_template'
);

if (welcomeTemplate) {
  console.log(`✓ Template ready: ${welcomeTemplate.template_id}`);
  // Send to customers
} else {
  console.log('✗ Template not found');
}
```

## 8. Phone Number Formatting

Chatsense accepts phone numbers in these formats:

- **10 digits** (auto-prefixed with 91): `9876543210` → `919876543210`
- **12 digits with 91**: `919876543210` → `919876543210`
- **With +91**: `+919876543210` → `919876543210`
- **All formats cleaned**: spaces, dashes, parentheses removed

## 9. API Reference

### ChatsenseClient Methods

```javascript
// List resources
await client.listTemplates()       // GET /integrations/templates
await client.listInteractives()    // GET /integrations/interactives
await client.listFlows()           // GET /integrations/flows
await client.listWebhooks()        // GET /integrations/webhooks

// Send messages
await client.sendTemplate({...})   // POST /integrations/templates/send
await client.sendInteractive({...}) // POST /integrations/interactives/send
await client.sendFlow({...})       // POST /integrations/flows/send

// Bulk operations
await client.bulkSendTemplate(customers, templateName, delayMs)

// Utilities
await client.validateApiKey()      // POST /api-keys/validate
await client.healthCheck()         // Verify API connectivity
await client.formatPhoneNumber(phone) // Format phone to 91XXXXXXXXXX
```

### REST Endpoints

```
GET    /api/chatsense/templates               - List templates
GET    /api/chatsense/interactives            - List interactives
GET    /api/chatsense/flows                   - List flows
GET    /api/chatsense/webhooks                - List webhooks
GET    /api/chatsense/health                  - Health check

POST   /api/chatsense/templates/send          - Send template
POST   /api/chatsense/interactives/send       - Send interactive
POST   /api/chatsense/flows/send              - Send flow
POST   /api/chatsense/templates/bulk-send     - Bulk send templates

POST   /webhooks/chatsense                    - Receive delivery webhooks
```

## 10. Webhook Handling

### Webhook Payload

```json
{
  "phone": "919876543210",
  "status": "delivered",
  "messageId": "msg_123456",
  "templateName": "welcome_template",
  "timestamp": "2026-08-25T13:30:00Z"
}
```

### Status Values

- `sent` - Message sent successfully
- `delivered` - Message delivered to phone
- `read` - Message read by recipient
- `failed` - Message delivery failed

### Webhook Handler

```javascript
// Endpoint at POST /webhooks/chatsense in index.js
// Logs incoming webhook events for processing
```

## 11. Error Handling

### Common Errors

**"Missing CHATSENSE_API_KEY"**
```bash
export CHATSENSE_API_KEY="your_api_key"
```

**"Phone must be 10 digits or +91XXXXXXXXXX format"**
- Use Indian phone numbers (10 digits)
- Optional: include +91 prefix

**"HTTP 401 - Unauthorized"**
- API key is invalid or expired
- Go to Chatsense dashboard to regenerate

**"HTTP 404 - Not Found"**
- Template/interactive/flow ID doesn't exist
- List available resources first

## 12. Rate Limiting

- **Single send**: No limit
- **Bulk send**: Default 1 second delay between requests
- **Adjust delay**: Pass `delayMs` parameter in bulk-send request

```bash
curl -X POST http://localhost:3000/api/chatsense/templates/bulk-send \
  -H "Content-Type: application/json" \
  -d '{
    "customers": [...],
    "templateName": "template_name",
    "delayMs": 500  # Send faster (500ms between requests)
  }'
```

## 13. Next Steps

1. ✅ Set up credentials in `.env`
2. ✅ List available templates: `GET /api/chatsense/templates`
3. ✅ Send test message: `POST /api/chatsense/templates/send`
4. ✅ Verify delivery via webhook: `POST /webhooks/chatsense`
5. ✅ Integrate with OBD IVR for multi-channel campaigns
6. ✅ Integrate with Oriserve for voice agent follow-ups

## Support

- **Chatsense Docs:** https://docs.chatsense.com
- **IVR Router:** See `CHATSENSE_INTEGRATION_GUIDE.md` for detailed API reference
- **GitHub:** Check `lib/chatsenseClient.js` for implementation details

---

Last Updated: 2026-08-25
