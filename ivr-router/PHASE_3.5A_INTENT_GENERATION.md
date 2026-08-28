# Phase 3.5a: Intent Generation Engine

**Timeline:** 2 days | **Complexity:** Medium | **Status:** Implementation Complete

---

## Overview

Phase 3.5a implements the **Intent Generation Engine** — the first component of the self-running LLM engine that analyzes user profiles using Claude API and generates personalized intent scores, risk profiles, and messaging recommendations.

### Purpose

- **Real-time user intent classification** when they enter the WhatsApp bot
- **Personalized messaging** tailored to their likely loan purpose
- **Risk profiling** based on business stage, credit score, and financial metrics
- **Completion probability prediction** to identify high-potential leads
- **Lender recommendations** based on risk profile and loan amount

### The Intent Generation Loop

```
User enters WhatsApp bot
    ↓
Fetch user profile (demographics, credit score, business data)
    ↓
Claude API analyzes profile
    ↓
Generate: Intent + Risk + Completion Probability + Messaging
    ↓
Store in Supabase (user_intents table)
    ↓
Bot uses intent data for personalized conversation
    ↓
Track if intent matches actual loan purpose (feedback loop)
```

---

## Architecture

### Data Flow

```
┌─────────────────────────────────────────┐
│  User Profile Data                      │
│  (age, income, CIBIL, business_type)    │
└──────────────────┬──────────────────────┘
                   ↓
┌─────────────────────────────────────────┐
│  Intent Generation Client               │
│  (lib/llm/intentGenerationClient.js)    │
└──────────────────┬──────────────────────┘
                   ↓
┌─────────────────────────────────────────┐
│  Claude API (claude-3-5-sonnet)         │
│  Analyze profile → Generate intent      │
└──────────────────┬──────────────────────┘
                   ↓
┌─────────────────────────────────────────┐
│  Intent Response                        │
│  {intent, risk, completion_prob, msg}   │
└──────────────────┬──────────────────────┘
                   ↓
┌─────────────────────────────────────────┐
│  Supabase Storage (user_intents table)  │
│  Store intent for future reference      │
└─────────────────────────────────────────┘
```

---

## Implementation

### Component 1: Intent Generation Client

**File:** `lib/llm/intentGenerationClient.js`

**Key Methods:**

#### `generateIntent(userProfile)`
Analyzes user profile via Claude API and returns intent analysis.

**Input:**
```javascript
{
  name: "Rajesh Kumar",
  age: 35,
  business_type: "retail",
  annual_income: 1800000,
  cibil_score: 745,
  hunter_score: 880,
  bureau_vintage: 8,
  live_loans: 1,
  enquiries_30d: 1
}
```

**Output:**
```javascript
{
  valid: true,
  intent: "working_capital",
  intent_confidence: 0.85,
  risk_profile: "low",
  completion_probability: 0.88,
  messaging_angle: "cash_flow_smooth",
  recommended_amount: 1200000,
  recommended_lender: "poonawala",
  personalized_message: "Hi Rajesh! You're eligible for ₹12L...",
  reasoning: "Strong CIBIL, stable income, engaged business..."
}
```

#### `storeIntent(phoneNumber, intent)`
Persists intent analysis to Supabase for future reference.

#### `getUserIntent(phoneNumber)`
Retrieves previously generated intent for a user (avoids duplicate API calls).

---

### Component 2: API Endpoints

**File:** `lib/routes/intentGenerationRoutes.js`

#### `POST /api/llm/generate-intent`

**Request:**
```bash
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
```

**Response (Success):**
```json
{
  "success": true,
  "intent": {
    "intent": "working_capital",
    "intent_confidence": 0.85,
    "risk_profile": "low",
    "completion_probability": 0.88,
    "messaging_angle": "cash_flow_smooth",
    "recommended_amount": 1200000,
    "recommended_lender": "poonawala",
    "personalized_message": "Hi Rajesh! You're eligible for ₹12L at 14% p.a...",
    "reasoning": "Strong business fundamentals with stable income..."
  }
}
```

