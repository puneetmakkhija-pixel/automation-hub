# Phase 3.5E: Re-engagement Campaign Engine

**Objective:** Nightly batch job (02:00 AM IST) that runs after Phase 3.5d rule updates, finds users who were previously rejected but are NOW eligible under new rules, and sends personalized re-engagement via multi-channel (WhatsApp + Email). **Expected outcome:** 18-20% conversion on re-engaged users, closing the feedback loop.

**Closes Loop:** Phase 3.5d finds newly-eligible users → Phase 3.5e re-engages them → User restarts application (Phase 3a bot) → Approval → Feedback loop complete ✓

---

## Problem Statement

**Current State:** User rejected on Day 1 with CIBIL 680 (threshold was 700). Rules relaxed overnight to CIBIL 650. User is now eligible but **doesn't know it** — they've moved on.

**Solution:** Query `eligibility_rules` version changes, identify users who failed under old rules but pass under new rules, send personalized "You're now eligible!" message via WhatsApp + Email, re-engage them in conversation bot (Phase 3a).

**Expected Lift:** 
- Newly-eligible pool: 200-400 users/day (from Phase 3.5d)
- Re-engagement message delivery: 85%+ (WhatsApp + email fallback)
- Response rate: 25-30% (users click "restart application")
- Application completion: 18-20% (conversational bot guidance)
- **Effective re-engagement conversion:** 300 users/day × 20% = 60 new applications/day from previously-rejected pool

---

## Architecture

### Data Flow
```
Phase 3.5d: Rule Update Complete (v1 → v2) @ 01:00 AM IST
    ↓
02:00 AM IST: Reengagement Job Fires (1 hour later)
    ↓
Query: rejection_logs WHERE rejected_at > 24h ago AND user_engaged_again = false
    ↓
Filter: Would fail under OLD rules BUT pass under NEW rules
    ↓ Result: newlyEligibleUsers = [user1, user2, ..., user300]
    ↓
For each user:
  • Fetch full profile (name, email, phone, business_type, annual_income)
  • Generate personalized message via Claude LLM (1-2 sentences)
  • Send WhatsApp: "Hi {Name}! New rules = you're now eligible. Restart: [link]"
  • Send Email: HTML template with pre-filled form
  • Track: reengagement_events (campaign_sent)
    ↓
Slack alert: "300 users re-engaged today, 85 opened WhatsApp, 45 clicked restart"
    ↓
User clicks WhatsApp link OR email button
    ↓
Phase 3a: Conversation Bot Engages
  • "Welcome back! Let's finish your application in 5 minutes."
  • 9-phase state machine (product → eligibility → lender → personal → business → docs → kyc → submit → approval)
  • Real-time eligibility check against NEW rules
  • If approved: Loan funded, user joins winner cohort
    ↓
Phase 3.5c: Track Success or Next Rejection
    ↓
Feedback Loop Closed ✓
```

---

## Implementation

### 1. Database Schema

Add to `database-schema.sql`:

```sql
-- Re-engagement campaign events
CREATE TABLE reengagement_events (
  id BIGSERIAL PRIMARY KEY,
  phone_number VARCHAR(20) NOT NULL,
  
  -- Event types: campaign_sent, email_clicked, whatsapp_opened, application_started, application_completed, response_recorded
  event_type VARCHAR(50) NOT NULL,
  
  -- Metadata: message, outcome, timestamp, etc.
  metadata JSONB DEFAULT '{}',
  
  -- Audit
  created_at TIMESTAMP DEFAULT now(),
  
  FOREIGN KEY (phone_number) REFERENCES users(phone_number),
  CONSTRAINT valid_event_type CHECK (event_type IN (
    'campaign_sent', 'email_clicked', 'whatsapp_opened', 
    'application_started', 'application_completed', 'response_recorded'
  ))
);

CREATE INDEX idx_reengagement_events_phone ON reengagement_events(phone_number);
CREATE INDEX idx_reengagement_events_type ON reengagement_events(event_type);
CREATE INDEX idx_reengagement_events_created ON reengagement_events(created_at DESC);

-- Add columns to rejection_logs (from Phase 3.5c schema)
-- (These should already exist from 3.5c)
-- ALTER TABLE rejection_logs ADD COLUMN reengagement_sent_at TIMESTAMP;
-- ALTER TABLE rejection_logs ADD COLUMN reengagement_channel VARCHAR(50);
-- ALTER TABLE rejection_logs ADD COLUMN reengagement_response_at TIMESTAMP;
-- ALTER TABLE rejection_logs ADD COLUMN reengagement_response_outcome VARCHAR(100);
```

