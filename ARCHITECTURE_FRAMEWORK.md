# System Architecture Framework

**Purpose:** Define roles, responsibilities, and data flows before implementing Phase 3+  
**Status:** Reference Architecture (Pre-Implementation)

---

## System Components & Roles

### 1. IVR Router (automation-hub)
**Responsibility:** Voice call orchestration & lead capture  
**Role:** Lead aggregator + routing engine  

| Component | Role | Owns |
|-----------|------|------|
| OBD Routes | Outbound dialing orchestration | Campaign execution |
| Ananta Routes | WhatsApp message delivery | Bulk SMS/WhatsApp campaigns |
| Eleven Labs Routes | Voice synthesis | Personalized voice greetings |
| Pincode Gating | Eligibility pre-check | Gating rules enforcement |
| CRM Integration (Phase 1) | Lead intake sync | Voice → CRM application creation |
| Lender Routing (Phase 2) | Multi-lender eligibility | Route to best lender |

**Primary Responsibility:**
- Capture voice dispositions from OBD/Chatsense
- Push leads to CRM with full metadata
- Route applications to appropriate lenders
- Trigger follow-up campaigns (WhatsApp, callbacks)

**Does NOT own:**
- Loan application state (owned by CRM)
- Document storage (owned by CRM)
- Credit scoring algorithms (owned by bureau / internal engine)
- Lender submission APIs (owned by each lender)

---

### 2. Business Loans CRM (dsa-business-crm)
**Responsibility:** Loan application lifecycle management  
**Role:** Single source of truth for application state

| Component | Role | Owns |
|-----------|------|------|
| crm.leads | Application master table | Application metadata + status |
| crm.lead_events | Audit trail | All state changes + timestamps |
| crm.documents | Document storage metadata | Document references + upload status |
| crm.lender_submissions | Lender submission tracking | Which lender, when, status |
| crm.approvals | Approval decisions | Credit decision + terms |
| crm.billing | EMI + payment tracking | Billing state |

**Primary Responsibility:**
- Store application state (single source of truth)
- Track state transitions (lead → documents → approval → disbursal)
- Log all events for compliance
- Query application state for downstream systems

**Does NOT own:**
- Voice call management (owned by OBD)
- Document upload UI (owned by the customer portal)
- Credit decision logic (owned by bureau / internal engine)
- Payment processing (owned by payment gateway)

---

### 3. Credit Scoring Engine (External / Future)
**Responsibility:** Credit decision making  
**Role:** Risk assessment & approval probability

| Component | Role | Owns |
|-----------|------|------|
| Bureau API (CIBIL/CRIF) | Credit history | CIBIL score, delinquency history |
| Internal Risk Engine | Proprietary scoring | Approval probability per lender |
| Fraud Detection | Risk mitigation | Fraud flags + risk scores |

**Primary Responsibility:**
- Fetch and validate credit scores
- Calculate approval probability
- Flag fraud risks
- Return risk assessment to IVR Router (Phase 2)

**Does NOT own:**
- Lead intake (owned by IVR Router)
- Application state (owned by CRM)
- Lender-specific underwriting (owned by each lender)

---

### 4. Lender APIs (External / Multiple)
**Responsibility:** Loan processing per lender  
**Role:** Loan origination endpoint

| Lender | Role | Owns |
|--------|------|------|
| Poonawala Fincorp | Primary lender | Underwriting + approval |
| HDFC Bank Jumbo | Premium option | Premium underwriting |
| Hero FinCorp STPL | Alternative option | STPL-specific rules |
| Bajaj Finserv | Fallback option | Fallback underwriting |

**Primary Responsibility:**
- Accept applications from IVR Router (via CRM)
- Perform lender-specific underwriting
- Return approval/rejection decision
- Provide sanction letter

**Does NOT own:**
- Eligibility pre-filtering (owned by IVR Router Phase 2)
- Document collection (owned by IVR Router Phase 3)
- Payment processing (owned by payment gateway)

---

### 5. Document Management System (Phase 3)
**Responsibility:** Lender-specific document collection  
**Role:** Document orchestration engine

