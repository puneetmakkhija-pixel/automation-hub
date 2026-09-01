# Phase 2: Lender Routing & Multi-Lender Eligibility Guide

**Status:** Implementation Complete  
**Objective:** Multi-lender eligibility checking and intelligent routing to best lender  
**Output:** Application routed to 1 of 4 lenders within 2 minutes of credit check completion

---

## Overview

Phase 2 integrates multiple lender eligibility engines and routes applications to the best lender based on:
- Applicant creditworthiness (age, income, CIBIL score, Hunter score)
- Loan amount & tenor requirements
- Lender-specific eligibility criteria
- Approval probability (calibrated per lender)
- Interest rate competitiveness
- EMI affordability

### Supported Lenders

1. **Poonawala Fincorp** (Primary)
   - Loan: ₹1L - ₹25L
   - Rate: 12-18% p.a.
   - Approval: 75% probability
   - Min CIBIL: 720, Min Income: ₹3L

2. **HDFC Bank Jumbo Loan** (Premium)
   - Loan: ₹5L - ₹50L
   - Rate: 10-15% p.a.
   - Approval: 65% probability
   - Min CIBIL: 750, Min Income: ₹5L

3. **Hero FinCorp STPL** (Alternative)
   - Loan: ₹50K - ₹20L
   - Rate: 13-20% p.a.
   - Approval: 80% probability
   - Min CIBIL: 700, Min Income: ₹2.5L

4. **Bajaj Finserv** (Fallback)
   - Loan: ₹1L - ₹30L
   - Rate: 11-17% p.a.
   - Approval: 70% probability
   - Min CIBIL: 730, Min Income: ₹3.5L

---

## Setup Requirements

### Environment Variables

No new environment variables needed (uses existing SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).

### Supabase Tables

#### 1. routing_logs (Audit Trail)

```sql
CREATE TABLE IF NOT EXISTS routing_logs (
  id BIGSERIAL PRIMARY KEY,
  phone VARCHAR(20),
  routed_lender_id VARCHAR(50),
  status VARCHAR(50), -- routed, no_eligible_lenders, error
  logged_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX routing_logs_phone_idx ON routing_logs(phone);
CREATE INDEX routing_logs_lender_idx ON routing_logs(routed_lender_id);
CREATE INDEX routing_logs_status_idx ON routing_logs(status);
```

#### 2. lender_rates (Optional - for dynamic rate management)

```sql
CREATE TABLE IF NOT EXISTS lender_rates (
  id BIGSERIAL PRIMARY KEY,
  lender_id VARCHAR(50),
  min_cibil INT,
  min_income BIGINT,
  min_loan_amount BIGINT,
  max_loan_amount BIGINT,
  rate_min DECIMAL(5,2),
  rate_max DECIMAL(5,2),
  processing_fee DECIMAL(5,4),
  approval_probability DECIMAL(3,2),
  active BOOLEAN DEFAULT true,
  effective_from DATE,
  effective_to DATE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX lender_rates_lender_idx ON lender_rates(lender_id);
CREATE INDEX lender_rates_active_idx ON lender_rates(active);
```

---

## API Endpoints

### 1. List Active Lenders

```
GET /api/routing/lenders
```

**Response:**
```json
{
  "success": true,
  "totalLenders": 4,
  "lenders": [
    {
      "lenderId": "poonawala",
      "name": "Poonawala Fincorp",
      "minLoanAmount": 100000,
      "maxLoanAmount": 2500000,
      "interestRateMin": 12,
      "interestRateMax": 18,
      "approvalProbability": 75
    },
    {
      "lenderId": "hdfc_jumbo",
      "name": "HDFC Bank - Jumbo Loan",
      "minLoanAmount": 500000,
      "maxLoanAmount": 5000000,
      "interestRateMin": 10,
      "interestRateMax": 15,
      "approvalProbability": 65
    }
  ]
}
```

---

### 2. Get Lender Details

```
GET /api/routing/lenders/{lenderId}
```

**Example:**
```
GET /api/routing/lenders/poonawala
```

**Response:**
```json
{
  "success": true,
  "lenderId": "poonawala",
  "lender": {
    "name": "Poonawala Fincorp",
    "minAge": 24,
    "maxAge": 55,
    "minIncome": 300000,
    "minCibil": 720,
    "minHunterScore": 850,
    "minLoanAmount": 100000,
    "maxLoanAmount": 2500000,
    "tenor": [12, 24, 36, 48, 60],
    "interestRateMin": 12,
    "interestRateMax": 18,
    "processingFeePercent": 1,
    "approvalProbability": 75
  }
}
```

---

### 3. Check Multi-Lender Eligibility (Core Endpoint)

**Phase 2 CORE ENDPOINT**

```
POST /api/routing/check-eligibility
```

