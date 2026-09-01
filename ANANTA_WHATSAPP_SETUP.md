# Ananta WhatsApp Integration - FlexiLoans Campaign

**Status:** ✅ Complete  
**Date:** 2025-08-29  
**Feature:** Send FlexiLoans link via Ananta WhatsApp after DTMF Press 1

---

## Overview

When a lead presses **1** on the IVR (interested), the system automatically sends a WhatsApp message via Ananta with the FlexiLoans document verification link.

### Flow
```
Lead Calls IVR
    ↓
Presses 1 → "Interested in FlexiLoans"
    ↓
System captures phone + details
    ↓
Sends WhatsApp via ANANTA ✅
    ↓
Message includes: FlexiLoans Link
https://s1.whistleloop.com/?linkid=1710&offerid=178&...
    ↓
Lead clicks → Document Collection
```

---

## Configuration

### 1. **Environment Variables**

Add to your `.env` file:

```bash
# Ananta WhatsApp API
ANANTA_API_ENDPOINT=https://api.ananta.io/v1/messages/send
ANANTA_API_KEY=your_ananta_api_key_here
ANANTA_PHONE_NUMBER=+91XXXXXXXXXX
ANANTA_ACCOUNT_ID=your_account_id
ANANTA_WEBHOOK_URL=https://automation-hub.local/api/webhooks/ananta/status
ANANTA_DEBUG=false
```

### 2. **Get Ananta Credentials**

