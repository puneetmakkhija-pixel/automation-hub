# Phase 3.5c: Rejection Tracking Engine

**Timeline:** 1 day | **Complexity:** Low | **Status:** Implementation Complete

---

## Overview

Phase 3.5c implements the **Rejection Tracking Engine** — the critical feedback loop that captures why lenders reject applications and provides real-time insights into rejection patterns. This data feeds directly into Phase 3.5d (Suppression & Recalibration) to enable continuous learning and rule optimization.

### Purpose

- **Capture lender rejection reasons** in real-time
- **Categorize rejections** (bureau, demographic, business, soft)
- **Track rejected variables** (CIBIL score, age, income, pincode, etc.)
- **Analyze rejection patterns** to identify over-suppressed segments
- **Enable Phase 3.5d** to recalibrate eligibility rules based on actual lender feedback
- **Feed Phase 3.5e** with re-engagement candidates

### The Rejection Loop

```
User Applies for Loan
    ↓
Submitted to Lender (Phase 4)
    ↓
Lender Decision: ✅ Approved or ❌ Rejected
    ├─ If Approved: → Log success, move to funding
    └─ If Rejected:
        ├─ Capture reason (CIBIL low, age out of range, etc.)
        ├─ Store rejected variables (CIBIL: 650, age: 56, etc.)
        ├─ Categorize rejection
        ├─ Alert ops via Slack
        ├─ Mark for Phase 3.5d analysis
        └─ [Next] Phase 3.5d: Analyze patterns
            └─ Identify if threshold is too strict
            └─ Recommend rule changes
            └─ Identify newly-eligible segment
            └─ [Next] Phase 3.5e: Re-engage newly-eligible users
```

---

## Architecture

### Data Flow

```
┌────────────────────────────────────────┐
│  Lender Rejection (via webhook or API) │
│  - Rejection reason code                │
│  - Rejected variables (CIBIL, age, etc) │
└─────────────┬──────────────────────────┘
              ↓
┌────────────────────────────────────────┐
│  Rejection Tracking Client              │
│  (lib/llm/rejectionTrackingClient.js)  │
│  - Validate rejection reason            │
│  - Categorize (bureau/demo/business)    │
│  - Extract variables                    │
└─────────────┬──────────────────────────┘
              ├─────────┬──────────┬─────────────┐
              ↓         ↓          ↓             ↓
        ┌──────────┐ ┌─────────┐ ┌──────────┐ ┌─────────┐
        │ Supabase │ │Slack    │ │ Analysis │ │ Metrics │
        │ rejection│ │ Alert   │ │ Patterns │ │ Calc    │
        │_logs     │ │ (#rej   │ │          │ │         │
        └──────────┘ │ection   │ └──────────┘ └─────────┘
              ↓      │tracking)│
        Rejection    └─────────┘
        Data Stored       ↓
                    Ops Team
                   Notified
                   
                        ↓ [Phase 3.5d]
                   Nightly Analysis
                   (01:00 UTC)
```

---

## Implementation

### Component 1: Rejection Tracking Client

**File:** `lib/llm/rejectionTrackingClient.js`

**Key Methods:**

#### `captureRejection(rejectionData)`

Captures a rejection from a lender and stores it for analysis.

**Input:**
```javascript
{
  phone_number: "+919999999999",
  application_id: "app_123",
  lender_id: "poonawala",
  rejection_reason: "cibil_low",  // Must be in REJECTION_REASONS map
  rejection_message: "CIBIL score 650 is below minimum 700",
  rejected_bureau_vars: {
    cibil_score: 650,
    hunter_score: 780,
    dpd: 0
  },
  rejected_demographic_vars: {
    age: 56,
    income: 800000,
    pincode: "400001"
  }
}
```

**Output:**
```javascript
{
  success: true,
  message: "Rejection tracked: CIBIL Score Below Threshold",
  data: { id: "...", created_at: "..." }
}
```

#### `getRejectionsByLender(lenderId, hours = 24)`

Retrieves rejections for a specific lender and analyzes patterns.

**Output:**
```javascript
{
  success: true,
  total_rejections: 152,
  analysis: {
    total_rejections: 152,
    top_rejection_reasons: [
      {
        reason: "cibil_low",
        count: 68,
        rate: "44.7%"
      },
      {
        reason: "enquiry_limit_exceeded",
        count: 45,
        rate: "29.6%"
      }
    ],
    rejection_by_category: [
      {
        category: "bureau",
        count: 113,
        rate: "74.3%"
      },
      {
        category: "demographic",
        count: 39,
        rate: "25.7%"
      }
    ]
  }
}
```

#### `getRejectionsByCategory(category, hours = 24)`

