# Phase 3.5b: Application Push Engine

**Timeline:** 2-3 days | **Complexity:** Medium | **Status:** Implementation Complete

---

## Overview

Phase 3.5b implements the **Application Push Engine** — the multi-channel orchestration layer that sends personalized application invitations using intent data from Phase 3.5a. It coordinates WhatsApp (primary), Email (fallback), and Slack (ops alerts) to maximize application completion rates.

### Purpose

- **Multi-channel push orchestration** (WhatsApp → Email → Slack)
- **Personalized messaging** based on intent classification
- **Engagement tracking** to measure channel performance
- **Ops visibility** through Slack alerts for high-intent leads
- **Fallback logic** if primary channel fails

### The Application Push Loop

```
Intent Generated (Phase 3.5a)
    ↓
Retrieve User Intent + Profile
    ↓
Send WhatsApp Message (Primary)
    ├─ Success? → Log event, alert Slack
    └─ Failure? → Send Email (Fallback)
    ├─ Success? → Log event
    └─ Failure? → Log failure
    ↓
Track Engagement Events
    ├─ WhatsApp opened
    ├─ Email clicked
    ├─ Application started
    └─ Inactivity triggers re-engagement
    ↓
Feed engagement signals back to re-engagement engine (Phase 3.5e)
```

---

## Architecture

### Data Flow

```
┌──────────────────────────────────────────┐
│  Intent from Phase 3.5a                  │
│  (personalized_message, recommended_amt) │
└──────────────┬───────────────────────────┘
               ↓
┌──────────────────────────────────────────┐
│  Application Push Client                 │
│  (lib/llm/applicationPushClient.js)      │
└──────────────┬───────────────────────────┘
               ├─────────────────────┬─────────────────────┬──────────────┐
               ↓                     ↓                     ↓              ↓
        ┌──────────────┐      ┌──────────────┐      ┌──────────────┐ ┌──────────────┐
        │  Ananta API  │      │ SendGrid API │      │ Slack API    │ │ Supabase     │
        │  WhatsApp    │      │ Email        │      │ Ops Alerts   │ │ Event Log    │
        └──────────────┘      └──────────────┘      └──────────────┘ └──────────────┘
               ↓                     ↓                     ↓              ↓
        Message Sent          Fallback Send         High-Intent      Track Events
                                                    Alert Sent
               ↓                     ↓                     ↓
        ┌──────────────────────────────────────────────────────┐
        │  Track Engagement (push_engagement_events)           │
        │  - WhatsApp opened                                   │
        │  - Email clicked                                     │
        │  - Application started                               │
        │  - Inactivity 2h → Send re-engagement prompt         │
        └──────────────────────────────────────────────────────┘
```

---

## Implementation

### Component 1: Application Push Client

**File:** `lib/llm/applicationPushClient.js`

**Key Methods:**

#### `sendPersonalizedApplicationPush(phoneNumber, userIntent, userProfile)`

Orchestrates multi-channel push and returns success/failure status.

**Input:**
```javascript
{
  phoneNumber: "+919999999999",
  userIntent: {
    intent: "working_capital",
    completion_probability: 0.88,
    recommended_amount: 1200000,
    personalized_message: "Hi Rajesh! You're eligible for ₹12L...",
    messaging_angle: "cash_flow_smooth"
  },
  userProfile: {
    name: "Rajesh Kumar",
    email: "rajesh@example.com",
    age: 35,
    annual_income: 1800000
  }
}
```

**Output:**
```javascript
{
  success: true,
  push_event: {
    phone_number: "+919999999999",
    channels_attempted: ["whatsapp", "slack"],
    channels_succeeded: ["whatsapp", "slack"],
    intent_used: "working_capital",
    whatsapp_message_id: "whatsapp_...",
    push_timestamp: "2024-08-25T16:30:00Z"
  },
  message: "Push sent via whatsapp, slack"
}
```