| Component | Role | Owns |
|-----------|------|------|
| Doc Requirements | Lender-specific templates | Which docs needed per lender |
| Upload Service | Document ingestion | Secure document upload + storage |
| Verification Engine | Compliance checking | OCR + document validation |

**Primary Responsibility:**
- Define lender-specific doc requirements
- Send collection requests via Ananta WhatsApp
- Verify uploaded documents
- Track document completeness per lender

**Does NOT own:**
- Application state (owned by CRM)
- Credit decisions (owned by bureau)
- Payment collection (owned by billing system)

---

### 6. Billing & Settlement System (Phase 5)
**Responsibility:** Loan billing & lender payouts  
**Role:** Financial reconciliation engine

| Component | Role | Owns |
|-----------|------|------|
| Billing Engine | EMI calculation | Monthly billing schedule |
| Payment Gateway | Payment collection | Customer payment processing |
| Settlement System | Lender payouts | P&L per lender per campaign |

**Primary Responsibility:**
- Generate monthly billing
- Collect EMI payments
- Reconcile payments vs. billing
- Calculate lender payouts

**Does NOT own:**
- Loan approval (owned by lenders)
- Document collection (owned by Phase 3)
- Application state (owned by CRM)

---

## Data Flow Architecture

### Flow 1: Lead Intake (Phase 1)

```
┌─────────────────────────────────────────────────────────────┐
│ VOICE CALL WORKFLOW                                         │
└─────────────────────────────────────────────────────────────┘

[OBD Dialer]
    │ (outbound call)
    ↓
[Customer Answers]
    │ (DTMF prompt: 1=interested, 2=agent, 3=callback)
    ↓
[Chatsense DTMF Capture]
    │ (disposition captured)
    ↓
[IVR Router: /api/crm/lead-intake-sync]
    │ POST {phone, name, age, income, disposition, callDuration, ...}
    ↓
[CRM Integration Client]
    │ ├─ Call Supabase RPC: lead_intake_sync()
    │ ├─ Create row in crm.leads
    │ ├─ Log event in crm.lead_events
    │ └─ Return application_id
    ↓
[Response to IVR Router]
    │ {success: true, applicationId: "app_12345"}
    ↓
[IVR Router Tags Application for Follow-up]
    │ ├─ Send WhatsApp callback for "callback" disposition
    │ ├─ Tag with campaign_id for analytics
    │ └─ Schedule follow-up (Phase 3)

CRM State After Phase 1:
├─ crm.leads: {phone, name, age, income, disposition, applicationId}
├─ crm.lead_events: {event_type: "voice_disposition", disposition, timestamp}
└─ Ready for Phase 2
```

**Key Points:**
- Atomicity: Application + event logged in single RPC call
- Deduplication: Phone-based upsert ensures no duplicates
- Audit Trail: Every event timestamped in crm.lead_events
- No Manual Touch: 100% automated

---

### Flow 2: Eligibility & Routing (Phase 2)

```
┌─────────────────────────────────────────────────────────────┐
│ CREDIT CHECK & MULTI-LENDER ROUTING WORKFLOW                │
└─────────────────────────────────────────────────────────────┘

[Application in CRM] (from Phase 1)
    │ (waiting for credit scores)
    ↓
[Credit Scoring Engine] (External - CIBIL/CRIF)
    │ ├─ Fetch CIBIL score
    │ ├─ Fetch Hunter score
    │ └─ Fetch delinquency history
    ↓
[IVR Router: /api/routing/check-eligibility]
    │ POST {phone, age, income, cibilScore, hunterScore, loanAmount, ...}
    ↓
[Lender Routing Client]
    │ ├─ Check against Poonawala criteria
    │ ├─ Check against HDFC criteria
    │ ├─ Check against Hero FinCorp criteria
    │ └─ Check against Bajaj criteria
    ↓
[Return Eligible Lenders]
    │ {
    │   totalEligible: 3,
    │   primaryLender: "poonawala" (best approval probability),
    │   allEligible: ["poonawala", "hdfc_jumbo", "hero_fincorp"],
    │   estimatedEmi: {poonawala: 15500, hdfc_jumbo: 14200, ...}
    │ }
    ↓
[IVR Router: /api/routing/application/:id/assign-lender]
    │ POST {lenderId: "poonawala", loanAmount: 500000}
    ↓
[CRM Lender Assignment]
    │ ├─ Update crm.leads.assigned_lender_id
    │ ├─ Update crm.leads.status = "eligibility_passed"
    │ ├─ Log event in crm.lead_events
    │ └─ Return assignment_id
    ↓
[IVR Router Tags Application for Phase 3]
    │ ├─ Mark ready for document collection
    │ └─ Store lender-specific doc requirements

CRM State After Phase 2:
├─ crm.leads: {assigned_lender_id: "poonawala", status: "eligibility_passed"}
├─ crm.lead_events: {event_type: "lender_assigned", lender_id: "poonawala"}
└─ Ready for Phase 3 (Document Collection)
```

