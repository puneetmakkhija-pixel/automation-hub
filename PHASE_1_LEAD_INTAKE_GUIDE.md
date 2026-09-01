# Phase 1: Lead Intake Pipeline — Implementation Guide

**Status:** Ready for Integration Testing
**Date:** 2026-08-25
**Integration Points:** Automation Hub ↔ Business Loans CRM

---

## Overview

Phase 1 automates the lead intake pipeline from OBD voice calls → Chatsense disposition capture → CRM application creation.

**Current Flow (Manual):**
```
OBD Voice Call → Chatsense captures DTMF → Manual entry in CRM (4h delay) → Missed leads
```

**New Flow (Automated):**
```
OBD Voice Call → Chatsense captures DTMF → lead_intake_sync RPC → Application in CRM (30 seconds)
```

**Timeline:** Customer appears in CRM queue immediately after hanging up. Agents see real-time applications ready for follow-up.

---

## Prerequisites

### Automation Hub Side (✅ Complete)

- ✅ `crmIntegrationClient.js` — CRM API client
- ✅ `crmIntegrationRoutes.js` — REST endpoints for lead intake
- ⚠️ `chatsenseRoutes.js` — **deleted on 1 Sep 2026.** It carried a second,
  equivalent `voice-disposition` entry point; `/api/crm/lead-intake-sync`
  below is now the only one.
- ✅ `index.js` — Mounted `/api/crm` routes

**Environment Variables Required:**
```bash
# CRM Supabase (same as automation-hub or separate)
CRM_SUPABASE_URL=https://your-crm-project.supabase.co
CRM_SUPABASE_SERVICE_ROLE_KEY=your_service_role_key

# OBD (existing)
OBD_BASE_URL=https://obdapi2.ivrsms.com
OBD_USERNAME=your_username
OBD_PASSWORD=your_password
```

### CRM Side (Required - Implement in dsa-business-crm)

**Supabase Tables Required:**

```sql
-- 1. Main applications table (if not exists)
CREATE TABLE crm.leads (
  application_id TEXT PRIMARY KEY,
  phone TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  age INTEGER,
  income NUMERIC,
  pincode TEXT,
  state TEXT,
  email TEXT,
  channel TEXT, -- 'obd_voice', 'whatsapp', 'email'
  stage TEXT, -- 'Lead', 'Documents', 'Login', 'MTC', 'Sanction', 'Disbursal', 'Billing'
  substage TEXT, -- 'contacted', 'interested', 'callback', 'rejected'
  disposition TEXT, -- 'interested', 'callback', 'rejected', 'agent_connect'
  call_duration INTEGER,
  dtmf_choice INTEGER,
  answered BOOLEAN DEFAULT false,
  call_recording_url TEXT,
  eligible_lenders TEXT[], -- ['poonawala', 'hdfc', 'hero']
  best_lender TEXT,
  campaign_id TEXT,
  batch_id INTEGER,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 2. Audit trail for lead events
CREATE TABLE crm.lead_events (
  id BIGSERIAL PRIMARY KEY,
  application_id TEXT REFERENCES crm.leads(application_id),
  event_type TEXT, -- 'voice_disposition', 'document_received', etc.
  event_data JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Create indexes
CREATE INDEX ON crm.leads(phone);
CREATE INDEX ON crm.leads(campaign_id);
CREATE INDEX ON crm.leads(stage);
CREATE INDEX ON crm.lead_events(application_id);
```

**Supabase RPC Function:**

