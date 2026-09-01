# Ananta WhatsApp Integration - Quick Start

Complete guide to fetch and use Ananta approved templates, campaign links, and webhooks.

## 1. Get Your Credentials

1. **Go to Ananta Dashboard:**
   - Visit https://anantadot.com/dashboard
   - Login with your account

2. **Navigate to API Keys:**
   - Click "Manage API Key" or Settings → API Keys
   - You'll see three values:
     - `ANANTA_API_KEY` - for sending messages (waba/sendmessage)
     - `ANANTA_API_TOKEN` - for templates/campaigns/webhooks
     - `ANANTA_API_SECRET_KEY` - for templates/campaigns/webhooks

3. **Never commit these to git** - use environment variables

## 2. Fetch All Templates & Links

### Option A: Using Bash Script (Recommended)

```bash
# Set your credentials
export ANANTA_API_TOKEN="your_token_here"
export ANANTA_API_SECRET_KEY="your_secret_key_here"

# Run the fetch script
chmod +x scripts/fetchAnantaData.sh
./scripts/fetchAnantaData.sh

# View the results
ls -lh ananta_data/
cat ananta_data/templates_approved_*.json | jq .
```

### Option B: Using curl (One-Liner)

```bash
# Get approved templates
curl -X GET "https://data-api.anantadot.com/WhatsApp/templates/approved" \
  -H "Content-Type: application/json" \
  -d '{
    "api_token": "YOUR_TOKEN",
    "api_sec_key": "YOUR_SECRET"
  }' | jq .

# Get campaign links
curl -X GET "https://data-api.anantadot.com/Campaigns/links" \
  -H "Content-Type: application/json" \
  -d '{
    "api_token": "YOUR_TOKEN",
    "api_sec_key": "YOUR_SECRET"
  }' | jq .

# Get webhooks
curl -X POST "https://data-api.anantadot.com/Webhooks/list" \
  -H "Content-Type: application/json" \
  -d '{
    "api_token": "YOUR_TOKEN",
    "api_sec_key": "YOUR_SECRET"
  }' | jq .
```

### Option C: Using Node.js

```javascript
import AnantaDataClient from './lib/anantaDataClient.js';

// Initialize client (reads from env variables)
const client = new AnantaDataClient();

// Get all data at once
const allData = await client.getAllData();
console.log(allData);

// Or fetch individually
const templates = await client.getApprovedTemplates();
const links = await client.getCampaignLinks();
const webhooks = await client.listWebhooks();

// Find specific template
const template = await client.findTemplateByName('loan_disbursed_notification');
console.log(template.template_id); // Use in send calls
```

## 3. Understanding the Responses

### Approved Templates Response

```json
{
  "status": "true",
  "code": "200",
  "data": [
    {
      "template_id": "1023948",
      "template_name": "loan_disbursed_notification",
      "status": "APPROVED"
    },
    {
      "template_id": "1024012",
      "template_name": "kyc_pending_followup",
      "status": "PENDING"
    }
  ]
}
```

**Fields:**
- `template_id` - Use this when sending messages
- `template_name` - Human-readable identifier
- `status` - APPROVED, PENDING, or REJECTED

### Campaign Links Response

```json
{
  "status": "true",
  "code": "200",
  "data": [
    {
      "link_id": "cl_7841",
      "link_name": "BL_June_Payday_Campaign",
      "url": "https://anantadot.com/l/7841abc"
    }
  ]
}
```

**Fields:**
- `link_id` - Unique link identifier
- `link_name` - Campaign name
- `url` - Trackable link to use in messages

### Webhooks Response

```json
{
  "status": "true",
  "code": "200",
  "data": [
    {
      "webhook_url": "https://buddyloan.example.com/webhooks/ananta/delivery",
      "events": ["message_delivered", "message_read", "message_failed"]
    }
  ]
}
```

**Fields:**
- `webhook_url` - Your webhook endpoint
- `events` - Events this webhook receives

## 4. Send WhatsApp Messages Using Templates

### API Endpoint

```bash
POST https://utilsapi.anantadot.com/waba/sendmessage
Header: api_key: YOUR_ANANTA_API_KEY
Content-Type: application/json
```

### Send Simple Message

```bash
curl -X POST "https://utilsapi.anantadot.com/waba/sendmessage" \
  -H "Content-Type: application/json" \
  -H "api_key: YOUR_API_KEY" \
  -d '{
    "template": "1023948",
    "phone": "+919876543210",
    "is_short_url": "0"
  }'
```

### Send Message with Variables

```bash
curl -X POST "https://utilsapi.anantadot.com/waba/sendmessage" \
  -H "Content-Type: application/json" \
  -H "api_key: YOUR_API_KEY" \
  -d '{
    "template": "1023948",
    "phone": "+919876543210",
    "placeholders": ["John Doe", "50,000"],
    "is_short_url": "0"
  }'
```

