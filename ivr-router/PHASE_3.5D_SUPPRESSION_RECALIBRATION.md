# Phase 3.5d: Suppression & Recalibration Engine

**Objective:** Nightly batch job (01:00 UTC) that analyzes rejection patterns from Phase 3.5c, identifies over-suppressed eligibility rules, recommends improvements via Claude API, updates rules, and notifies ops team for approval. **Expected outcome:** Expand eligible pool by 15-25% on month 2-3.

**Closes Loop:** Rejection data (Phase 3.5c) → Pattern analysis (3.5d) → Rule updates (3.5d) → Re-engagement targets (Phase 3.5e)

---

## Problem Statement

Current eligibility rules are **static and overly conservative**:
- CIBIL minimum = 720 (rejects viable segment with 650-700)
- Age maximum = 65 (rejects senior entrepreneurs with 65-70)
- Income minimum = ₹150K (rejects seasonal workers averaging ₹140K)
- Pincode restrictions = hardcoded 50-state blocklist (rejects aspirational markets)

**Result:** 40-50% of rejected users are actually viable but ruled out due to threshold over-strictness.

**Solution:** Analyze 1000+ rejections nightly, use Claude LLM to identify which rules are over-suppressing, recommend relaxations with confidence scores, update rules automatically (pending ops approval), re-engage newly-eligible users 02:00 UTC.

---

## Architecture

### Data Flow
```
rejection_logs (1000+ records/24h from Phase 3.5c)
    ↓ GROUP BY rejection_reason, rejection_category
    ↓ ANALYZE rejected_bureau_vars, rejected_demographic_vars
    ↓
Claude API Prompt:
  Input: {total_rejections: 1200, top_reasons: {cibil_low: 520, age_out_of_range: 180, ...}}
  Prompt: "Which rules are over-strict? Recommend: CIBIL 720→650, Age 65→68, etc."
  Output: {suggested_rules: {cibil_min: 650, age_max: 68}, confidence: 0.92, estimated_newly_eligible: 280}
    ↓
rule_recommendations table (pending_review → applied/rejected)
    ↓
eligibility_rules table (version history, audit trail)
    ↓ Slack alert to #suppression-analysis with recommendation
    ↓ Ops team approves or rejects in Slack
    ↓ POST /api/suppression/apply-recommendation/:id (approve/reject)
    ↓
user_eligibility_cache (INVALIDATE old rules, rebuild with new thresholds)
    ↓
Phase 3.5e: Re-engagement queries new_eligible_users (WHERE old_eligible=false AND new_eligible=true)
```

---

## Implementation

### 1. Database Schema

Add three new tables to `database-schema.sql`:

```sql
-- Eligibility rules with version history
CREATE TABLE eligibility_rules (
  id BIGSERIAL PRIMARY KEY,
  version INTEGER NOT NULL,
  
  -- Credit bureau thresholds
  cibil_minimum_score INTEGER NOT NULL DEFAULT 700,
  
  -- Demographic thresholds
  age_minimum INTEGER NOT NULL DEFAULT 21,
  age_maximum INTEGER NOT NULL DEFAULT 65,
  income_minimum INTEGER NOT NULL DEFAULT 150000,
  income_maximum INTEGER NOT NULL DEFAULT 5000000,
  
  -- Business thresholds
  business_age_minimum_months INTEGER NOT NULL DEFAULT 12,
  
  -- Loan thresholds
  loan_amount_minimum INTEGER NOT NULL DEFAULT 50000,
  loan_amount_maximum INTEGER NOT NULL DEFAULT 5000000,
  
  -- Geographic restrictions
  pincode_blocklist TEXT[] DEFAULT '{}',
  
  -- Metadata
  active BOOLEAN DEFAULT false,
  recommendation_id BIGINT REFERENCES rule_recommendations(id),
  created_at TIMESTAMP DEFAULT now(),
  
  UNIQUE(version)
);

CREATE INDEX idx_eligibility_rules_active ON eligibility_rules(active);
CREATE INDEX idx_eligibility_rules_created ON eligibility_rules(created_at DESC);

-- Recommendations from suppression analysis
CREATE TABLE rule_recommendations (
  id BIGSERIAL PRIMARY KEY,
  
  -- Analysis metadata
  analysis_window_hours INTEGER NOT NULL DEFAULT 24,
  rejection_count INTEGER NOT NULL,
  analysis_data JSONB NOT NULL,  -- {total_rejections, top_reasons, rejection_by_category, ...}
  
  -- Rules comparison
  current_rules JSONB NOT NULL,  -- Full rules snapshot
  recommended_rules JSONB NOT NULL,  -- Suggested changes
  
  -- Recommendation quality
  confidence_score NUMERIC(3,2) NOT NULL,  -- 0.00 to 1.00
  estimated_reengagement_count INTEGER,
  
  -- Lifecycle
  status VARCHAR(50) DEFAULT 'pending_review',  -- pending_review, applied, rejected
  created_at TIMESTAMP DEFAULT now(),
  applied_at TIMESTAMP,
  
  CONSTRAINT valid_status CHECK (status IN ('pending_review', 'applied', 'rejected'))
);

CREATE INDEX idx_rule_recommendations_status ON rule_recommendations(status);
CREATE INDEX idx_rule_recommendations_created ON rule_recommendations(created_at DESC);

-- Cache of user eligibility against current rules (for quick filtering)
CREATE TABLE user_eligibility_cache (
  id BIGSERIAL PRIMARY KEY,
  phone_number VARCHAR(20) NOT NULL UNIQUE,
  
  -- Profile snapshot
  age INTEGER,
  cibil_score INTEGER,
  annual_income INTEGER,
  business_age_months INTEGER,
  
  -- Eligibility against current rules
  eligible_with_current_rules BOOLEAN DEFAULT false,
  ineligible_reason VARCHAR(100),
  
  -- Audit trail
  last_checked_at TIMESTAMP,
  last_rule_version INTEGER,
  updated_at TIMESTAMP DEFAULT now(),
  
  FOREIGN KEY (phone_number) REFERENCES users(phone_number)
);

CREATE INDEX idx_user_eligibility_cache_eligible ON user_eligibility_cache(eligible_with_current_rules);
CREATE INDEX idx_user_eligibility_cache_updated ON user_eligibility_cache(updated_at DESC);
```

---

### 2. Suppression Analysis Client

**File:** `lib/llm/suppressionAnalysisClient.js` (400+ lines)

**Key Methods:**

#### `analyzeRejectionPatternsForRecalibration(timeWindowHours, lenderIds)`
- Query rejection_logs from Phase 3.5c (default: last 24 hours)
- Call `rejectionTrackingClient.analyzeRejectionPatterns()` (Phase 3.5c method)
- Fetch current active rules from eligibility_rules table
- Call `generateRuleRecommendation()` with analysis + current rules
- Calculate impact: estimate newly-eligible users
- Store recommendation in rule_recommendations table
- Alert ops via Slack
- Return: `{ recommendation: {...}, analysis: {...} }`

**Prompt Structure (Claude 3.5 Sonnet):**

```
CURRENT REJECTION ANALYSIS (Last 24-72 hours):
{
  "total_rejections": 1200,
  "top_rejection_reasons": [
    {"reason": "cibil_low", "count": 520, "rate": "43.3%"},
    {"reason": "age_out_of_range", "count": 180, "rate": "15%"},
    {"reason": "income_below_minimum", "count": 90, "rate": "7.5%"}
  ],
  "rejection_by_category": [
    {"category": "bureau", "count": 650},
    {"category": "demographic", "count": 450}
  ],
  "most_common_variables": {
    "bureau_variables": ["cibil_score (520 times)", "dpd (180 times)"],
    "demographic_variables": ["age (150 times)", "income (90 times)"]
  }
}

CURRENT ELIGIBILITY RULES:
{
  "cibil_minimum_score": 700,
  "age_minimum": 21,
  "age_maximum": 65,
  "income_minimum": 150000,
  ...
}

YOUR TASK:
Analyze rejection patterns and recommend rule changes that:
1. Expand eligible pool by re-including over-suppressed segments
2. Maintain credit quality (60%+ approval rate per lender)
3. Prioritize changes with highest estimated impact

RESPOND WITH ONLY valid JSON:
{
  "suggested_rules": {
    "cibil_minimum_score": 650,  // Relaxed from 700 (would include 520 cibil_low rejections)
    "age_maximum": 68,           // Relaxed from 65 (would include 180 age rejections)
    "income_minimum": 140000,    // Relaxed from 150000 (would include 90 income rejections)
    ...
  },
  "rationale": {
    "cibil_minimum_score": "43.3% of rejections cite CIBIL 650-720. Lender X approves 65% in this band.",
    "age_maximum": "15% of rejections cite age 65-70, typically co-owners with 50+ year experience."
  },
  "confidence": 0.92,
  "estimated_additional_eligible_users": 280,
  "key_insights": [
    "CIBIL 650-720 is over-suppressed; recommend relaxation.",
    "Age 65+ segment has 65%+ approval across lenders.",
    "Income 140-150K micro-entrepreneurs are underserved."
  ]
}
```

