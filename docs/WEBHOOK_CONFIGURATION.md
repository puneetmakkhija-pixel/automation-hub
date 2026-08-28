# Task 5: Lender Webhook Configuration Guide

## Overview
This guide configures webhooks for tracking message delivery, voice call events, and lender feedback across multiple providers.

---

## 1. Ananta WhatsApp Messaging Webhooks

### Endpoint
```
POST https://ivr-voice-bot-system-production.up.railway.app/webhooks/ananta
```

### Setup Instructions
1. **Log into Ananta Dashboard**
   - Go to https://data-api.anantadot.com/dashboard
   - Navigate to Settings → Webhooks

2. **Configure Webhook**
   - **Event Type:** Message Delivery
   - **Webhook URL:** `https://ivr-voice-bot-system-production.up.railway.app/webhooks/ananta`
   - **Method:** POST
   - **Content-Type:** application/json
   - **Authentication:** None (Internal API)

3. **Payload Format**
   ```json
   {
     "account_number": "ANANTA_ACCOUNT_ID",
     "phone": "919876543210",
     "status": "delivered|failed|read",
     "msgid": "msg_123456",
     "date": "2024-01-15T10:30:00Z",
     "template": "template_name",
     "campaign_date": "2024-01-15"
   }
   ```

### Test Payload
```bash
curl -X POST https://ivr-voice-bot-system-production.up.railway.app/webhooks/ananta \
  -H "Content-Type: application/json" \
  -d '{
    "account_number": "acc_12345",
    "phone": "919876543210",
    "status": "delivered",
    "msgid": "msg_987654",
    "date": "2024-01-15T10:30:00Z",
    "template": "order_confirmation",
    "campaign_date": "2024-01-15"
  }'
```

### Tracked Events
- ✓ Message sent
- ✓ Message delivered
- ✓ Message failed
- ✓ Message read
- ✓ Template usage
- ✓ Campaign tracking

---

## 2. MIS Feedback Webhooks (Lender Rejections)

### Poonawala MIS Endpoint
```
POST https://ivr-voice-bot-system-production.up.railway.app/api/mis/webhook/poonawalla
```

### Hero FinCorp MIS Endpoint
```
POST https://ivr-voice-bot-system-production.up.railway.app/api/mis/webhook/hero-fincorp
```

### Setup Instructions

#### For Poonawala:
1. **Contact Poonawala Integration Team**
   - Email: integrations@poonawalla.com
   - Request webhook configuration for MIS feedback

2. **Provide Webhook Details**
   - **URL:** `https://ivr-voice-bot-system-production.up.railway.app/api/mis/webhook/poonawalla`
   - **Method:** POST
   - **Content-Type:** application/json
   - **Events:** Application rejections, status updates

3. **Environment Variables Required**
   ```
   POONAWALLA_MIS_SECRET=<webhook_signing_secret>
   POONAWALLA_API_TOKEN=<api_token>
   ```

#### For Hero FinCorp:
1. **Contact Hero FinCorp Integration Team**
   - Email: api@herofincorp.com
   - Request webhook configuration for MIS reporting

2. **Provide Webhook Details**
   - **URL:** `https://ivr-voice-bot-system-production.up.railway.app/api/mis/webhook/hero-fincorp`
   - **Method:** POST
   - **Content-Type:** application/json
   - **Events:** Application rejections, status updates

3. **Environment Variables Required**
   ```
   HERO_FINCORP_MIS_SECRET=<webhook_signing_secret>
   HERO_FINCORP_API_TOKEN=<api_token>
   ```

### Payload Format
```json
{
  "source": "poonawalla|hero_fincorp",
  "reportDate": "2024-01-15",
  "records": [
    {
      "phone": "919876543210",
      "applicationId": "poo_123456",
      "status": "rejected|approved|pending",
      "rejectionCode": "CIBIL_LOW|BUREAU_INQUIRY|EXISTING_LOAN",
      "rejectionReason": "CIBIL score below minimum",
      "loanAmount": 500000,
      "appliedAt": "2024-01-15T09:00:00Z",
      "processedAt": "2024-01-15T10:30:00Z"
    }
  ]
}
```

### Test Payloads

