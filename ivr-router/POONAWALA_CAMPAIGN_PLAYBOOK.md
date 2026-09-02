# Poonawala STPL Campaign Playbook

Complete guide to execute a 5M customer campaign for Poonawala Fincorp using the SMEcircle 4M base with voice + WhatsApp sequential outreach.

## 1. Campaign Overview

**Objective:** Pre-qualify and convert 5M customers from SMEcircle database into Poonawala STPL loan applications

**Target Segment:**
- Age: 24-35 (Young professionals)
- CIBIL Score: 720+ (Strong credit profiles)
- Geographic: Poonawala's 160+ serviceable pincodes only

**Channels:**
1. **Voice (OBD)** - Personalized IVR with dynamic greeting and loan amount
2. **WhatsApp (Ananta)** - 2-hour follow-up with application link

**Campaign Timeline:** 100 days @ 50K daily volume = 5M customers

**Expected Conversion:** 15% (750K applications)

## 2. Pre-Campaign Checklist

### A. Environment Setup

```bash
# 1. Set environment variables
export SUPABASE_URL="https://your-sme-circle.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="your_service_role_key"
export OBD_BASE_URL="https://obdapi2.ivrsms.com"
export OBD_USERNAME="your_obd_username"
export OBD_PASSWORD="your_obd_password"
export ANANTA_API_KEY="your_ananta_api_key"
export ANANTA_API_TOKEN="your_ananta_token"
export ANANTA_API_SECRET_KEY="your_ananta_secret"
export ELEVEN_LABS_API_KEY="your_eleven_labs_key"

# 2. Start server
node index.js

# 3. Verify health
curl -X GET http://localhost:3000/api/poonawala/campaign/health
```

### B. Database Prerequisites

Ensure SMEcircle Supabase has `customers_sme` table with:
```sql
-- Required fields
phone (TEXT, unique)
name (TEXT)
age (INTEGER)
email (TEXT)
state (TEXT)
pincode (TEXT)
cibil_score (INTEGER)
income (NUMERIC)
metadata (JSONB) -- contains: hunterScore, dpdData, bureauVintage, etc.
created_at (TIMESTAMP)
```

### C. Poonawala Pincode Setup

Upload 160+ pincodes to the gating system:
```bash
curl -X POST http://localhost:3000/api/gating/bulk-upload-pincodes \
  -H "Content-Type: application/json" \
  -d '{
    "lenderType": "poonawala",
    "pincodes": ["400001", "400002", ... "160 total"]
  }'

# Verify
curl -X GET http://localhost:3000/api/gating/stats?lenderType=poonawala
```

## 3. Campaign Estimation

### Step 1: Estimate Eligible Customers

```bash
curl -X POST http://localhost:3000/api/poonawala/campaign/estimate \
  -H "Content-Type: application/json" \
  -d '{
    "targetAge": {
      "min": 24,
      "max": 35
    },
    "minCibilScore": 720
  }'
```

**Response:**
```json
{
  "success": true,
  "estimate": {
    "totalCustomers": 4000000,
    "sampleSize": 100,
    "eligibleInSample": 42,
    "sampleEligibilityRate": "42.00%",
    "estimatedEligibleTotal": 1680000,
    "estimatedDailyCapacity": 50000,
    "estimatedCampaignDuration": "34 days",
    "estimatedConversion": "252000 applications"
  },
  "sampleResults": [
    {
      "phone": "919876543210",
      "eligible": true,
      "reason": "Eligible"
    },
    {
      "phone": "919876543211",
      "eligible": false,
      "reason": "Pincode not in serviceable list"
    }
  ]
}
```

**Interpretation:**
- 4M total customers in SMEcircle
- ~42% pass Poonawala gating criteria (1.68M eligible)
- At 50K/day: Campaign completes in ~34 days
- Expected conversion: 15% = 252K applications

## 4. Campaign Execution

### Phase 1: Initialize Campaign Batches

