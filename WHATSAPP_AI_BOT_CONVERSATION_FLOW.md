# WhatsApp AI Bot Conversation Flow (Ananta Integration)

**Purpose:** Guide users through complete loan application on WhatsApp (not web/forms)  
**Channel:** Ananta WhatsApp integration  
**Goal:** Reduce application drop-off from 99% to <30%  
**Status:** Architecture & Design

---

## Problem We're Solving

```
Current Funnel:
IVR Press 1 (100%) → Send WhatsApp Link → User clicks → Web form → ABANDONS (99%)

Better Funnel (This Design):
IVR Press 1 (100%) → WhatsApp AI Bot greets → Conversational flow → Application complete → COMPLETION (target: 70%+)
```

**Key Insight:** Users abandon because:
- Web forms feel formal & intimidating
- Too many fields at once
- Can't go back/edit easily
- No real-time guidance
- Not in their comfort zone (WhatsApp)

**Solution:** Conversational AI bot on WhatsApp = natural, guided, step-by-step, low friction.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    WHATSAPP AI BOT FLOW                      │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  Step 1: IVR Press 1                                         │
│  └─ "Your loan application will arrive in WhatsApp"         │
│                                                               │
│  Step 2: WhatsApp Welcome Message (Ananta)                  │
│  └─ "Hi Rajesh! 👋 Let's get your business loan approved"   │
│                                                               │
│  Step 3: Product Selection (Banking / Non-Banking)          │
│  └─ Buttons: "Yes, I have bank account" / "No bank account" │
│                                                               │
│  Step 4: Eligibility Pre-Check (Pincode + CIBIL)           │
│  └─ AI Bot: "What's your pincode?"                          │
│     User: "400001"                                           │
│     Bot: "Great! You're eligible. Let's get your credit info" │
│                                                               │
│  Step 5: Lender Selection (Based on Eligibility)            │
│  └─ Buttons: "Poonawala Fincorp" / "Hero FinCorp"           │
│                                                               │
│  Step 6: Application Form (Conversational)                  │
│  ├─ Name? → Bot: "What's your full name?"                   │
│  ├─ Age? → Bot: "How old are you?"                          │
│  ├─ Income? → Bot: "Annual income?"                         │
│  ├─ Loan needed? → Bot: "How much do you need?"             │
│  └─ VALIDATE EACH INPUT in real-time                        │
│                                                               │
│  Step 7: Document Collection (WhatsApp Media)               │
│  └─ Bot: "Send your business registration certificate"      │
│     User uploads file → Auto-verified via OCR               │
│                                                               │
│  Step 8: Verification & KYC                                 │
│  └─ Bot: "We're verifying your details..."                  │
│     (Background processing, progress updates)                │
│                                                               │
│  Step 9: Submission to Lender                               │
│  └─ Bot: "Sending to Poonawala Fincorp..."                  │
│     (Real-time status: submitted → processing → approved)    │
│                                                               │
│  Step 10: Approval & Next Steps                             │
│  └─ Bot: "🎉 Your application approved! Next: disbursal"    │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

---

## Detailed Conversation Flows

### Flow 1: Product Selection (Banking vs Non-Banking)

```
User Context: Just pressed 1 on IVR, got WhatsApp link
Time: Within 1 minute of IVR press

BOT MESSAGE:
"Hi Rajesh! 👋

I'll help you complete your business loan application in just 5 minutes.

Do you have a business bank account?

⚪ Yes, I have a bank account
⚪ No, I don't have a bank account"

USER CLICKS: "Yes, I have a bank account"

BOT: "Perfect! You can access all business lenders:
- Poonawala Fincorp (₹1L-25L, 12-18% rate)
- HDFC Business Loan (₹5L-50L, 10-15% rate)
- And more...

Let's check which one is best for you."

BACKEND:
├─ product_type = "banking"
├─ Log: "User selected banking product"
└─ Next: Eligibility pre-check
```

---

### Flow 2: Eligibility Pre-Check