```sql
-- RPC: lead_intake_sync
-- Called by: Automation Hub /api/crm/lead-intake-sync endpoint
-- Purpose: Create application record from voice disposition
CREATE OR REPLACE FUNCTION crm.lead_intake_sync(
  p_phone TEXT,
  p_name TEXT,
  p_age INTEGER DEFAULT NULL,
  p_income NUMERIC DEFAULT NULL,
  p_pincode TEXT DEFAULT NULL,
  p_state TEXT DEFAULT NULL,
  p_email TEXT DEFAULT NULL,
  p_channel TEXT DEFAULT 'obd_voice',
  p_disposition TEXT DEFAULT 'contacted',
  p_call_duration INTEGER DEFAULT 0,
  p_dtmf_choice INTEGER DEFAULT NULL,
  p_campaign_id TEXT DEFAULT NULL,
  p_batch_id INTEGER DEFAULT NULL,
  p_ivr_greeting TEXT DEFAULT NULL,
  p_metadata TEXT DEFAULT '{}'
)
RETURNS TABLE (
  application_id TEXT,
  success BOOLEAN,
  message TEXT
) AS $$
DECLARE
  v_app_id TEXT;
  v_phone_exists BOOLEAN;
BEGIN
  -- Generate unique application ID
  v_app_id := 'app_' || gen_random_uuid()::TEXT;

  -- Check if phone already exists (dedupe)
  SELECT EXISTS(SELECT 1 FROM crm.leads WHERE phone = p_phone)
  INTO v_phone_exists;

  IF v_phone_exists THEN
    -- Update existing application
    UPDATE crm.leads
    SET
      disposition = p_disposition,
      call_duration = p_call_duration,
      dtmf_choice = p_dtmf_choice,
      channel = p_channel,
      campaign_id = COALESCE(p_campaign_id, campaign_id),
      batch_id = COALESCE(p_batch_id, batch_id),
      updated_at = NOW()
    WHERE phone = p_phone
    RETURNING application_id INTO v_app_id;

    RETURN QUERY SELECT v_app_id, true::BOOLEAN, 'Application updated'::TEXT;
  ELSE
    -- Create new application
    INSERT INTO crm.leads (
      application_id, phone, name, age, income, pincode, state, email,
      channel, stage, substage, disposition, call_duration, dtmf_choice,
      campaign_id, batch_id, created_at, updated_at
    ) VALUES (
      v_app_id, p_phone, p_name, p_age, p_income, p_pincode, p_state, p_email,
      p_channel, 'Lead', 'contacted', p_disposition, p_call_duration, p_dtmf_choice,
      p_campaign_id, p_batch_id, NOW(), NOW()
    );

    -- Log event
    INSERT INTO crm.lead_events (application_id, event_type, event_data)
    VALUES (
      v_app_id,
      'voice_disposition',
      jsonb_build_object(
        'disposition', p_disposition,
        'call_duration', p_call_duration,
        'dtmf_choice', p_dtmf_choice,
        'campaign_id', p_campaign_id,
        'batch_id', p_batch_id,
        'metadata', p_metadata::JSONB
      )
    );

    RETURN QUERY SELECT v_app_id, true::BOOLEAN, 'Application created'::TEXT;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Grant execute on RPC to service role
GRANT EXECUTE ON FUNCTION crm.lead_intake_sync TO service_role;
```

---

## API Endpoints (Automation Hub)

### 1. **POST /api/crm/health**
Check CRM connectivity

```bash
curl -X POST http://localhost:3000/api/crm/health
```

**Response:**
```json
{
  "success": true,
  "status": "connected",
  "message": "CRM Supabase connected"
}
```

---

### 2. **POST /api/crm/lead-intake-sync** ⭐ CORE ENDPOINT

Called by: Chatsense webhook after voice disposition

```bash
curl -X POST http://localhost:3000/api/crm/lead-intake-sync \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "919876543210",
    "name": "Rajesh Kumar",
    "age": 32,
    "income": 500000,
    "pincode": "400001",
    "state": "Maharashtra",
    "email": "rajesh@email.com",
    "channel": "obd_voice",
    "disposition": "interested",
    "callDuration": 45,
    "dtmfChoice": 1,
    "campaignId": "poonawala_stpl_batch_1724095200000_1",
    "batchId": 1,
    "customMetadata": {
      "callSid": "call_12345",
      "agentId": "agent_001"
    }
  }'
```

**Response:**
```json
{
  "success": true,
  "applicationId": "app_550e8400-e29b-41d4-a716-446655440000",
  "message": "Application created successfully"
}
```

**Dispositions Accepted:**
- `interested` — Customer interested, ready for documents
- `callback` — Customer wants callback, schedule for later
- `rejected` — Customer not interested
- `agent_connect` — Customer wants to talk to agent
- `contacted` — Default, no disposition captured

---

### 3. ~~POST /api/chatsense/voice-disposition~~ — removed

This was an alternative entry point that Chatsense could call directly. It was
deleted on 1 Sep 2026 with the rest of the Chatsense integration and now
returns **404**.

It was never a separate path: it validated the same fields and then called the
same `crmClient.leadIntakeSyncFromVoice()` that endpoint 2 above calls. Point
the Chatsense webhook at `/api/crm/lead-intake-sync` instead. Two differences
when moving a caller across:

- `callSid` was top-level; it now goes inside `customMetadata`.
- The removed endpoint logged the disposition to `crm.lead_events` itself. To
  keep that audit record, follow the intake with
  `POST /api/crm/application/<applicationId>/log-event`.

---

### 4. **GET /api/crm/application/:applicationId**

Fetch application details from CRM

```bash
curl -X GET http://localhost:3000/api/crm/application/app_550e8400-e29b-41d4-a716-446655440000
```