**Key Points:**
- Routing Decision: Based on approval probability (not just eligibility)
- Fallback Chain: If Poonawala declines later, can fall back to HDFC/Hero
- No Lender Duplication: Single primary lender assigned
- Audit Trail: Routing decision logged with reasoning

---

### Flow 3: Document Collection (Phase 3)

```
┌─────────────────────────────────────────────────────────────┐
│ LENDER-SPECIFIC DOCUMENT COLLECTION WORKFLOW (PHASE 3)      │
└─────────────────────────────────────────────────────────────┘

[Application with Assigned Lender] (from Phase 2)
    │ (status = "eligibility_passed", assigned_lender_id = "poonawala")
    ↓
[IVR Router: /api/documents/get-requirements]
    │ GET /api/documents/requirements/poonawala
    │ Returns: [ITR, Bank Statement, ID Proof, Address, Employment]
    ↓
[IVR Router: /api/documents/send-collection]
    │ POST {applicationId, lenderId}
    │ Triggers Ananta interactive template
    ↓
[Ananta Template] (WhatsApp Interactive)
    │ "📄 Documents Required for Poonawala Fincorp:"
    │ "1️⃣  ITR (last 2 years)"
    │ "2️⃣  Bank Statement (last 6 months)"
    │ "3️⃣  ID Proof"
    │ "4️⃣  Address Proof"
    │ "5️⃣  Employment Letter"
    │ [Button: "Upload Documents"]
    ↓
[Customer Uploads via WhatsApp/Portal]
    │ ├─ Document file uploaded
    │ ├─ Metadata captured (doc type, upload time, file size)
    │ └─ Webhook triggers: /api/documents/uploaded
    ↓
[Document Verification Engine]
    │ ├─ OCR on document
    │ ├─ Check doc validity (not expired, valid format)
    │ ├─ Compliance check (name match, PAN match, etc.)
    │ └─ Flag if issues found
    ↓
[CRM Document Tracking]
    │ ├─ crm.documents: {applicationId, docType, uploadUrl, status}
    │ ├─ crm.lead_events: {event_type: "document_uploaded", docType}
    │ └─ Track completeness (3/5 docs received)
    ↓
[Ananta Follow-up]
    │ IF all_docs_received:
    │   └─ "✅ All documents received. Proceeding to credit review."
    │ ELSE:
    │   └─ "⏳ Waiting for: ITR, Employment Letter"
    ↓
[Status Update in CRM]
    │ When all docs received:
    │ ├─ crm.leads.status = "documents_complete"
    │ ├─ crm.leads.docs_received_date = NOW()
    │ └─ Ready for Phase 4 (Credit Submission)

CRM State After Phase 3:
├─ crm.leads: {status: "documents_complete", docs_received_date}
├─ crm.documents: [{docType, uploadUrl, verificationStatus}] (multiple rows)
├─ crm.lead_events: [{event_type: "document_uploaded", docType}] (multiple events)
└─ Ready for Phase 4 (Lender Submission)
```

**Key Points:**
- Lender-Specific: Different doc requirements per lender
- Verify as You Go: OCR + compliance check on each doc
- Track Completeness: Show customer progress (3/5 docs)
- Automated Follow-ups: Send reminders for missing docs