**Request:**
```json
{
  "phone": "919876543210",
  "age": 32,
  "income": 500000,
  "cibilScore": 750,
  "hunterScore": 880,
  "pincode": "400001",
  "loanAmount": 500000,
  "loanTenor": 36,
  "liveLoans": 1,
  "enquiriesCount": 0,
  "currentOverdue": false,
  "dpdData": {
    "dpdLatest6m": 0,
    "dpdLatest12m": 0
  }
}
```

**Response (Success - Multiple Eligible Lenders):**
```json
{
  "success": true,
  "phone": "919876543210",
  "totalEligible": 3,
  "pincodeValid": true,
  "primaryLender": {
    "lenderId": "poonawala",
    "lenderName": "Poonawala Fincorp",
    "eligible": true,
    "approvalProbability": 0.75,
    "interestRateMin": 12,
    "interestRateMax": 18,
    "estimatedEmi": 15500,
    "processingFee": 5000
  },
  "allEligibleLenders": [
    {
      "lenderId": "poonawala",
      "lenderName": "Poonawala Fincorp",
      "approvalProbability": 0.75,
      "interestRateMin": 12,
      "interestRateMax": 18,
      "estimatedEmi": 15500,
      "processingFee": 5000
    },
    {
      "lenderId": "hdfc_jumbo",
      "lenderName": "HDFC Bank - Jumbo Loan",
      "approvalProbability": 0.65,
      "interestRateMin": 10,
      "interestRateMax": 15,
      "estimatedEmi": 14200,
      "processingFee": 7500
    },
    {
      "lenderId": "hero_fincorp_stpl",
      "lenderName": "Hero FinCorp - STPL",
      "approvalProbability": 0.80,
      "interestRateMin": 13,
      "interestRateMax": 20,
      "estimatedEmi": 15800,
      "processingFee": 6000
    }
  ],
  "loanAmount": 500000,
  "loanTenor": 36
}
```

**Response (Failure - No Eligible Lenders):**
```json
{
  "success": false,
  "phone": "919876543210",
  "error": "No eligible lenders found",
  "totalEligible": 0,
  "pincodeValid": false,
  "primaryLender": null
}
```

---

### 4. Assign Lender to Application

```
POST /api/routing/application/{applicationId}/assign-lender
```

**Request:**
```json
{
  "lenderId": "poonawala",
  "loanAmount": 500000,
  "loanTenor": 36
}
```

**Response:**
```json
{
  "success": true,
  "applicationId": "app_12345",
  "lenderId": "poonawala",
  "lenderName": "Poonawala Fincorp",
  "loanAmount": 500000,
  "loanTenor": 36,
  "assignedAt": "2024-10-01T10:30:00Z",
  "nextStep": "document_collection",
  "message": "Application ready for Poonawala Fincorp submission"
}
```

---

### 5. Batch Eligibility Check

```
POST /api/routing/batch-eligibility-check
```

Used for bulk eligibility checking during campaign processing (50K+/day).

**Request:**
```json
{
  "applications": [
    {
      "phone": "919876543210",
      "age": 32,
      "income": 500000,
      "cibilScore": 750,
      "hunterScore": 880,
      "loanAmount": 500000,
      "loanTenor": 36
    },
    {
      "phone": "919876543211",
      "age": 28,
      "income": 350000,
      "cibilScore": 710,
      "hunterScore": 800,
      "loanAmount": 300000,
      "loanTenor": 24
    }
  ]
}
```

**Response:**
```json
{
  "success": true,
  "totalApplications": 2,
  "successCount": 2,
  "failureCount": 0,
  "results": [
    {
      "phone": "919876543210",
      "success": true,
      "totalEligible": 3,
      "primaryLender": {
        "lenderId": "poonawala",
        "lenderName": "Poonawala Fincorp",
        "approvalProbability": 0.75
      }
    },
    {
      "phone": "919876543211",
      "success": true,
      "totalEligible": 2,
      "primaryLender": {
        "lenderId": "hero_fincorp_stpl",
        "lenderName": "Hero FinCorp - STPL",
        "approvalProbability": 0.80
      }
    }
  ]
}
```

---

## Integration Flow

### Sequence: Phase 1 → Phase 2

1. **Phase 1: Voice Call + Lead Intake**
   - OBD call completes → Chatsense DTMF capture
   - `POST /api/crm/lead-intake-sync` → Application created in CRM

2. **Phase 2a: Credit Score Fetch** (External - CIBIL/Hunter API)
   - Fetch CIBIL score from bureau
   - Fetch Hunter score (decision engine score)

3. **Phase 2b: Multi-Lender Eligibility Check**
   - `POST /api/routing/check-eligibility` with credit scores
   - Returns eligible lenders sorted by approval probability
   - Selects primary lender for routing