---

### 2. Reengagement Client

**File:** `lib/llm/reengagementClient.js` (400+ lines)

**Key Methods:**

#### `findNewlyEligibleUsers(timeWindowHours=24)`
- Fetch current and previous eligibility rules from eligibility_rules table
- Query rejection_logs from last 24h where user_engaged_again=false
- For each rejected user, check:
  - Would they fail under OLD rules? ✓
  - Would they pass under NEW rules? ✓
  - If both true → add to newly_eligible_users[]
- Return: `{ newly_eligible_users: [...], count: 300, previous_version: 1, current_version: 2 }`

**Logic:**

```javascript
checkEligibility(rejection, rules) {
  // Returns true if INELIGIBLE (failed check), false if eligible
  
  if (rejection.bureau.cibil_score < rules.cibil_minimum_score) {
    return true;  // Ineligible: failed CIBIL check
  }
  
  if (rejection.demographic.age > rules.age_maximum) {
    return true;  // Ineligible: too old
  }
  
  if (rejection.demographic.annual_income < rules.income_minimum) {
    return true;  // Ineligible: income too low
  }
  
  return false;  // Eligible
}

// Usage:
const wouldFailOldRules = checkEligibility(rejection, previousRules);
const wouldPassNewRules = !checkEligibility(rejection, currentRules);

if (wouldFailOldRules && wouldPassNewRules) {
  newlyEligible.push(rejection);
}
```

#### `generateReengagementMessage(phoneNumber, userProfile)`
- Call Claude API with context: "User was rejected previously but is NOW eligible due to rule changes"
- Prompt: "Craft a 1-2 sentence re-engagement message (WhatsApp-friendly) for this user."
- Return: Personalized message, e.g., "Great news! We've relaxed our eligibility criteria and you now qualify for ₹50L. Ready to restart your application?"
- Fallback if API fails: Generic message

**Claude Prompt:**

```
You are a loan origination specialist re-engaging a user who was previously rejected.

USER PROFILE:
- Name: {name}
- Business: {business_type}
- Annual Income: ₹{annual_income}
- CIBIL Score: {cibil_score}

CONTEXT:
- This user applied previously and was rejected
- Our eligibility rules have been updated (CIBIL threshold relaxed 700 → 650)
- They now qualify under new rules
- Message is for WhatsApp, must be 1-2 sentences, conversational, exciting

GENERATE A MESSAGE (return ONLY the message text):`;
```

#### `sendReengagementCampaign(newlyEligibleUsers)`
- For each user:
  1. Fetch full profile from users table
  2. Generate personalized message via Claude
  3. Send WhatsApp (via Ananta client)
  4. Send Email (via SendGrid fallback)
  5. Track event in reengagement_events table
- Aggregate results: { total: 300, sent: 285, failed: 15, channels: { whatsapp: 250, email: 35 } }
- Alert Slack with summary
- Return results

#### `sendWhatsAppReengagement(phoneNumber, message, userProfile)`
- Call `anantaClient.sendTextMessage()`
- Message format: "Hi {Name}! {personalized_message}\n\nTap to restart: [WhatsApp link]"
- Link: `https://wa.link/automation-hub/restart/{phoneNumber}`
- Return: `{ success: true, message_id: "..." }`

#### `sendEmailReengagement(phoneNumber, userProfile, message)`
- Call SendGrid API (v3)
- Subject: "Good News! You're Now Eligible for a Loan 💰"
- HTML body: Professional template with personalized message, loan amount, APR, CTA button
- Button link: `https://wa.link/automation-hub/restart/{phoneNumber}`
- Return: `{ success: true }`