```
BOT: "Quick check to find the best lender for you.

What's your business registration pincode?"

USER: "400001"

BOT VALIDATION:
├─ Check pincode serviceable
├─ If YES → "Great! That's our service area"
└─ If NO → "Sorry, we don't serve that pincode yet. Try non-banking options"

BOT: "What's your approximate annual business income?"

USER: "₹5 lakh"

BOT VALIDATION:
├─ Check income range
├─ If < ₹2L → "Minimum income is ₹2L. Check micro-finance options"
├─ If ₹2L-10L → "You can get ₹1L-10L loans"
└─ If > ₹10L → "You can get ₹1L-50L+ loans"

BOT: "Do you have a CIBIL score? (optional)"

USER: "750"

BOT:
├─ Check against lender thresholds
├─ Poonawala: "✅ Eligible (needs 720+)"
├─ HDFC: "✅ Eligible (needs 750+)"
└─ Hero: "✅ Eligible (needs 700+)"

BACKEND:
├─ Pre-check results stored
├─ eligible_lenders = ["poonawala", "hdfc", "hero"]
└─ Next: Lender selection
```

---

### Flow 3: Lender Selection

```
BOT: "Based on your profile, here are the best options:

🏆 BEST RATES
💰 Poonawala Fincorp
   Loan: ₹1L-25L
   Rate: 12-18% p.a.
   EMI (₹10L @ 15%): ₹3,200/month
   [SELECT]

🏛️ PREMIUM OPTION
💰 HDFC Bank
   Loan: ₹5L-50L
   Rate: 10-15% p.a.
   EMI (₹10L @ 12%): ₹2,900/month
   [SELECT]

⚡ FASTEST APPROVAL
💰 Hero FinCorp
   Loan: ₹1L-20L
   Rate: 13-20% p.a.
   EMI (₹10L @ 16%): ₹3,300/month
   [SELECT]"

USER CLICKS: [SELECT] under Poonawala

BOT: "Excellent! You'll be approved faster with Poonawala.

Let's complete your application (5 minutes).

First, your personal details."

BACKEND:
├─ selected_lender = "poonawala"
├─ Log: "User selected Poonawala"
└─ Next: Application form (personal details)
```

---

### Flow 4: Application Form (Conversational)

```
╔════════════════════════════════════════════════════════════╗
║           SECTION 1: PERSONAL DETAILS (2 min)             ║
╚════════════════════════════════════════════════════════════╝

BOT: "Let's start with your basic details.

What's your full name?"

USER: "Rajesh Kumar Singh"

BOT VALIDATION:
├─ Length check (3-100 chars)
├─ No numbers/special chars
└─ If INVALID → "Name should only have letters. Try again."
└─ If VALID → ✅ "Got it, Rajesh!"

BOT: "What's your age?"

USER: "32"

BOT VALIDATION:
├─ Numeric, 18-75
└─ If INVALID → "Age should be between 18-75. What's your age?"
└─ If VALID → ✅ "Perfect!"

BOT: "What's your email?"

USER: "rajesh@email.com"

BOT VALIDATION:
├─ Email format check
└─ If VALID → ✅ "Email saved"

BOT: "What's your phone number?"
[Phone already captured from IVR, but confirm]

USER: "9876543210"

BOT: "We'll send updates to this number. Correct?"
Buttons: [Yes] [Change]

╔════════════════════════════════════════════════════════════╗
║         SECTION 2: BUSINESS DETAILS (2 min)              ║
╚════════════════════════════════════════════════════════════╝

BOT: "Now your business details.

What's your business type?"

BUTTONS:
├─ Retail / E-commerce
├─ Manufacturing
├─ Services
├─ Import/Export
└─ Other

USER CLICKS: "Retail / E-commerce"

BOT: "How long have you been in business?"

BUTTONS:
├─ Less than 1 year
├─ 1-3 years
├─ 3-5 years
├─ 5+ years

USER CLICKS: "3-5 years"

BOT: "Annual business income?"

USER: "₹15 lakh"

BOT VALIDATION:
├─ Check against lender min (Poonawala: ₹3L min)
└─ ✅ "Great! That qualifies for ₹15L+ loans"

BOT: "Loan amount needed?"

USER: "₹10 lakh"

BOT VALIDATION:
├─ Check against lender range (₹1L-25L)
├─ Check against income (can afford 40-50% of income)
└─ ✅ "₹10L is perfect for your profile. EMI: ₹3,100/month"

BOT: "Loan tenure?"

BUTTONS: [12 months] [24 months] [36 months] [48 months]

USER CLICKS: [36 months]

BOT: "📋 Summary so far:

Name: Rajesh Kumar Singh
Age: 32
Business: Retail / E-commerce
Income: ₹15 lakh/year
Loan needed: ₹10 lakh
Tenure: 36 months
EMI: ₹3,100/month

Everything correct?"

Buttons: [✅ Yes, correct] [❌ Edit]

USER CLICKS: [✅ Yes, correct]

BACKEND:
├─ application_id = "app_12345" (created)
├─ All personal & business details stored
├─ Log: "Application form completed"
└─ Next: Document collection
```