#### `sendWhatsAppMessage(phoneNumber, userIntent, userProfile)`

Sends personalized WhatsApp message via Ananta API.

**Message Template:**
```
Hi {name}! 👋

We can help you get {amount} to {messaging_angle}.

✅ No guarantor needed
✅ Approval in 24 hours
✅ Your rate: 14% p.a. (EMI: ₹{emi}/month)

Start your application → [Click here]

Any questions? Just reply here! 💬
```

**Example Output:**
```
Hi Rajesh! 👋

We can help you get ₹12L to manage your seasonal cash flow.

✅ No guarantor needed
✅ Approval in 24 hours
✅ Your rate: 14% p.a. (EMI: ₹3,200/month)

Start your application → [Click here]

Any questions? Just reply here! 💬
```

#### `sendEmailMessage(phoneNumber, userIntent, userProfile)`

Fallback email via SendGrid if WhatsApp fails.

**Email Subject:**
```
₹{amount} Pre-Approved for {name} - Complete in 5 Minutes
```

**Email Body:**
HTML-formatted pre-approval letter with key details, benefits, and CTA button.

#### `sendSlackAlert(phoneNumber, userIntent, userProfile)`

Sends high-intent lead alert to ops team (for leads with completion_probability > 0.80).

**Slack Message:**
```
🚀 High-Intent Lead: Rajesh Kumar
Phone: +919999999999
Loan Amount: ₹12L
Intent: working_capital
Completion Probability: 88%
Recommended Lender: Poonawala
Risk Profile: low
Message: "Hi Rajesh! You're eligible for ₹12L..."
```

#### `trackPushEngagement(phoneNumber, eventType, metadata)`

Logs engagement events for later analysis and re-engagement triggering.

**Event Types:**
- `whatsapp_opened` — User opened WhatsApp message
- `email_clicked` — User clicked email link
- `application_started` — User began application
- `application_abandoned` — User paused after {step}
- `inactivity_2h` — No activity for 2 hours (triggers re-engagement)
- `document_rejected` — Lender rejected document (triggers re-upload guidance)

---

### Component 2: API Endpoints

**File:** `lib/routes/applicationPushRoutes.js`

#### `POST /api/push/send-application-push`

Sends personalized application push via all configured channels.

**Request:**
```bash
curl -X POST http://localhost:3000/api/push/send-application-push \
  -H "Content-Type: application/json" \
  -d '{
    "phone_number": "+919999999999",
    "user_profile": {
      "name": "Rajesh Kumar",
      "email": "rajesh@example.com",
      "age": 35,
      "annual_income": 1800000
    }
  }'
```

**Response (Success):**
```json
{
  "success": true,
  "push_event": {
    "phone_number": "+919999999999",
    "channels_attempted": ["whatsapp", "slack"],
    "channels_succeeded": ["whatsapp", "slack"],
    "intent_used": "working_capital",
    "personalized_message": "Hi Rajesh! You're eligible for ₹12L...",
    "whatsapp_message_id": "whatsapp_1724068200000",
    "push_timestamp": "2024-08-25T16:30:00Z"
  },
  "message": "Push sent via whatsapp, slack"
}
```

#### `POST /api/push/track-engagement`

Records engagement events for analysis.

**Request:**
```bash
curl -X POST http://localhost:3000/api/push/track-engagement \
  -H "Content-Type: application/json" \
  -d '{
    "phone_number": "+919999999999",
    "event_type": "whatsapp_opened",
    "metadata": {
      "time_elapsed": 120,
      "device": "mobile"
    }
  }'
```

**Response:**
```json
{
  "success": true,
  "message": "Engagement tracked"
}
```

#### `GET /api/push/events/:phone_number`

Retrieves push and engagement events for a user.

**Request:**
```bash
curl http://localhost:3000/api/push/events/+919999999999
```

---

### Component 3: Database Schema