#### `trackReengagementResponse(phoneNumber, responseOutcome)`
- Update rejection_logs: SET reengagement_response_at=now(), reengagement_response_outcome=outcome
- Insert into reengagement_events: { event_type: 'response_recorded', outcome: outcome }
- Call Phase 3.5c method to mark user as engaged
- Return: `{ success: true }`

#### `getReengagementMetrics(timeWindowHours=24)`
- Count campaigns_sent (event_type='campaign_sent')
- Count responses_received (event_type='response_recorded')
- Calculate conversion_rate = responses / campaigns × 100
- Return: `{ campaigns_sent: 300, responses_received: 75, conversion_rate: 25.0 }`

#### `alertCampaignViaSlack(results)`
- Post to #reengagement-campaigns
- Color-coded attachment (green if >80% success, yellow if 60-80%, red if <60%)
- Fields: Total Targeted, Successfully Sent, WhatsApp Count, Email Count, Success Rate, Timestamp

---

### 3. Routes

**File:** `lib/routes/reengagementRoutes.js`

```javascript
POST /api/reengagement/find-eligible
  Input:  { hours: 24 }
  Output: {
    newly_eligible_count: 300,
    users: [{phone_number, bureau_vars, demographic_vars, rejected_at}, ...],
    total_found: 300,
    previous_rules_version: 1,
    current_rules_version: 2
  }
  Called by: Nightly job (02:00 UTC) or manual trigger

POST /api/reengagement/campaign
  Input:  { users: [{phone_number, bureau_vars, demographic_vars}, ...] }
  Output: {
    results: {
      total: 300,
      sent: 285,
      failed: 15,
      channels: { whatsapp: 250, email: 35 }
    }
  }
  Called by: Nightly job after find-eligible

POST /api/reengagement/track-response
  Input:  { phone_number: "919876543210", response_outcome: "started_application" }
  Output: { success: true }
  Called by: User clicks WhatsApp/Email link, bot triggers this endpoint

GET /api/reengagement/metrics
  Query:  ?hours=24
  Output: {
    metrics: {
      campaigns_sent: 300,
      responses_received: 75,
      conversion_rate: 25.0
    }
  }
  Called by: Dashboard, ops monitoring

GET /api/reengagement/events/:phone_number
  Query:  ?limit=20
  Output: {
    events: [{event_type, metadata, created_at}, ...],
    count: 5
  }
  Called by: User profile page, audit trail
```

---

### 4. Nightly Job Integration (BullMQ)

**Scheduled Job @ 02:00 UTC** (1 hour after Phase 3.5d @ 01:00 UTC):

```javascript
// ivr-router/lib/jobs/reengagementCampaignJob.js

import Queue from 'bullmq';
import reengagementClient from '../llm/reengagementClient.js';

const reengagement_queue = new Queue('reengagement-campaign', {
  connection: { host: process.env.REDIS_HOST || 'localhost', port: process.env.REDIS_PORT || 6379 }
});

// Schedule nightly @ 02:00 AM IST (20:30 UTC previous day)
reengagement_queue.add(
  'send-campaign',
  { hours: 24 },
  {
    repeat: { cron: '30 20 * * *' },  // 02:00 AM IST (20:30 UTC)
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 }
  }
);

// Process job
reengagement_queue.process(async (job) => {
  console.log('[Reengagement Job] Starting re-engagement campaign...');
  
  // Step 1: Find newly-eligible users
  const eligibleResult = await reengagementClient.findNewlyEligibleUsers(job.data.hours);
  
  if (!eligibleResult.success || eligibleResult.count === 0) {
    console.log('[Reengagement Job] No newly-eligible users found');
    return { success: true, message: 'No users to re-engage' };
  }
  
  console.log(`[Reengagement Job] Found ${eligibleResult.count} newly-eligible users`);
  
  // Step 2: Send re-engagement campaign
  const campaignResult = await reengagementClient.sendReengagementCampaign(
    eligibleResult.newly_eligible_users
  );
  
  if (campaignResult.success) {
    console.log(`[Reengagement Job] Campaign sent: ${campaignResult.results.sent}/${campaignResult.results.total}`);
    // Slack alert sent automatically by reengagementClient
  }
  
  return campaignResult;
});
```