**Batch 1 (Day 1):** 50K customers
```bash
curl -X POST http://localhost:3000/api/poonawala/campaign/start-batch \
  -H "Content-Type: application/json" \
  -d '{
    "batchNumber": 1,
    "limit": 50000
  }'
```

**Response:**
```json
{
  "success": true,
  "message": "Campaign batch 1 initiated successfully",
  "batchNumber": 1,
  "campaignId": "poonawala_stpl_batch_1724095200000_1",
  "campaignName": "Poonawala STPL - Targeted Loan Offer - Batch 1",
  "totalBaseCount": 4000000,
  "candidatesQueried": 50000,
  "eligibleCount": 21000,
  "voiceCallsTriggered": 21000,
  "voiceCallsSuccessful": 18900,
  "voiceCallSuccess": "90.00%",
  "ineligibilityBreakdown": {
    "Pincode not in serviceable list": 15000,
    "Age not in range 24-55": 8000,
    "CIBIL Score < 720": 6000
  },
  "nextBatchOffset": 50000,
  "hasMoreCustomers": true,
  "estimatedConversion": 3150,
  "whatsappFollowUpScheduled": true
}
```

**Key Metrics:**
- 50K candidates queried
- 21K eligible (42% pass rate)
- 18.9K voice calls successfully initiated (90%)
- WhatsApp follow-ups scheduled for 2 hours post-call

### Phase 2: Monitor Campaign Progress

**Check Campaign Status:**
```bash
curl -X GET "http://localhost:3000/api/poonawala/campaign/campaign/poonawala_stpl_batch_1724095200000_1/status"
```

**Response:**
```json
{
  "success": true,
  "campaignId": "poonawala_stpl_batch_1724095200000_1",
  "campaignName": "Poonawala STPL - Targeted Loan Offer - Batch 1",
  "status": "in_progress",
  "createdAt": "2026-08-25T14:00:00Z",
  "voiceStats": {
    "total": 18900,
    "delivered": 17100,
    "answered": 12825,
    "notAnswered": 4275,
    "failed": 1800
  },
  "whatsappStats": {
    "total": 18900,
    "sent": 18900,
    "delivered": 16200,
    "read": 12960,
    "failed": 2700
  },
  "totalContacts": 37800,
  "overallDeliveryRate": "88.50%"
}
```

### Phase 3: Scale to 50K Daily

Run batches sequentially over 100 days:

```bash
#!/bin/bash
# poonawala_campaign.sh - Run 100-day campaign

for BATCH in {1..100}; do
  echo "Starting Batch $BATCH..."
  
  curl -X POST http://localhost:3000/api/poonawala/campaign/start-batch \
    -H "Content-Type: application/json" \
    -d "{
      \"batchNumber\": $BATCH,
      \"limit\": 50000
    }" | jq '.'
  
  # Wait 24 hours before next batch
  echo "Waiting 24 hours for batch to complete..."
  sleep 86400
done

echo "Campaign complete!"
```

Or use cron for automated batches:

```bash
# Add to crontab (runs daily at 00:00 UTC)
# 0 0 * * * curl -X POST http://localhost:3000/api/poonawala/campaign/start-batch \
#   -H "Content-Type: application/json" \
#   -d '{"batchNumber": 1, "limit": 50000}' >> /var/log/poonawala_campaign.log 2>&1
```