4. **Phase 2c: Lender Assignment**
   - `POST /api/routing/application/:id/assign-lender`
   - Application tagged with assigned lender
   - Status updated to "eligibility_passed"

5. **Phase 3+: Document Collection**
   - Ananta sends the lender-specific doc collection template
   - Application advances to "documents_pending"

---

## Curl Examples

### Check Eligibility for Single Applicant

```bash
curl -X POST http://localhost:3000/api/routing/check-eligibility \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "919876543210",
    "age": 32,
    "income": 500000,
    "cibilScore": 750,
    "hunterScore": 880,
    "pincode": "400001",
    "loanAmount": 500000,
    "loanTenor": 36,
    "liveLoans": 1,
    "enquiriesCount": 0,
    "currentOverdue": false
  }'
```

### List Active Lenders

```bash
curl http://localhost:3000/api/routing/lenders
```

### Get Lender Details

```bash
curl http://localhost:3000/api/routing/lenders/poonawala
```

### Assign Lender to Application

```bash
curl -X POST http://localhost:3000/api/routing/application/app_12345/assign-lender \
  -H "Content-Type: application/json" \
  -d '{
    "lenderId": "poonawala",
    "loanAmount": 500000,
    "loanTenor": 36
  }'
```

### Batch Eligibility Check (50K+ applicants)

```bash
curl -X POST http://localhost:3000/api/routing/batch-eligibility-check \
  -H "Content-Type: application/json" \
  -d '{
    "applications": [
      {
        "phone": "919876543210",
        "age": 32,
        "income": 500000,
        "cibilScore": 750,
        "hunterScore": 880,
        "loanAmount": 500000,
        "loanTenor": 36
      },
      {
        "phone": "919876543211",
        "age": 28,
        "income": 350000,
        "cibilScore": 710,
        "hunterScore": 800,
        "loanAmount": 300000,
        "loanTenor": 24
      }
    ]
  }'
```

---

## Testing & Validation

### Health Check

```bash
curl http://localhost:3000/api/routing/health
# Response: { "success": true, "status": "connected", "activeLenders": 4 }
```

### Test Cases

#### Test 1: High Credit - Multiple Eligible Lenders
```bash
# Expected: 3-4 eligible lenders, Poonawala as primary
CIBIL: 780, Income: ₹8L, Age: 35, Loan: ₹50L
```

#### Test 2: Mid Credit - Limited Options
```bash
# Expected: 2 eligible lenders, Hero as primary
CIBIL: 710, Income: ₹3.5L, Age: 30, Loan: ₹3L
```

#### Test 3: Low Credit - Single Option or Rejected
```bash
# Expected: No eligible lenders
CIBIL: 650, Income: ₹2L, Age: 28, Loan: ₹2L
```

#### Test 4: Out of Age Range
```bash
# Expected: No eligible lenders
CIBIL: 750, Income: ₹5L, Age: 62, Loan: ₹50L
```

---

## Monitoring SQL Queries

### Check Routing Logs

```sql
SELECT 
  phone,
  routed_lender_id,
  status,
  COUNT(*) as count
FROM routing_logs
WHERE logged_at > NOW() - INTERVAL '24 hours'
GROUP BY phone, routed_lender_id, status
ORDER BY logged_at DESC;
```

### Lender Distribution

```sql
SELECT 
  routed_lender_id,
  COUNT(*) as routed_applications,
  ROUND(100 * COUNT(*) / SUM(COUNT(*)) OVER (), 2) as percentage
FROM routing_logs
WHERE logged_at > NOW() - INTERVAL '24 hours'
  AND status = 'routed'
GROUP BY routed_lender_id
ORDER BY routed_applications DESC;
```

### Applications with No Eligible Lenders

```sql
SELECT 
  phone,
  COUNT(*) as attempts,
  MAX(logged_at) as last_attempt
FROM routing_logs
WHERE status = 'no_eligible_lenders'
  AND logged_at > NOW() - INTERVAL '24 hours'
GROUP BY phone
ORDER BY attempts DESC
LIMIT 100;
```

---

## Success Criteria

✅ **Phase 2 Complete when:**
1. All 4 lenders properly configured with correct eligibility rules
2. Eligibility engine returns correct lender matches for test cases
3. EMI calculation accurate within ±₹100
4. Batch processing handles 50K+ applications/day
5. Routing logs captured for audit trail
6. <100ms response time for single eligibility check
7. <5s for batch check of 1000 applications

---

## What's Next (Phase 3)

- Document collection via Ananta templates
- Lender-specific doc requirements mapping
- Document upload & verification workflow
- OCR + compliance checking

---

## Support

File issues or enhancements in the CRM project.

---

**Last Updated:** 2024-10-01  
**Next Review:** Phase 2 Testing & Lender Integration  
**Owner:** Automation Hub Team
