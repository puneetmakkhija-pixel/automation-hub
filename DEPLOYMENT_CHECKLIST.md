# Production Deployment Checklist

**Status:** Ready for Deployment  
**Date:** August 28, 2026  
**Target:** Production (Railway)

---

## ✅ PRE-DEPLOYMENT VERIFICATION (15 minutes)

### Backend API Health Check
- [ ] Health endpoint responds: `curl https://ivr-voice-bot-system-production.up.railway.app/api/health`
- [ ] Metrics endpoint works: `curl https://ivr-voice-bot-system-production.up.railway.app/api/analytics/metrics`
- [ ] Database connected: Verify Supabase status
- [ ] All services online on Railway dashboard

### API Response Format Verification
- [ ] GET /api/analytics/metrics returns: `{success: true, data: {...}}`
- [ ] GET /api/campaigns returns array of campaigns
- [ ] GET /api/leads returns array with pagination
- [ ] POST /api/campaigns creates campaign and returns id
- [ ] POST /api/leads/bulk processes CSV file

### Dashboard File Check
- [ ] dashboard/index.html exists and loads
- [ ] JavaScript has no syntax errors (F12 console)
- [ ] All API endpoints referenced in code exist
- [ ] Test data file exists: test_leads_100.csv

---

## 🚀 DEPLOYMENT STEPS (30 minutes)

### Step 1: Choose Hosting (5 min)
Select one deployment option:

**Option A: Railway (Same as Backend)**
```bash
# Add static file serving to existing Railway project
# Upload dashboard/index.html to public/ folder
# Deploy: https://ivr-voice-bot-system-production.up.railway.app/dashboard
```

**Option B: GitHub Pages (Free)**
```bash
# Create gh-pages branch
# Upload dashboard/index.html
# Access at: https://yourusername.github.io/automation-hub/dashboard.html
```

**Option C: Netlify (Free)**
```bash
# Connect GitHub repo
# Set build command: none
# Set publish directory: ./
# Deploy dashboard/index.html
```

**Option D: Vercel (Free)**
```bash
# Connect GitHub repo
# Import project
# Deploy as static site
```

### Step 2: Deploy Dashboard (10 min)

**For Railway:**
```bash
# SSH to Railway container
railway connect
mkdir -p /app/public
cp dashboard/index.html /app/public/
exit
# Redeploy
railway up
```

**For GitHub Pages:**
```bash
git checkout --orphan gh-pages
git rm -rf .
cp dashboard/index.html index.html
git add index.html
git commit -m "Deploy dashboard"
git push origin gh-pages
```

### Step 3: Test Deployment (10 min)
- [ ] Open deployed dashboard URL in browser
- [ ] Dashboard loads without errors (F12 console)
- [ ] Metric cards show "Loading..." initially
- [ ] After 2-3 seconds, metrics display numbers
- [ ] All tabs (Dashboard, Campaigns, Leads, etc.) work
- [ ] Forms open and close properly

### Step 4: Verify Cross-Origin Requests (5 min)
- [ ] No CORS errors in browser console
- [ ] Can make requests from deployed dashboard to Railway backend
- [ ] Error alerts display correctly when API fails

---

## 📊 POST-DEPLOYMENT VALIDATION (15 minutes)

### Database Verification
- [ ] Login to Supabase console
- [ ] Verify tables exist: leads, campaigns, events, dispositions
- [ ] Check row counts
- [ ] Verify indexes on phone column (for search performance)

### API Endpoint Testing (via Dashboard)
| Endpoint | Test | Expected | Status |
|----------|------|----------|--------|
| GET /api/analytics/metrics | Click Dashboard tab | Numbers appear | ✓ |
| POST /api/campaigns | Create campaign | Success alert | ✓ |
| GET /api/campaigns | See campaign list | Campaign in table | ✓ |
| POST /api/leads/bulk | Upload test_leads_100.csv | 100 leads imported | ✓ |
| GET /api/leads | View leads table | Leads display | ✓ |
| GET /api/leads/search | Search phone | Filtered results | ✓ |

### Performance Check
- [ ] Dashboard loads in <2 seconds
- [ ] Metric refresh completes in <1 second
- [ ] Campaign creation completes in <2 seconds
- [ ] Lead upload completes in <5 seconds
- [ ] No console errors (F12)
- [ ] No network timeouts

---

## 🎯 LIVE CAMPAIGN LAUNCH CHECKLIST (1 hour)

### Pre-Campaign (15 min)
- [ ] 100 test leads prepared (test_leads_100.csv)
- [ ] WhatsApp template configured in Ananta
- [ ] Voice prompt configured in OBD
- [ ] DTMF routing rules set
- [ ] Do-not-call list updated
- [ ] Monitoring dashboard open (dashboard in browser)
- [ ] Team notified and ready

### Campaign Execution (30 min)
- [ ] Upload leads via dashboard → "100 leads imported"
- [ ] Create campaign via dashboard → Success alert
- [ ] Click "Launch" → Status changes to "active"
- [ ] Monitor metrics in real-time:
  - WhatsApp delivery notifications
  - Call connection events
  - DTMF input captures
  - Disposition updates