---

### Flow 4: Credit Decision & Lender Submission (Phase 4)

```
┌─────────────────────────────────────────────────────────────┐
│ CREDIT DECISION & LENDER SUBMISSION WORKFLOW (PHASE 4)      │
└─────────────────────────────────────────────────────────────┘

[Application with All Documents] (from Phase 3)
    │ (status = "documents_complete")
    ↓
[IVR Router: /api/lenders/submit-application]
    │ POST {applicationId, lenderId: "poonawala"}
    │ Body: Full application data (lead + docs + credit scores)
    ↓
[Lender-Specific Formatter]
    │ ├─ Format application per Poonawala API spec
    │ ├─ Map doc uploads to Poonawala's document IDs
    │ ├─ Include CIBIL score + Hunter score
    │ └─ Add custom metadata (campaign_id, batch_id)
    ↓
[Poonawala Lender API]
    │ POST https://api.poonawala.com/submit-application
    │ Response: {lender_application_id, status: "received"}
    ↓
[CRM Lender Submission Tracking]
    │ ├─ crm.lender_submissions: {
    │ │    applicationId,
    │ │    lender_id: "poonawala",
    │ │    lender_application_id: "POO_12345",
    │ │    submitted_at: NOW(),
    │ │    status: "submitted"
    │ │  }
    │ ├─ crm.leads.status = "submitted_to_lender"
    │ ├─ crm.lead_events: {event_type: "submitted_to_lender", lender_id}
    │ └─ Start polling for decision
    ↓
[Poll Lender for Decision] (every 1 hour)
    │ GET https://api.poonawala.com/application/POO_12345/status
    │ Response: {status: "in_progress" | "approved" | "rejected"}
    ↓
[Decision Received]
    │ ├─ crm.lender_submissions.status = "approved"
    │ ├─ crm.lender_submissions.decision_date = NOW()
    │ ├─ crm.lender_submissions.approved_amount = 500000
    │ ├─ crm.lender_submissions.approved_rate = 14.5
    │ ├─ crm.lender_submissions.approved_tenor = 36
    │ └─ crm.lender_submissions.sanction_letter_url = "..."
    ↓
[CRM Application Update]
    │ ├─ crm.leads.status = "loan_approved"
    │ ├─ crm.leads.approved_amount = 500000
    │ ├─ crm.leads.approved_rate = 14.5
    │ ├─ crm.leads.approved_tenor = 36
    │ ├─ crm.lead_events: {event_type: "loan_approved", decision}
    │ └─ Ready for Phase 5 (Disbursal)
    ↓
[Customer Notification]
    │ Ananta WhatsApp: "🎉 Your loan of ₹5,00,000 has been approved!"
    │ "Rate: 14.5% p.a. | Tenor: 36 months | EMI: ₹15,500"
    │ [Button: "View Sanction Letter"]

CRM State After Phase 4:
├─ crm.leads: {status: "loan_approved", approved_amount, approved_rate}
├─ crm.lender_submissions: {status: "approved", lender_application_id}
├─ crm.lead_events: [{event_type: "loan_approved", decision}]
└─ Ready for Phase 5 (Disbursal & Billing)
```

**Key Points:**
- Lender-Specific API: Different format per lender
- Async Decision: Poll lender for approval status (not real-time)
- Fallback Logic: If Poonawala rejects, retry with HDFC/Hero
- Approval Terms: Store approved amount + rate + tenor
- Customer Communication: Auto-send sanction details

---

### Flow 5: Disbursal & Billing (Phase 5)