**Claude Response Processing:**
- Parse JSON response
- Validate against current rules (no regression)
- Calculate impact (how many rejected users would now be eligible)
- Store in rule_recommendations (status='pending_review')
- Alert Slack with color coding (green=high confidence, yellow=medium, red=low)

#### `applyRuleChanges(recommendationId, approve=true)`
- Fetch recommendation from rule_recommendations table
- If approve=true:
  - Deactivate current rules (SET active=false)
  - Insert new rules (SET active=true, version++)
  - Mark recommendation as applied
  - Log rule_history for audit trail
- Else:
  - Mark recommendation as rejected
- Return: `{ new_version: 2 }`

#### `calculateRuleImpact(suggestedRules, rejections)`
- Iterate through rejected users
- Check: "Would this user be eligible under suggested rules?"
- Count newly-eligible users
- Return: `{ estimated_newly_eligible: 280, percentage_of_rejected: "23.3%" }`

#### `alertRecommendationViaSlack(...)`
- Post to #suppression-analysis channel
- Color-coded attachment (green for high confidence, orange for medium)
- Fields: Confidence, Newly Eligible Count, Top Reasons, Recommended Changes, Key Insights
- Include action buttons (Approve/Reject) linking to `/api/suppression/apply-recommendation/:id`

---

### 3. Routes

**File:** `lib/routes/suppressionAnalysisRoutes.js`

```javascript
POST /api/suppression/analyze
  Input:  { hours: 24, lender_ids: [] }
  Output: { recommendation: {...}, analysis: {...} }
  Called by: Nightly job (01:00 UTC) or manual trigger

POST /api/suppression/apply-recommendation/:recommendation_id
  Input:  { approve: true }
  Output: { message: "Rules updated", new_version: 2 }
  Called by: Ops team (via Slack button) or automated approval

GET /api/suppression/recommendations
  Query:  ?status=pending_review&limit=10
  Output: { recommendations: [...], count: 5 }
  Called by: Dashboard, Slack alerts

GET /api/suppression/current-rules
  Output: { rules: {...} }
  Called by: Phase 3.5e (to check for newly-eligible), Dashboard

GET /api/suppression/rule-history
  Query:  ?limit=20
  Output: { history: [{version: 1, ...}, {version: 2, ...}] }
  Called by: Audit trail, Dashboard
```

---

### 4. Integration with Nightly Jobs (BullMQ)

**Scheduled Job @ 01:00 UTC:**

```javascript
// ivr-router/lib/jobs/suppressionRecalibrationJob.js

import Queue from 'bullmq';
import suppressionAnalysisClient from '../llm/suppressionAnalysisClient.js';

const suppression_queue = new Queue('suppression-recalibration', {
  connection: { host: process.env.REDIS_HOST || 'localhost', port: process.env.REDIS_PORT || 6379 }
});

// Schedule nightly @ 01:00 UTC
suppression_queue.add(
  'analyze-rejections',
  { hours: 24, lender_ids: [] },
  {
    repeat: { cron: '0 1 * * *' },  // 01:00 UTC
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 }
  }
);

// Process job
suppression_queue.process(async (job) => {
  console.log('[Suppression Job] Analyzing rejections...');
  
  const result = await suppressionAnalysisClient.analyzeRejectionPatternsForRecalibration(
    job.data.hours,
    job.data.lender_ids
  );
  
  if (result.success) {
    console.log('[Suppression Job] Recommendation generated, confidence:', result.recommendation.confidence);
    // Slack alert sent automatically by suppressionAnalysisClient
    
    // Optional: Auto-apply if confidence > 0.95
    if (result.recommendation.confidence > 0.95) {
      console.log('[Suppression Job] Auto-applying high-confidence recommendation...');
      // Fetch recommendation ID and call applyRuleChanges()
    }
  }
  
  return result;
});
```

