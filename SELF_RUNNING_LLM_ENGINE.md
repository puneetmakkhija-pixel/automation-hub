# Self-Running LLM Engine: Closed-Loop Intelligence System

**Status:** Design Phase | **Scope:** Phase 3.5 (Post-Application Phase) | **Complexity:** High

---

## Overview

A **self-running LLM engine** that continuously learns from rejections, suppresses ineligible segments, recalibrates marketing, and re-engages users with smarter targeting. This is the intelligence layer that transforms raw lead data into increasingly smarter marketing campaigns.

### The Closed Loop

```
Supabase (User Data)
    ↓
Intent Generation (Claude LLM)
    ↓
Application Push (WhatsApp/Email)
    ↓
Lender Rejection Tracking
    ↓
Suppression Analysis (Bureau Variables → Eligible Base)
    ↓
Recalibration (Update Eligibility Rules)
    ↓
Re-Marketing (Segment → Re-engage)
    ↓
[Loop repeats with smarter targeting]
```

---

## System Architecture

### Core Components (5 Engines)

#### 1. **Intent Generation Engine** (Claude LLM)
- **Input:** User profile (demographics, bureau data, application stage)
- **Processing:** Claude API analyzes:
  - What loan purpose? (working capital, expansion, equipment, debt consolidation)
  - Why did they engage? (cash flow crisis? growth opportunity? seasonal need?)
  - What's their risk profile? (strong business fundamentals? struggling?)
  - Likelihood to complete application?
  - Best messaging angle?
- **Output:** Personalized intent score + messaging recommendation
- **Trigger:** Real-time when user enters WhatsApp bot

**Example:**
```
Input: Age 32, CIBIL 750, Annual Income ₹18L, Business Age 4yr, Enquiries: 1
Claude Analysis:
{
  "intent": "debt_consolidation",
  "confidence": 0.92,
  "risk_profile": "low_risk",
  "completion_probability": 0.87,
  "messaging_angle": "consolidate_high_rate_debts",
  "recommended_loan_amount": "₹12L",
  "recommended_lender": "poonawala"
}
```

#### 2. **Application Push Engine** (Ananta + Slack + SendGrid)
- **Channel Selection:** WhatsApp (primary) + Email (secondary) + Slack (internal alerts)
- **Personalized Guidance:** Uses intent data to customize conversation flow
- **Progress Tracking:** Real-time updates on form completion
- **Reengagement Triggers:**
  - 2-hour inactivity → Resume prompt via WhatsApp
  - Document rejection → Retry tips + OCR fix guide via SendGrid
  - Eligibility warning → Alternative lender suggestion via WhatsApp
- **Multi-Channel Orchestration:** Zapier coordinates cross-channel messaging
- **Output:** Application completion event logged to Supabase

#### 3. **Lender Mismatch Tracker** (Supabase + Airtable)
- **Capture:** Track why lender rejected user
  - Bureau-based: CIBIL too low, Hunter score failed, DPD detected
  - Demographic: Age out of range, income below minimum, pincode not serviceable
  - Business: Industry not approved, leverage too high, tenure too short
  - Soft: Enquiry limit exceeded, bureau vintage too low
- **Storage:** Rejection reason + rejected_at + lender_id in `rejection_logs` table
- **Airtable Sync:** Real-time sync of rejections to Airtable dashboard for ops visibility
- **Output:** Structured rejection data for suppression analysis

**Database Schema:**
```sql
CREATE TABLE rejection_logs (
  id UUID PRIMARY KEY,
  application_id UUID REFERENCES crm.leads,
  lender_id VARCHAR,
  rejection_reason VARCHAR, -- 'cibil_low', 'age_out_of_range', 'pincode_not_serviceable'
  rejection_category VARCHAR, -- 'bureau', 'demographic', 'business', 'soft'
  rejected_bureau_vars JSONB, -- {cibil: 650, hunter: 800, dpd: 1}
  rejected_demographic_vars JSONB, -- {age: 56, income: 150000, pincode: '400001'}
  rejected_at TIMESTAMP,
  user_engaged_again BOOLEAN DEFAULT FALSE,
  reengagement_channel VARCHAR
);
```