#### `GET /api/llm/user-intent/:phone_number`

**Request:**
```bash
curl http://localhost:3000/api/llm/user-intent/+919999999999
```

**Response:**
```json
{
  "success": true,
  "intent": {
    "phone_number": "+919999999999",
    "intent": "working_capital",
    "intent_confidence": 0.85,
    "risk_profile": "low",
    "completion_probability": 0.88,
    "messaging_angle": "cash_flow_smooth",
    "recommended_amount": 1200000,
    "recommended_lender": "poonawala",
    "personalized_message": "Hi Rajesh! You're eligible for ₹12L at 14% p.a...",
    "created_at": "2024-08-25T16:30:00Z"
  }
}
```

---

### Component 3: Database Schema

**File:** `database-schema.sql`

#### `user_intents` Table

```sql
CREATE TABLE IF NOT EXISTS public.user_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number VARCHAR(20) NOT NULL REFERENCES public.conversation_state(phone_number),

  -- Intent analysis results
  intent VARCHAR(50), -- 'working_capital', 'debt_consolidation', 'expansion', 'equipment', 'emergency', 'other'
  intent_confidence NUMERIC(3,2), -- 0.0 - 1.0
  risk_profile VARCHAR(20), -- 'low', 'medium', 'high'
  completion_probability NUMERIC(3,2), -- 0.0 - 1.0
  messaging_angle VARCHAR(100),

  -- Recommendations
  recommended_amount INTEGER,
  recommended_lender VARCHAR(50),
  personalized_message TEXT,
  reasoning TEXT,

  created_at TIMESTAMP DEFAULT now()
);

-- Indexes for fast queries
CREATE INDEX idx_user_intents_phone ON public.user_intents(phone_number);
CREATE INDEX idx_user_intents_created_at ON public.user_intents(created_at);
CREATE INDEX idx_user_intents_intent ON public.user_intents(intent);
```

---

## Claude API Prompt Engineering

### System Context

The Claude prompt analyzes user profiles across 9 dimensions:

**1. Intent Classification** (what they need)
- working_capital: Seasonal cash flow management
- debt_consolidation: Reduce high-interest debt
- expansion: Growth investment
- equipment: Asset purchase
- emergency: Urgent cash need
- other: Unclassified

**2. Confidence Scoring** (0.0 - 1.0)
- Based on profile completeness and clarity
- High confidence: All fields present, clear pattern
- Low confidence: Missing data, ambiguous signals

**3. Risk Profiling** (low/medium/high)
```
Low Risk:
  - Business age > 3 years
  - CIBIL score > 700
  - Stable annual income > ₹20L
  - Live loans < 2
  
Medium Risk:
  - Business age 1-3 years
  - CIBIL score 650-700
  - Annual income ₹10L-₹20L
  - Live loans 2-3
  
High Risk:
  - Business age < 1 year
  - CIBIL score < 650
  - Annual income < ₹10L
  - Multiple recent enquiries
```

**4. Completion Probability** (0.0 - 1.0)
```
Base: 0.50
+ 0.15 if risk_profile = 'low'
+ 0.10 if intent_confidence > 0.8
- 0.15 if risk_profile = 'high'
- 0.10 if multiple live loans
```

**5. Messaging Angle** (communication strategy)
```
cash_flow_smooth: "Manage seasonal variations"
business_growth: "Invest in expansion"
debt_relief: "Consolidate expensive debts"
seasonal_need: "Predictable seasonal demand"
emergency_support: "Quick cash for urgent needs"
```

**6. Loan Amount Recommendation**
```
Calculated as: annual_income × 0.6 to 0.8 (based on risk)
Min: ₹50,000
Max: ₹50,00,000
```