## 5. Campaign Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                    DAY 1-100: CAMPAIGN EXECUTION                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  BATCH N (50K customers/day)                                     │
│    ↓                                                              │
│  Query SMEcircle: Age 24-35, CIBIL 720+                         │
│    ↓ 50,000 candidates                                           │
│  Poonawala Gating Filter                                         │
│    - Pincode validation (160 serviceable)                        │
│    - CIBIL parameters                                            │
│    - Hard rejects (DPD, derog, MFI, etc.)                       │
│    ↓ ~21,000 eligible (42%)                                      │
│  VOICE CHANNEL (OBD)                                             │
│    - Trigger IVR call with personalized greeting                 │
│    - TTS: "Hello {name}, ₹50,000 loan offer"                   │
│    - DTMF options: 1=Learn More, 2=Agent, 3=Callback            │
│    ↓ ~18,900 delivered (90%)                                     │
│    ↓ ~12,825 answered (68%)                                      │
│  DELAY: 2-hour wait for call completion                         │
│    ↓                                                              │
│  WHATSAPP FOLLOW-UP (Ananta)                                     │
│    - Send application link                                       │
│    - Loan terms + rates                                          │
│    - Interactive buttons (Apply, Call, More Info)                │
│    ↓ ~16,200 delivered (86%)                                     │
│  CONVERSION TRACKING                                             │
│    - Log to Supabase                                             │
│    - Update campaign_results table                               │
│    - Track applications submitted                                │
│    ↓ Expected 3,150 conversions per batch (15%)                 │
│                                                                   │
│  BATCH N+1 STARTS NEXT DAY                                       │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘

AGGREGATED CAMPAIGN STATS (100 days):
  Total Contacts: 5M
  Voice Delivered: 4.45M (89%)
  Answered: 3.4M (68%)
  WhatsApp Delivered: 4.32M (86%)
  Applications: 750K (15%)
```

## 6. Real-Time Monitoring

### API Endpoints for Monitoring

**Campaign Health:**
```bash
curl -X GET http://localhost:3000/api/poonawala/campaign/health
```

**Campaign Status (During Execution):**
```bash
# Get latest batch status
curl -X GET "http://localhost:3000/api/poonawala/campaign/campaign/{campaignId}/status" \
  | jq '.voiceStats, .whatsappStats'
```

**ROI Calculation (Post-Campaign):**
```bash
curl -X GET "http://localhost:3000/api/poonawala/campaign/campaign/{campaignId}/roi"
```

**Response:**
```json
{
  "success": true,
  "campaignId": "poonawala_stpl_batch_1724095200000_1",
  "totalContacts": 37800,
  "conversions": 5670,
  "conversionRate": "15.00%",
  "totalReachCost": "18900.00",
  "costPerConversion": "3.33",
  "revenuePerConversion": "1500.00",
  "estimatedProfit": "9469500.00",
  "roi": "50025.00%"
}
```

## 7. Daily Monitoring Checklist

### Morning (00:00 UTC)
- [ ] Start batch via API
- [ ] Verify 50K customers queried
- [ ] Check eligibility rate (target: 40-45%)
- [ ] Monitor voice delivery (target: 85%+)

### Midday (12:00 UTC)
- [ ] Check answered call rate (target: 65%+)
- [ ] Monitor WhatsApp delivery (should start ~2h after batch)
- [ ] Verify no API errors in logs

### Evening (18:00 UTC)
- [ ] Get campaign status update
- [ ] Check conversion rate (target: 15%+)
- [ ] Review ineligibility breakdown
- [ ] Plan adjustments for next day

## 8. Troubleshooting

### Issue: Low Eligibility Rate (<35%)
**Symptoms:** Less than 35% of candidates passing gating
**Solutions:**
1. Check pincode database - ensure all 160 uploaded
2. Verify CIBIL data freshness in SMEcircle
3. Review hard rejects breakdown - adjust criteria if needed

### Issue: Low Voice Delivery (<80%)
**Symptoms:** Only 80% or fewer voice calls delivered
**Solutions:**
1. Check OBD API health: `curl -H "x-webhook-secret: $CONSOLE_SECRET" http://localhost:3000/api/obd/health`
   (all of /api/obd is behind the console secret — it can stop live campaigns)
2. Verify phone numbers are valid Indian format
3. Check OBD rate limiting (50K/day should be fine)
4. Review firewall/IP whitelist rules