#### 4. **Suppression & Recalibration Engine** (Claude LLM + Supabase)
- **Analyze Rejection Patterns:**
  - Which bureau variables are causing 80%+ rejection rate?
  - Which demographic segments are being rejected disproportionately?
  - Which bureau thresholds are too strict?
  
**Example Analysis:**
```
Input: Last 1000 rejections for Poonawala
Claude Analysis:
{
  "top_rejection_drivers": [
    {"variable": "cibil_score", "rejection_rate": 0.68, "threshold": "< 700"},
    {"variable": "enquiry_count", "rejection_rate": 0.45, "threshold": "> 2 in 30d"},
    {"variable": "age", "rejection_rate": 0.12, "threshold": "> 55"}
  ],
  "suppression_recommendations": [
    "Suppress CIBIL < 650 (too strict, 30% approval even at 650-700)",
    "Suppress age > 55 (only 8% rejection, accept)",
    "Suppress enquiry_count > 3 in 30d (68% rejection, suppress)"
  ],
  "new_eligibility_rules": {
    "cibil_min": 650,  # down from 700
    "age_max": 60,     # up from 55
    "enquiry_max_30d": 2  # same
  }
}
```

- **Update Eligible Base:** Recalibrate eligibility rules in real-time
- **Segment Expansion:** Identify suppressed segments that are now eligible
- **Output:** Updated eligibility rules + suppressed segments list

#### 5. **Re-Marketing Engine** (Segment + Zapier + Ananta)
- **Segment Identification:** Find users previously suppressed (now eligible)
- **Batch Operations:** 
  - Query Supabase for "rejected but now eligible" users
  - Segment via Segment.com (behavioral, demographic)
  - Trigger re-engagement campaign via Zapier
- **Personalized Re-engagement:**
  - WhatsApp: "Good news! We've updated our eligibility. You're now approved for ₹15L"
  - Email: "Exclusive offer: ₹15L at 14% p.a. - No bureau check needed"
  - Slack: Internal alert for ops team
- **Conversion Tracking:** Track re-engagement → application → approval
- **Output:** New applications from re-engaged users

---

## Data Flow Architecture

### Real-Time Flow (Per User)

```
┌─────────────────────────────────────────────────────────────────┐
│                    USER ENTERS WHATSAPP BOT                      │
└─────────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│  1. FETCH USER PROFILE                                           │
│     Source: Supabase (crm.leads) + Bureau API (CIBIL/Hunter)    │
└─────────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│  2. INTENT GENERATION                                            │
│     Claude LLM: Analyze profile → Intent + Messaging             │
│     Endpoint: POST /api/llm/generate-intent                      │
│     Response: {intent, confidence, risk_profile, messaging}      │
└─────────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│  3. PERSONALIZED APPLICATION PUSH                               │
│     WhatsApp: "Hi {name}, you're eligible for ₹{amount}"        │
│     Ananta: Send personalized message based on intent            │
│     Email: SendGrid backup if WhatsApp fails                     │
└─────────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│  4. APPLICATION COMPLETION TRACKING                              │
│     Supabase: Log each form step (started, name_entered, ...)    │
│     Slack: Real-time progress alerts (#application-tracking)    │
│     Airtable: Sync application record for ops view               │
└─────────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│  5. LENDER ELIGIBILITY CHECK                                     │
│     Source: `/api/routing/check-eligibility` (Phase 2)           │
│     Response: eligible_lenders = [poonawala, hero, ...]          │
└─────────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│  6. LENDER SUBMISSION                                            │
│     Primary: Poonawala → ✅ Approved OR ❌ Rejected              │
└─────────────────────────────────────────────────────────────────┘
                    ↓                          ↓
            ✅ APPROVED              ❌ REJECTED
                    ↓                          ↓
    Log to Supabase        Log rejection_logs table
    crm.leads              (reason, variables, etc.)
    Status: approved            ↓
                   Trigger Reengagement Engine
                   (Try fallback lender or mark suppressed)
                           ↓
                   Update Suppression Analysis
```

### Batch Flow (Nightly Analysis & Recalibration)