**File:** `database-schema.sql`

#### `push_events` Table

Tracks when pushes are sent and via which channels.

```sql
CREATE TABLE IF NOT EXISTS public.push_events (
  id UUID PRIMARY KEY,
  phone_number VARCHAR(20) NOT NULL,
  channels_attempted VARCHAR[], -- ['whatsapp', 'email', 'slack']
  channels_succeeded VARCHAR[], -- Channels that worked
  whatsapp_message_id VARCHAR(255),
  email_message_id VARCHAR(255),
  intent_used VARCHAR(50),
  personalized_message TEXT,
  created_at TIMESTAMP DEFAULT now(),
  delivered_at TIMESTAMP,
  read_at TIMESTAMP
);
```

#### `push_engagement_events` Table

Tracks user engagement after push is sent.

```sql
CREATE TABLE IF NOT EXISTS public.push_engagement_events (
  id UUID PRIMARY KEY,
  phone_number VARCHAR(20) NOT NULL,
  event_type VARCHAR(100),  -- 'whatsapp_opened', 'email_clicked', etc.
  metadata JSONB,            -- Additional event data
  created_at TIMESTAMP DEFAULT now()
);
```

---

## Channel-Specific Configuration

### WhatsApp (Ananta)

**Status:** Primary channel
**Success Rate Target:** 95%+ (high deliverability)
**Latency:** <100ms

**Message Format:**
- Max 1024 characters
- Emoji support: ✅, ❌, 📞, 💬, 💰, 📊, 📄, 🔍, 💸, 📅, 👤, 💯
- Interactive buttons supported (future enhancement)

**Configuration in .env:**
```
ANANTA_BASE_URL=https://data-api.anantadot.com
ANANTA_API_KEY=...
ANANTA_API_TOKEN=...
ANANTA_API_SECRET_KEY=...
```

### Email (SendGrid)

**Status:** Fallback channel (if WhatsApp fails)
**Success Rate Target:** 98%+ (can be queued)
**Latency:** <5 seconds (may be async)

**Features:**
- HTML email templates
- Unsubscribe links
- Delivery tracking
- Bounce handling

**Configuration in .env:**
```
SENDGRID_API_KEY=SG.xxxxx
SENDGRID_FROM_EMAIL=support@buddyloan.com
```

### Slack

**Status:** Internal ops channel (high-intent leads only)
**Success Rate Target:** 99%+
**Latency:** <500ms

**Configuration in .env:**
```
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK/URL
```

**Channel:** `#application-tracking`

---

## Integration with Phase 3.5a (Intent Generation)

The application push engine relies on Phase 3.5a to provide:

1. **Intent Classification** → Used for messaging angle
2. **Completion Probability** → Determines if Slack alert is sent (threshold: 0.80)
3. **Recommended Amount** → Personalized loan offer
4. **Risk Profile** → Helps ops team prioritize follow-up
5. **Personalized Message** → Direct quote to use in WhatsApp

**Workflow:**

```
1. User completes personal/business details in WhatsApp bot
   ↓
2. Phase 3.5a generates intent analysis
   ↓
3. Ops/System triggers Phase 3.5b application push
   ↓
4. User receives personalized message based on intent
   ↓
5. Engagement is tracked (open, click, start, abandon, etc.)
   ↓
6. Feedback signal sent to Phase 3.5d (recalibration) and 3.5e (re-engagement)
```

---

## Testing

### Unit Tests