```
┌─────────────────────────────────────────────────────────────┐
│ DISBURSAL & BILLING WORKFLOW (PHASE 5)                      │
└─────────────────────────────────────────────────────────────┘

[Approved Loan] (from Phase 4)
    │ (status = "loan_approved", approved_amount, approved_rate)
    ↓
[IVR Router: /api/disbursals/initiate]
    │ POST {applicationId, bankAccount}
    │ Triggers disbursal to customer bank account
    ↓
[Payment Gateway]
    │ ├─ Validate bank account
    │ ├─ Initiate NEFT/IMPS transfer
    │ └─ Return transaction_id
    ↓
[CRM Disbursal Tracking]
    │ ├─ crm.leads.status = "disbursal_initiated"
    │ ├─ crm.lead_events: {event_type: "disbursal_initiated", transaction_id}
    │ └─ Poll for confirmation
    ↓
[Disbursal Confirmed]
    │ ├─ crm.leads.status = "loan_disbursed"
    │ ├─ crm.leads.disbursal_date = NOW()
    │ ├─ crm.leads.disbursal_amount = 500000
    │ ├─ crm.lead_events: {event_type: "loan_disbursed", amount}
    │ └─ Generate billing schedule
    ↓
[Billing Engine]
    │ ├─ Calculate EMI: ₹15,500 (500K @ 14.5% for 36 months)
    │ ├─ Generate billing schedule (36 months, start date +30 days)
    │ └─ Create crm.billing rows (one per month)
    ↓
[Monthly Billing Cycle]
    │ ├─ Day 1-10: Customer receives bill (WhatsApp + SMS)
    │ ├─ Day 11-25: Collection attempts
    │ ├─ Day 26-30: Late payment follow-up
    │ └─ Day 31: Payment reconciliation
    ↓
[Payment Collection]
    │ ├─ Customer pays via auto-debit / manual payment
    │ ├─ Payment gateway confirms payment
    │ ├─ crm.billing.payment_date = NOW()
    │ ├─ crm.billing.payment_status = "received"
    │ └─ crm.lead_events: {event_type: "payment_received", amount}
    ↓
[Lender Settlement]
    │ Once per month:
    │ ├─ Aggregate all payments for lender
    │ ├─ Deduct processing fees + insurance
    │ ├─ Calculate lender's share
    │ └─ Initiate payout to lender bank account
    ↓
[P&L Tracking]
    │ ├─ Revenue: Interest collected per month
    │ ├─ Cost: Processing fees + insurance + overheads
    │ ├─ Profit: Revenue - Cost
    │ └─ Per campaign, per lender, per month

CRM State During & After Phase 5:
├─ crm.leads: {status: "loan_disbursed", disbursal_date}
├─ crm.billing: [{month, billing_amount, payment_amount, payment_date}]
├─ crm.lead_events: [{event_type: "payment_received|late_payment|default"}]
└─ P&L reports per campaign + lender
```

**Key Points:**
- Auto Disbursal: No manual approval needed
- Monthly Billing: EMI calculated, scheduled, and tracked
- Payment Collection: Via auto-debit / manual payment links
- Lender Settlement: Automated monthly payout
- P&L Tracking: Revenue, cost, profit per campaign/lender

---

## Role Boundaries & Ownership

### Clear Handoffs

| From | To | Data | Responsibility |
|------|----|----|---|
| IVR Router | CRM | Application metadata | IVR captures, CRM stores |
| CRM | Lender API | Full application | CRM formats, Lender decides |
| Lender API | CRM | Approval decision | Lender decides, CRM logs |
| CRM | Billing Engine | Approved terms | CRM retrieves, Billing calculates |
| Payment Gateway | CRM | Payment confirmation | Gateway processes, CRM logs |
| CRM | Reports | Application history | CRM data, Reports consume |

### Data Ownership

| Table | Owned By | Read By | Write By |
|-------|----------|---------|----------|
| crm.leads | CRM | IVR Router, Reports, Billing | CRM (RPC), Phase 2 updates |
| crm.lead_events | CRM | Audit logs, Compliance | CRM (RPC), All phases append |
| crm.documents | CRM | Lender API, Phase 4 submission | Phase 3 (document service) |
| crm.lender_submissions | CRM | Polling service, Reports | Phase 4 (lender API) |
| routing_logs | IVR Router | Analytics | Phase 2 (routing engine) |

---

## Integration Patterns

### Synchronous (Real-Time)