Get all rejections in a specific category (bureau/demographic/business/soft).

#### `getRejectionsByReason(reason, hours = 24)`

Get all rejections with a specific reason code.

#### `markUserEngagedAgain(phoneNumber, channel = 'whatsapp')`

Mark a previously rejected user as re-engaged (called by Phase 3.5e).

#### `recordReengagementResponse(phoneNumber, outcome = 'started_application')`

Record when a re-engaged user responds or applies again.

#### `analyzeRejectionPatterns(rejections)`

Analyzes a list of rejections to identify patterns:
- Top rejection reasons
- Rejection rates by category
- Frequency of rejected variables
- Most common rejection patterns

---

### Component 2: API Endpoints

**File:** `lib/routes/rejectionTrackingRoutes.js`

#### `POST /api/rejections/capture`

Capture a lender rejection.

**Request:**
```bash
curl -X POST http://localhost:3000/api/rejections/capture \
  -H "Content-Type: application/json" \
  -d '{
    "phone_number": "+919999999999",
    "application_id": "app_123",
    "lender_id": "poonawala",
    "rejection_reason": "cibil_low",
    "rejection_message": "CIBIL score 650 is below minimum 700",
    "rejected_bureau_vars": {
      "cibil_score": 650,
      "hunter_score": 780
    },
    "rejected_demographic_vars": {
      "age": 56,
      "income": 800000
    }
  }'
```

**Response:**
```json
{
  "success": true,
  "message": "Rejection tracked: CIBIL Score Below Threshold",
  "data": { "id": "...", "created_at": "..." }
}
```

#### `GET /api/rejections/by-lender/:lender_id`

Get rejections for a lender with pattern analysis.

**Request:**
```bash
curl "http://localhost:3000/api/rejections/by-lender/poonawala?hours=24"
```

**Response:**
```json
{
  "success": true,
  "total_rejections": 152,
  "analysis": {
    "top_rejection_reasons": [
      { "reason": "cibil_low", "count": 68, "rate": "44.7%" },
      { "reason": "enquiry_limit_exceeded", "count": 45, "rate": "29.6%" }
    ],
    "rejection_by_category": [
      { "category": "bureau", "count": 113, "rate": "74.3%" }
    ]
  },
  "rejections": [ ... ]
}
```

#### `GET /api/rejections/by-category/:category`

Get all rejections in a category (bureau/demographic/business/soft).

**Request:**
```bash
curl "http://localhost:3000/api/rejections/by-category/bureau?hours=24"
```

#### `GET /api/rejections/by-reason/:reason`

Get all rejections with a specific reason.

**Request:**
```bash
curl "http://localhost:3000/api/rejections/by-reason/cibil_low?hours=24"
```

#### `POST /api/rejections/mark-engaged`

Mark a user as re-engaged after rejection (called by Phase 3.5e).

**Request:**
```bash
curl -X POST http://localhost:3000/api/rejections/mark-engaged \
  -H "Content-Type: application/json" \
  -d '{
    "phone_number": "+919999999999",
    "reengagement_channel": "whatsapp"
  }'
```

#### `POST /api/rejections/record-response`

Record response from re-engaged user.

**Request:**
```bash
curl -X POST http://localhost:3000/api/rejections/record-response \
  -H "Content-Type: application/json" \
  -d '{
    "phone_number": "+919999999999",
    "response_outcome": "started_application"
  }'
```

---

## Rejection Reasons & Categories

### Rejection Reason Codes

**Bureau-Based (Hard to Fix):**
- `cibil_low` — CIBIL score below minimum threshold
- `hunter_score_failed` — Secondary credit score rejected
- `dpd_detected` — Payment defaults found
- `bureau_vintage_low` — Credit history too short
- `enquiry_limit_exceeded` — Too many recent credit enquiries
- `high_nbfc_exposure` — Too much NBFC debt

**Demographic (May Expand Later):**
- `age_out_of_range` — Age < 18 or > 65
- `income_below_minimum` — Income insufficient
- `income_above_maximum` — Income too high (limits loan amount)
- `pincode_not_serviceable` — Geographic restriction
- `state_not_serviceable` — State not covered
- `kyc_incomplete` — Verification failed

**Business (Medium Difficulty):**
- `business_age_too_low` — Business < 1 year old
- `industry_not_approved` — Industry rejected by lender
- `leverage_too_high` — Existing debt too high
- `revenue_below_threshold` — Business income insufficient
- `business_type_not_approved` — Business type not supported

**Soft (Easy to Fix):**
- `duplicate_application` — Already applied recently
- `application_incomplete` — Missing fields
- `document_quality_low` — Poor document images
- `manual_review_required` — Needs human review
- `compliance_check_failed` — Regulatory issue

