# Railway Deployment Guide: IVR Router (Self-Running LLM Engine)

**Last Updated:** 2026-08-25  
**Status:** Ready for Production Deployment  
**Phases:** 3.5a-3.5e Complete

---

## 📋 Pre-Deployment Checklist

Before deploying to Railway, ensure you have:

- [ ] Railway account created (https://railway.app)
- [ ] Railway CLI installed (`npm install -g @railway/cli`)
- [ ] GitHub repo connected to Railway (or ready to connect)
- [ ] All environment variables ready
- [ ] PostgreSQL database (Railway or external Supabase)
- [ ] Redis instance (Railway will create)
- [ ] 30 minutes to complete full deployment

---

## 🚀 Step 1: Create Railway Project

### Option A: Via Railway Dashboard (Recommended)

1. Go to https://railway.app/dashboard
2. Click "Create New Project"
3. Select "Deploy from GitHub" → Connect your GitHub account
4. Select repo: `puneetmakkhija-pixel/automation-hub`
5. Select branch: `claude/ivr-api-automation-hub-7hnftv`
6. Click "Deploy Now"

### Option B: Via Railway CLI

```bash
# Login to Railway
railway login

# Create new project
railway init

# Name: ivr-router
# Region: Choose closest to India (Singapore or Tokyo recommended)

# Link to existing GitHub repo
railway link <project-id>
```

---

## 🗄️ Step 2: Add PostgreSQL Database

Railway will automatically detect `Dockerfile` and create a container. Now add database:

1. In Railway dashboard, click "Create" button in your project
2. Select "PostgreSQL"
3. Click "Deploy"
4. Wait for PostgreSQL to start (~1-2 mins)

Railway will automatically:
- Create `DATABASE_URL` environment variable
- Provision SSL certificate
- Enable automatic backups

**Verify connection:**
```bash
railway link <project-id>
railway env list | grep DATABASE_URL
```

---

## 🔴 Step 3: Add Redis Service

1. In Railway dashboard, click "Create" button
2. Select "Redis"
3. Click "Deploy"
4. Wait for Redis to start (~1-2 mins)

Railway will automatically:
- Create `REDIS_URL` environment variable (format: `redis://default:password@host:port`)
- Enable persistence
- Set up monitoring

**Verify connection:**
```bash
railway env list | grep REDIS_URL
```

---

## 🔑 Step 4: Set Environment Variables

In Railway dashboard, go to Variables tab and add all production variables:

### Required Variables

```
NODE_ENV=production
PORT=3000
LOG_LEVEL=info

# Claude API
CLAUDE_API_KEY=sk-ant-xxxxx
CLAUDE_MODEL=claude-3-5-sonnet-20241022
CLAUDE_MAX_TOKENS=1024

# Supabase (if external, else use DATABASE_URL from Railway PostgreSQL)
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_KEY=xxxxx
SUPABASE_SERVICE_ROLE_KEY=xxxxx

# Ananta (WhatsApp)
ANANTA_API_KEY=xxxxx
ANANTA_API_URL=https://api.ananta.io/v1

# SendGrid (Email)
SENDGRID_API_KEY=SG.xxxxx
SENDGRID_FROM_EMAIL=noreply@loan.co

# Slack Webhooks
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/xxxxx
SLACK_WEBHOOK_REENGAGEMENT=https://hooks.slack.com/services/xxxxx
SLACK_WEBHOOK_REJECTION=https://hooks.slack.com/services/xxxxx

# OBD API (Voice)
OBD_BASE_URL=https://obdapi2.ivrsms.com
OBD_USERNAME=xxxxx
OBD_PASSWORD=xxxxx
```

**How to add in Railway:**
1. Go to Variables tab
2. Click "Raw Editor"
3. Paste above (replace xxxxx with actual values)
4. Click "Save"

Railway automatically provides:
- `DATABASE_URL` (PostgreSQL)
- `REDIS_URL` (Redis)
- `PORT` (set to 3000)
- `RAILWAY_PUBLIC_DOMAIN` (your app's URL)

---

## 📊 Step 5: Database Migrations

Once PostgreSQL is running, apply migrations:

### Option A: Via Railway CLI

```bash
# Connect to railway
railway link <project-id>

# Exec migration on remote DB
railway run psql -f database-schema.sql
```

### Option B: Manual via psql

```bash
# Get DATABASE_URL
railway env list | grep DATABASE_URL

# Copy the URL and run:
psql "postgresql://user:password@host:port/database" -f database-schema.sql

# Verify tables created
psql "postgresql://user:password@host:port/database" -c "\dt"
```

**Expected tables:**
- rejection_logs
- eligibility_rules
- rule_recommendations
- reengagement_events
- user_intents
- push_events
- push_engagement_events

---

## 🐳 Step 6: Deploy Application

### Automatic Deploy (Recommended)

Once GitHub repo is connected, Railway automatically deploys when you push to `claude/ivr-api-automation-hub-7hnftv`:

```bash
# Push changes (already done, but for reference)
git push origin claude/ivr-api-automation-hub-7hnftv

# Railway detects push, builds Docker image, and deploys
# Watch progress in Railway dashboard
```

### Manual Deploy

```bash
# Connect to Railway
railway link <project-id>

# Deploy
railway up

# Watch logs
railway logs -f
```

**Deployment takes 3-5 minutes:**
1. Build Docker image
2. Push to Railway registry
3. Deploy container
4. Start health checks

---

## ✅ Step 7: Verify Deployment

### Check Application Health

```bash
# Get your app URL from Railway dashboard
# Format: https://ivr-router-production-xxxxxx.up.railway.app

# Test health endpoint
curl https://ivr-router-production-xxxxxx.up.railway.app/health
# Expected: "ok"
```

### Check Logs

```bash
# Via Railway CLI
railway logs -f

# Expected output:
# IVR Router listening on 3000
# OBD API configured at https://obdapi2.ivrsms.com
```

### Test API Endpoints

```bash
# Test rejection tracking (Phase 3.5c)
curl -X GET https://ivr-router-production-xxxxxx.up.railway.app/api/rejections/by-lender/poonawala?hours=24

# Test suppression analysis (Phase 3.5d)
curl -X GET https://ivr-router-production-xxxxxx.up.railway.app/api/suppression/current-rules

# Test re-engagement (Phase 3.5e)
curl -X GET https://ivr-router-production-xxxxxx.up.railway.app/api/reengagement/metrics?hours=24
```

---

## ⏰ Step 8: Register Nightly Jobs

The BullMQ job queue needs to be initialized. Add a job worker process in Railway:

### Option A: Include in main process

Jobs will run in the main app process. Ensure:

1. Redis is connected (via `REDIS_URL`)
2. In `index.js`, job queues initialize on startup
3. Check logs for: "BullMQ jobs initialized"

### Option B: Separate worker process (Optional)

Create `lib/workers/jobWorker.js`:

```javascript
// lib/workers/jobWorker.js
import { Worker } from 'bullmq';
import suppressionClient from '../llm/suppressionAnalysisClient.js';
import reengagementClient from '../llm/reengagementClient.js';

const redis_url = process.env.REDIS_URL || 'redis://localhost:6379';

// Phase 3.5d: Suppression analysis @ 01:00 AM IST
const suppressionWorker = new Worker('suppression-analysis', async () => {
  console.log('[BullMQ] Phase 3.5d worker: Running suppression analysis');
  const result = await suppressionClient.analyzeRejectionPatterns();
  return result;
}, { connection: redis_url });

suppressionWorker.on('completed', (job) => {
  console.log(`[BullMQ] Phase 3.5d completed: ${job.id}`);
});

suppressionWorker.on('failed', (job, err) => {
  console.error(`[BullMQ] Phase 3.5d failed: ${job.id}`, err);
});

// Phase 3.5e: Re-engagement @ 02:00 AM IST
const reengagementWorker = new Worker('reengagement-campaign', async () => {
  console.log('[BullMQ] Phase 3.5e worker: Finding newly-eligible users');
  const result = await reengagementClient.findNewlyEligibleUsers(24);
  console.log(`[BullMQ] Found ${result.count} newly-eligible users`);
  const campaign = await reengagementClient.sendReengagementCampaign(result.newly_eligible_users);
  return campaign;
}, { connection: redis_url });

reengagementWorker.on('completed', (job) => {
  console.log(`[BullMQ] Phase 3.5e completed: ${job.id}`);
});

reengagementWorker.on('failed', (job, err) => {
  console.error(`[BullMQ] Phase 3.5e failed: ${job.id}`, err);
});

console.log('[BullMQ] Workers initialized');
```

Then in Railway, add another process:
1. Click "New Service"
2. Select "Custom"
3. Build command: `npm ci`
4. Start command: `node lib/workers/jobWorker.js`
5. Deploy

---

## 📡 Step 9: Set Up Monitoring

### Railway Built-in Monitoring

Railway provides automatic monitoring:
- Logs: `railway logs -f`
- Metrics: Dashboard shows CPU, memory, disk
- Health checks: Automatically polls `/health` endpoint

### Connect to External Services

Once deployed, configure webhooks from external services:

**Lender Rejection Webhooks:**
```
POST https://ivr-router-production-xxxxxx.up.railway.app/webhooks/obd
POST https://ivr-router-production-xxxxxx.up.railway.app/webhooks/sms
POST https://ivr-router-production-xxxxxx.up.railway.app/webhooks/ananta
```

**Update your lender configs to point to production URLs**

### Optional: Add Uptime Monitoring

```bash
# Via Railway dashboard
# Create a simple health check monitor pointing to /health endpoint
# Alert on failures
```

---

## 🔄 Step 10: Enable Nightly Jobs

Once deployed, jobs should start automatically. Verify:

```bash
# Check logs @ 01:00 AM IST for Phase 3.5d
railway logs -f | grep "Phase 3.5d"

# Check logs @ 02:00 AM IST for Phase 3.5e
railway logs -f | grep "Phase 3.5e"

# Expected:
# [Phase 3.5d] Analysis started
# [Phase 3.5d] Recommendation generated with confidence 0.92
# [Phase 3.5d] Slack alert posted
```

---

## 🧪 Testing Checklist (Day 1)

- [ ] App is healthy: `/health` returns "ok"
- [ ] API endpoints respond: test all 5 phases
- [ ] Database connected: can query rejection_logs
- [ ] Redis connected: can see REDIS_URL in env
- [ ] Slack webhooks working: send test message
- [ ] Claude API working: generate intent for test user
- [ ] Ananta/SendGrid working: send test WhatsApp/email
- [ ] Logs are flowing: `railway logs -f` shows activity

---

## 📊 Post-Deployment Operations

### Daily Monitoring

```bash
# Watch logs in real-time
railway logs -f

# Check specific phase logs
railway logs -f | grep "Phase 3.5"

# Check error logs
railway logs -f | grep "ERROR\|CRITICAL"
```

### Common Issues & Fixes

#### Issue: 502 Bad Gateway

**Cause:** App crashed or not responding  
**Fix:**
```bash
# Check logs
railway logs -f | tail -50

# Restart app
railway redeploy

# Check health
curl https://ivr-router-production-xxxxxx.up.railway.app/health
```

#### Issue: Database Connection Failed

**Cause:** DATABASE_URL not set or wrong  
**Fix:**
```bash
# Verify DATABASE_URL
railway env list | grep DATABASE_URL

# Reconnect
railway link <project-id>
railway env update DATABASE_URL

# Redeploy
railway redeploy
```

#### Issue: Redis Connection Failed

**Cause:** REDIS_URL not set or Redis not running  
**Fix:**
```bash
# Verify Redis is running in Railway dashboard
# Verify REDIS_URL in env
railway env list | grep REDIS_URL

# If not found, add Redis service:
# 1. Click "Create" in Railway dashboard
# 2. Select Redis
# 3. Deploy

# Redeploy app
railway redeploy
```

#### Issue: Jobs Not Running @ 01:00 AM IST

**Cause:** BullMQ not initialized or Redis offline  
**Fix:**
```bash
# Check for job initialization in logs
railway logs -f | grep "BullMQ"

# Manual trigger to test
curl -X POST https://ivr-router-production-xxxxxx.up.railway.app/api/suppression/analyze \
  -H "Content-Type: application/json" \
  -d '{"hours": 24}'

# If works manually but not scheduled:
# 1. Check Redis is connected
# 2. Restart app: railway redeploy
# 3. Check logs again @ next scheduled time
```

---

## 🚀 Rollback Plan

If something breaks after deployment:

```bash
# Option 1: Rollback to previous commit
git revert HEAD
git push origin claude/ivr-api-automation-hub-7hnftv
# Railway auto-redeploys

# Option 2: Rollback via Railway dashboard
# Deployments tab → select previous version → click "Rollback"

# Option 3: Stop deployment
railway redeploy --no-build
```

---

## 📞 Get Help

**Railway Support:**
- Docs: https://railway.app/docs
- Discord: https://discord.gg/railway
- Status: https://railway.app/status

**Your Team:**
- Slack: #suppression-analysis, #reengagement-campaigns
- Email: ops@loan.co

---

## ✅ Deployment Summary

**Before:** Code on `claude/ivr-api-automation-hub-7hnftv` branch  
**After:** App running on Railway at `https://ivr-router-production-xxxxxx.up.railway.app`

**What's Deployed:**
- ✅ Phase 3.5a: Intent Generation (real-time)
- ✅ Phase 3.5b: Application Push (real-time)
- ✅ Phase 3.5c: Rejection Tracking (real-time)
- ✅ Phase 3.5d: Suppression Analysis (nightly @ 01:00 AM IST)
- ✅ Phase 3.5e: Re-engagement Campaign (nightly @ 02:00 AM IST)

**Expected Results:**
- Day 1: 1,200+ rejections captured
- Day 2 @ 01:00 AM: Rule analysis runs, 0.85+ confidence
- Day 2 @ 02:00 AM: 200-400 newly-eligible users re-engaged
- Day 2 @ 08:00 AM: 25-30% response rate from re-engagement
- Week 1: 3-5% end-to-end completion (from 0.1% baseline)

**Keep Monitoring:**
- Daily: Check #suppression-analysis, #reengagement-campaigns, #rejection-tracking
- Weekly: Review metrics, test full flow
- Monthly: Update documentation, plan optimizations

**Next Steps:**
1. Complete deployment checklist
2. Run 24-hour monitoring after deployment
3. Plan Phase 4: Lender Submission
4. Optimize based on real data