```
IVR Router → CRM
├─ POST /api/crm/lead-intake-sync (Phase 1)
│  └─ Response: {applicationId} (immediately)
├─ POST /api/routing/check-eligibility (Phase 2)
│  └─ Response: {primaryLender, estimatedEmi} (immediately)
└─ POST /api/documents/upload (Phase 3)
   └─ Response: {uploadStatus} (immediately)
```

**Use:** When immediate response needed for UX or logic flow

---

### Asynchronous (Event-Driven)

```
Lender API → CRM
├─ Poll: GET /api/lenders/application/{id}/status (Phase 4)
│  └─ Every 1 hour until decision received
├─ Webhook: POST /webhooks/lender-decision (Phase 4)
│  └─ When lender decision ready (optional, if lender supports)
└─ Batch: Settlement report email (Phase 5)
   └─ Once per month
```

**Use:** When response not immediately needed or long-running

---

### Batch Processing

```
Campaign Processing
├─ Phase 1: 50K leads ingested daily (batch)
├─ Phase 2: 50K eligibility checks (batch) ✓ Already supported
├─ Phase 3: 30K doc collection started (async)
├─ Phase 4: 10K-20K submitted to lenders (batch)
└─ Phase 5: 5K-10K payments collected daily (batch)
```

**Use:** When processing large volumes (campaigns, migrations)

---

## Error Handling & Resilience

### Failure Scenarios by Phase

#### Phase 1 Failures
```
Lead Intake Fails → Application NOT created
├─ Retry RPC call (exponential backoff)
├─ Log error to crm.lead_events
└─ Alert ops team (manual recovery)
```

#### Phase 2 Failures
```
Eligibility Check Fails → Revert to manual routing
├─ Retry eligibility check (API timeout)
├─ If persistent, mark as "manual_review"
└─ Alert ops team for manual decision
```

#### Phase 4 Failures
```
Lender Submission Fails → Fallback to next lender
├─ If Poonawala API down → Try HDFC
├─ If all lenders fail → Mark as "pending_lender_submission"
└─ Retry once per hour (max 5 attempts)
```

#### Phase 5 Failures
```
Disbursal Fails → Application stuck in "disbursal_initiated"
├─ Retry disbursal (no retry limit)
├─ Customer receives notification of delay
└─ Alert ops team after 24 hours
```

---

## Data Consistency & Atomicity

### Atomic Operations (Transactional)

```
Phase 1: Lead Intake
├─ RPC lead_intake_sync() ensures:
│  ├─ crm.leads INSERT OR UPDATE
│  ├─ crm.lead_events INSERT (audit)
│  └─ Both succeed together or both fail (no partial state)
```

### Eventually Consistent (Event-Driven)

```
Phase 4: Lender Decision
├─ Lender API returns approval
├─ CRM logs event (eventually)
├─ Reports eventual consistency (some lag acceptable)
└─ OK for reports, NOT OK for loan processing
```

---

## Phase 3-6 Implementation Order

### Phase 3: Document Collection
**Depends On:** Phase 1 (has applicationId)  
**Interfaces:**
- Reads: crm.leads (to get assigned_lender_id)
- Writes: crm.documents, crm.lead_events
- External: Ananta (template delivery)

### Phase 4: Credit Submission & Approval
**Depends On:** Phase 2 (has assigned_lender_id) + Phase 3 (has documents)  
**Interfaces:**
- Reads: crm.documents, crm.leads
- Writes: crm.lender_submissions, crm.lead_events
- External: Lender APIs (submit + poll)

### Phase 5: Disbursal & Billing
**Depends On:** Phase 4 (has approval + approved_amount)  
**Interfaces:**
- Reads: crm.lender_submissions (approved terms)
- Writes: crm.billing, crm.lead_events
- External: Payment gateway (disbursal + collection)

### Phase 6: Dashboard & Analytics
**Depends On:** Phase 1-5 (has all data in crm.*)  
**Interfaces:**
- Reads: crm.leads, crm.lead_events, crm.billing, routing_logs
- Writes: None (read-only)
- External: BI tool / dashboard

---

## Technology Stack