---

## Integration with Phase 4 (Lender Submission)

Phase 4 (Lender Submission) calls rejection tracking when lender responds:

```javascript
// In Phase 4 (lib/lenderSubmissionClient.js)
const lenderResponse = await submitToLender(application);

if (lenderResponse.status === 'rejected') {
  // Capture rejection for Phase 3.5c analysis
  await rejectionTrackingClient.captureRejection({
    phone_number: application.phone_number,
    application_id: application.id,
    lender_id: lenderResponse.lender_id,
    rejection_reason: lenderResponse.reason_code, // 'cibil_low', etc.
    rejection_message: lenderResponse.message,
    rejected_bureau_vars: lenderResponse.bureau_vars,
    rejected_demographic_vars: lenderResponse.demographic_vars
  });
}
```

---

## Database Schema

**Table:** `rejection_logs` (already in database-schema.sql)

```sql
CREATE TABLE rejection_logs (
  id UUID PRIMARY KEY,
  phone_number VARCHAR(20) NOT NULL,
  application_id UUID,
  lender_id VARCHAR(50),
  
  rejection_reason VARCHAR(100),  -- 'cibil_low', 'age_out_of_range', etc.
  rejection_category VARCHAR(50),  -- 'bureau', 'demographic', 'business', 'soft'
  rejection_message TEXT,
  
  rejected_bureau_vars JSONB,      -- {cibil: 650, hunter: 800}
  rejected_demographic_vars JSONB, -- {age: 56, income: 800000}
  
  user_engaged_again BOOLEAN,      -- Set to true by Phase 3.5e
  reengagement_channel VARCHAR(50),-- 'whatsapp' or 'email'
  reengagement_sent_at TIMESTAMP,  -- When re-engagement was sent
  reengagement_response_at TIMESTAMP, -- When user responded
  
  rejected_at TIMESTAMP DEFAULT now(),
  created_at TIMESTAMP DEFAULT now()
);
```

---

## Testing

### Unit Tests

```javascript
// Test 1: Capture valid rejection
test('Captures valid rejection correctly', async () => {
  const result = await rejectionTrackingClient.captureRejection({
    phone_number: '+919999999999',
    application_id: 'app_123',
    lender_id: 'poonawala',
    rejection_reason: 'cibil_low',
    rejected_bureau_vars: { cibil_score: 650 }
  });
  
  expect(result.success).toBe(true);
  expect(result.message).toContain('CIBIL Score Below Threshold');
});

// Test 2: Reject invalid rejection reason
test('Warns on unknown rejection reason', async () => {
  const result = await rejectionTrackingClient.captureRejection({
    phone_number: '+919999999999',
    lender_id: 'poonawala',
    rejection_reason: 'unknown_reason_xyz' // Not in map
  });
  
  // Should still capture but log warning
  expect(result.success).toBe(true);
});

// Test 3: Analyze rejection patterns
test('Correctly analyzes rejection patterns', async () => {
  const rejections = [
    { rejection_reason: 'cibil_low', rejection_category: 'bureau' },
    { rejection_reason: 'cibil_low', rejection_category: 'bureau' },
    { rejection_reason: 'age_out_of_range', rejection_category: 'demographic' }
  ];
  
  const analysis = rejectionTrackingClient.analyzeRejectionPatterns(rejections);
  expect(analysis.total_rejections).toBe(3);
  expect(analysis.top_rejection_reasons[0].reason).toBe('cibil_low');
  expect(analysis.top_rejection_reasons[0].rate).toBe('66.7%');
});

// Test 4: Get rejections by lender
test('Retrieves rejections for specific lender', async () => {
  // Insert test rejections
  // ...
  
  const result = await rejectionTrackingClient.getRejectionsByLender('poonawala', 24);
  expect(result.success).toBe(true);
  expect(result.total_rejections).toBeGreaterThan(0);
  expect(result.analysis).toBeDefined();
});

// Test 5: Track re-engagement
test('Marks user as re-engaged', async () => {
  const result = await rejectionTrackingClient.markUserEngagedAgain('+919999999999');
  expect(result.success).toBe(true);
});
```

### Manual Testing Flow