```javascript
// Test 1: WhatsApp message formatting
test('WhatsApp message includes all required elements', async () => {
  const intent = {
    messaging_angle: 'cash_flow_smooth',
    recommended_amount: 1200000,
    personalized_message: 'Hi Rajesh!...'
  };
  const profile = { name: 'Rajesh Kumar' };
  
  const message = applicationPushClient.buildWhatsAppMessage(intent, profile);
  expect(message).toContain('Hi Rajesh Kumar!');
  expect(message).toContain('₹12,00,000');
  expect(message).toContain('Start your application');
});

// Test 2: Email fallback on WhatsApp failure
test('Falls back to email if WhatsApp fails', async () => {
  const result = await applicationPushClient.sendPersonalizedApplicationPush(
    '+919999999999',
    mockIntent,
    mockProfile
  );
  
  expect(result.push_event.channels_attempted).toContain('whatsapp');
  expect(result.push_event.channels_succeeded.length).toBeGreaterThan(0);
});

// Test 3: Slack alert for high-intent leads only
test('Slack alert sent only for high-intent leads (>0.80)', async () => {
  const lowIntentResult = await applicationPushClient.sendPersonalizedApplicationPush(
    '+919999999999',
    { ...mockIntent, completion_probability: 0.70 },
    mockProfile
  );
  expect(lowIntentResult.push_event.channels_attempted).not.toContain('slack');
  
  const highIntentResult = await applicationPushClient.sendPersonalizedApplicationPush(
    '+919999999999',
    { ...mockIntent, completion_probability: 0.88 },
    mockProfile
  );
  expect(highIntentResult.push_event.channels_attempted).toContain('slack');
});

// Test 4: Engagement event tracking
test('Engagement events are tracked correctly', async () => {
  const result = await applicationPushClient.trackPushEngagement(
    '+919999999999',
    'whatsapp_opened',
    { time_elapsed: 120 }
  );
  expect(result.success).toBe(true);
});

// Test 5: SendGrid email formatting
test('Email includes correct subject and HTML', async () => {
  const { subject, html } = applicationPushClient.buildEmailContent(
    mockIntent,
    mockProfile
  );
  
  expect(subject).toContain('Pre-Approved');
  expect(subject).toContain('₹12,00,000');
  expect(html).toContain('Complete Your Application');
});
```

### Manual Testing Flow

```bash
# 1. Ensure intent exists for user
curl -X POST http://localhost:3000/api/llm/generate-intent \
  -H "Content-Type: application/json" \
  -d '{
    "phone_number": "+919999999999",
    "user_profile": {
      "name": "Rajesh Kumar",
      "age": 35,
      "business_type": "retail",
      "annual_income": 1800000,
      "cibil_score": 745,
      "hunter_score": 880,
      "bureau_vintage": 8,
      "live_loans": 1,
      "enquiries_30d": 1
    }
  }'

# 2. Send application push
curl -X POST http://localhost:3000/api/push/send-application-push \
  -H "Content-Type: application/json" \
  -d '{
    "phone_number": "+919999999999",
    "user_profile": {
      "name": "Rajesh Kumar",
      "email": "rajesh@example.com",
      "age": 35,
      "annual_income": 1800000
    }
  }'

# Expected: WhatsApp message sent, Slack alert sent (if completion_probability > 0.80)

# 3. Track engagement
curl -X POST http://localhost:3000/api/push/track-engagement \
  -H "Content-Type: application/json" \
  -d '{
    "phone_number": "+919999999999",
    "event_type": "whatsapp_opened",
    "metadata": { "device": "mobile" }
  }'

# Expected: Engagement event logged
```

---

## Conversation Flow with Push Integration

```
User: Completes business details form
Bot: "✅ Perfect! Here's your summary:
      💰 Loan Amount: ₹12,00,000
      📅 Tenure: 36 months
      💸 Approx EMI: ₹3,200/month
      
      📄 Now let's upload your documents."

[Behind the scenes: System generates intent → Sends push to Ops]

Ops/System: Triggers Phase 3.5b push
User: Receives WhatsApp message
"Hi Rajesh! 👋

We can help you get ₹12L to manage your seasonal cash flow.

✅ No guarantor needed
✅ Approval in 24 hours
✅ Your rate: 14% p.a. (EMI: ₹3,200/month)

Start your application → [Click here]

Any questions? Just reply here! 💬"

User: Clicks link or replies in WhatsApp
System: Tracks engagement → Feeds to Phase 3.5e (re-engagement)
```