**Dependencies:** `npm install bullmq redis`

---

## Testing

### Unit Test: Rule Recommendation

```javascript
import suppressionAnalysisClient from '../lib/llm/suppressionAnalysisClient.js';

describe('Phase 3.5d: Suppression & Recalibration', () => {
  test('generateRuleRecommendation should return structured output', async () => {
    const mockAnalysis = {
      total_rejections: 1200,
      top_rejection_reasons: [
        { reason: 'cibil_low', count: 520, rate: '43.3%' },
        { reason: 'age_out_of_range', count: 180, rate: '15%' }
      ],
      bureau_vars_frequency: { cibil_score: 520 },
      demographic_vars_frequency: { age: 180 }
    };

    const mockCurrentRules = {
      cibil_minimum_score: 700,
      age_maximum: 65,
      income_minimum: 150000
    };

    const recommendation = await suppressionAnalysisClient.generateRuleRecommendation(
      mockAnalysis,
      [],
      mockCurrentRules
    );

    expect(recommendation.success).toBe(true);
    expect(recommendation.suggested_rules).toBeDefined();
    expect(recommendation.confidence).toBeGreaterThan(0);
    expect(recommendation.key_insights).toHaveLength(3);
  });

  test('calculateRuleImpact should count newly-eligible users', () => {
    const mockRejections = [
      { rejected_bureau_vars: { cibil_score: 680 } },  // Would be eligible if CIBIL min = 650
      { rejected_bureau_vars: { cibil_score: 710 } },  // Already eligible
      { rejected_demographic_vars: { age: 68 } }       // Would be eligible if age max = 70
    ];

    const suggestedRules = {
      cibil_minimum_score: 650,
      age_maximum: 70
    };

    const impact = suppressionAnalysisClient.calculateRuleImpact(suggestedRules, mockRejections);

    expect(impact.estimated_newly_eligible).toBe(2);  // 680 CIBIL + 68 age
  });
});
```

### Integration Test: Analyze & Alert

```javascript
test('analyzeRejectionPatternsForRecalibration should store recommendation and alert Slack', async () => {
  // Insert 100 mock rejections into rejection_logs
  // Call analyzeRejectionPatternsForRecalibration(24)
  // Verify:
  // 1. rule_recommendations row created with status='pending_review'
  // 2. Slack webhook called with recommendation details
  // 3. Response includes recommendation.suggested_rules
  
  const result = await suppressionAnalysisClient.analyzeRejectionPatternsForRecalibration(24);
  
  expect(result.success).toBe(true);
  expect(result.recommendation.suggested_rules).toBeDefined();
  
  // Verify DB insert
  const { data: recommendations } = await supabase
    .from('rule_recommendations')
    .select('*')
    .eq('status', 'pending_review');
  
  expect(recommendations.length).toBeGreaterThan(0);
});
```

### cURL Testing

**1. Analyze Rejections (Manual Trigger)**

```bash
curl -X POST http://localhost:3000/api/suppression/analyze \
  -H "Content-Type: application/json" \
  -d '{
    "hours": 24,
    "lender_ids": ["poonawala", "hero", "hdfc"]
  }'

# Response
{
  "success": true,
  "message": "Suppression analysis completed",
  "recommendation": {
    "suggested_rules": {
      "cibil_minimum_score": 650,  // Relaxed from 700
      "age_maximum": 68,
      "income_minimum": 140000
    },
    "confidence": 0.92,
    "key_insights": [...]
  }
}
```