```bash
# 1. Simulate a rejection from lender
curl -X POST http://localhost:3000/api/rejections/capture \
  -H "Content-Type: application/json" \
  -d '{
    "phone_number": "+919999999999",
    "application_id": "app_123",
    "lender_id": "poonawala",
    "rejection_reason": "cibil_low",
    "rejection_message": "CIBIL score 650 is below minimum 700",
    "rejected_bureau_vars": {
      "cibil_score": 650,
      "hunter_score": 780
    }
  }'

# Expected: Rejection captured, Slack alert sent to #rejection-tracking

# 2. Get rejections for lender (with pattern analysis)
curl "http://localhost:3000/api/rejections/by-lender/poonawala?hours=24"

# Expected: List of rejections + analysis showing top reasons and rates

# 3. Get rejections by category
curl "http://localhost:3000/api/rejections/by-category/bureau?hours=24"

# 4. Get rejections by specific reason
curl "http://localhost:3000/api/rejections/by-reason/cibil_low?hours=24"

# 5. Mark user as re-engaged (called by Phase 3.5e)
curl -X POST http://localhost:3000/api/rejections/mark-engaged \
  -H "Content-Type: application/json" \
  -d '{
    "phone_number": "+919999999999",
    "reengagement_channel": "whatsapp"
  }'

# Expected: Rejection record updated with user_engaged_again = true

# 6. Record re-engagement response
curl -X POST http://localhost:3000/api/rejections/record-response \
  -H "Content-Type: application/json" \
  -d '{
    "phone_number": "+919999999999",
    "response_outcome": "started_application"
  }'

# Expected: Rejection record updated with reengagement_response_at timestamp
```

---

## Slack Alerts

When a rejection is captured, a Slack alert is sent to `#rejection-tracking`:

**Example Alert:**
```
❌ Application Rejected
Phone: +919999999999
Lender: Poonawala
Reason: CIBIL Score Below Threshold
Category: BUREAU

Bureau Variables:
{
  "cibil_score": 650,
  "hunter_score": 780,
  "dpd": 0
}
```

**Color Coding:**
- 🔴 **Bureau** (Red) — Hard to fix, requires time
- 🟠 **Demographic** (Orange) — May expand eligibility later
- 🟡 **Business** (Gold) — Medium difficulty
- 🟢 **Soft** (Green) — Easy to fix

---

## Metrics to Track

| Metric | Query | Goal |
|--------|-------|------|
| Total rejections captured | `COUNT(*) FROM rejection_logs WHERE rejected_at > now() - interval '24 hours'` | All rejections tracked |
| Rejection rate by lender | `COUNT(*) WHERE lender_id = X / total_applications * 100` | <50% for good lenders |
| Top rejection reason | `GROUP BY rejection_reason ORDER BY COUNT(*) DESC LIMIT 1` | Identify bottleneck |
| Bureau vs Demographic split | `COUNT(*) WHERE rejection_category = 'bureau'` | Monitor distribution |
| Re-engagement tracking | `COUNT(*) WHERE user_engaged_again = true` | Feedback signal |
| Re-engagement success rate | `COUNT(*) WHERE reengagement_response_at IS NOT NULL` | Measure Phase 3.5e |

---

## Configuration

### Environment Variables

```bash
# Slack Webhooks
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK/URL

# Supabase (for storing rejections)
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...
```

### Slack Channel Setup

```
#rejection-tracking — Real-time rejection alerts
#daily-digest — Phase 3.5d sends recalibration summary here
```

---

## Integration with Phase 3.5d (Recalibration)

Phase 3.5d runs nightly at 01:00 UTC and:

1. Queries Phase 3.5c data: `GET /api/rejections/by-lender/{lender}?hours=1440` (last 24h)
2. Analyzes rejection patterns: top reasons, rates, rejected variables
3. Claude API: Identifies if thresholds are too strict
4. Updates eligibility rules in Supabase
5. Sends summary to Slack: "Analyzed 150 rejections: CIBIL min → 650 (was 700)"

---

## Next Steps

### Phase 3.5d: Suppression & Recalibration (2 days)
- Nightly batch job (01:00 UTC)
- Analyze rejection patterns from Phase 3.5c
- Claude API: Recommend rule changes
- Update eligibility_rules table
- Alert ops team of changes

### Phase 3.5e: Re-engagement Campaign (2-3 days)
- Nightly batch job (02:00 UTC)
- Query Phase 3.5c: "Rejected yesterday but now eligible"
- Send personalized re-engagement push
- Track engagement responses
- Closes the feedback loop

---

## Files Modified

| File | Changes |
|------|---------|
| `lib/llm/rejectionTrackingClient.js` | NEW - Rejection capture and analysis |
| `lib/routes/rejectionTrackingRoutes.js` | NEW - Express routes for rejection endpoints |
| `index.js` | UPDATED - Mounted rejection tracking routes |

---

## Success Metrics

After Phase 3.5c implementation:
- ✅ All lender rejections are captured in real-time
- ✅ Rejection patterns are analyzed and available via API
- ✅ Ops team receives Slack alerts for all rejections
- ✅ Re-engagement tracking enables Phase 3.5e success measurement
- ✅ Data pipeline ready for Phase 3.5d recalibration engine