### Issue: Low Conversion Rate (<12%)
**Symptoms:** Less than 12% applications
**Solutions:**
1. A/B test IVR greeting text (personalization matters)
2. Check WhatsApp delivery - if <85%, fix messaging
3. Review application link - ensure it's mobile-friendly
4. Test DTMF routing - verify agent option works

## 9. Optimization Strategies

### Strategy 1: Segment by Income Level
```bash
curl -X POST http://localhost:3000/api/poonawala/campaign/estimate \
  -H "Content-Type: application/json" \
  -d '{
    "targetAge": {"min": 24, "max": 35},
    "minCibilScore": 750,
    "minIncome": 500000
  }'
```

Higher income = higher conversion rate (expect 18-20%)

### Strategy 2: Geographic Targeting
Focus on metros first (better connectivity):
```bash
# Prioritize: Mumbai, Delhi, Bangalore, Hyderabad, Pune
# Then: Tier-2 cities
# Last: Tier-3/4 cities
```

### Strategy 3: Time-of-Day Optimization
- **Morning (8-10am):** Best call answer rate
- **Afternoon (2-4pm):** Lower answer rate
- **Evening (6-8pm):** Good for WhatsApp engagement

## 10. Campaign Budget & ROI

### Cost Breakdown (per 5M campaign)
| Component | Cost/Contact | 5M Total |
|-----------|-------------|----------|
| Voice calls (OBD) | ₹0.30 | ₹1,500,000 |
| WhatsApp (Ananta) | ₹0.15 | ₹750,000 |
| TTS (Eleven Labs) | ₹0.02 | ₹100,000 |
| Data processing | ₹0.03 | ₹150,000 |
| **Total** | **₹0.50** | **₹2,500,000** |

### Revenue Projection (15% conversion)
| Metric | Value |
|--------|-------|
| Applications | 750,000 |
| Avg Loan Amount | ₹50,000 |
| Avg Margin | 3% |
| Revenue/Application | ₹1,500 |
| **Total Revenue** | **₹1,125,000,000** |
| **Campaign Cost** | **₹2,500,000** |
| **Profit** | **₹1,122,500,000** |
| **ROI** | **44,900%** |

## 11. Post-Campaign Analytics

### Query Conversion by Segment
```sql
SELECT 
  customer_age,
  COUNT(*) as applications,
  COUNT(CASE WHEN status = 'approved' THEN 1 END) as approved,
  COUNT(CASE WHEN status = 'approved' THEN 1 END) * 100.0 / COUNT(*) as approval_rate
FROM poonawala_applications
WHERE campaign_id LIKE 'poonawala_stpl_batch%'
GROUP BY customer_age
ORDER BY approval_rate DESC;
```

### Top Performing Pincodes
```sql
SELECT 
  pincode,
  COUNT(*) as applications,
  COUNT(CASE WHEN status = 'approved' THEN 1 END) as approved,
  COUNT(CASE WHEN status = 'approved' THEN 1 END) * 100.0 / COUNT(*) as approval_rate
FROM poonawala_applications
WHERE campaign_id LIKE 'poonawala_stpl_batch%'
GROUP BY pincode
ORDER BY approval_rate DESC
LIMIT 20;
```

## 12. Next Steps

1. ✅ Verify SMEcircle database connectivity
2. ✅ Upload 160+ Poonawala pincodes
3. ✅ Run estimation to confirm eligible customer count
4. ✅ Start Batch 1 with 50K customers
5. ✅ Monitor health metrics for 24 hours
6. ✅ Scale to full 100-day campaign
7. ✅ Track conversions and ROI
8. ✅ Optimize for next campaign cycle

## Support

- **OBD Issues:** contact@obdapi2.ivrsms.com
- **Ananta Issues:** support@anantadot.com
- **Poonawala Partnership:** updates.instapl@poonawallafincorp.com

---

Last Updated: 2026-08-25

**Estimated Campaign Timeline:** August 25 - December 3, 2026 (100 days)
**Expected Outcome:** 750K applications, ₹1.12B profit
