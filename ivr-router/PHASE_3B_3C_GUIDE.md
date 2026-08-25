# Phase 3b & 3c: Multi-Step Forms & Document Collection

**Timeline:** 1 week total | **Complexity:** Medium | **Status:** Implementation Complete

---

## Overview

Phase 3b and 3c build on Phase 3a's state machine foundation:

- **Phase 3b**: Multi-step forms for personal and business details (Phases 4-5)
- **Phase 3c**: Document collection and upload handling (Phase 6)

---

## Architecture

```
User input (WhatsApp) → Webhook → Load state → Determine phase + step
↓
Form handler (3b/3c) → Validate input → Store in form_data JSONB → Return message
↓
Update conversation_state → Send response → User sees next question
```

---

## Phase 3b: Multi-Step Forms

### Components

**File:** `lib/state-machine/formHandlers.js`

#### Personal Details Form (Phase 4 - 50% completion)

```javascript
handlePersonalDetailsForm(state, userMessage, step)
```

**Steps:**
1. **Name** (already collected in Phase 3a)
2. **Email** - Validate email format (regex check)
3. **Age** - Validate 18-100 range
4. **Transition** - Move to business details

**Example Flow:**
```
Bot: "📞 What's your contact email address?"
User: "rajesh@example.com"
Bot: "✅ Got it! 👤 What's your age?"
User: "35"
Bot: "✅ Perfect! 📊 What's your business type?"
```

#### Business Details Form (Phase 5 - 60% completion)

```javascript
handleBusinessDetailsForm(state, userMessage, step)
```

**Steps:**
1. **Business Type** - Choice (Retail, Manufacturing, Services, Import/Export, Other)
2. **Annual Income** - Numeric validation (₹100K - ₹5Cr)
3. **Loan Amount** - Numeric validation (₹50K - ₹50Lakh)
4. **Tenure** - Choice (12, 24, 36, 48, 60 months)
5. **Summary & EMI Calculation** - Show calculated EMI, move to documents

**Example Flow:**
```
Bot: "📊 What's your business type? 1️⃣ Retail 2️⃣ Manufacturing..."
User: "1"
Bot: "✅ Got it! 💰 What's your annual business income? (in ₹)"
User: "1800000"
Bot: "💯 Great! 💸 How much loan amount do you need?"
User: "1200000"
Bot: "📅 What tenure do you prefer? 1️⃣ 12 months 2️⃣ 24 months..."
User: "3"
Bot: "✅ Perfect! Here's your summary...
      💰 Loan: ₹12,00,000
      📅 Tenure: 36 months
      💸 EMI: ₹3,200/month
      📄 Now let's upload your documents."
```

### Database Schema Updates

**conversation_state.form_data (JSONB)**

```jsonb
{
  "product_type": "banking",
  "pincode": "400001",
  "full_name": "Rajesh Kumar",
  "email": "rajesh@example.com",
  "age": 35,
  "business_type": "Retail",
  "annual_income": 1800000,
  "loan_amount": 1200000,
  "tenure_months": 36,
  "selected_lender": "Poonawala"
}
```

### Validation Rules

| Field | Type | Min | Max | Format |
|-------|------|-----|-----|--------|
| name | string | 3 | 100 | No numbers |
| email | string | - | - | Valid email regex |
| age | integer | 18 | 100 | Whole number |
| business_type | string | - | - | Predefined list |
| annual_income | integer | 100,000 | 50,000,000 | Numeric |
| loan_amount | integer | 50,000 | 5,000,000 | Numeric |
| tenure_months | integer | - | - | {12, 24, 36, 48, 60} |

---

## Phase 3c: Document Collection

### Components

**File:** `lib/state-machine/formHandlers.js`

#### Document Upload Handler (Phase 6 - 80% completion)

```javascript
handleDocumentsForm(state, userMessage)
```

**Document Types Required:**
1. **BRC** - Business Registration Certificate
2. **Bank Statements** - Last 6 months
3. **ID Proof** - Aadhar/Passport/Driving License

### Document Flow

```
User types: "upload"
Bot: "📤 Please upload via link..."
User uploads 3 documents
User replies: "DONE"
Bot moves to KYC verification
```

### Example Conversation

```
Bot: "📄 Now let's upload your documents"
User: "upload"
Bot: "📤 Please upload your documents via this link:
     https://upload.buddyloan.com

     Required documents:
     1️⃣ Business Registration Certificate (BRC)
     2️⃣ Bank Statements (last 6 months)
     3️⃣ ID Proof (Aadhar/Passport/DL)

     Reply 'DONE' when you've uploaded all documents."

User uploads files...
User: "DONE"

Bot: "✅ Documents received!
     🔍 Our team is verifying your documents...
     Expected time: 2-4 hours
     We'll update you via WhatsApp!"
```