```
NIGHTLY BATCH JOB (01:00 UTC)
├─ 1. Query rejection_logs (last 24h)
├─ 2. Claude LLM: Analyze patterns
│      └─ Which variables causing rejections?
│      └─ Which segments are over-suppressed?
├─ 3. Update eligible_base table
│      └─ Add newly-eligible segments
│      └─ Update suppression_list table
├─ 4. Query re-engagement candidates
│      └─ "Rejected yesterday but now eligible" users
├─ 5. Segment via Segment.com
│      └─ Behavioral, demographic, bureau score bands
├─ 6. Trigger Zapier workflow
│      └─ Create re-engagement campaign
│      └─ Queue WhatsApp messages
│      └─ Queue email sends via SendGrid
├─ 7. Log campaign to Airtable
│      └─ Recalibration_Campaigns table
└─ 8. Slack notification
       └─ "#daily-digest: {X} rejections analyzed, {Y} segments expanded, {Z} users re-engaged"
```

---

## Connector Integration Map

### Data Sources (Inbound)

| Source | Data | Frequency | Purpose |
|--------|------|-----------|---------|
| **Supabase** | User profiles, applications, rejections | Real-time | Core data |
| **CIBIL API** | Credit scores, DPD, bureau vintage | Per application | Eligibility check |
| **Hunter API** | Secondary credit score | Per application | Eligibility check |
| **Contentsquare** | User behavior on web (engagement patterns) | Real-time | Intent analysis (what pages do they visit?) |
| **Segment** | Customer analytics (segmentation data) | Real-time | Demographic/behavioral segments |
| **Google Analytics** | Conversion funnel (voice call → WhatsApp click → app completion) | Hourly | Performance tracking |
| **Airtable** | Feedback from ops team (manual overrides, edge cases) | Ad-hoc | Feedback loop |

### Processing (LLM)

| Tool | Component | Role |
|------|-----------|------|
| **Claude API** | Intent Generation | Analyze user profile → Personalized messaging |
| **Claude API** | Suppression Analysis | Analyze rejection patterns → Recommend rule changes |
| **Claude API** | Re-engagement Strategy | Generate personalized re-engagement message per user |

### Action Channels (Outbound)

| Channel | Tool | Use Case |
|---------|------|----------|
| **WhatsApp** | Ananta | Real-time application push, reengagement, status updates |
| **Email** | SendGrid | Backup application push, document collection, approval letters |
| **Internal Alerts** | Slack | Real-time ops notifications, daily digest, suppression analysis |
| **Workflow Automation** | Zapier | Orchestrate multi-channel campaigns, trigger re-engagement |
| **Dashboard** | Airtable | Ops view of applications, rejections, recalibrations |
| **Monitoring** | Grafana | Real-time metrics (completion rate, rejection rate, re-engagement ROI) |
| **Logging** | Sentry + ELK | Error tracking, audit trail |

### Analytics & Feedback

| Tool | Data Tracked | Insight |
|------|--------------|---------|
| **Contentsquare** | User behavior during form fill (rage clicks, hesitation points) | Where do users get stuck? What confuses them? |
| **Segment** | Cohort performance (which segments convert best?) | Which segments are most profitable? |
| **Google Analytics** | Funnel conversion (voice → WhatsApp → app → approval) | Where's the biggest drop-off? |
| **Grafana** | System metrics (API latency, webhook processing time) | Performance bottlenecks? |
| **Sentry** | Errors during application flow | Which errors cause user abandonment? |

---

## Implementation: 5 Engines

### Engine 1: Intent Generation (Real-Time)

**Endpoint:** `POST /api/llm/generate-intent`

**Request:**
```json
{
  "user_id": "app_123",
  "profile": {
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
}
```

**Claude Prompt:**
```
You are a loan origination AI. Analyze this user's profile and generate:
1. What's their likely intent? (working_capital, debt_consolidation, expansion, equipment, emergency)
2. Confidence level (0-1)?
3. Risk profile (low/medium/high)?
4. Completion probability (0-1)?
5. Best messaging angle to drive application completion?
6. Recommended loan amount based on income + business stage?
7. Best lender match?

Profile: {user_profile}

Respond as JSON only.
```