### Send with Header and Buttons

```bash
curl -X POST "https://utilsapi.anantadot.com/waba/sendmessage" \
  -H "Content-Type: application/json" \
  -H "api_key: YOUR_API_KEY" \
  -d '{
    "template": "1023948",
    "phone": "+919876543210",
    "placeholders": ["John Doe", "50,000"],
    "header": {
      "type": "image",
      "link": "https://example.com/banner.jpg"
    },
    "buttons": {
      "button_url": "https://anantadot.com/l/7841abc"
    },
    "is_short_url": "1"
  }'
```

### Shortening the link (`is_short_url`)

The IVR keypress webhook sends the lender journey URL, and for Poonawalla
Fincorp that is ~190 characters:

```
https://instant-pocket-loan.poonawallafincorp.com/?utm_DSA_Code=PKA00192&UTM_Partner_Name=BuddyLoan&UTM_Partner_Medium=BDLParameter&UTM_Partner_AgentCode=IVRSMS&UTM_Partner_ReferenceID=PK2002
```

On a phone that wraps over three lines, none of it means anything to the person
reading it, and a wall of tracking parameters is what a scam message looks
like. Setting `is_short_url` to `"1"` has Ananta rewrite it to
`anantadot.com/l/<code>` — roughly 30 characters — before the message goes out.

`lib/routes/ivrWhatsAppRoutes.js` sends `"1"` by default. To send links at full
length again:

```bash
ANANTA_IS_SHORT_URL=0
```

**Two things to know.**

*It is Ananta's redirect, so the click is recorded in their panel*, against
their message id, and does not reach `whatsapp_messages`. Our send log still
records the URL we handed them, so what a customer was sent stays answerable
from our side — but whether they opened it does not. Their **Click URL**
webhook is the way to close that: it is configured on the same screen as the
DLR webhook (a bare URL field, no custom headers — so authenticate it with
`?token=<secret>`, the way `/webhooks/ananta` does).

*Confirm it applies to your template.* Ananta documents `is_short_url` on the
send API but only shows it worked through in the example carrying a
`buttons.button_url`. Our templates put the link in a **body placeholder**
instead, and nothing in their documentation says outright whether the shortener
rewrites those too. One test call settles it — send to your own number and look
at what arrives:

```bash
curl -X POST "https://utilsapi.anantadot.com/waba/sendmessage" \
  -H "Content-Type: application/json" \
  -H "api_key: $ANANTA_API_KEY" \
  -d '{
    "template": "<your template id>",
    "phone": "<your mobile>",
    "is_short_url": "1",
    "message": { "placeholders": [" ", "https://instant-pocket-loan.poonawallafincorp.com/?utm_DSA_Code=PKA00192&UTM_Partner_Name=BuddyLoan&UTM_Partner_Medium=BDLParameter&UTM_Partner_AgentCode=IVRSMS&UTM_Partner_ReferenceID=PK2002" ] }
  }'
```

If the link arrives at full length, the shortener only covers button URLs, and
shortening a body link needs either a template whose button carries the URL or
a redirect of our own.

## 5. Integration with IVR Router

### Configuration

Add to `.env`:

```bash
ANANTA_API_KEY=your_api_key_for_sending
ANANTA_API_TOKEN=your_api_token_for_data_api
ANANTA_API_SECRET_KEY=your_api_secret_key
```

### Use in Routes

```javascript
import AnantaDataClient from './lib/anantaDataClient.js';
import AnantaApiClient from './lib/anantaApiClient.js';

// Fetch templates
const dataClient = new AnantaDataClient();
const templates = await dataClient.getApprovedTemplates();

// Send message
const apiClient = new AnantaApiClient(
  'https://data-api.anantadot.com',
  process.env.ANANTA_API_TOKEN,
  process.env.ANANTA_API_SECRET_KEY
);

await apiClient.sendWhatsAppMessage(
  '9876543210',
  '1023948',  // template ID from templates above
  'Custom message text'
);
```

## 6. Common Workflows

### Workflow 1: Campaign Launch

```bash
# 1. Fetch all templates
./scripts/fetchAnantaData.sh

# 2. Review templates in ananta_data/templates_approved_*.json

# 3. Get template ID you want to use
TEMPLATE_ID="1023948"

# 4. Fetch customer list
# (using OBD or Ananta customer data)

# 5. Send WhatsApp messages using the template
# Use anantaApiClient.bulkSendWhatsApp()

# 6. Monitor delivery via webhooks
# Webhooks configured in ananta_data/webhooks_*.json
```

### Workflow 2: OBD + Ananta Coordinated Campaign