### First 5 Minutes
- [ ] First WhatsApp delivery received? (Check Ananta webhook)
- [ ] First call connected? (Check OBD webhook)
- [ ] First DTMF captured? (Check console)
- [ ] Dashboard metrics updating? (Auto-refresh every 30s)

### 15-30 Minutes
- [ ] WhatsApp delivery rate tracking (expect 85%+)
- [ ] Call connect rate tracking (expect 70%+)
- [ ] DTMF response rate (expect 60%+)
- [ ] No errors in webhook logs
- [ ] Database storing dispositions

### Post-Campaign (15 min)
- [ ] Campaign marked complete
- [ ] Metrics finalized
- [ ] Generate summary report
- [ ] Archive for analysis

---

## 📈 SUCCESS CRITERIA

### Deployment Success
- ✅ Dashboard loads from deployed URL
- ✅ No JavaScript errors
- ✅ Can communicate with backend API
- ✅ Forms submit successfully
- ✅ Data displays correctly

### Campaign Success
- ✅ 100 leads imported
- ✅ 80+ WhatsApp delivered (80%+)
- ✅ 60+ calls connected (60%+)
- ✅ 40+ DTMF captured (40%+)
- ✅ 15+ interested dispositions
- ✅ 0 critical errors

### Metrics Success
- ✅ Dashboard metrics match actual numbers
- ✅ Conversion funnel accurate
- ✅ Rejection breakdown correct
- ✅ Cost per lead calculated (₹8)
- ✅ System uptime maintained (99.95%+)

---

## 🚨 TROUBLESHOOTING DURING DEPLOYMENT

### Dashboard Won't Load
```
1. Check browser console (F12)
2. Verify URL is correct
3. Check server returns 200 OK
4. Verify HTML file exists on server
5. Clear browser cache (Ctrl+Shift+Delete)
```

### Metrics Show "Loading..." Forever
```
1. Check backend health: curl .../api/health
2. Check metrics endpoint: curl .../api/analytics/metrics
3. Look for CORS errors in console
4. Verify backend is responding (not timeout)
5. Check network tab in F12
```

### Campaign Form Doesn't Submit
```
1. Check all form fields are filled
2. Look for JavaScript errors in console
3. Check network tab for API request status
4. Verify endpoint in DASHBOARD_API_CONTRACT.md
5. Check backend logs for errors
```

### WebSocket Connection Issues
```
1. Check firewall rules allow WebSocket
2. Verify backend supports WebSocket (or use polling)
3. Check browser console for connection errors
4. Try refreshing page
5. Restart backend service
```

---

## 📝 DEPLOYMENT COMMAND CHEATSHEET

### Local Testing Before Deploy
```bash
# Open dashboard locally
open file:///home/user/automation-hub/dashboard/index.html

# Test backend endpoints
curl https://ivr-voice-bot-system-production.up.railway.app/api/health
curl https://ivr-voice-bot-system-production.up.railway.app/api/analytics/metrics
curl https://ivr-voice-bot-system-production.up.railway.app/api/campaigns
```

### Deploy to Railway
```bash
railway connect
cp dashboard/index.html public/
railway up
```

### Deploy to GitHub Pages
```bash
git checkout -b gh-pages
cp dashboard/index.html index.html
git add index.html
git commit -m "Deploy dashboard"
git push origin gh-pages
```

### Monitor After Deploy
```bash
# Check logs
railway logs

# Monitor metrics
curl -s https://ivr-voice-bot-system-production.up.railway.app/api/analytics/metrics | jq

# Check database
# Login to Supabase console
```

---

## 🔄 ROLLBACK PROCEDURE (If Needed)

### Revert Dashboard Deployment
```bash
# For Railway: Rollback to previous deployment
railway logs --tail
railway down

# For GitHub Pages: Revert commit
git reset --hard HEAD~1
git push origin gh-pages --force

# For Netlify: Rollback to previous deploy
# Via Netlify dashboard → Deploys → Rollback
```

### Revert Database Changes
```bash
# If bad data imported:
# 1. Login to Supabase console
# 2. Delete problematic records
# 3. Re-run data validation
```

---

## 📊 MONITORING AFTER DEPLOYMENT

### Daily Checks
- [ ] Dashboard health: curl .../health
- [ ] Metrics updating: Check dashboard tab
- [ ] No error alerts in browser console
- [ ] API response times <1 second

### Weekly Checks
- [ ] Database size growing normally
- [ ] No failed webhooks in logs
- [ ] Conversion metrics consistent
- [ ] Cost per lead tracking correctly

### Monthly Checks
- [ ] Performance benchmarking
- [ ] Database optimization
- [ ] Security audit (no exposed credentials)
- [ ] Capacity planning (traffic growth)

---

## ✅ SIGN-OFF

**When all items above are checked:**
- [ ] Production deployment complete
- [ ] Live campaign tested successfully
- [ ] Metrics validated
- [ ] Monitoring active
- [ ] Team trained on dashboard

**Status: READY FOR PRODUCTION** ✅

**Date Deployed:** _______________  
**Deployed By:** _______________  
**Approval:** _______________
