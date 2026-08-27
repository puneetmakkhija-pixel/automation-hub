# Quick Deployment Checklist

## 🚀 5-Step Production Deployment

### ✅ Step 1: Database Migration (5 minutes)

```
Location: Supabase Dashboard → SQL Editor
File: database/migrations/001_dual_campaign_system.sql
Action: Copy entire SQL file → Paste → Run
Verify: All 10 tables created (check at Data → Tables)
```

**Command to verify in SQL Editor:**
```sql
SELECT COUNT(*) as table_count FROM information_schema.tables 
WHERE table_schema = 'public' AND table_name LIKE 'bre_%' OR table_name LIKE '%_journey%' 
OR table_name LIKE '%_rejection%' OR table_name LIKE 'diy_%';
-- Should return 9
```

---

### ✅ Step 2: Environment Configuration (5 minutes)

**File:** `ivr-router/.env`

**Add these lines:**
```bash
# NEW - Lender MIS Webhook Secrets
POONAWALLA_MIS_SECRET=<get_from_poonawalla_ops>
HERO_FINCORP_MIS_SECRET=<get_from_hero_ops>
```

**Verify existing variables are set:**
- SUPABASE_URL ✓
- SUPABASE_SERVICE_ROLE_KEY ✓
- OBD_BASE_URL, OBD_USERNAME, OBD_PASSWORD ✓
- ANANTA_BASE_URL, ANANTA_API_* ✓

---

### ✅ Step 3: Deploy Monitoring Console (2 minutes)

**Option A (Recommended):** Upload to Web Server
```
File: automation-console.html
URL: https://crmbusinessloans.com/automation-hub
Access: Browser → Test all 5 tabs load
```

**Option B:** Serve from IVR Router
```
Copy: automation-console.html → ivr-router/public/
Access: https://your-railway-url/automation-console
```

---

### ✅ Step 4: Test API Endpoints (5 minutes)

**Health Check (all should return 200):**
```bash
curl https://your-railway-url/api/bre/health
curl https://your-railway-url/api/router/health
curl https://your-railway-url/api/mis/health
```

**Test BRE Shortlisting:**
```bash
curl -X POST https://your-railway-url/api/bre/run-daily-shortlist \
  -H "Content-Type: application/json" \
  -d '{"reportDate":"2024-01-15","limit":10,"lenderId":"poonawalla"}'
```

**Test DIY Journey:**
```bash
curl -X POST https://your-railway-url/api/router/diy-journey \
  -H "Content-Type: application/json" \
  -d '{"phone":"919876543210","name":"Test","campaignId":"c1","lenderId":"poonawalla"}'
```

**Test MIS Report:**
```bash
curl -X POST https://your-railway-url/api/mis/process-report \
  -H "Content-Type: application/json" \
  -d '{
    "source":"poonawalla",
    "reportDate":"2024-01-15",
    "records":[{"phone":"919876543210","applicationId":"a1","status":"rejected","rejectionCode":"CIBIL_LOW"}]
  }'
```

---

### ✅ Step 5: Configure Lender Webhooks (10 minutes)

**Share with Poonawalla Ops:**
```
Webhook URL: https://your-railway-url/api/mis/webhook/poonawalla
Method: POST
Auth: Bearer {POONAWALLA_MIS_SECRET}
Headers: Content-Type: application/json
Body Format: See DEPLOYMENT_GUIDE.md Phase 4
```

**Share with Hero FinCorp Ops:**
```
Webhook URL: https://your-railway-url/api/mis/webhook/hero-fincorp
Method: POST
Auth: Bearer {HERO_FINCORP_MIS_SECRET}
Headers: Content-Type: application/json
Body Format: See DEPLOYMENT_GUIDE.md Phase 4
```

---

## 🧪 Quick Testing Workflow (via Console)

### Test 1: BRE Shortlisting
1. Open console → **BRE Shortlisting** tab
2. Click "Run Daily Shortlist"
3. Set limit=5, lender=poonawalla
4. Click **Execute**
5. ✓ Should see shortlist in response

### Test 2: Document Journey (Path A)
1. Console → **Campaign Routing** tab
2. Section: "Document Journey (Path A)"
3. Fill: phone=919876543210, name=TestUser, campaignId=test1, lenderId=poonawalla
4. Click **Execute**
5. ✓ Should get routing ID

### Test 3: DIY Journey (Path B)
1. Console → **Campaign Routing** tab
2. Section: "DIY Journey (Path B)"
3. Fill same fields
4. Click **Execute**
5. ✓ Should get DIY link with UTM params

### Test 4: Rejection Fallback
1. Console → **Campaign Routing** tab
2. Section: "Handle Rejection/Fallback"
3. Fill: phone, campaignId, rejectedLender=poonawalla
4. Click **Execute**
5. ✓ Should return Hero FinCorp fallback link

### Test 5: MIS Processing
1. Console → **MIS Feedback** tab
2. Paste sample JSON rejection data
3. Click **Process Report**
4. ✓ Should see processing confirmation
5. Verify in DB: `SELECT * FROM lender_rejection_events`

---

## 📊 Database Verification Queries

**Check BRE shortlist:**
```sql
SELECT lender_id, COUNT(*) as count, AVG(eligibility_score) as avg_score 
FROM bre_shortlists 
WHERE shortlist_date = CURRENT_DATE 
GROUP BY lender_id;
```

**Check routing decisions:**
```sql
SELECT campaign_type, dtmf_input, COUNT(*) 
FROM ivr_routing_decisions 
WHERE DATE(created_at) = CURRENT_DATE 
GROUP BY campaign_type, dtmf_input;
```

**Check rejection patterns:**
```sql
SELECT rejection_code, rejection_category, COUNT(*) 
FROM lender_rejection_events 
WHERE DATE(created_at) = CURRENT_DATE 
GROUP BY rejection_code, rejection_category 
ORDER BY COUNT(*) DESC;
```

**Check DIY conversions:**
```sql
SELECT lender_id, status, COUNT(*) 
FROM diy_journey_log 
WHERE DATE(created_at) = CURRENT_DATE 
GROUP BY lender_id, status;
```

---

## 🔧 Common Issues & Fixes

| Issue | Fix |
|-------|-----|
| Tables don't exist | Re-run migration SQL in Supabase |
| MIS webhooks failing | Check POONAWALLA_MIS_SECRET is set |
| DIY links not sending | Verify ANANTA credentials in .env |
| 404 on endpoints | Confirm routes mounted in index.js |
| Shortlist empty | Check Supabase customers_sme table exists |
| Rejection codes not found | Verify lender_rejection_events has records |

---

## 📅 Post-Deployment

After all tests pass:

1. **Schedule Daily Shortlist Job** (6 AM UTC)
   ```
   Cron: 0 6 * * * curl -X POST https://your-url/api/bre/run-daily-shortlist
   ```

2. **Setup Monitoring Alerts**
   - API error rate > 5%
   - Response time > 5s
   - Shortlist completion failed

3. **Review Weekly Metrics**
   - Top rejection codes
   - Conversion rates by path
   - BRE optimization recommendations

4. **Coordinate with Lenders**
   - Confirm webhooks working
   - Share dashboard link for monitoring

---

**Status:** Ready for production deployment ✓  
**Timeline:** ~30 minutes total  
**Support:** See DEPLOYMENT_GUIDE.md for detailed steps