**Response:**
```json
{
  "success": true,
  "application": {
    "application_id": "app_550e8400-e29b-41d4-a716-446655440000",
    "phone": "919876543210",
    "name": "Rajesh Kumar",
    "stage": "Lead",
    "substage": "contacted",
    "eligible_lenders": ["poonawala", "hdfc"],
    "best_lender": "hdfc",
    "created_at": "2026-08-25T14:23:15Z"
  }
}
```

---

### 5. **POST /api/crm/batch-lead-intake**

Bulk create applications from batch campaign

```bash
curl -X POST http://localhost:3000/api/crm/batch-lead-intake \
  -H "Content-Type: application/json" \
  -d '{
    "campaignId": "poonawala_stpl_batch_1724095200000_1",
    "batchId": 1,
    "leads": [
      {
        "phone": "919876543210",
        "name": "Rajesh Kumar",
        "age": 32,
        "income": 500000,
        "pincode": "400001",
        "state": "Maharashtra",
        "disposition": "interested",
        "callDuration": 45,
        "dtmfChoice": 1
      },
      {
        "phone": "919876543211",
        "name": "Priya Singh",
        "age": 28,
        "income": 450000,
        "pincode": "400002",
        "state": "Maharashtra",
        "disposition": "callback",
        "callDuration": 32,
        "dtmfChoice": 3
      }
    ]
  }'
```

**Response:**
```json
{
  "success": true,
  "campaignId": "poonawala_stpl_batch_1724095200000_1",
  "batchId": 1,
  "totalLeads": 2,
  "successCount": 2,
  "failureCount": 0,
  "results": [
    {
      "phone": "919876543210",
      "success": true,
      "applicationId": "app_550e8400-e29b-41d4-a716-446655440000"
    },
    {
      "phone": "919876543211",
      "success": true,
      "applicationId": "app_660e8400-e29b-41d4-a716-446655440001"
    }
  ]
}
```

---

## Integration Flow: Step-by-Step

### Flow 1: Single Voice Call → Application Creation

```
1. OBD voice call initiated
   └─► Customer answers
       └─► Eleven Labs TTS: "Hello Rajesh, ₹50,000 offer"
           └─► Customer presses DTMF 1 (Learn More)
               └─► Chatsense captures disposition + call metadata

2. Chatsense webhook triggers
   └─► POST /api/crm/lead-intake-sync
       ├─ phone: "919876543210"
       ├─ name: "Rajesh Kumar"
       ├─ disposition: "interested"
       ├─ callDuration: 45
       └─ dtmfChoice: 1

3. CRM Integration Client processes
   └─► crmClient.leadIntakeSyncFromVoice()
       └─► Calls Supabase RPC: lead_intake_sync
           └─► Creates application_id: "app_550e..."

4. Response returned
   └─► applicationId for tagging future WhatsApp, callbacks

5. CRM audit trail logged
   └─► crm.lead_events record created
       └─ event_type: "voice_disposition"
       └─ event_data: {disposition, callDuration, dtmfChoice, campaignId}
```

### Flow 2: Batch Campaign (50K/day) → Bulk Intake

```
1. Poonawala batch processing complete
   └─► 50K candidates → 21K eligible → 18.9K voice calls delivered

2. Disposition aggregation (batch post-processing)
   └─► Collect all dispositions from Chatsense for batch

3. Bulk lead intake
   └─► POST /api/crm/batch-lead-intake
       ├─ campaignId: "poonawala_stpl_batch_1..."
       ├─ batchId: 1
       └─ leads: [array of 18,900 dispositions]

4. CRM creates 18,900 applications in parallel
   └─► Each application: stage="Lead", substage="contacted"
   └─► All linked to campaign_id + batch_id

5. Dashboard updates real-time
   └─► Agents see 18,900 new leads in "My Work" queue
```

---

## Testing Phase 1

### Test 1: Single Lead Intake

```bash
#!/bin/bash

echo "=== Test 1: Single Lead Intake ==="

# Step 1: Check health
echo "1. Checking CRM health..."
curl -s -X POST http://localhost:3000/api/crm/health | jq '.'

# Step 2: Create lead
echo -e "\n2. Creating lead via voice disposition..."
RESPONSE=$(curl -s -X POST http://localhost:3000/api/crm/lead-intake-sync \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "919876543210",
    "name": "Rajesh Kumar",
    "age": 32,
    "income": 500000,
    "pincode": "400001",
    "state": "Maharashtra",
    "email": "rajesh@email.com",
    "channel": "obd_voice",
    "disposition": "interested",
    "callDuration": 45,
    "dtmfChoice": 1,
    "campaignId": "test_batch_001"
  }')

echo $RESPONSE | jq '.'
APP_ID=$(echo $RESPONSE | jq -r '.applicationId')
echo "Created application: $APP_ID"

# Step 3: Fetch application
echo -e "\n3. Fetching application details..."
curl -s -X GET http://localhost:3000/api/crm/application/$APP_ID | jq '.'

echo -e "\n✅ Test 1 Complete"
```