**2. Apply Recommendation (Ops Approval)**

```bash
curl -X POST http://localhost:3000/api/suppression/apply-recommendation/123 \
  -H "Content-Type: application/json" \
  -d '{ "approve": true }'

# Response
{
  "success": true,
  "message": "Rules updated successfully",
  "new_version": 2
}
```

**3. Fetch Pending Recommendations**

```bash
curl http://localhost:3000/api/suppression/recommendations?status=pending_review

# Response
{
  "success": true,
  "recommendations": [
    {
      "id": 123,
      "analysis_window_hours": 24,
      "rejection_count": 1200,
      "confidence_score": 0.92,
      "status": "pending_review",
      "created_at": "2026-08-25T01:00:00Z"
    }
  ]
}
```

**4. Fetch Current Rules**

```bash
curl http://localhost:3000/api/suppression/current-rules

# Response
{
  "success": true,
  "rules": {
    "version": 2,
    "cibil_minimum_score": 650,
    "age_maximum": 68,
    "active": true
  }
}
```

---

## Slack Integration

### Recommendation Alert (Posted @ 01:00 UTC)

**Channel:** `#suppression-analysis`

**Message:**
```
📊 Eligibility Rule Recommendation

Confidence: 92%
Total Rejections Analyzed: 1,200
Estimated Newly Eligible Users: 280 (23.3%)

Top Rejection Reason: cibil_low (520 rejections)

Recommended Changes:
• CIBIL minimum: 650 (was 700) - 43% of rejections cite CIBIL 650-720
• Age maximum: 68 (was 65) - 15% of rejections cite age 65-70
• Income minimum: ₹140,000 (was ₹150,000) - Micro-entrepreneurs underserved

Key Insights:
• CIBIL 650-720 segment has 65%+ approval across lenders
• Age 65+ co-owners typically have 50+ years experience
• Income 140-150K micro-entrepreneurs are low-risk (DPD<2%)

[APPROVE] [REJECT]
```

**Buttons Link To:**
- `POST /api/suppression/apply-recommendation/123?approve=true`
- `POST /api/suppression/apply-recommendation/123?approve=false`

---

## Data Flow: Rejection to Re-engagement

### Step 1: User Rejected by Lender
```
Phase 4 (Lender Submission)
→ POST /api/rejections/capture
  { phone: "919876543210", lender_id: "poonawala", rejection_reason: "cibil_low", 
    rejected_bureau_vars: { cibil_score: 680 } }
→ Stored in rejection_logs
```

### Step 2: Nightly Analysis @ 01:00 UTC
```
suppression_queue.process('analyze-rejections')
→ Query rejection_logs (last 24h, 1200+ records)
→ Analyze patterns (43% cite CIBIL 650-720)
→ Claude recommends: CIBIL 700 → 650
→ POST /api/suppression/recommendations stored
→ Slack alert to ops team
```

### Step 3: Ops Approval (Manual or Auto)
```
If confidence > 0.95:
  Auto-apply recommendation
  POST /api/suppression/apply-recommendation/123
    → Deactivate old rules (version 1)
    → Insert new rules (version 2)
    → Mark recommendation as "applied"
```

### Step 4: User Eligibility Cache Invalidation
```
-- Clear old cache
DELETE FROM user_eligibility_cache WHERE last_rule_version < 2

-- Phase 3.5e will re-query with new rules:
SELECT phone_number, user_profile
FROM users u
WHERE NOT EXISTS (
  SELECT 1 FROM user_eligibility_cache c 
  WHERE c.phone_number = u.phone_number AND c.eligible_with_current_rules = true
)
AND u.annual_income >= 140000  -- New rule
AND u.age <= 68                -- New rule
...
```

### Step 5: Re-engagement @ 02:00 UTC
```
Phase 3.5e (Re-engagement Campaign)
→ Query: Users with old_eligible=false, new_eligible=true
→ Segment by persona
→ Send personalized WhatsApp + Email
→ "You're now eligible for ₹X loan! Start your application."
→ Phase 3a conversation bot engages
→ If approval: loop closes ✓
```

---

## Monitoring & Observability

### Key Metrics