**Response:**
```json
{
  "intent": "working_capital",
  "intent_confidence": 0.85,
  "risk_profile": "low",
  "completion_probability": 0.88,
  "messaging_angle": "cash_flow_smooth",
  "recommended_amount": 1200000,
  "recommended_lender": "poonawala",
  "personalized_message": "Hi Rajesh! You're eligible for ₹12L at 14% p.a. to manage seasonal cash flow. Quick 5-min application."
}
```

**Integration:**
- Store in Supabase: `user_intents` table
- Use in WhatsApp bot to personalize messages
- Track if intent matches actual loan purpose (feedback signal)

---

### Engine 2: Application Push (Multi-Channel)

**Endpoint:** `POST /api/push/personalized-application`

**Logic:**
```
1. Get user's intent from user_intents table
2. Get user's communication preference (WhatsApp/Email/SMS)
3. Check recent rejections (if any, suggest fallback lender)
4. Generate personalized message using intent data
5. Send via Ananta (WhatsApp)
6. Backup send via SendGrid (Email) if WhatsApp fails
7. Log to Supabase: push_events table
8. Alert Slack: #application-tracking channel
```

**Ananta Message:**
```
WhatsApp message:
"Hi Rajesh! 👋

We can help you get ₹12L to manage your cash flow smoothly.

✅ No guarantor needed
✅ Approval in 24 hours  
✅ Your rate: 14% p.a. (EMI: ₹3,100/month)

Start your application → [Click here]

Any questions? Just reply here! 💬"
```

**SendGrid Backup:**
```
Email subject: "₹12L Pre-Approved for Rajesh - Complete in 5 Minutes"

Body:
"We've pre-approved you for ₹12L working capital loan.
- No guarantor needed
- Rate: 14% p.a.
- Approval: 24 hours
- EMI: ₹3,100/month

Complete application: [Link]

Questions? Reply to this email."
```

**Slack Alert:**
```
Channel: #application-tracking
"🚀 Push: Rajesh Kumar (ID: app_123)
   Intent: working_capital
   Amount: ₹12L
   Lender: Poonawala
   Channel: WhatsApp + Email
   Status: Sent"
```

**Zapier Workflow:**
- Trigger: Application push event
- Action 1: Send WhatsApp via Ananta
- Action 2: Send Email via SendGrid (delay 10 min)
- Action 3: Create/update Airtable record
- Action 4: Slack notification

---

### Engine 3: Lender Rejection Tracker

**Trigger:** When lender API returns rejection

**Capture Logic:**
```python
def track_rejection(application_id, lender_id, rejection_response):
    # Parse lender rejection response
    rejection_reason = rejection_response.get('reason')  # e.g., 'cibil_score_low'
    rejection_vars = rejection_response.get('failed_checks')  # e.g., {cibil: 650, hunter: 800}
    
    # Categorize rejection
    category = categorize_rejection(rejection_reason)  # 'bureau', 'demographic', 'business'
    
    # Store to Supabase
    supabase.table('rejection_logs').insert({
        'application_id': application_id,
        'lender_id': lender_id,
        'rejection_reason': rejection_reason,
        'rejection_category': category,
        'rejected_bureau_vars': rejection_vars,
        'rejected_demographic_vars': get_demographic_vars(application_id),
        'rejected_at': datetime.now()
    })
    
    # Sync to Airtable for ops visibility
    airtable.table('Rejection_Logs').add_record({
        'Application ID': application_id,
        'Lender': lender_id,
        'Reason': rejection_reason,
        'Category': category,
        'Timestamp': datetime.now()
    })
    
    # Check if fallback lender exists
    fallback_lenders = get_fallback_lenders(lender_id)
    if fallback_lenders:
        # Try next lender in chain
        trigger_lender_submission(application_id, fallback_lenders[0])
    else:
        # No more fallbacks, mark for suppression analysis
        mark_for_suppression_analysis(application_id)
```