#### Poonawala Test:
```bash
curl -X POST https://ivr-voice-bot-system-production.up.railway.app/api/mis/webhook/poonawalla \
  -H "Content-Type: application/json" \
  -d '{
    "source": "poonawalla",
    "reportDate": "2024-01-15",
    "records": [
      {
        "phone": "919876543210",
        "applicationId": "poo_123456",
        "status": "rejected",
        "rejectionCode": "CIBIL_LOW",
        "rejectionReason": "CIBIL score below minimum"
      }
    ]
  }'
```

#### Hero FinCorp Test:
```bash
curl -X POST https://ivr-voice-bot-system-production.up.railway.app/api/mis/webhook/hero-fincorp \
  -H "Content-Type: application/json" \
  -d '{
    "source": "hero_fincorp",
    "reportDate": "2024-01-15",
    "records": [
      {
        "phone": "919876543210",
        "applicationId": "hero_654321",
        "status": "rejected",
        "rejectionCode": "BUREAU_INQUIRY",
        "rejectionReason": "Too many recent inquiries"
      }
    ]
  }'
```

### Tracked Events
- ✓ Application rejected
- ✓ Application approved
- ✓ Rejection reason categorization
- ✓ BRE optimization insights
- ✓ Customer rejection history
- ✓ Daily MIS report processing

---

## 3. OBD Voice Call Webhooks

### Endpoints
```
POST /webhooks/obd              # Main webhook
POST /webhooks/obd/hangup       # Call hangup
POST /webhooks/obd/connect      # Call connect
POST /webhooks/obd/completion   # Campaign completion
```

### Setup Instructions (OBD API)
1. **Log into OBD API Portal**
   - Go to https://obdapi2.ivrsms.com/dashboard
   - Navigate to Webhooks section

2. **Configure Main Webhook**
   - **URL:** `https://ivr-voice-bot-system-production.up.railway.app/webhooks/obd`
   - **Events:** All voice events
   - **Retry Policy:** 3 retries with exponential backoff

3. **Configure Specific Webhooks** (Optional but recommended)
   - **Hangup:** `https://ivr-voice-bot-system-production.up.railway.app/webhooks/obd/hangup`
   - **Connect:** `https://ivr-voice-bot-system-production.up.railway.app/webhooks/obd/connect`
   - **Completion:** `https://ivr-voice-bot-system-production.up.railway.app/webhooks/obd/completion`

### Payload Formats

#### Call Connect Event
```json
{
  "eventType": "CALL_CONNECT",
  "payload": {
    "phone": "919876543210",
    "lenderId": "poonawala",
    "callSid": "call_123456",
    "campaignId": "camp_789",
    "callStartTime": "2024-01-15T10:30:00Z"
  }
}
```

#### DTMF Input Event
```json
{
  "eventType": "DTMF_INPUT",
  "payload": {
    "phone": "919876543210",
    "dtmfInput": "1",
    "lenderId": "poonawala",
    "callSid": "call_123456"
  }
}
```

#### Hangup Event
```json
{
  "phone": "919876543210",
  "callDuration": 45,
  "reason": "customer_ended",
  "callSid": "call_123456"
}
```

### Test Payload
```bash
curl -X POST https://ivr-voice-bot-system-production.up.railway.app/webhooks/obd/connect \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "919876543210",
    "lenderId": "poonawala",
    "callSid": "call_123456",
    "campaignId": "poonawala_stpl_batch_1724095200000_1"
  }'
```

### Tracked Events
- ✓ Incoming call
- ✓ DTMF key presses
- ✓ Call hangup
- ✓ Call duration
- ✓ Campaign completion
- ✓ Voice bot disposition capture

---

## 4. Chatsense Voice Disposition Webhooks

### Endpoint
```
POST https://ivr-voice-bot-system-production.up.railway.app/api/chatsense/voice-disposition
```

### Setup Instructions
1. **Configure in Chatsense Dashboard**
   - Navigate to Campaign Settings → Webhooks
   - **URL:** `https://ivr-voice-bot-system-production.up.railway.app/api/chatsense/voice-disposition`
   - **Trigger:** After DTMF capture and voice call completion

2. **Environment Variables**
   ```
   CHATSENSE_API_KEY=<api_key>
   CHATSENSE_BASE_URL=https://api.chatsense.ai
   ```

