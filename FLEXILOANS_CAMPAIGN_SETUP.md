# FlexiLoans IVR Campaign - Document Collection Setup

**Status:** ✅ Complete  
**Date:** 2025-08-29  
**Campaign Type:** Bureau-Qualified Leads → FlexiLoans Document Collection

---

## Campaign Overview

This campaign routes bureau-qualified leads to FlexiLoans for post-IVR document verification through WhatsApp bot and Ori voice bot integration.

### Flow Diagram
```
IVR Call Received
        ↓
    [120 seconds max]
        ↓
    Audio Plays: "Bureau Qualified Greeting"
    (rec_bureau_qualified_07.mp3 - 415KB)
        ↓
    [Waiting for DTMF Input]
        ↓
    ┌─────────────────────┬──────────────────────┐
    │                     │                      │
   PRESS 1              PRESS 2           NO RESPONSE
  (Interested)         (DND)             (Timeout)
    │                     │                      │
    ↓                     ↓                      ↓
Route to          Mark as              Retry or
FlexiLoans      Do Not Disturb        End Call
(Primary)         Status
    │
    ↓
Primary Lender: FlexiLoans
Fallback Lender: Poonawala
    │
    ↓
WhatsApp Bot Initiates:
"Hi! We have a personalized loan offer for you.
Click below to complete your document verification
with FlexiLoans."
    │
    ↓
Ori Voice Bot Activates:
• Bank Statement Verification
• KYC Document Collection
• Employment Proof
• Address Proof
    │
    ↓
Documents Submitted
→ Logged in ivr_campaign_events
→ Metrics Updated
```

---

## Campaign Configuration

### Basic Details
- **Campaign ID:** campaign_flexiloans_docs_YYYY_MM_DD_HH24_MI_SS
- **Campaign Name:** FlexiLoans Document Collection
- **Status:** Draft (Ready to Launch)
- **Target Lead Count:** 500
- **Created:** 2025-08-29

### IVR Voice Configuration
- **Greeting Audio File:** `ivr_bureau_qualified_07.mp3`
- **Recording ID:** `rec_bureau_qualified_07`
- **Duration:** 15 seconds
- **Language:** en-IN (Indian English)
- **Format:** MP3 (128kbps, 44100Hz)
- **Voice Type:** Professional

### DTMF Routing Rules

#### Press 1 - Interested in FlexiLoans
```json
{
  "action": "route_to_lender",
  "primary_lender": "flexiloans",
  "fallback_lender": "poonawala",
  "channel": "whatsapp_bot",
  "collect_documents": true,
  "whatsapp_message": "Hi! We have a personalized loan offer for you. Click below to complete your document verification with FlexiLoans."
}
```

#### Press 2 - Do Not Disturb
```json
{
  "action": "mark_dnd",
  "description": "Mark lead as Do Not Disturb"
}
```

### Ori Voice Bot Configuration (Document Collection)
- **Status:** Enabled
- **Purpose:** Banking Documents Collection
- **Voice ID:** Default Professional
- **Features Enabled:**
  - ✅ Bank Statement Verification
  - ✅ KYC Document Collection
  - ✅ Employment Proof Collection
  - ✅ Address Proof Collection

---

## Lender Details - FlexiLoans

| Property | Value |
|----------|-------|
| Lender ID | `flexiloans` |
| Name | FlexiLoans |
| Webhook URL | https://api.flexiloans.com/webhook |
| Status | Connected |
| Min Loan Amount | ₹50,000 |
| Max Loan Amount | ₹50,00,000 |
| Document Collection | Via WhatsApp + Ori Voice Bot |

---

## Data Tables Involved

### 1. `ivr_campaigns`
- Stores campaign metadata
- Configuration (IVR greeting, DTMF options, Ori voice bot)
- Campaign status and timestamps