---

### Flow 5: Document Collection (WhatsApp Media)

```
BOT: "📄 Documents needed (usually 3-5)

Poonawala Fincorp needs:
1️⃣  Business Registration Certificate
2️⃣  Bank Statement (last 6 months)
3️⃣  ID Proof (Aadhar/PAN/Driving License)
4️⃣  Address Proof
5️⃣  Business License (if any)

You can send anytime. Let's start:

📤 Send your Business Registration Certificate"

USER SENDS: [Document File via WhatsApp Media]

BOT RECEIVES:
├─ File: business_reg.pdf (detected)
├─ Size: 2.3MB (OK)
├─ Format: PDF (acceptable)
└─ Message: "📥 Received! Verifying..."

BACKEND:
├─ Call OCR API (AWS Textract / Google Vision)
├─ Verify: Company name, registration date, address
├─ Extract: Registration number, business type
├─ Store: document metadata in crm.documents
├─ Status: "verified" or "needs_review"

BOT: "✅ Document verified!

📤 Now send your Bank Statement (last 6 months)"

[Process repeats for each document]

AFTER ALL DOCS SENT:

BOT: "✅ All documents received!

We're verifying them now (usually 5-10 minutes).
You'll get updates in this chat.

⏳ Status: Verifying documents..."

BACKEND:
├─ OCR on all documents
├─ Compliance check (name match, PAN match)
├─ Flag if issues (e.g., document expired)
├─ Log: "All documents received and processing"
└─ Next: KYC verification (background)
```

---

### Flow 6: KYC & Verification (Background)

```
BOT UPDATES (Real-time):

"⏳ Step 1/3: Verifying documents..."
[Wait 2 minutes]

"✅ Step 1/3: Documents verified"
"⏳ Step 2/3: Checking business details..."
[Wait 1 minute]

"✅ Step 2/3: Business verified"
"⏳ Step 3/3: Getting credit decision..."
[Wait 3 minutes]

BACKEND (Background):
├─ OCR + Compliance on all docs
├─ CIBIL score lookup (if not provided)
├─ Business verification (GSTIN, registration)
├─ Call Phase 2 eligibility engine
├─ Get approved amount, rate, tenor
├─ Log: "KYC complete, ready for submission"
└─ Next: Submit to lender
```

---

### Flow 7: Lender Submission & Status Tracking

```
BOT: "✅ You're approved for ₹10 lakh!

Details:
💰 Amount: ₹10,00,000
📊 Rate: 14.5% p.a.
📅 Tenure: 36 months
💵 Monthly EMI: ₹3,100

Ready to proceed to Poonawala Fincorp?"

Buttons: [✅ Yes, proceed] [❌ Cancel]

USER CLICKS: [✅ Yes, proceed]

BOT: "🚀 Submitting to Poonawala Fincorp..."

BACKEND:
├─ Format application per Poonawala spec
├─ Call Poonawala API: /submit-application
├─ Get: lender_application_id = "POO_12345"
├─ Store in crm.lender_submissions
├─ Start polling for decision (every 1 hour)

BOT UPDATES (Real-time):

"⏳ Status: Submitted to Poonawala Fincorp
Submission ID: POO_12345
Submitted: 2024-10-01 10:30 AM

Poonawala usually approves within 24 hours.
You'll get updates here. 👇"

[WAIT 1 HOUR - POLL LENDER]

BOT: "⏳ Status: Under review
Expected decision: Tomorrow 10:30 AM

In the meantime, here's your next steps:
1️⃣  Arrange collateral docs (if needed)
2️⃣  Prepare bank details for disbursal
3️⃣  Keep your phone handy for Poonawala's call

Need help? Reply 'help'"

[WAIT 4 HOURS - POLL LENDER AGAIN]

BOT: "🎉 Great news!

Your loan has been APPROVED by Poonawala!

Approval Details:
✅ Amount: ₹10,00,000
✅ Rate: 14.5% p.a.
✅ Tenure: 36 months
✅ EMI: ₹3,100/month

Next step: Disbursal in 2-3 business days

Poonawala will call you at +91-XXXXXXX10 to finalize.

Questions? Type 'help' or call us at 1800-BUDDYLOAN"

BACKEND:
├─ Poll returned: status = "approved"
├─ Update crm.lender_submissions.status = "approved"
├─ Extract: approved_amount, approved_rate, approved_tenor
├─ Log: "Loan approved by Poonawala"
├─ Send WhatsApp notification to user
├─ Schedule: Follow-up message in 48 hours (disbursal status)
└─ Next: Disbursal (Phase 5)
```