### Payload Format
```json
{
  "phone": "919876543210",
  "name": "Rajesh Kumar",
  "age": 32,
  "income": 500000,
  "pincode": "400001",
  "state": "Maharashtra",
  "email": "rajesh@email.com",
  "disposition": "interested|not_interested|callback_later",
  "callDuration": 45,
  "dtmfChoice": 1,
  "callSid": "call_123456",
  "campaignId": "poonawala_stpl_batch_1724095200000_1",
  "batchId": "batch_001",
  "metadata": {
    "ivrGreeting": "english",
    "customField": "value"
  }
}
```

### Test Payload
```bash
curl -X POST https://ivr-voice-bot-system-production.up.railway.app/api/chatsense/voice-disposition \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "919876543210",
    "name": "Test User",
    "disposition": "interested",
    "callDuration": 45,
    "dtmfChoice": 1,
    "callSid": "call_test_123"
  }'
```

### Tracked Events
- ✓ Voice call completion
- ✓ Customer disposition (interested/not interested)
- ✓ DTMF choice tracking
- ✓ Lead intake synchronization
- ✓ Customer demographic capture

---

## 5. Environment Variables Required

Add these to your `.env` file:

```bash
# Ananta Configuration
ANANTA_BASE_URL=https://data-api.anantadot.com
ANANTA_API_TOKEN=<your_api_token>
ANANTA_API_SEC_KEY=<your_secret_key>

# OBD API Configuration
OBD_BASE_URL=https://obdapi2.ivrsms.com
OBD_USERNAME=<username>
OBD_PASSWORD=<password>

# Chatsense Configuration
CHATSENSE_API_KEY=<api_key>
CHATSENSE_BASE_URL=https://api.chatsense.ai

# Lender MIS Secrets
POONAWALLA_MIS_SECRET=<webhook_secret>
POONAWALLA_API_TOKEN=<api_token>

HERO_FINCORP_MIS_SECRET=<webhook_secret>
HERO_FINCORP_API_TOKEN=<api_token>

# Supabase Configuration
SUPABASE_URL=<your_supabase_url>
SUPABASE_SERVICE_ROLE_KEY=<your_service_role_key>
```

---

## 6. Webhook Testing Checklist

- [ ] Ananta webhook configured and tested
- [ ] Poonawala MIS webhook configured and tested
- [ ] Hero FinCorp MIS webhook configured and tested
- [ ] OBD voice webhooks configured and tested
- [ ] Chatsense voice disposition webhook configured and tested
- [ ] All environment variables set in Railway
- [ ] SSL/TLS certificates verified
- [ ] Webhook signatures validated (where applicable)
- [ ] Retry policies configured
- [ ] Monitoring and logging enabled

---

## 7. Verification

To verify webhooks are working:

### 1. Check Webhook Logs
```bash
# View recent webhook events from the application logs
# Check Railway dashboard → Logs tab
```

### 2. Test Webhook Delivery
```bash
# Test each endpoint with sample payload
# Verify 200 OK response
```

### 3. Monitor Dashboard
```bash
# View webhook statistics
# Check delivery success rates
# Monitor failed deliveries
```

### 4. End-to-End Testing
- Trigger a voice call campaign
- Verify DTMF input captured
- Check MIS feedback received
- Confirm data in Supabase

---

## 8. Troubleshooting

### Webhook Not Received
1. Verify URL is correct and accessible from internet
2. Check firewall/network policies
3. Verify SSL certificate
4. Check webhook logs in provider dashboard

### 500 Error Responses
1. Check application logs in Railway
2. Verify all required environment variables are set
3. Check Supabase connectivity
4. Verify request payload format

### Timeout Issues
1. Increase webhook timeout settings in provider dashboard
2. Optimize database queries
3. Add caching where applicable
4. Scale application if under heavy load

---

## 9. Webhook Security

- [ ] Validate webhook signatures using provider secrets
- [ ] Use HTTPS only
- [ ] Implement rate limiting
- [ ] Log all webhook events
- [ ] Monitor for suspicious patterns
- [ ] Implement idempotency checks
- [ ] Encrypt sensitive data in transit

---

## 10. Support Contacts

| Provider | Email | Phone |
|----------|-------|-------|
| Ananta | support@anantadot.com | +91-XXXX-XXXXXX |
| OBD API | support@obdapi.com | +91-XXXX-XXXXXX |
| Poonawala | integrations@poonawalla.com | +91-XXXX-XXXXXX |
| Hero FinCorp | api@herofincorp.com | +91-XXXX-XXXXXX |
| Chatsense | support@chatsense.ai | +91-XXXX-XXXXXX |