---

## Testing

### Unit Test: Find Newly-Eligible Users

```javascript
import reengagementClient from '../lib/llm/reengagementClient.js';

describe('Phase 3.5e: Re-engagement', () => {
  test('findNewlyEligibleUsers should identify rule change winners', async () => {
    // Mocks:
    // 1. Current rules: CIBIL 650, age 65
    // 2. Previous rules: CIBIL 700, age 65
    // 3. User A: CIBIL 680 (failed old, passes new)
    // 4. User B: CIBIL 710 (passed both)
    // 5. User C: CIBIL 600 (failed both)

    const result = await reengagementClient.findNewlyEligibleUsers(24);

    expect(result.success).toBe(true);
    expect(result.count).toBe(1);  // Only User A
    expect(result.newly_eligible_users[0].bureau_vars.cibil_score).toBe(680);
  });

  test('generateReengagementMessage should return personalized text', async () => {
    const message = await reengagementClient.generateReengagementMessage(
      '919876543210',
      { name: 'Rajesh', business_type: 'retail', annual_income: 450000 }
    );

    expect(message).toBeDefined();
    expect(message.length).toBeGreaterThan(20);
    expect(message.length).toBeLessThan(200);
  });

  test('sendReengagementCampaign should send messages to all users', async () => {
    const users = [
      { phone_number: '919876543210', bureau_vars: { cibil_score: 680 } },
      { phone_number: '919876543211', bureau_vars: { cibil_score: 670 } }
    ];

    const result = await reengagementClient.sendReengagementCampaign(users);

    expect(result.success).toBe(true);
    expect(result.results.sent).toBeGreaterThan(0);
    expect(result.results.channels.whatsapp + result.results.channels.email).toBeGreaterThan(0);
  });
});
```

### Integration Test: Nightly Job

```javascript
test('Reengagement nightly job should complete end-to-end', async () => {
  // Setup: Create rules v1 and v2 in DB, insert 50 rejection_logs
  
  // Execute
  const result = await reengagementClient.findNewlyEligibleUsers(24);
  expect(result.success).toBe(true);
  
  const campaignResult = await reengagementClient.sendReengagementCampaign(
    result.newly_eligible_users
  );
  expect(campaignResult.success).toBe(true);
  
  // Verify: reengagement_events table has 50+ rows with event_type='campaign_sent'
  const { data: events } = await supabase
    .from('reengagement_events')
    .select('*')
    .eq('event_type', 'campaign_sent');
  
  expect(events.length).toBeGreaterThanOrEqual(50);
});
```

### cURL Testing

**1. Find Newly-Eligible Users**

```bash
curl -X POST http://localhost:3000/api/reengagement/find-eligible \
  -H "Content-Type: application/json" \
  -d '{ "hours": 24 }'

# Response
{
  "success": true,
  "newly_eligible_count": 300,
  "users": [
    {
      "phone_number": "919876543210",
      "bureau_vars": { "cibil_score": 680 },
      "demographic_vars": { "age": 45, "annual_income": 450000 },
      "rejected_at": "2026-08-25T18:00:00Z"
    },
    ...
  ],
  "total_found": 300,
  "previous_rules_version": 1,
  "current_rules_version": 2
}
```

**2. Send Re-engagement Campaign**

```bash
curl -X POST http://localhost:3000/api/reengagement/campaign \
  -H "Content-Type: application/json" \
  -d '{
    "users": [
      {
        "phone_number": "919876543210",
        "bureau_vars": { "cibil_score": 680 },
        "demographic_vars": { "age": 45 }
      }
    ]
  }'

# Response
{
  "success": true,
  "message": "Re-engagement campaign completed",
  "results": {
    "total": 1,
    "sent": 1,
    "failed": 0,
    "channels": { "whatsapp": 1, "email": 0 }
  }
}
```

**3. Track User Response**