---

### Flow 8: Error Handling & Fallback

```
SCENARIO 1: Lender Rejects

BOT: "❌ Poonawala Fincorp reviewed your application

Unfortunately, they can't approve at this time.
Reason: Income threshold slightly below minimum

But don't worry! We can try other lenders.

Would you like to try:
👉 Hero FinCorp (higher approval probability)
👉 Bajaj Finserv (alternative option)"

USER CLICKS: [Hero FinCorp]

BOT: "🚀 Resubmitting to Hero FinCorp..."
[Repeat Flow 7 with new lender]

BACKEND:
├─ Update crm.lender_submissions.status = "rejected"
├─ Log rejection reason
├─ Fallback to next eligible lender
└─ Auto-submit to fallback lender

---

SCENARIO 2: User Abandons Mid-Application

BOT (After 2 hours of inactivity):
"👋 Hi Rajesh! Still interested in that ₹10L loan?

You were 80% through the application.

👉 RESUME APPLICATION (2 min remaining)
👉 START OVER

Reply with the number you want!"

BACKEND:
├─ Track abandonment point
├─ Log: "User abandoned at: document collection"
├─ Send reminder after 2 hours
├─ Send reminder after 24 hours (only once)
├─ Store as: abandoned_application
└─ Can be resumed anytime (within 7 days)

---

SCENARIO 3: Document Rejected (OCR Failed)

BOT: "⚠️ Document issue

Your PAN document quality is too low. 
Can you re-upload a clearer photo?

Tips:
✅ Take in good lighting
✅ Keep document flat
✅ Avoid glare
✅ All 4 corners visible"

USER SENDS: [New document file]

BOT: "✅ Great! Document verified"

BACKEND:
├─ OCR failed on first attempt
├─ Ask user to re-upload
├─ Store all attempts (audit trail)
└─ Flag for manual review if repeated failures
```

---

## Backend Integration Points

### 1. Ananta WhatsApp Integration

```javascript
// Receive message from user
POST /webhooks/ananta/message
{
  phone: "919876543210",
  message_text: "400001",
  message_type: "text" | "media" | "button_click",
  media_url: "https://...",
  timestamp: "2024-10-01T10:30:00Z"
}

// Send message to user
POST /api/ananta/send-message
{
  phone: "919876543210",
  message_type: "text" | "buttons" | "template",
  text: "Hi Rajesh!",
  buttons: [
    { id: "btn_1", label: "Yes" },
    { id: "btn_2", label: "No" }
  ]
}
```

### 2. Conversation State Management

```javascript
// Store conversation state per user
CREATE TABLE conversation_state (
  phone VARCHAR,
  session_id VARCHAR,
  current_step VARCHAR, // product_selection, eligibility, form_personal, form_business, documents, kYC, submission, approval
  application_id VARCHAR,
  form_data JSONB, // {name, age, email, business_type, ...}
  document_status JSONB, // {biz_reg: verified, bank_stmt: pending, ...}
  created_at TIMESTAMP,
  updated_at TIMESTAMP,
  last_message_at TIMESTAMP
);

// Retrieve state
SELECT * FROM conversation_state WHERE phone = "919876543210"

// Update state after each user message
UPDATE conversation_state 
SET current_step = "documents", 
    form_data = {...}, 
    updated_at = NOW() 
WHERE phone = "919876543210"
```

### 3. Message Routing (Ananta → Backend → Response)

```
User sends message on WhatsApp
    ↓
Ananta receives (POST /webhooks/ananta/message)
    ↓
Backend: Extract phone, message, session
    ↓
Backend: Load conversation_state (current_step, form_data)
    ↓
Backend: AI Bot logic (based on current_step)
    ├─ Validate input
    ├─ Call external APIs (if needed: OCR, eligibility, lender submission)
    ├─ Update conversation_state
    └─ Generate response message
    ↓
Backend: Send response (POST /api/ananta/send-message)
    ↓
Ananta sends to user on WhatsApp
    ↓
User sees bot response and types next message
    ↓
[Loop repeats]
```