**Database:**
```sql
CREATE TABLE rejection_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID REFERENCES crm.leads NOT NULL,
  lender_id VARCHAR NOT NULL,
  rejection_reason VARCHAR, -- 'cibil_score_low', 'age_out_of_range', etc.
  rejection_category VARCHAR, -- 'bureau', 'demographic', 'business', 'soft'
  rejected_bureau_vars JSONB, -- {cibil: 650, hunter: 800, dpd: 1}
  rejected_demographic_vars JSONB, -- {age: 56, income: 150000, pincode: '400001'}
  lender_message TEXT, -- Full rejection message from lender
  rejected_at TIMESTAMP DEFAULT now(),
  
  -- Reengagement tracking
  user_engaged_again BOOLEAN DEFAULT FALSE,
  reengagement_channel VARCHAR, -- 'whatsapp', 'email', 'sms'
  reengagement_at TIMESTAMP,
  
  -- Suppression tracking
  suppressed BOOLEAN DEFAULT FALSE,
  suppression_reason VARCHAR,
  suppressed_at TIMESTAMP,
  
  INDEX (application_id),
  INDEX (lender_id),
  INDEX (rejection_category),
  INDEX (rejected_at)
);
```

---

### Engine 4: Suppression & Recalibration (Nightly Batch)

**Cron Job:** Daily at 01:00 UTC

**Process:**
```
STEP 1: Query Rejections (Last 24h)
SELECT * FROM rejection_logs 
WHERE rejected_at > NOW() - INTERVAL '24 hours'
LIMIT 1000;

Output: List of {rejection_reason, bureau_vars, demographic_vars, category}

STEP 2: Claude LLM Analysis
Prompt: "Analyze these 1000 rejections. For each bureau variable (CIBIL, Hunter, DPD, Enquiries), 
         calculate rejection rate. If rejection_rate > 0.7 for a threshold, recommend suppressing 
         that threshold. If < 0.3, recommend loosening."

Output: {
  "variable": "cibil_score",
  "current_threshold": 700,
  "rejection_rate_at_650-700": 0.32,
  "recommendation": "Loosen to 650 (only 32% rejection, likely approval driven by other factors)",
  "confidence": 0.85
}

STEP 3: Update Eligibility Rules
For each recommendation with confidence > 0.8:
  UPDATE eligibility_rules SET cibil_min = 650 WHERE lender_id = 'poonawala';

STEP 4: Identify Newly Eligible Segments
SELECT COUNT(*) FROM crm.leads 
WHERE 
  status = 'rejected' AND 
  rejected_reason = 'cibil_score_low' AND
  cibil_score >= 650;  -- Now eligible under new rule

Output: "234 users previously rejected for CIBIL, now eligible"

STEP 5: Flag for Re-engagement
INSERT INTO reengagement_candidates 
SELECT * FROM crm.leads 
WHERE 
  status = 'rejected' AND
  rejected_reason = 'cibil_score_low' AND
  cibil_score >= 650 AND
  last_engaged_at > NOW() - INTERVAL '30 days';

Output: "145 users eligible + engaged in last 30d → Ready for re-engagement"
```

**Claude Prompt for Analysis:**
```
You are an eligibility rule optimization AI. Analyze these 1000 lender rejections.

For each bureau variable (CIBIL, Hunter, DPD, Enquiries, Bureau Vintage), calculate:
1. How many rejections cited this variable? (rejection_count)
2. What threshold level was rejected? (e.g., CIBIL < 700)
3. What's the rejection rate? (rejection_count / total)
4. Are we being too strict?

Recommendation rules:
- If rejection_rate > 70%: This threshold is highly predictive, KEEP
- If rejection_rate 50-70%: Consider loosening by 1 step
- If rejection_rate 30-50%: Definitely loosen (too many false negatives)
- If rejection_rate < 30%: This is not a good predictor, REMOVE

Output as JSON: {variable, current_threshold, rejection_rate, recommendation}

Rejections data:
{rejection_logs}

Respond as JSON only.
```