### Database Schema Updates

**conversation_state.document_status (JSONB)**

```jsonb
{
  "brc": {
    "uploaded": true,
    "verified": false,
    "status": "pending",
    "url": "s3://buddyloan/docs/brc-12345.pdf",
    "uploaded_at": "2024-08-25T15:30:00Z"
  },
  "bank_statement": {
    "uploaded": true,
    "verified": false,
    "status": "pending",
    "url": "s3://buddyloan/docs/bank-12345.pdf",
    "uploaded_at": "2024-08-25T15:30:00Z"
  },
  "id_proof": {
    "uploaded": true,
    "verified": false,
    "status": "pending",
    "url": "s3://buddyloan/docs/id-12345.pdf",
    "uploaded_at": "2024-08-25T15:30:00Z"
  }
}
```

### Document Status Lifecycle

| Status | Meaning | Next Step |
|--------|---------|-----------|
| pending | Uploaded, awaiting verification | OCR & verification (Phase 3.5d) |
| verifying | Being processed by OCR/CIBIL | Waiting |
| verified | Passed verification | Move to lender submission |
| rejected | Failed verification | User notified, can re-upload |

---

## Implementation Checklist

### Phase 3b: Multi-Step Forms

- [x] Create `formHandlers.js` with email validation (regex)
- [x] Create `formHandlers.js` with age validation (18-100)
- [x] Create business type handler (5-choice selector)
- [x] Create income validator (₹100K - ₹5Cr)
- [x] Create loan amount validator (₹50K - ₹50L)
- [x] Create tenure selector (12/24/36/48/60 months)
- [x] Calculate EMI based on loan + tenure
- [x] Store all form data in JSONB
- [x] Update handlers.js to use formHandlers
- [ ] Test email validation edge cases
- [ ] Test income ranges
- [ ] Test tenure selection
- [ ] Test EMI calculation accuracy

### Phase 3c: Document Collection