| Layer | Component | Tech | Responsibility |
|-------|-----------|------|---|
| API | IVR Router | Express.js + Node.js | Route orchestration |
| API | CRM | Supabase (PostgreSQL) | Data storage + RPC |
| Message Queue | Webhooks | Express webhooks | Event handling |
| External APIs | OBD/Chatsense (voice + DTMF), Ananta (WhatsApp) | REST APIs | Voice + messaging |
| External APIs | Lenders | REST APIs | Loan processing |
| External APIs | Bureau | REST APIs | Credit scores |
| Database | CRM | PostgreSQL (Supabase) | Single source of truth |
| Cache | Routing | In-memory (can add Redis) | Lender config |
| Monitoring | Logging | Console + Supabase audit | Audit trail |

---

## Security & Compliance

### Data Protection
- **PII:** Phone, name, email, address → Encrypted at rest in Supabase
- **Financial:** CIBIL score, approved amount → Encrypted in transit
- **Audit Trail:** All events logged immutably in crm.lead_events

### Compliance
- **KYC:** Verified during Phase 1 (name, address, PAN)
- **Consent:** Capture consent for DTMF (voice call)
- **Audit Trail:** Immutable event log for RBI compliance
- **Data Retention:** Delete personal data after 7 years (per RBI guidelines)

---

## Monitoring & Observability

### Key Metrics by Phase

**Phase 1:** Voice → CRM
```sql
SELECT 
  COUNT(*) as leads_created,
  COUNT(CASE WHEN disposition = 'interested' THEN 1 END) as interested,
  COUNT(CASE WHEN disposition = 'callback' THEN 1 END) as callback,
  ROUND(AVG(EXTRACT(EPOCH FROM updated_at - created_at)), 2) as avg_latency_sec
FROM crm.leads
WHERE created_at > NOW() - INTERVAL '24 hours';
```

**Phase 2:** Eligibility
```sql
SELECT 
  routed_lender_id,
  COUNT(*) as count,
  ROUND(100 * COUNT(*) / SUM(COUNT(*)) OVER (), 2) as percent
FROM routing_logs
WHERE logged_at > NOW() - INTERVAL '24 hours'
GROUP BY routed_lender_id;
```

**Phase 4:** Lender Approval Rate
```sql
SELECT 
  lender_id,
  COUNT(*) as submitted,
  COUNT(CASE WHEN status = 'approved' THEN 1 END) as approved,
  ROUND(100 * COUNT(CASE WHEN status = 'approved' THEN 1 END) / COUNT(*), 2) as approval_rate
FROM crm.lender_submissions
WHERE submitted_at > NOW() - INTERVAL '7 days'
GROUP BY lender_id;
```

**Phase 5:** Collection Rate
```sql
SELECT 
  DATE(billing_date) as date,
  COUNT(*) as emis_due,
  COUNT(CASE WHEN payment_status = 'received' THEN 1 END) as paid,
  ROUND(100 * COUNT(CASE WHEN payment_status = 'received' THEN 1 END) / COUNT(*), 2) as collection_rate
FROM crm.billing
WHERE billing_date > NOW() - INTERVAL '30 days'
GROUP BY DATE(billing_date);
```

---

## Summary: Architectural Principles

1. **Single Source of Truth:** CRM owns all application state
2. **Clear Responsibilities:** Each system owns what it creates
3. **Atomic Transactions:** Phase 1 uses RPC for consistency
4. **Audit Trail:** Every change logged immutably
5. **Error Resilience:** Fallback chains + retry logic
6. **Performance:** Sub-second Phase 1 + Phase 2, async Phase 4-5
7. **Security:** PII encrypted, consent captured, audit trail maintained
8. **Scalability:** Batch endpoints for 50K+ leads/day
9. **Compliance:** KYC + audit trail for RBI
10. **Observability:** SQL queries for all key metrics

This architecture enables **50,000 applications/day with zero manual touchpoints and 100% compliance visibility**.

---

**Next Steps:**
1. Review & approve architecture
2. Define Phase 3 document collection design
3. Define Phase 4 lender submission design
4. Implement Phase 3 following this framework

