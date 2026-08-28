# Task 5: Configure Lender Webhooks - Implementation Plan

## Current Status

### ✅ Completed (Task 4)
- API server is running and all 48 endpoints are tested and working
- All routes have proper error handling and status codes
- Health check endpoints verify service availability
- Webhook endpoints are ready to receive data from external providers

### 🔄 In Progress (Task 5)
- Webhook configuration with external providers
- Environment variable setup
- Webhook signature validation (where applicable)
- End-to-end testing

---

## Webhook Implementation Steps

### Step 1: Configure Ananta Webhooks (WhatsApp Messaging)

**Status:** Ready for configuration

**What to do:**
1. Log into Ananta dashboard (https://data-api.anantadot.com/dashboard)
2. Navigate to Settings → Webhooks → Add New Webhook
3. Configure with these details:
   - **Name:** "IVR Router Delivery Tracking"
   - **URL:** `https://ivr-voice-bot-system-production.up.railway.app/webhooks/ananta`
   - **Event Types:** Message delivery, Message failed, Message read
   - **Authentication:** None (internal)
   - **Retry Policy:** 3 retries

4. Test with sample payload:
   ```bash
   curl -X POST https://ivr-voice-bot-system-production.up.railway.app/webhooks/ananta \
     -H "Content-Type: application/json" \
     -d '{
       "phone": "919876543210",
       "status": "delivered",
       "msgid": "test_123"
     }'
   ```

5. Verify response: Should return 200 with `{ "success": true, ... }`

---

### Step 2: Configure Poonawala MIS Feedback Webhooks

**Status:** Requires API setup with Poonawala

**What to do:**
1. Contact Poonawala Integration Team
   - Email: integrations@poonawalla.com
   - Request webhook setup for MIS daily reports

2. Provide these webhook details:
   - **URL:** `https://ivr-voice-bot-system-production.up.railway.app/api/mis/webhook/poonawalla`
   - **Method:** POST
   - **Content-Type:** application/json
   - **Events:** Daily MIS report delivery

3. Get from Poonawala:
   - API token
   - Webhook signing secret (if using signature validation)
   - Report delivery schedule/timing

4. Add environment variables in Railway:
   ```
   POONAWALLA_API_TOKEN=<token_from_poonawala>
   POONAWALLA_MIS_SECRET=<webhook_secret>
   ```

5. Test endpoint:
   ```bash
   curl -X POST https://ivr-voice-bot-system-production.up.railway.app/api/mis/webhook/poonawalla \
     -H "Content-Type: application/json" \
     -d '{
       "source": "poonawalla",
       "reportDate": "2024-01-15",
       "records": [{
         "phone": "919876543210",
         "applicationId": "poo_123",
         "status": "rejected",
         "rejectionCode": "CIBIL_LOW"
       }]
     }'
   ```

---

### Step 3: Configure Hero FinCorp MIS Feedback Webhooks

**Status:** Requires API setup with Hero FinCorp

**What to do:**
1. Contact Hero FinCorp Integration Team
   - Email: api@herofincorp.com
   - Request webhook setup for MIS daily reports

2. Provide these webhook details:
   - **URL:** `https://ivr-voice-bot-system-production.up.railway.app/api/mis/webhook/hero-fincorp`
   - **Method:** POST
   - **Content-Type:** application/json
   - **Events:** Daily MIS report delivery

3. Get from Hero FinCorp:
   - API token
   - Webhook signing secret (if applicable)
   - Report format specifications

4. Add environment variables in Railway:
   ```
   HERO_FINCORP_API_TOKEN=<token_from_herofincorp>
   HERO_FINCORP_MIS_SECRET=<webhook_secret>
   ```

5. Test endpoint:
   ```bash
   curl -X POST https://ivr-voice-bot-system-production.up.railway.app/api/mis/webhook/hero-fincorp \
     -H "Content-Type: application/json" \
     -d '{
       "source": "hero_fincorp",
       "reportDate": "2024-01-15",
       "records": [{
         "phone": "919876543210",
         "applicationId": "hero_456",
         "status": "rejected",
         "rejectionCode": "BUREAU_INQUIRY"
       }]
     }'
   ```

---

### Step 4: Configure OBD Voice Call Webhooks

**Status:** Ready for configuration

**What to do:**
1. Log into OBD API dashboard (https://obdapi2.ivrsms.com/dashboard)
2. Navigate to API Settings → Webhooks → Configure

3. Set up main webhook:
   - **URL:** `https://ivr-voice-bot-system-production.up.railway.app/webhooks/obd`
   - **Events:** All voice call events
   - **Retry:** 3 retries with backoff
   - **Timeout:** 30 seconds

4. (Optional) Set up specific webhooks for better tracking:
   - Call Connect: `https://ivr-voice-bot-system-production.up.railway.app/webhooks/obd/connect`
   - Call Hangup: `https://ivr-voice-bot-system-production.up.railway.app/webhooks/obd/hangup`
   - Campaign Complete: `https://ivr-voice-bot-system-production.up.railway.app/webhooks/obd/completion`

5. Test webhook:
   ```bash
   curl -X POST https://ivr-voice-bot-system-production.up.railway.app/webhooks/obd/connect \
     -H "Content-Type: application/json" \
     -d '{
       "phone": "919876543210",
       "lenderId": "poonawala",
       "callSid": "call_123"
     }'
   ```

---

### Step 5: Configure Chatsense Voice Disposition Webhooks

**Status:** Requires Chatsense account configuration

**What to do:**
1. Log into Chatsense dashboard
2. Navigate to Campaign Settings → Webhooks

3. Configure voice disposition webhook:
   - **URL:** `https://ivr-voice-bot-system-production.up.railway.app/api/chatsense/voice-disposition`
   - **Trigger:** After DTMF capture
   - **Method:** POST

4. Add environment variables:
   ```
   CHATSENSE_API_KEY=<your_api_key>
   CHATSENSE_BASE_URL=https://api.chatsense.ai
   ```

5. Test endpoint:
   ```bash
   curl -X POST https://ivr-voice-bot-system-production.up.railway.app/api/chatsense/voice-disposition \
     -H "Content-Type: application/json" \
     -d '{
       "phone": "919876543210",
       "name": "Test User",
       "disposition": "interested",
       "callDuration": 45,
       "dtmfChoice": 1,
       "callSid": "call_test"
     }'
   ```

---

## Railway Environment Variables Setup

1. Go to Railway dashboard → Your Project → Variables
2. Add these environment variables:

```
# Ananta Configuration
ANANTA_BASE_URL=https://data-api.anantadot.com
ANANTA_API_TOKEN=<get_from_ananta>
ANANTA_API_SEC_KEY=<get_from_ananta>

# OBD Configuration
OBD_BASE_URL=https://obdapi2.ivrsms.com
OBD_USERNAME=<get_from_obd>
OBD_PASSWORD=<get_from_obd>

# Lender MIS Webhooks
POONAWALLA_API_TOKEN=<get_from_poonawala>
POONAWALLA_MIS_SECRET=<get_from_poonawala>

HERO_FINCORP_API_TOKEN=<get_from_hero>
HERO_FINCORP_MIS_SECRET=<get_from_hero>

# Chatsense Configuration
CHATSENSE_API_KEY=<get_from_chatsense>
CHATSENSE_BASE_URL=https://api.chatsense.ai

# Supabase Configuration (already set)
SUPABASE_URL=<your_supabase_url>
SUPABASE_SERVICE_ROLE_KEY=<your_key>
```

---

## Webhook Verification Checklist

### Ananta Webhooks
- [ ] Dashboard webhook configured
- [ ] Test payload successfully processed
- [ ] Webhook logs show delivery events
- [ ] Failed deliveries tracked
- [ ] Message templates properly logged

### Poonawala MIS Webhooks
- [ ] Integration team contacted
- [ ] API credentials obtained
- [ ] Environment variables set in Railway
- [ ] Daily report receiving working
- [ ] Rejection codes properly categorized
- [ ] BRE optimization reports generated

### Hero FinCorp MIS Webhooks
- [ ] Integration team contacted
- [ ] API credentials obtained
- [ ] Environment variables set in Railway
- [ ] Daily report receiving working
- [ ] Rejection tracking functioning
- [ ] Application status updates processed

### OBD Voice Webhooks
- [ ] Main webhook configured
- [ ] Call events received and logged
- [ ] DTMF input tracking working
- [ ] Call hangup events recorded
- [ ] Campaign completion tracked

### Chatsense Voice Disposition
- [ ] Webhook endpoint configured
- [ ] Voice disposition capturing
- [ ] Customer data enrichment working
- [ ] Lead intake synchronization active

---

## Monitoring & Logging

### View Webhook Events
1. Railway Dashboard → Logs
2. Filter for webhook events:
   ```
   - "Ananta Delivery Webhook"
   - "Poonawalla webhook"
   - "Hero FinCorp webhook"
   - "OBD webhook"
   - "Chatsense voice disposition"
   ```

### Check Webhook Failures
1. Search logs for "webhook error"
2. Check HTTP status codes
3. Review error messages
4. Verify payload format

### Performance Monitoring
1. Check response times (target: < 1 second)
2. Monitor retry counts
3. Track failed deliveries
4. Alert on threshold violations

---

## Troubleshooting

### Webhook Not Received
- [ ] Verify URL is correct and publicly accessible
- [ ] Check SSL/TLS certificate validity
- [ ] Verify network/firewall policies
- [ ] Check webhook configuration in provider dashboard
- [ ] Look for DNS resolution issues

### Authentication Failures
- [ ] Verify API keys and tokens are correct
- [ ] Check webhook signing secrets
- [ ] Verify token expiration dates
- [ ] Check authorization headers

### Payload Format Errors
- [ ] Compare actual payload with documentation
- [ ] Validate JSON structure
- [ ] Check for required fields
- [ ] Verify data types match expectations

### Database Errors
- [ ] Verify Supabase connectivity
- [ ] Check database schema
- [ ] Verify table permissions
- [ ] Check for connection pool exhaustion

---

## Timeline

| Task | Timeline | Status |
|------|----------|--------|
| Ananta webhook setup | 1-2 hours | Ready |
| Poonawala coordination | 1-2 days | Awaiting contact |
| Hero FinCorp coordination | 1-2 days | Awaiting contact |
| OBD webhook configuration | 1-2 hours | Ready |
| Chatsense setup | 1-2 hours | Ready |
| End-to-end testing | 2-4 hours | Pending |
| Production deployment | 1 hour | Pending |

---

## Next Steps

1. **Immediate (Today)**
   - Set up Ananta webhook
   - Configure OBD webhook
   - Test both endpoints

2. **This Week**
   - Contact Poonawala and Hero FinCorp
   - Get API credentials
   - Set up environment variables

3. **Next Week**
   - Set up Chatsense webhook
   - Complete end-to-end testing
   - Production deployment
   - Monitoring and alerting setup

---

## Support & Questions

For questions about webhook configuration:
1. Review the detailed WEBHOOK_CONFIGURATION.md guide
2. Check Railway deployment logs
3. Test endpoints manually with curl
4. Contact provider support teams using emails in the guide

---

## Success Criteria

✅ All webhook endpoints returning 200 OK for valid requests
✅ All external providers sending data successfully
✅ Data properly persisted in Supabase
✅ Logs showing successful event processing
✅ No failed or unprocessed webhook events
✅ End-to-end testing successful
✅ Monitoring and alerts configured