### 4. Background Tasks (Non-Blocking)

```
While conversation continues, background jobs:
├─ OCR documents (5-10 min)
├─ Verify business (2-3 min)
├─ Check CIBIL (1-2 min)
├─ Call eligibility engine (1 min)
├─ Submit to lender (real-time)
└─ Poll lender for decision (every 1 hour, max 24 hours)

User gets updates via WhatsApp as tasks complete:
"✅ Documents verified"
"✅ Business verified"
"✅ Submitting to lender..."
```

---

## Conversation State Machine

```
START
  ↓
[product_selection] → User selects Banking/Non-Banking
  ↓
[eligibility_check] → Bot asks pincode, income, CIBIL
  ↓
[lender_selection] → Bot shows eligible lenders with rates
  ↓
[form_personal] → Bot asks: name, age, email, phone
  ↓
[form_business] → Bot asks: business type, age, income, loan_amount, tenor
  ↓
[documents] → Bot asks for each doc, validates via OCR
  ↓
[kyc_verification] → Background: OCR, compliance, CIBIL, business check
  ↓
[lender_submission] → Submit to Poonawala/HDFC/Hero (wait for approval)
  ↓
[approval] → Show approval details, next steps
  ↓
[disbursal] → Track disbursal status
  ↓
END

Fallback paths:
- [eligibility_check] → Not eligible → Offer non-banking
- [lender_selection] → All rejected → Offer alternative lenders
- [documents] → Rejected → Ask to re-upload
- [lender_submission] → Lender rejects → Try fallback lender
```

---

## Expected Improvements

| Metric | Current | Target | Mechanism |
|--------|---------|--------|-----------|
| Press 1 → Click WhatsApp | ~20% | 80%+ | SMS link is easier than redirect |
| Open app → Start form | ~15% | 70%+ | Welcome message immediately engaging |
| Start form → Complete form | ~5% | 80%+ | Conversational (not form), validate-as-you-go |
| Complete form → Submit | ~2% | 95%+ | Auto-submit, no extra step |
| Submit → Approved | ~70% | 70% | (Lender-driven, not our control) |
| **Overall Completion** | **~0.1%** | **40%+** | **Frictionless WhatsApp flow** |

---

## Development Phases

### Phase 3a: WhatsApp Bot Infrastructure (1 week)
- [ ] Ananta webhook receiver (inbound messages)
- [ ] Ananta message sender (outbound messages)
- [ ] Conversation state table + management
- [ ] State machine implementation
- [ ] Button/template support

### Phase 3b: Conversation Flows (2 weeks)
- [ ] Product selection flow
- [ ] Eligibility check flow
- [ ] Lender selection flow
- [ ] Application form (personal + business)
- [ ] Error handling & fallbacks

### Phase 3c: Document Collection (1 week)
- [ ] Media upload receiver
- [ ] OCR integration (AWS Textract / Google Vision)
- [ ] Compliance checking
- [ ] Document verification responses

### Phase 4: Lender Integration (Already designed)
- [ ] Formatter per lender
- [ ] Async submission + polling
- [ ] Fallback chain

### Phase 5: Status Tracking (Already designed)
- [ ] Real-time updates via WhatsApp
- [ ] Disbursal status
- [ ] EMI tracking

---

## Success Metrics for WhatsApp Bot

| KPI | Target | How to Measure |
|-----|--------|--------|
| Click rate (IVR → WhatsApp) | 80%+ | Clicks / Calls |
| Message open rate | 95%+ | Opened / Sent |
| Conversation completion | 40%+ | Submitted / Started |
| Form abandonment | <30% | Abandoned / Started |
| Document upload rate | 85%+ | All docs uploaded / Required |
| Time to complete | <10 min | Average session duration |
| Approval rate | 70%+ | Approved / Submitted |
| Customer satisfaction | 4.5/5 | Post-completion survey |

---

**This WhatsApp AI Bot approach reduces friction from 99% abandonment to ~40% completion.**

Key wins:
✅ Stay in WhatsApp (familiar, fast, low-friction)
✅ Conversational (not forms)
✅ Real-time validation (catches errors early)
✅ Guided (shows what's needed next)
✅ Transparent (status updates)
✅ Fallback chain (rejects from one lender → try next)