**Output to Slack:**
```
Channel: #daily-digest
"📊 RECALIBRATION REPORT (24h)

Rejections analyzed: 1,234
Recommendation updates: 3
- CIBIL threshold: 700 → 650 (84% confidence)
- Age max: 55 → 60 (72% confidence)
- Enquiry limit: 2 → 3 (68% confidence)

Newly eligible segments: 345 users
- CIBIL 650-700: 234 users
- Age 56-60: 89 users
- Enquiry 2-3: 22 users

Re-engagement campaign ready: 189 users
(engaged in last 30d + now eligible)

Action: Review recommendations in Airtable before applying."
```

---

### Engine 5: Re-Marketing & Re-engagement

**Trigger:** After recalibration, daily at 02:00 UTC

**Process:**
```
STEP 1: Query Reengagement Candidates
SELECT * FROM reengagement_candidates 
WHERE flagged_at > NOW() - INTERVAL '24 hours'
LIMIT 500;

Output: 189 users ready for re-engagement

STEP 2: Segment via Segment.com
For each user:
  - Get demographic segment (age, income, industry)
  - Get behavioral segment (engagement frequency, previous interests)
  - Get bureau segment (CIBIL band, bureau_vintage)
  
Example: {
  "user_id": "app_123",
  "segments": ["age_30-40", "income_15-20L", "retail_business", "cibil_700-750"]
}

STEP 3: Generate Personalized Re-engagement Message
Claude Prompt:
"User was previously rejected for CIBIL. Their CIBIL score is now 680, which is now eligible 
 under our updated rules. Generate a re-engagement message that:
 1. Acknowledges their previous attempt
 2. Explains the good news (eligibility rule updated)
 3. Urges them to try again now
 4. Personalizes based on their intent (working_capital)
 
 User: {user_profile}
 Respond as plain text (no JSON)."

Output: "Good news, Rajesh! We've updated our eligibility criteria, and you're now approved 
         for ₹15L working capital loan. Your rate is 14% p.a. (EMI: ₹3,200). 
         Ready to apply again? Start here: [link]"

STEP 4: Trigger Zapier Workflow
Workflow: "Re-engagement Campaign"
- Trigger: User in reengagement_candidates
- Action 1: Send WhatsApp via Ananta
- Action 2: Wait 5 minutes
- Action 3: Send Email via SendGrid (if no WhatsApp click)
- Action 4: Log to Airtable (reengagement_campaigns table)
- Action 5: Set conversion tracking tag

STEP 5: Track Conversion
When user completes application after re-engagement:
  UPDATE reengagement_candidates 
  SET re_engaged = TRUE, re_engaged_at = NOW() 
  WHERE user_id = 'app_123';
  
  Log to Supabase: reengagement_conversions table
  
STEP 6: Report to Slack
Channel: #daily-digest
"🎯 RE-ENGAGEMENT CAMPAIGN RESULTS

Candidates: 189
Re-engaged: 143 (75.6%)
Applications started: 87 (46%)
Applications submitted: 52 (27%)
Approved: 38 (20% → 2x better than normal 10%)

Campaign ROI: ₹2.5M potential AUM with 20% approval rate
```

---

## Expected Improvements

### Week 1 (Baseline)
- Rejection rate: 30%
- Approval rate: 70%
- Application completion: 5%
- Re-engagement rate: 0%

### Week 2 (Intent Generation)
- Completion rate improves to 7% (personalized messaging)
- Segment-specific completion: retail +15%, manufacturing +8%

### Week 3 (Rejection Analysis)
- Identify CIBIL threshold too strict (70% rejections at <700)
- Loosen to 650: +15% new eligible pool

### Week 4 (First Recalibration)
- Re-engagement campaign to 650-700 CIBIL band
- 25% of previously rejected now eligible
- Re-engagement conversion: 18% (2x normal rate)
- Net new approvals: +12%

### Month 2-3 (Continuous Learning)
- Suppression list refined based on 5K+ rejections
- Age, enquiry limits, industry restrictions optimized
- Re-engagement pool expands to 40% of rejected users
- Overall completion: 0.1% → 3-5% (30-50x improvement)

---

## Technical Stack

### Real-Time Components
- **Claude API** (Intent Generation)
- **Supabase** (Data storage + RPC)
- **Ananta** (WhatsApp messaging)
- **SendGrid** (Email)
- **Slack** (Alerts)

