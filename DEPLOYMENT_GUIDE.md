# Production Deployment Guide: Dual-Campaign System

This guide covers deploying the BRE Shortlisting, IVR Campaign Router, and MIS Feedback Collection modules to production.

## Phase 1: Database Migration (Supabase)

### Step 1: Connect to Supabase Project

1. Go to [Supabase Dashboard](https://app.supabase.com)
2. Select your project (automation-hub database)
3. Navigate to **SQL Editor**

### Step 2: Run Migration

Copy and execute the contents of `database/migrations/001_dual_campaign_system.sql`:

1. Click **"New Query"**
2. Paste the entire migration SQL file
3. Click **"Run"** (or Cmd+Enter)

**Expected Result:**
- 10 tables created: `bre_shortlists`, `ivr_routing_decisions`, `customer_journey_status`, `diy_journey_log`, `diy_lender_tracking`, `diy_fallback_log`, `customer_rejection_history`, `lender_rejection_events`, `mis_report_logs`
- 2 views created: `daily_rejection_summary`, `campaign_routing_summary`
- Indexes and triggers auto-created

### Step 3: Verify Migration

In Supabase SQL Editor:
```sql
-- Check all new tables exist
SELECT table_name FROM information_schema.tables 
WHERE table_schema = 'public' 
AND table_name IN (
  'bre_shortlists', 'ivr_routing_decisions', 'customer_journey_status',
  'diy_journey_log', 'diy_lender_tracking', 'diy_fallback_log',
  'customer_rejection_history', 'lender_rejection_events', 'mis_report_logs'
);

-- Should return 9 rows
```

---

## Phase 2: Environment Configuration

### Step 1: Update .env File in IVR Router

In `ivr-router/.env`, add/update these variables:

```bash
# Existing variables (already configured)
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGc...

OBD_BASE_URL=https://obdapi2.ivrsms.com
OBD_USERNAME=your_username
OBD_PASSWORD=your_password

ANANTA_BASE_URL=https://data-api.anantadot.com
ANANTA_API_KEY=your_key
ANANTA_API_TOKEN=your_token
ANANTA_API_SECRET_KEY=your_secret

# NEW: Lender MIS Webhook Secrets
POONAWALLA_MIS_SECRET=poonawalla_webhook_signature_key
HERO_FINCORP_MIS_SECRET=hero_fincorp_webhook_signature_key
```

### Step 2: Verify Configuration

Test configuration by hitting the health endpoints:

```bash
# Test BRE shortlisting
curl https://your-railway-url/api/bre/health

# Test IVR router
curl https://your-railway-url/api/router/health

# Test MIS feedback
curl https://your-railway-url/api/mis/health

# All should return 200 with { success: true, status: "healthy" }
```

---

## Phase 3: Deploy Monitoring Console

### Option A: Deploy to Public URL (Recommended)

1. **Get the console file:**
   - File: `automation-console.html`

2. **Deploy to web server:**
   - Upload to your web host (e.g., crmbusinessloans.com)
   - URL: `https://crmbusinessloans.com/automation-hub` or similar
   - File should be directly accessible via HTTPS

3. **Verify access:**
   - Open the URL in browser
   - Should see the 5-tab console interface

### Option B: Serve from IVR Router (Alternative)

1. Add to `ivr-router/index.js`:
```javascript
// Before other routes
app.use('/automation-console', express.static('./automation-console.html'));
```

2. Access at: `https://your-railway-url/automation-console`

### Console Configuration

Once deployed, the console will:
1. Prompt for API Base URL on first load
2. Save to browser localStorage
3. Allow dynamic reconfiguration via the "Config" section

**Default settings:**
- API Base URL: `http://localhost:3000` (auto-detects in console)
- Updates saved to localStorage automatically

---

## Phase 4: API Endpoint Configuration

### Webhook Endpoints Setup

Configure these webhooks in lender systems:

#### Poonawalla MIS Report Webhook
- **Endpoint:** `https://your-railway-url/api/mis/webhook/poonawalla`
- **Method:** POST
- **Auth:** Include `Authorization: Bearer {POONAWALLA_MIS_SECRET}` in header
- **Payload Format:**
```json
{
  "reportDate": "2024-01-15",
  "records": [
    {
      "phone": "919876543210",
      "applicationId": "poo_123",
      "status": "rejected",
      "rejectionCode": "CIBIL_LOW",
      "rejectionReason": "CIBIL score below minimum"
    }
  ]
}
```

#### Hero FinCorp MIS Report Webhook
- **Endpoint:** `https://your-railway-url/api/mis/webhook/hero-fincorp`
- **Method:** POST
- **Auth:** Include `Authorization: Bearer {HERO_FINCORP_MIS_SECRET}` in header
- **Payload Format:** Same as Poonawalla

### Test Webhook Endpoints

Use the monitoring console:
1. Go to **MIS Feedback** tab
2. Section: **Process MIS Reports**
3. Paste sample JSON and click **Process Report**
4. Should return success response

---

## Phase 5: End-to-End Testing

### Test 1: BRE Shortlisting

**Via Console:**
1. Open monitoring console
2. Go to **BRE Shortlisting** tab
3. Click **"Run Daily Shortlist"**
4. Set date, limit (5-10 for testing), lender
5. Click **Execute**

**Expected:**
- API returns shortlist with customer records
- Records stored in `bre_shortlists` table
- Metrics show by lender

**Via API (curl):**
```bash
curl -X POST https://your-railway-url/api/bre/run-daily-shortlist \
  -H "Content-Type: application/json" \
  -d '{
    "reportDate": "2024-01-15",
    "limit": 10,
    "lenderId": "poonawalla"
  }'
```

### Test 2: Dual-Path Routing

#### Test Path A (Document Journey)

**Via Console:**
1. Go to **Campaign Routing** tab
2. Section: **Document Journey (Path A)**
3. Fill form with test customer data
4. Click **Execute**

**Via API:**
```bash
curl -X POST https://your-railway-url/api/router/document-journey \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "919876543210",
    "name": "Test User",
    "campaignId": "camp_test_001",
    "lenderId": "poonawalla"
  }'
```

**Expected:**
- Returns routing ID
- Records stored in `customer_journey_status` table
- Status: "active"

#### Test Path B (DIY Journey)

**Via Console:**
1. Go to **Campaign Routing** tab
2. Section: **DIY Journey (Path B)**
3. Fill form with test customer data
4. Click **Execute**

**Via API:**
```bash
curl -X POST https://your-railway-url/api/router/diy-journey \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "919876543210",
    "name": "Test User",
    "campaignId": "camp_test_001",
    "lenderId": "poonawalla"
  }'
```

**Expected:**
- Returns journey ID with UTM link
- Records stored in `diy_journey_log` table
- WhatsApp link generated with Poonawalla UTM parameters

### Test 3: Fallback Logic (Rejection → Hero FinCorp)

**Scenario: Poonawalla Rejection**

1. **First, send rejection webhook:**
```bash
curl -X POST https://your-railway-url/api/router/lender-rejection \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "919876543210",
    "campaignId": "camp_test_001",
    "rejectedLender": "poonawalla",
    "rejectionCode": "CIBIL_LOW",
    "rejectionReason": "CIBIL score below 650"
  }'
```

2. **Verify in database:**
```sql
-- Should see fallback record created
SELECT * FROM diy_fallback_log 
WHERE phone = '919876543210' 
ORDER BY created_at DESC LIMIT 1;

-- fallback_lender should be 'hero_fincorp'
-- status should be 'initiated'
```

3. **Via Console:**
   - Go to **Campaign Routing** tab
   - Section: **Handle Rejection/Fallback**
   - Fill with same customer data
   - Click **Execute**
   - Should return fallback journey with Hero FinCorp UTM link

### Test 4: MIS Feedback Processing

**Send MIS Report:**
```bash
curl -X POST https://your-railway-url/api/mis/process-report \
  -H "Content-Type: application/json" \
  -d '{
    "source": "poonawalla",
    "reportDate": "2024-01-15",
    "records": [
      {
        "phone": "919876543210",
        "applicationId": "poo_123",
        "status": "rejected",
        "rejectionCode": "CIBIL_LOW",
        "rejectionReason": "CIBIL score below minimum"
      },
      {
        "phone": "919123456789",
        "applicationId": "poo_124",
        "status": "rejected",
        "rejectionCode": "INCOME_LOW",
        "rejectionReason": "Income verification failed"
      }
    ]
  }'
```

**Verify in Database:**
```sql
-- Check rejection events
SELECT rejection_code, rejection_category, COUNT(*) 
FROM lender_rejection_events 
WHERE DATE(created_at) = CURRENT_DATE
GROUP BY rejection_code, rejection_category;

-- Generate BRE optimization report
SELECT * FROM daily_rejection_summary 
WHERE rejection_date = CURRENT_DATE
ORDER BY rejection_count DESC;
```

### Test 5: BRE Optimization Report

**Via API:**
```bash
curl https://your-railway-url/api/mis/bre-optimization-report/2024-01-15
```

**Expected:**
```json
{
  "success": true,
  "reportDate": "2024-01-15",
  "totalRejections": 2,
  "topRejectionCodes": [
    {
      "code": "CIBIL_LOW",
      "category": "credit_score",
      "count": 1,
      "weight": 15,
      "recommendedAction": "Raise CIBIL threshold"
    }
  ],
  "breRecommendations": ["Adjust CIBIL minimum", "Review income criteria"]
}
```

---

## Phase 6: Load Testing (Optional)

For production validation with ~50K daily shortlist:

### Using Artillery (Load Testing Tool)

```bash
npm install -g artillery

# Create load-test.yml
cat > load-test.yml << 'EOF'
config:
  target: "https://your-railway-url"
  phases:
    - duration: 60
      arrivalRate: 100
scenarios:
  - name: "BRE Shortlisting"
    flow:
      - post:
          url: "/api/bre/run-daily-shortlist"
          json:
            reportDate: "2024-01-15"
            limit: 1000
            lenderId: "poonawalla"
EOF

artillery run load-test.yml
```

### Monitoring During Load Test

1. Check Railway logs:
   - CPU usage
   - Memory usage
   - Response times
   - Error rates

2. Monitor Supabase:
   - Connection pool usage
   - Query performance
   - Disk I/O

---

## Phase 7: Production Checklist

- [ ] Database migration executed in Supabase
- [ ] All 10 tables created and indexes applied
- [ ] Environment variables configured (POONAWALLA_MIS_SECRET, HERO_FINCORP_MIS_SECRET)
- [ ] Monitoring console deployed and accessible
- [ ] API health endpoints returning 200
- [ ] BRE shortlisting working (records in `bre_shortlists` table)
- [ ] Path A (Document Journey) tested and working
- [ ] Path B (DIY Journey) tested and working
- [ ] Fallback logic tested (rejection triggers Hero FinCorp)
- [ ] MIS webhook receiving reports
- [ ] BRE optimization report generating correctly
- [ ] Customer rejection history queryable
- [ ] All API endpoints secured with proper auth
- [ ] Logging configured and flowing to monitoring system
- [ ] Error handling tested (network failures, invalid data)
- [ ] Rate limiting configured if needed
- [ ] Database backups configured in Supabase
- [ ] Monitoring alerts set up for errors

---

## Troubleshooting

### Issue: "Table does not exist" errors

**Solution:** Run migration again, ensure all SQL executed without errors

### Issue: "SUPABASE_SERVICE_ROLE_KEY not found"

**Solution:** Add to `.env` file in ivr-router directory

### Issue: Webhooks not being received

**Solution:** 
- Verify webhook URL is publicly accessible
- Check webhook secret matches environment variable
- Verify lender system has correct endpoint configured

### Issue: MIS report not processing

**Solution:**
- Check payload format matches schema
- Verify `source` field is "poonawalla" or "hero_fincorp"
- Check logs for validation errors

### Issue: DIY journey link not sending via WhatsApp

**Solution:**
- Verify ANANTA credentials are correct
- Check phone number format (must be 10 digits, no +91)
- Verify lender UTM configuration in ivrCampaignRouter.js

---

## Next Steps After Deployment

1. **Schedule Daily BRE Shortlisting:**
   - Set up cron job to run `/api/bre/run-daily-shortlist` daily at 6 AM

2. **Configure Lender Webhooks:**
   - Coordinate with Poonawalla and Hero FinCorp ops teams
   - Provide webhook URLs and secrets

3. **Monitor System Health:**
   - Set up alerts for API errors
   - Monitor database connection pool
   - Track shortlist completion rate

4. **Optimize BRE Rules:**
   - Review weekly rejection patterns
   - Adjust eligibility criteria based on MIS feedback
   - A/B test different BRE rule configurations

---

**Support:** For issues or questions, check logs at `ivr-router/logs/` or review API error responses.