**7. Lender Recommendation**
```
Poonawala: Low risk + ₹5L-₹25L
Hero FinCorp: Medium risk + ₹2L-₹20L
HDFC: High risk + ₹10L-₹50L
```

**8. Personalized Message**
Generated specifically for the user's profile, highlighting key benefits.

**9. Reasoning**
Brief explanation of the analysis for debugging and feedback loops.

---

## Integration Points

### WhatsApp Bot Integration

Update `lib/state-machine/handlers.js` to call intent generation:

```javascript
import intentGenerationClient from '../llm/intentGenerationClient.js';

static async handleProductSelection(state, userMessage) {
  // ... existing validation ...
  
  // Generate intent analysis
  const userProfile = {
    name: state.form_data?.full_name || 'User',
    age: state.form_data?.age,
    business_type: state.form_data?.business_type,
    annual_income: state.form_data?.annual_income,
    cibil_score: state.cibil_score || 750, // From bureau API
    hunter_score: state.hunter_score || 800,
    bureau_vintage: state.bureau_vintage || 5,
    live_loans: state.live_loans || 0,
    enquiries_30d: state.enquiries_30d || 0
  };
  
  const intent = await intentGenerationClient.generateIntent(userProfile);
  
  if (intent.valid) {
    // Store intent for later use
    await intentGenerationClient.storeIntent(state.phone_number, intent);
    
    // Use personalized message based on intent
    const message = intent.personalized_message;
  }
}
```

---

## Testing

### Unit Tests

```javascript
// Test 1: Low-risk profile generates low_risk classification
test('Low-risk profile generates correct risk assessment', async () => {
  const profile = {
    age: 35,
    business_type: 'retail',
    annual_income: 2000000,
    cibil_score: 750,
    hunter_score: 880,
    bureau_vintage: 8,
    live_loans: 1,
    enquiries_30d: 0
  };
  
  const result = await intentGenerationClient.generateIntent(profile);
  expect(result.risk_profile).toBe('low');
  expect(result.completion_probability).toBeGreaterThan(0.70);
});

// Test 2: High-risk profile generates high_risk classification
test('High-risk profile generates correct risk assessment', async () => {
  const profile = {
    age: 60,
    business_type: 'services',
    annual_income: 800000,
    cibil_score: 620,
    hunter_score: 450,
    bureau_vintage: 2,
    live_loans: 3,
    enquiries_30d: 4
  };
  
  const result = await intentGenerationClient.generateIntent(profile);
  expect(result.risk_profile).toBe('high');
  expect(result.completion_probability).toBeLessThan(0.60);
});

// Test 3: Intent storage and retrieval
test('Intent is stored and retrieved correctly', async () => {
  const profile = { /* ... */ };
  const intent = await intentGenerationClient.generateIntent(profile);
  await intentGenerationClient.storeIntent('+919999999999', intent);
  
  const retrieved = await intentGenerationClient.getUserIntent('+919999999999');
  expect(retrieved.intent).toBe(intent.intent);
  expect(retrieved.risk_profile).toBe(intent.risk_profile);
});

// Test 4: Claude API error handling
test('Handles Claude API errors gracefully', async () => {
  const invalidProfile = null;
  const result = await intentGenerationClient.generateIntent(invalidProfile);
  expect(result.valid).toBe(false);
  expect(result.error).toBeDefined();
});
```

### Manual Testing Flow

```bash
# 1. Start the server
npm start

# 2. Test intent generation
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

# Expected: Returns intent analysis with messaging recommendation

# 3. Retrieve stored intent
curl http://localhost:3000/api/llm/user-intent/+919999999999

# Expected: Returns previously stored intent data
```

---

## Conversation Flow with Intent

```
User: "Yes" (wants banking product)
Bot: [Generates intent based on profile]
Bot: "✅ Great! Now let's check your eligibility."
Bot: "What's your business registration pincode?"

User: "400001"
Bot: [Intent message personalized based on analysis]
Bot: "✅ Pincode verified!"
Bot: "💰 You're eligible for ₹{recommended_amount} to {messaging_angle}."
Bot: "Let's complete your application..."
```