```bash
curl -X POST http://localhost:3000/api/reengagement/track-response \
  -H "Content-Type: application/json" \
  -d '{
    "phone_number": "919876543210",
    "response_outcome": "started_application"
  }'

# Response
{
  "success": true,
  "message": "Response tracked",
  "outcome": "started_application"
}
```

**4. Fetch Metrics**

```bash
curl http://localhost:3000/api/reengagement/metrics?hours=24

# Response
{
  "success": true,
  "metrics": {
    "campaigns_sent": 300,
    "responses_received": 75,
    "conversion_rate": 25.0,
    "time_window_hours": 24
  }
}
```

**5. Fetch User Events**

```bash
curl http://localhost:3000/api/reengagement/events/919876543210?limit=20

# Response
{
  "success": true,
  "phone_number": "919876543210",
  "events": [
    {
      "event_type": "campaign_sent",
      "metadata": { "message": "Great news! You're now eligible...", "whatsapp_sent": true },
      "created_at": "2026-08-25T02:00:00Z"
    },
    {
      "event_type": "response_recorded",
      "metadata": { "outcome": "started_application" },
      "created_at": "2026-08-25T02:15:00Z"
    }
  ],
  "count": 2
}
```

---

## Slack Integration

### Campaign Alert (Posted @ 02:00 AM IST)

**Channel:** `#reengagement-campaigns`

**Message:**
```
🎯 Re-engagement Campaign Summary

Total Users Targeted: 300
Successfully Sent: 285 (95%)
WhatsApp Messages: 250
Emails Sent: 35
Failed: 15

Timestamp: 2026-08-25T02:00:00Z

✅ Expected 75+ users to respond within 24h (25% conversion)
```

---

## Monitoring & Observability

### Key Metrics

| Metric | Target | Formula |
|--------|--------|---------|
| Newly-Eligible Users/Day | 200-400 | From Phase 3.5d recommendations |
| Re-engagement Delivery Rate | >85% | sent / total |
| Response Rate | 25-30% | responses_received / campaigns_sent |
| Application Completion Rate | 18-20% | applications_started / responses_received |
| Overall Loop Conversion | 5-8% | applications_started / newly_eligible |

### Logs

```javascript
[Reengagement Job] Starting re-engagement campaign...
[Reengagement Job] Found 300 newly-eligible users
[Reengagement Job] Generating personalized messages (5 per second)...
[Reengagement Job] Sending WhatsApp: 250 queued
[Reengagement Job] Sending Email (fallback): 50 queued
[Reengagement Job] Campaign sent: 285/300
[Reengagement Job] Slack alert sent to #reengagement-campaigns
```

### Grafana Dashboard

- **Daily Newly-Eligible** (line: date vs count from Phase 3.5d)
- **Campaign Delivery Rate** (gauge: target 85%)
- **Response Rate Trend** (line: date vs response_rate %)
- **Application Started** (bar: by day, target 75+/day)
- **Rule Version Timeline** (step: version changes, dates, impact estimates)

---

## Configuration

**Environment Variables:**

```bash
CLAUDE_API_KEY=sk-...                          # Anthropic API key
CLAUDE_MODEL=claude-3-5-sonnet-20241022        # Model for message generation
SENDGRID_API_KEY=SG.xxxxxx                     # SendGrid API key
SENDGRID_FROM_EMAIL=reengagement@loan.co       # From email
SLACK_WEBHOOK_URL=https://hooks.slack.com/...  # #reengagement-campaigns webhook
ANANTA_API_KEY=...                             # Ananta WhatsApp API
REDIS_HOST=localhost                           # BullMQ job queue
REDIS_PORT=6379
```

---

## Success Metrics: Full Feedback Loop

### End-to-End Conversion Path