### 2. `ivr_campaign_metrics`
- Real-time tracking metrics:
  - Total calls received
  - DTMF press counts (Press 1, Press 2, No Response)
  - WhatsApp delivery metrics
  - Lender routing stats
  - Ori voice bot trigger count
  - Documents collected count

### 3. `ivr_campaign_events` (Audit Trail)
- Call events: `call_received`
- DTMF events: `dtmf_press_1`, `dtmf_press_2`
- WhatsApp events: `whatsapp_sent`, `whatsapp_delivered`
- Routing events: `lender_routed`
- DND events: `dnd_marked`
- Document events: `document_collected`

### 4. `lenders`
- FlexiLoans lender registration
- Webhook configuration
- Loan product limits

---

## Expected Behavior After Launch

1. **IVR Call Received**
   - System logs `call_received` event
   - Plays bureau-qualified greeting audio
   - Increments `total_calls_received` in metrics

2. **Lead Presses 1 (Interested)**
   - System logs `dtmf_press_1` event
   - Increments `dtmf_press_1_count` in metrics
   - Routes to FlexiLoans primary lender
   - Sends WhatsApp message to lead

3. **WhatsApp Bot Interaction**
   - User clicks link in WhatsApp message
   - System logs `whatsapp_sent`, `whatsapp_delivered` events
   - Increments relevant WhatsApp metrics

4. **Ori Voice Bot Document Collection**
   - Voice bot initiates conversation
   - Collects required documents
   - System logs `document_collected` events
   - Increments `documents_collected_count` in metrics

5. **DND Handling (Press 2)**
   - System logs `dnd_marked` event
   - Lead added to DND list
   - Future calls to this number are blocked

---

## Testing Checklist

- [ ] Navigate to ☎️ IVR Campaigns tab
- [ ] Verify campaign appears in list with "Draft" status
- [ ] Click campaign to view details
- [ ] Verify audio recording displays correctly
- [ ] Check DTMF routing (Press 1 → FlexiLoans, Press 2 → DND)
- [ ] Verify Ori voice bot settings enabled
- [ ] Launch campaign (status → "active")
- [ ] Monitor metrics in real-time
- [ ] Verify events logged in audit trail

---

## To Deploy This Campaign

**Option 1: Via Database Migration**
```sql
-- Run the migration
psql -h <db-host> -U postgres -d automation_hub -f ivr-router/migrations/001_add_flexiloans_campaign.sql
```

**Option 2: Via Dashboard UI**
1. Click ☎️ IVR Campaigns tab
2. Click "+ New IVR Campaign"
3. Fill in campaign details (matching above configuration)
4. Select recording: "Bureau Qualified Greeting"
5. Configure DTMF routing
6. Enable Ori voice bot
7. Click "Create Campaign"
8. Once created, click "Launch" to activate

**Option 3: Via REST API**
```bash
curl -X POST https://api.automation-hub.local/api/ivr-campaigns \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d @campaign_config.json
```

---

## Recording Library Location

```
ivr-router/
├── recordings/
│   ├── MANIFEST.json                    (Recording metadata)
│   └── ivr_bureau_qualified_07.mp3      (Audio file - 415KB)
└── migrations/
    └── 001_add_flexiloans_campaign.sql  (Database setup)
```

---

## Success Metrics to Track

| Metric | Target | Current |
|--------|--------|---------|
| Total Calls Received | 500 | - |
| Press 1 Rate | 30-40% | - |
| Press 2 Rate (DND) | 5-10% | - |
| WhatsApp Delivery Rate | >95% | - |
| Documents Collected | 80%+ of interested leads | - |
| Average Processing Time | <5 min | - |

---

## Next Steps

1. ✅ Campaign configuration complete
2. ⏳ Run database migration to create campaign
3. ⏳ Launch campaign from dashboard
4. ⏳ Monitor metrics and events in real-time
5. ⏳ Optimize based on performance data

---

**Last Updated:** 2025-08-29 13:58 PM IST  
**Prepared By:** Claude Code  
**Status:** Ready for Deployment