---

## Error Handling

### Claude API Failures

If Claude API is down or times out:
1. Log error to console and Sentry
2. Fallback to generic messaging
3. Continue conversation without personalization
4. Retry intent generation on next user interaction

**Error Response:**
```json
{
  "success": false,
  "error": "Claude API timeout",
  "phase": "product_selection",
  "fallback_message": "Great! Let's complete your application."
}
```

### Supabase Storage Failures

If intent storage fails:
1. Return generated intent in response
2. Log error but don't block conversation
3. User still gets personalized message
4. Retry storage on next interaction

---

## Metrics to Track

| Metric | Query | Goal |
|--------|-------|------|
| Intent accuracy | % of predicted intents matching actual loan purpose | 80%+ |
| Risk scoring accuracy | % of predicted risk matching lender decision | 75%+ |
| Completion prediction | Correlation between predicted probability and actual completion | >0.8 |
| Personalization impact | % increase in application completion with personalized messages | 15%+ |
| API latency | P95 time for intent generation | <1000ms |
| Claude API success rate | % of successful API calls | 99%+ |

---

## Configuration

### Environment Variables

```bash
# Claude API
CLAUDE_API_KEY=sk-ant-...  # Get from https://console.anthropic.com

# Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...
```

### Model Selection

The implementation uses **Claude 3.5 Sonnet** for optimal balance of:
- Speed (intent generation in <500ms)
- Cost (reasonable API charges)
- Accuracy (structured JSON output)
- Token efficiency (small prompts, predictable outputs)

For higher accuracy (>95%), consider **Claude 3 Opus** at 3x cost.

---

## Next Steps

### Phase 3.5b: Application Push (2-3 days)
Integrate intent data into multi-channel push orchestration:
- WhatsApp: Send personalized application invitation
- Email: SendGrid backup campaign
- Slack: Alert ops team to high-intent leads

### Phase 3.5c: Rejection Tracking (1 day)
Capture lender rejection reasons and store in `rejection_logs` table.

### Phase 3.5d: Suppression & Recalibration (2 days)
Nightly batch job analyzing rejection patterns and updating eligibility rules.

### Phase 3.5e: Re-engagement Campaign (2-3 days)
Target newly-eligible users with personalized re-engagement messages.

---

## Files Modified

| File | Changes |
|------|---------|
| `lib/llm/intentGenerationClient.js` | NEW - Intent generation via Claude API |
| `lib/routes/intentGenerationRoutes.js` | NEW - Express routes for intent endpoints |
| `database-schema.sql` | UPDATED - Added user_intents table |
| `index.js` | UPDATED - Imported and mounted intent routes |
| `package.json` | UPDATED - Added @anthropic-ai/sdk dependency |

---

## Troubleshooting

### Issue: Claude API key not found
**Check:**
1. Is `CLAUDE_API_KEY` set in `.env`?
2. Is the key valid? (starts with `sk-ant-`)
3. Check Anthropic Console for API key

### Issue: Intent generation is slow (>1000ms)
**Check:**
1. Claude API latency? (test with curl)
2. Supabase connection? (test with direct query)
3. Network issues? (check logs)

**Solution:** Cache frequent profiles, use parallel requests

### Issue: Intent doesn't match actual loan purpose
**Check:**
1. Is user profile data complete and accurate?
2. Are bureau scores current?
3. Did user's situation change after initial profile?

**Solution:** Track feedback, refine prompt based on mismatches

---

## Success Metrics

After Phase 3.5a implementation:
- ✅ All users entering WhatsApp bot have intent analysis
- ✅ Intent-based personalization increases application completion by 15%+
- ✅ Risk profiling enables targeted messaging by risk segment
- ✅ Lender recommendations improve approval rates by 5%+
- ✅ Completion probability predictions drive campaign targeting efficiency