---

## Error Handling

### WhatsApp Send Failure

**Retry Logic:**
1. Log error to console and Sentry
2. Immediately attempt SendGrid email fallback
3. If email succeeds, consider push successful
4. If both fail, log to rejection_logs for ops review

**Slack Alert on Repeated Failures:**
Send alert to `#application-tracking` if both channels fail for a high-intent lead.

### SendGrid Email Failure

**Retry Logic:**
1. Log error
2. Retry once (async job queue in Phase 3.5b+)
3. If persistent, alert ops via Slack
4. Manual override option in ops dashboard

### Slack Webhook Failure

**Handling:**
- Non-critical channel (ops alert only)
- Failure doesn't block push success
- Log error but don't fail the entire push
- Can be retried via BullMQ in Phase 3.5b+

---

## Metrics to Track

| Metric | Target | Query |
|--------|--------|-------|
| WhatsApp delivery rate | 98%+ | `channels_succeeded ILIKE 'whatsapp'` |
| Email fallback rate | <2% | `'email' IN channels_succeeded AND 'whatsapp' NOT IN channels_succeeded` |
| Slack alert accuracy | 95%+ | `event_count / high_intent_count` |
| WhatsApp open rate | 60%+ | `COUNT(*) WHERE event_type = 'whatsapp_opened'` |
| Email click rate | 25%+ | `COUNT(*) WHERE event_type = 'email_clicked'` |
| Application start rate | 40%+ | `COUNT(*) WHERE event_type = 'application_started' / COUNT DISTINCT phone` |
| Push-to-completion rate | 15%+ (Phase 3a baseline 5%) | By segment analysis |

---

## Configuration

### Environment Variables

```bash
# Ananta WhatsApp
ANANTA_BASE_URL=https://data-api.anantadot.com
ANANTA_API_KEY=...
ANANTA_API_TOKEN=...
ANANTA_API_SECRET_KEY=...

# SendGrid Email
SENDGRID_API_KEY=SG.xxxxx...
SENDGRID_FROM_EMAIL=support@buddyloan.com

# Slack Ops Alerts
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK/URL

# Supabase (for event tracking)
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...
```

---

## Next Steps

### Phase 3.5c: Rejection Tracking (1 day)
Capture lender rejection reasons and store in rejection_logs table for Phase 3.5d analysis.

### Phase 3.5d: Suppression & Recalibration (2 days)
Nightly batch job analyzing rejection patterns and updating eligibility rules.

### Phase 3.5e: Re-engagement Campaign (2-3 days)
Use push engagement events + rejection logs to trigger re-engagement campaigns for newly-eligible users.

### Phase 3.5b+ (Optional): BullMQ Job Queue
Add async job processing for:
- Retry failed sends
- Schedule timed re-engagement pushes
- Batch email sends (high volume)

---

## Files Modified

| File | Changes |
|------|---------|
| `lib/llm/applicationPushClient.js` | NEW - Multi-channel push orchestration |
| `lib/routes/applicationPushRoutes.js` | NEW - Express routes for push endpoints |
| `database-schema.sql` | UPDATED - Added push_events and push_engagement_events tables |
| `index.js` | UPDATED - Imported and mounted push routes |
| `package.json` | UPDATED - Added @sendgrid/mail dependency |
| `.env.example` | UPDATED - Added SendGrid and Slack configuration |

---

## Success Metrics

After Phase 3.5b implementation:
- ✅ All high-intent users receive personalized application push
- ✅ 98%+ WhatsApp delivery rate with email fallback
- ✅ Slack alerts enable ops team to proactively follow up
- ✅ Engagement tracking provides feedback for re-engagement engine
- ✅ Application push increases completion rate by 15%+ over baseline