```javascript
// 1. Start OBD voice campaign
const voiceCampaign = await obdClient.composeCampaign({
  campaignName: "Loan Offer - Voice + WhatsApp",
  // ... OBD config
});

// 2. Get approved templates for follow-up
const templates = await anantaDataClient.getApprovedTemplates();
const followUpTemplate = templates.data.find(
  t => t.template_name === 'loan_offer_followup'
);

// 3. Get customers
const customers = await anantaClient.getCustomersByDemographics({
  ageMin: 25,
  ageMax: 50
});

// 4. Send WhatsApp follow-up after voice call
await anantaClient.bulkSendWhatsApp(
  customers.customers,
  followUpTemplate.template_id,
  'Your loan offer is ready!'
);

// 5. Track both channels
const voiceStats = await obdClient.analyzeCampaign(...);
const whatsappStats = await anantaClient.getDeliveryStats(...);
```

### Workflow 3: Template Validation

```javascript
// Check if specific template exists and is approved
const template = await anantaDataClient.findTemplateByName('loan_disbursed_notification');

if (template && template.status === 'APPROVED') {
  console.log(`✓ Template ${template.template_id} is ready to use`);
} else if (template && template.status === 'PENDING') {
  console.log('⚠ Template is pending approval');
} else {
  console.log('✗ Template not found');
}
```

## 7. Environment Variables

Create a `.env` file (never commit to git):

```bash
# Ananta API Credentials
ANANTA_API_KEY=your_api_key_from_dashboard
ANANTA_API_TOKEN=your_api_token_from_dashboard
ANANTA_API_SECRET_KEY=your_api_secret_key_from_dashboard

# Optional: override base URL if needed
ANANTA_DATA_BASE_URL=https://data-api.anantadot.com
ANANTA_UTILS_BASE_URL=https://utilsapi.anantadot.com

# Shorten links in outgoing messages. Defaults to 1; set 0 to send full URLs.
ANANTA_IS_SHORT_URL=1
```

## 8. Troubleshooting

### "Missing ANANTA_API_TOKEN / ANANTA_API_SECRET_KEY"

**Fix:** Set environment variables before running:

```bash
export ANANTA_API_TOKEN="your_token"
export ANANTA_API_SECRET_KEY="your_secret"
```

### Templates list is empty

**Possible causes:**
- No templates created yet in Ananta
- Credentials are incorrect
- Account doesn't have access to templates API

**Fix:**
1. Verify credentials in Ananta dashboard
2. Check if any templates exist
3. Contact Ananta support if issue persists

### "Request failed with HTTP 401"

**Cause:** Credentials are invalid or expired

**Fix:**
1. Go to https://anantadot.com/dashboard
2. Click "Manage API Key" and regenerate if needed
3. Update your .env with new credentials

### Webhook events not arriving

**Possible causes:**
- Webhook URL not configured in Ananta
- Network connectivity issues
- Firewall blocking inbound requests

**Fix:**
1. Verify webhook URL exists: `./scripts/fetchAnantaData.sh`
2. Check `/webhooks/ananta` endpoint is accessible
3. Test with curl from your server to ensure connectivity

## 9. API Reference

### AnantaDataClient Methods

```javascript
// Get templates
await client.getApprovedTemplates()     // GET /WhatsApp/templates/approved
await client.listTemplates()             // POST /WhatsApp/list-templates

// Get campaign links
await client.getCampaignLinks()         // GET /Campaigns/links

// Get webhooks
await client.listWebhooks()             // POST /Webhooks/list

// Get all data at once
await client.getAllData()               // All 3 above in parallel

// Helpers
await client.getTemplatesByStatus('APPROVED')
await client.findTemplateById('1023948')
await client.findTemplateByName('loan_disbursed')
await client.findCampaignLinkByName('june_campaign')
await client.isWebhookConfigured('https://...')
```

### AnantaApiClient Methods

```javascript
// Send messages
await client.sendWhatsAppMessage(phone, templateId, messageText)
await client.bulkSendWhatsApp(segment, templateId, messageText)

// Customer management
await client.sendCustomerData(customers)
await client.getCustomer(phoneNumber)
await client.getCustomersByDemographics(criteria)

// Analytics
await client.getDeliveryStats(campaignId, startDate, endDate)
```

## 10. Next Steps

1. ✅ Set up credentials in `.env`
2. ✅ Run `./scripts/fetchAnantaData.sh` to see available templates
3. ✅ Note template IDs to use in campaigns
4. ✅ Test sending a message with `/api/ananta/messages/send`
5. ✅ Monitor delivery via `/webhooks/ananta`
6. ✅ Integrate with OBD for multi-channel campaigns

## Support

- **Ananta Docs:** https://anantadot.com/WAtransactionalAPIdocument
- **IVR Router:** See `ANANTA_INTEGRATION_GUIDE.md` for detailed API docs
- **GitHub:** Check `lib/anantaDataClient.js` and `lib/anantaApiClient.js` for code examples

---

Last Updated: 2024-08-25