1. Log in to [Ananta Dashboard](https://dashboard.ananta.io)
2. Go to **Settings → API Keys**
3. Create new API key for WhatsApp
4. Copy:
   - **API Key** → `ANANTA_API_KEY`
   - **Phone Number** → `ANANTA_PHONE_NUMBER`
   - **Account ID** → `ANANTA_ACCOUNT_ID`

### 3. **WhatsApp Message Template**

The system sends this message format:

```
Hi {name} 🎉

We have a personalized loan offer for you with FlexiLoans!

📋 Complete your document verification here:
https://s1.whistleloop.com/?linkid=1710&offerid=178&publisher_id=259&parentid=259&pub_name=BuddyAdsIndia&sub_id1=PTest_alias_{phone}&loop_id={campaign_id}

✅ Quick & Secure
✅ Up to ₹50L
✅ Instant Approval

Click above to get started!
```

**Variables:**
- `{name}` → Lead name
- `{phone}` → Lead phone number
- `{campaign_id}` → Campaign ID
- `{lead_id}` → Lead ID

---

## Implementation

### Service File
- **Path:** `ivr-router/lib/services/anantaWhatsAppService.js`
- **Methods:**
  - `sendMessage()` - Send single WhatsApp
  - `sendBulkMessages()` - Send to multiple leads
  - `getMessageStatus()` - Check delivery status
  - `formatFlexiLoansMessage()` - Format FlexiLoans message

### Integration Points

#### 1. **In IVR Campaign Routes** (`ivrCampaignsRoutes.js`)
```javascript
const AnantaWhatsAppService = require('../services/anantaWhatsAppService');

// When Press 1 is triggered:
if (dtmfOptions.press1.whatsapp_provider === 'ananta') {
  await AnantaWhatsAppService.sendMessage({
    phone: lead.phone,
    message: dtmfOptions.press1.whatsapp_message,
    campaignId: campaign.id,
    leadId: lead.id,
  });
}
```

#### 2. **In Lead Management** 
When a lead presses 1 → Ananta WhatsApp sends message automatically

#### 3. **Webhook Handler** (Optional)
```javascript
// GET /api/webhooks/ananta/status
// Receives delivery status from Ananta
// Updates ivr_campaign_events table
```

---

## Campaign Data Structure

### Campaign Configuration Includes:
```json
{
  "dtmfOptions": {
    "press1": {
      "action": "route_to_lender",
      "primary_lender": "flexiloans",
      "channel": "whatsapp",
      "whatsapp_provider": "ananta",
      "whatsapp_bot_endpoint": "https://s1.whistleloop.com/...",
      "whatsapp_api_endpoint": "https://api.ananta.io/v1/messages/send",
      "whatsapp_message": "Hi {name}! We have a personalized loan offer..."
    }
  }
}
```

---

## Metrics & Tracking

### Metrics Tracked:
- `whatsapp_sent_count` - Total WhatsApp messages sent
- `whatsapp_delivered_count` - Messages delivered
- `whatsapp_opened_count` - Messages opened/clicked
- `documents_collected_count` - Documents collected from links

### Events Logged:
- `whatsapp_sent` - When message is queued
- `whatsapp_delivered` - When Ananta confirms delivery
- `whatsapp_opened` - When lead clicks link (via webhook)

### Table: `ivr_campaign_events`
```sql
INSERT INTO public.ivr_campaign_events (
  campaign_id,
  phone_number,
  event_type,      -- 'whatsapp_sent', 'whatsapp_delivered'
  metadata
) VALUES (...)
```

---

## Testing the Integration

### 1. **Via Dashboard**
1. Go to ☎️ **IVR Campaigns**
2. Create campaign with:
   - Primary Lender: **FlexiLoans**
   - WhatsApp Provider: **Ananta**
   - WhatsApp Bot Endpoint: Pre-filled
3. Click **Launch**

### 2. **Manual Test (API)**

This step used to create a campaign through `POST /api/ivr-campaigns`. That
endpoint was retired on 1 Sep 2026 (`docs/RETIRED_ENDPOINTS.md`) — campaigns
live in the CRM now. To test the Ananta leg on its own, which is what this
guide is about, send one message:

```bash
curl -X POST http://localhost:3000/api/ananta/messages/send \
  -H "Content-Type: application/json" \
  -d '{"phoneNumber": "919812345678", "templateId": "<approved template id>"}'
```

(`phoneNumber` and `templateId` are both required — `lib/anantaRoutes.js` 400s
without them.)

### 3. **Check Logs**
```bash
# Watch service logs
tail -f logs/ananta-whatsapp.log

# Should show:
# 📱 Sending WhatsApp via Ananta: {...}
```

---

## Troubleshooting

### Issue: Messages not sending
**Solution:**
1. Verify `ANANTA_API_KEY` is correct
2. Check `ANANTA_PHONE_NUMBER` format (include country code)
3. Enable debug: `ANANTA_DEBUG=true`
4. Check logs for API errors

### Issue: Wrong template variables
**Solution:**
1. Verify lead object has: `phone`, `name`, `id`
2. Check campaign has `id` and `campaignId`
3. Variables are case-sensitive: `{name}` not `{Name}`

### Issue: High failure rate
**Solution:**
1. Check lead phone numbers are valid (+91XXXXXXXXXX)
2. Verify Ananta account has WhatsApp credits
3. Check rate limiting (100ms between sends)

---

## Production Checklist

- [ ] Add `ANANTA_API_KEY` to production `.env`
- [ ] Add `ANANTA_PHONE_NUMBER` to production `.env`
- [ ] Test with real lead phone numbers
- [ ] Monitor delivery rates
- [ ] Set up webhook for status tracking
- [ ] Configure retry logic for failed sends
- [ ] Set up alerting for >5% failure rate
- [ ] Document Ananta account support contact

---

## Support Links

- **Ananta Docs:** https://docs.ananta.io
- **Ananta Dashboard:** https://dashboard.ananta.io
- **API Reference:** https://api.ananta.io/docs
- **Support:** support@ananta.io

---

## Cost Estimation

| Metric | Cost |
|--------|------|
| Per WhatsApp message | ₹0.50 - ₹2.00 |
| Per 500 leads | ₹250 - ₹1,000 |
| Monthly (10K messages) | ₹5,000 - ₹20,000 |

*Actual cost varies based on Ananta pricing plan*

---

**Last Updated:** 2025-08-29  
**Prepared By:** Claude Code  
**Status:** Ready for Production