```
Phase 1-2: 50K leads/day → 3,500 eligible (7%)
    ↓
Phase 3a: 3,500 conversations → 700 applications (20%)
    ↓
Phase 4: 700 applications → 490 approvals (70%)
    ↓
**Baseline: 490 approvals/day = 0.98% end-to-end (490/50K)**
    ↓
Phase 3.5c: Rejection tracking: 350 rejections/day (logged)
    ↓
Phase 3.5d: Analysis @ 01:00 UTC: "CIBIL 700→650 would add 280 newly-eligible"
    ↓
Phase 3.5e: Re-engagement @ 02:00 UTC: 280 users get "You're now eligible!" message
    ↓
Response rate 25%: 70 users restart application
    ↓
Phase 3a: 70 conversations → 14 applications (20% completion on re-engage)
    ↓
Phase 4: 14 applications → 10 approvals (70%)
    ↓
**New Loop Contribution: 10 approvals/day**
    ↓
**Total Daily Approvals: 490 + 10 = 500**
    ↓
**New End-to-End Rate: 500/50K = 1.0%**
    ↓
**Improvement: 1.0% vs 0.98% baseline ≈ 2% lift (modest)**
```

### Month 2-3 Accumulation (Multiple Rule Changes)

Day 1: CIBIL 700→650 (280 users, 2% lift)
Day 3: Age 65→68 (120 users, 1% lift)
Day 7: Income 150K→140K (95 users, 1% lift)
Week 2: Pincode expansion (200 users, 2% lift)

**Cumulative Impact by Week 3:**
- Newly-eligible pool: 1,500+ users
- Loop contribution: 50-75 approvals/day
- End-to-end rate: 0.98% → 2.0% (2x improvement)

**Month 3 Target: 3-5% end-to-end** (30-50x from original 0.1%)

---

## Rollback & Safety

If re-engagement conversion drops below 15% for 2 consecutive days:

```javascript
// Manual trigger (ops)
POST /api/reengagement/pause
→ Stop campaign queue
→ Alert: "Re-engagement paused, conversion rate below threshold"

// Debug: Check if Phase 3a bot is down or rules are misaligned
// Once fixed, resume
POST /api/reengagement/resume
```

All campaign events logged to reengagement_events table for audit trail.

---

## Next Steps

### Phase 4: Lender Submission
- Format application per lender spec (Poonawala, Hero, HDFC)
- Submit API call with application data
- Poll async response (1hr intervals, max 24hr wait)
- Fallback chain: Primary lender → Secondary lender → Tertiary lender
- Track success/failure per lender for feedback to Phase 3.5d

### Phase 5: Billing & Settlement
- Extract approved loan details
- Initiate EMI billing (monthly)
- Reconcile payments with lender
- Payout to lenders
- Compliance reporting

---

## Closed-Loop Feedback: Complete Picture

```
Day 1 @ 01:00 AM IST ─→ Phase 3.5d (Suppression Analysis)
                         "1,200 rejections analyzed, CIBIL 700→650 recommended"
                         ↓ Store recommendation
                         ↓ Slack alert to ops
                      
Day 1 @ 02:00 AM IST ─→ Phase 3.5e (Re-engagement Campaign)
                      "280 users newly eligible, sending re-engagement..."
                      ↓ Send 250 WhatsApp + 30 Email
                      ↓ 70 users click "restart" (25% response)
                      ↓ 14 new applications started
                      
Day 1 @ 14:00 UTC ─→ Phase 3a (Conversation Bot)
                      "70 users in 9-phase conversation state machine"
                      ↓ 14 complete applications (20% completion)
                      
Day 1 @ 18:00 UTC ─→ Phase 4 (Lender Submission)
                      "14 applications submitted to lenders"
                      ↓ 10 approved (70% approval rate)
                      
Day 2 @ 02:30 PM IST ─→ Phase 3.5c (Rejection Tracking)
                        "4 applications rejected, patterns logged"
                        ↓ Store rejection reasons, bureau vars
                        ↓ Alert ops to new pattern
                      
Day 2 @ 01:00 AM IST ─→ LOOP REPEATS
                      "Analyze new rejections, adjust rules further"
                      ↓ CIBIL 650→640? Age 65→70?
                      ↓ Continuous optimization
                      
LOOP CLOSURE ✓
```

**Result:** Fully automated self-learning system. No manual intervention needed after Day 1 setup. Each day's rejections train tomorrow's rule adjustments.