### Test 2: Bulk Batch Intake

```bash
#!/bin/bash

echo "=== Test 2: Bulk Batch Lead Intake ==="

# Generate 10 test leads
LEADS='['
for i in {1..10}; do
  PHONE="9198765432${i:0:2}"
  NAME="Customer_$i"
  DISPOSITION=$(["interested", "callback", "rejected"][RANDOM % 3])
  
  LEADS+="{\"phone\":\"$PHONE\",\"name\":\"$NAME\",\"age\":30,\"income\":400000,\"pincode\":\"400001\",\"state\":\"Maharashtra\",\"disposition\":\"interested\",\"callDuration\":45,\"dtmfChoice\":1}"
  
  if [ $i -lt 10 ]; then
    LEADS+=","
  fi
done
LEADS+=']'

echo "Creating bulk leads..."
curl -s -X POST http://localhost:3000/api/crm/batch-lead-intake \
  -H "Content-Type: application/json" \
  -d "{
    \"campaignId\": \"test_batch_001\",
    \"batchId\": 1,
    \"leads\": $LEADS
  }" | jq '.'

echo -e "\n✅ Test 2 Complete"
```

---

## Monitoring & Validation

### In CRM (dsa-business-crm):

```sql
-- Check applications created today
SELECT 
  COUNT(*) as total_applications,
  COUNT(CASE WHEN disposition = 'interested' THEN 1 END) as interested,
  COUNT(CASE WHEN disposition = 'callback' THEN 1 END) as callback,
  COUNT(CASE WHEN disposition = 'rejected' THEN 1 END) as rejected
FROM crm.leads
WHERE created_at >= NOW() - INTERVAL '1 day'
GROUP BY DATE(created_at);

-- Check lead events
SELECT 
  application_id,
  event_type,
  event_data,
  created_at
FROM crm.lead_events
WHERE event_type = 'voice_disposition'
ORDER BY created_at DESC
LIMIT 20;

-- Verify dedupe (phone uniqueness)
SELECT phone, COUNT(*) as count
FROM crm.leads
GROUP BY phone
HAVING COUNT(*) > 1;
```

### In Automation Hub (logs):

```bash
# Check application creation
docker logs automation-hub | grep "Lead intake sync"

# Check error rates
docker logs automation-hub | grep -i "error\|failed" | grep "lead_intake"
```

---

## Success Criteria: Phase 1

- ✅ Application created in CRM within 5 seconds of voice call completion
- ✅ 100% of voice dispositions captured and logged
- ✅ Phone number dedupe working (updates existing record, not duplicates)
- ✅ Batch intake: 1,000 leads processed in <30 seconds
- ✅ CRM audit trail complete (all events logged)
- ✅ Zero data loss or truncation

---

## Rollback Plan

If Phase 1 integration fails:

1. **Disable lead intake webhook:**

   Turn the webhook off in the Chatsense dashboard — that is the only switch
   now. The old instruction here was to comment the handler out of
   `chatsenseRoutes.js`, which no longer exists. Do not comment out
   `/api/crm/lead-intake-sync`: the batch intake path and other callers share
   it.

2. **Revert to manual entry:**
   ```
   Chatsense dispositions → Spreadsheet → Manual CRM entry (existing process)
   ```

3. **No data loss:**
   - All Chatsense dispositions still logged in Chatsense platform
   - CRM applications can be manually created from dispositions
   - No customer-facing impact (leads still reachable)

---

## Next Steps (After Phase 1)

- Phase 2: Eligibility gating + multi-lender routing
- Phase 3: Document collection automation
- Phase 4: Credit scoring + lender submission
- Phase 5: Billing + payout automation

---

## Support & Questions

**Issues with lead intake?**
- Check CRM_SUPABASE_URL and CRM_SUPABASE_SERVICE_ROLE_KEY env vars
- Verify `crm.leads` table exists in CRM Supabase
- Verify RPC `lead_intake_sync` created
- Check logs: `docker logs automation-hub | grep -i "lead_intake"`

**Need to test without CRM?**
- Comment out `crmClient.leadIntakeSyncFromVoice()` call
- Respond with mock data for testing

**Performance concerns?**
- Batch endpoint optimized for 10K+ leads
- RPC is indexed on phone for deduping
- Consider async batch processing if >50K leads

---

**Implemented by:** Puneet Makkhija
**Date:** 2026-08-25
**Status:** Ready for Integration Testing