| Metric | Target | Formula |
|--------|--------|---------|
| Newly Eligible Users/Day | 200-400 | Sum of estimated_newly_eligible per recommendation |
| Rules Version Change Freq | 1/week | COUNT(DISTINCT version) / 7 |
| Recommendation Approval Rate | >80% | COUNT(applied) / COUNT(pending_review OR applied) |
| Avg Confidence Score | >0.85 | AVG(confidence_score) of applied recommendations |
| Re-engagement Conversion | >15% | Recommended users who re-apply / total recommended |

### Logs

```javascript
[SuppressionAnalysis] Analyzed 1200 rejections in 24h window
[SuppressionAnalysis] Claude recommendation generated, confidence: 0.92
[SuppressionAnalysis] Estimated 280 newly-eligible users
[SuppressionAnalysis] Recommendation ID 123 stored, awaiting approval
[SuppressionAnalysis] Slack alert sent to #suppression-analysis
```

### Grafana Dashboard

- **Rule Changes Over Time** (line chart: version vs created_at)
- **Confidence Distribution** (histogram: confidence_score)
- **Newly Eligible Estimate** (gauge: estimated_newly_eligible, target 200+/day)
- **Approval Rate** (pie: applied vs rejected vs pending)
- **Rejection Reasons Heat Map** (before/after rule changes)

---

## Configuration

**Environment Variables:**

```bash
CLAUDE_API_KEY=sk-...                          # Anthropic API key
CLAUDE_MODEL=claude-3-5-sonnet-20241022        # Model for analysis
SLACK_WEBHOOK_URL=https://hooks.slack.com/...  # #suppression-analysis webhook
REDIS_HOST=localhost                           # BullMQ job queue
REDIS_PORT=6379
```

**Database Indexes:**

```sql
CREATE INDEX idx_rule_recommendations_status ON rule_recommendations(status);
CREATE INDEX idx_rule_recommendations_created ON rule_recommendations(created_at DESC);
CREATE INDEX idx_eligibility_rules_active ON eligibility_rules(active);
CREATE INDEX idx_eligibility_rules_created ON eligibility_rules(created_at DESC);
CREATE INDEX idx_user_eligibility_cache_eligible ON user_eligibility_cache(eligible_with_current_rules);
```

---

## Next Phase: 3.5e (Re-engagement Campaign)

Phase 3.5d generates newly-eligible users. Phase 3.5e queries them:

```sql
SELECT u.*, NEW_RULES
FROM users u
LEFT JOIN user_eligibility_cache c ON u.phone_number = c.phone_number
WHERE c.eligible_with_current_rules = false  -- Was ineligible
  AND passes(u, NEW_RULES) = true            -- Now eligible with new rules
  AND u.rejected_at IS NOT NULL              -- Was previously rejected
```

Re-engagement campaign:
1. **WhatsApp:** "Good news! You now qualify for ₹50L at 10.5% APR. Start application in 30 seconds."
2. **Email:** HTML template with pre-filled form link
3. **Slack:** Ops alert "345 users re-engaged today, 64 have started applications"

Expected lift: **18-20% conversion** on re-engaged users.

---

## Success Metrics

| Milestone | Timeline | Target |
|-----------|----------|--------|
| Phase 3.5d Go-Live | Week 8 | Analyze 1000+ rejections, generate 1 recommendation |
| Rule Changes Approved | Week 9 | 3-5 rule versions deployed, 0-errors |
| Newly Eligible Pool Expansion | Week 10-12 | 200-400 users/day re-targeted |
| Re-engagement Conversion Lift | Month 3 | 18-20% conversion on newly-eligible |
| Overall End-to-End Improvement | Month 3 | **0.1% → 3-5% completion** (30-50x) |

---

## Rollback & Safety

If a rule change decreases approvals below 55% or increases bad loans above 5%:

```javascript
// Automatic rollback (or manual ops trigger)
POST /api/suppression/apply-recommendation/:id?revert=true
→ Deactivate current rules (v2)
→ Reactivate previous rules (v1)
→ Alert Slack: "Rollback triggered: rules v2 → v1"
```

All rule changes logged with recommendation ID for full audit trail.