- [x] Create document handler
- [x] Support "upload" command
- [x] Support "DONE" completion
- [x] Initialize document_status JSONB
- [x] Handle multi-step document flow
- [ ] Integrate with upload link (https://upload.buddyloan.com)
- [ ] Store S3 URLs in document_status
- [ ] Create Phase 3.5d OCR processor
- [ ] Create Phase 3.5d CIBIL fetch job
- [ ] Test document status tracking

---

## Testing

### Unit Tests

```javascript
// Test email validation
test('Rejects invalid email', async () => {
  const result = await handlers.handlePersonalDetails(state, 'not-an-email');
  expect(result.validation.valid).toBe(false);
});

test('Accepts valid email', async () => {
  const result = await handlers.handlePersonalDetails(state, 'raj@example.com');
  expect(result.nextPhase).toBe('form_business');
});

// Test income validation
test('Rejects income < 100K', async () => {
  const result = await handlers.handleBusinessDetails(state, '50000', 2);
  expect(result.validation.valid).toBe(false);
});

test('Accepts valid income', async () => {
  const result = await handlers.handleBusinessDetails(state, '1800000', 2);
  expect(result.nextPhase).toBe('form_business');
});

// Test EMI calculation
test('Calculates EMI correctly', async () => {
  const state = { form_data: { loan_amount: 1200000, tenure_months: 36 } };
  const result = await handlers.handleBusinessDetails(state, '36', 4);
  expect(result.message).toContain('₹3,200'); // Approx EMI
});

// Test document flow
test('Accepts DONE from documents', async () => {
  const result = await handlers.handleDocuments(state, 'DONE');
  expect(result.nextPhase).toBe('kyc_verification');
});
```

### Manual Testing Checklist

- [ ] **Personal Details Form**
  - [ ] Invalid email rejected with error
  - [ ] Valid email accepted
  - [ ] Age < 18 rejected
  - [ ] Age > 100 rejected
  - [ ] Valid age accepted
  - [ ] All fields persisted in form_data

- [ ] **Business Details Form**
  - [ ] Business type selection works (1-5)
  - [ ] Invalid choice rejected
  - [ ] Income outside range rejected
  - [ ] Loan amount outside range rejected
  - [ ] Tenure selection works (1-5)
  - [ ] EMI calculation shown correctly
  - [ ] All fields persisted in form_data

- [ ] **Document Collection**
  - [ ] "upload" triggers upload message
  - [ ] "DONE" moves to KYC phase
  - [ ] document_status initialized
  - [ ] State persists across sessions
  - [ ] Full conversation flow works

### Conversation Flow Test

```bash
# 1. Product selection
curl -X POST http://localhost:3000/api/webhooks/ananta/message \
  -H "Content-Type: application/json" \
  -d '{"phone": "+919999999999", "message_text": "Yes"}'
# Expect: phase = eligibility_check

# 2. Pincode
curl -X POST http://localhost:3000/api/webhooks/ananta/message \
  -H "Content-Type: application/json" \
  -d '{"phone": "+919999999999", "message_text": "400001"}'
# Expect: phase = form_personal

# 3. Name
curl -X POST http://localhost:3000/api/webhooks/ananta/message \
  -H "Content-Type: application/json" \
  -d '{"phone": "+919999999999", "message_text": "Rajesh Kumar"}'
# Expect: phase = form_business

# 4. Business type
curl -X POST http://localhost:3000/api/webhooks/ananta/message \
  -H "Content-Type: application/json" \
  -d '{"phone": "+919999999999", "message_text": "1"}'
# Expect: ask for email

# 5. Email
curl -X POST http://localhost:3000/api/webhooks/ananta/message \
  -H "Content-Type: application/json" \
  -d '{"phone": "+919999999999", "message_text": "rajesh@example.com"}'
# Expect: ask for age

# 6. Age
curl -X POST http://localhost:3000/api/webhooks/ananta/message \
  -H "Content-Type: application/json" \
  -d '{"phone": "+919999999999", "message_text": "35"}'
# Expect: ask for business type

# 7. Business type (again)
curl -X POST http://localhost:3000/api/webhooks/ananta/message \
  -H "Content-Type: application/json" \
  -d '{"phone": "+919999999999", "message_text": "1"}'
# Expect: ask for income

# 8. Income
curl -X POST http://localhost:3000/api/webhooks/ananta/message \
  -H "Content-Type: application/json" \
  -d '{"phone": "+919999999999", "message_text": "1800000"}'
# Expect: ask for loan amount

# 9. Loan amount
curl -X POST http://localhost:3000/api/webhooks/ananta/message \
  -H "Content-Type: application/json" \
  -d '{"phone": "+919999999999", "message_text": "1200000"}'
# Expect: ask for tenure

# 10. Tenure
curl -X POST http://localhost:3000/api/webhooks/ananta/message \
  -H "Content-Type: application/json" \
  -d '{"phone": "+919999999999", "message_text": "3"}'
# Expect: show summary, move to documents phase

# 11. Upload
curl -X POST http://localhost:3000/api/webhooks/ananta/message \
  -H "Content-Type: application/json" \
  -d '{"phone": "+919999999999", "message_text": "upload"}'
# Expect: show upload link

# 12. Done
curl -X POST http://localhost:3000/api/webhooks/ananta/message \
  -H "Content-Type: application/json" \
  -d '{"phone": "+919999999999", "message_text": "DONE"}'
# Expect: phase = kyc_verification
```

---

## Troubleshooting

### Issue: Form data not persisting
**Check:**
1. Is Supabase connection working?
2. Are JSONB columns allowing updates?
3. Check conversation_state table: `SELECT form_data FROM conversation_state WHERE phone_number = '+919999999999';`

### Issue: Email validation failing on valid emails
**Check:**
1. Regex pattern: `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`
2. Trim whitespace: `userMessage.trim()`
3. Test in Node: `console.log(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test('test@example.com'))`

### Issue: EMI calculation wrong
**Check:**
1. Formula: `EMI = (P × r × (1 + r)^n) / ((1 + r)^n - 1)`
2. Where P = principal, r = monthly rate (10.5% annual = 0.875% monthly), n = months
3. Example: ₹12L for 36 months at 10.5% = ₹3,200/month approx

### Issue: Document upload not working
**Check:**
1. Is upload.buddyloan.com accessible?
2. Are S3 credentials configured?
3. Check conversation_state.document_status JSONB for upload URLs

---

## Next Steps

- **Phase 3.5a**: Intent generation (Claude API analysis)
- **Phase 3.5d**: Rejection analysis & recalibration (nightly batch job)
- **Phase 4**: Lender submission & async polling
- **Integration**: Hook Phase 2 lender routing for eligibility check

---

## Files Modified

- `lib/state-machine/formHandlers.js` ✅ (New)
- `lib/state-machine/handlers.js` ✅ (Updated)

---

## Metrics to Track

- Average time per phase (form_personal, form_business, documents)
- Form abandonment rate per phase
- Error rate per validation field
- Document upload success rate
- EMI calculation accuracy