### Batch Components
- **Node.js/Python** (Data processing)
- **Claude API** (LLM analysis)
- **Segment.com** (Segmentation)
- **Zapier** (Workflow orchestration)
- **Airtable** (Ops dashboard)

### Analytics
- **Google Analytics** (Funnel tracking)
- **Contentsquare** (User behavior)
- **Grafana** (Metrics dashboard)
- **Sentry** (Error tracking)
- **ELK Stack** (Logs)

### Cron Jobs
- **Nightly (01:00):** Rejection analysis + recalibration
- **Nightly (02:00):** Re-engagement campaign generation
- **Hourly:** Real-time intent generation + application push
- **Every 5 min:** Lender polling + rejection tracking

---

## Development Phases

### Phase 3.5a: Intent Generation Engine (1 week)
- [ ] Claude API integration for intent analysis
- [ ] Endpoint: POST /api/llm/generate-intent
- [ ] Store intents in Supabase
- [ ] Use intents in WhatsApp bot messages

### Phase 3.5b: Multi-Channel Push (1 week)
- [ ] Ananta + SendGrid + Slack integration
- [ ] Endpoint: POST /api/push/personalized-application
- [ ] Zapier workflow orchestration
- [ ] Airtable sync for ops

### Phase 3.5c: Rejection Tracking (3 days)
- [ ] Create rejection_logs table
- [ ] Track lender rejections in real-time
- [ ] Airtable sync for visibility
- [ ] Fallback lender logic

### Phase 3.5d: Suppression Analysis (1 week)
- [ ] Nightly batch job to analyze rejections
- [ ] Claude LLM for pattern detection
- [ ] Update eligibility_rules table
- [ ] Identify newly eligible segments

### Phase 3.5e: Re-engagement Campaign (1 week)
- [ ] Query reengagement_candidates
- [ ] Segment via Segment.com
- [ ] Claude LLM for personalized messaging
- [ ] Zapier workflow + tracking
- [ ] Conversion measurement

**Total: 4 weeks for full closed-loop system**

---

## Success Metrics

| Metric | Baseline | Target | Timeline |
|--------|----------|--------|----------|
| Application Completion Rate | 5% | 15% | Week 2 |
| Lender Approval Rate | 70% | 75% | Week 4 |
| Rejection Analysis Speed | Manual | Automated (nightly) | Week 3 |
| Newly Eligible Pool | 0% | 25% | Week 3 |
| Re-engagement Conversion | 0% | 18% | Week 4 |
| Overall End-to-End | 0.1% | 3-5% | Month 2 |

---

## Feedback Loop Closure

```
Day 1: User applies → Rejected by Poonawala (CIBIL 680)
Day 1: Rejection logged to rejection_logs table
Day 1: Slack alert: "Rejection: CIBIL < 700"

Day 2: 01:00 UTC - Nightly batch analyzes 1,234 rejections
       Finding: 68% of rejections are CIBIL < 700, but 35% approval at 650-700
       Claude recommendation: Loosen threshold to 650
       Action: Update eligibility_rules

Day 2: 02:00 UTC - Re-engagement campaign identifies user with CIBIL 680
       Claude generates: "Good news! We've updated our criteria..."
       Zapier triggers: WhatsApp → Email
       User gets notified

Day 3: User clicks WhatsApp link → Starts application again
       Now sees Poonawala in eligible list (previously excluded)
       Completes application → Approved in 24h

Day 4: Approval logged to Supabase
       Slack alert: "Re-engagement conversion: Rajesh approved for ₹12L"
       Metric updated: Re-engagement conversion rate now 18%
```

---

## Notes

- **Privacy:** All suppression is data-driven, not manual. Rules are explainable.
- **Fairness:** Recalibration is bias-aware (check for demographic disparities).
- **Compliance:** Audit trail of all rule changes (why changed, by whom, impact).
- **Scale:** Designed for 50K leads/day with real-time intent generation.
- **Cost:** Claude API: ~₹5 per 1000 intents. For 50K leads = ₹250/day.

---

**Status:** Design Ready | **Next:** Implement Phase 3.5a (Intent Generation Engine)
