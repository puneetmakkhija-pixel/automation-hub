# Poonawala Fincorp STPL Gating & Eligibility Engine

Complete guide to implement Poonawala Fincorp STPL lending gating criteria using pincode-based eligibility checks.

## 1. Overview

Poonawala Fincorp has defined strict gating criteria for their STPL (Secured Personal Loan) product. This system validates customer eligibility based on:
- **160+ serviceable pincodes**
- **CIBIL parameters** (age, income, credit score)
- **Hard reject conditions** (automatic disqualifiers)
- **Soft reject conditions** (score-negative factors)
- **Credit-impacted variables** (binning-based scoring adjustments)

## 2. Database Schema

### Create Serviceable Pincodes Table

```sql
CREATE TABLE IF NOT EXISTS serviceable_pincodes (
  id BIGSERIAL PRIMARY KEY,
  pincode TEXT NOT NULL,
  lender_type TEXT NOT NULL, -- 'poonawala', 'herofincorp', etc.
  state TEXT,
  city TEXT,
  region TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE UNIQUE INDEX ON serviceable_pincodes(pincode, lender_type);
CREATE INDEX ON serviceable_pincodes(lender_type);
CREATE INDEX ON serviceable_pincodes(state);
```

### Create Gating Logs Table

```sql
CREATE TABLE IF NOT EXISTS gating_logs (
  id BIGSERIAL PRIMARY KEY,
  phone TEXT NOT NULL,
  lender_type TEXT NOT NULL,
  eligible BOOLEAN DEFAULT false,
  checks_passed JSONB DEFAULT '{}',
  hard_rejects TEXT[] DEFAULT '{}',
  soft_rejects TEXT[] DEFAULT '{}',
  logged_at TIMESTAMP DEFAULT NOW(),
  FOREIGN KEY (lender_type) REFERENCES lenders(type)
);

CREATE INDEX ON gating_logs(phone);
CREATE INDEX ON gating_logs(lender_type);
CREATE INDEX ON gating_logs(logged_at);
```

### Create Lenders Table

```sql
CREATE TABLE IF NOT EXISTS lenders (
  type TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  pincode_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

INSERT INTO lenders (type, name, description, pincode_count) 
VALUES ('poonawala', 'Poonawala Fincorp', 'STPL - Secured Personal Loan', 160);
```

## 3. CIBIL Parameters (Hard Requirements)

### Age Requirement
- **Valid Range:** 24-55 years
- **Action:** Reject if outside range
- **Weight:** Hard reject

### Income Requirement
- **Minimum:** ₹3,00,000 annual household income
- **Action:** Reject if below minimum
- **Weight:** Hard reject

### Location (Pincode)
- **Requirement:** Current address pincode must be in serviceable pincode list
- **Count:** 160+ pincodes
- **Action:** Validate against database before proceeding
- **Weight:** Hard reject

### CIBIL Credit Score
- **Floor:** 720 (remove < 720)
- **Action:** Reject if below 720
- **Weight:** Hard reject

### Hunter Score
- **Floor:** 850 (remove < 850)
- **Action:** Reject if below 850
- **Weight:** Hard reject

## 4. Hard Reject Conditions (Automatic Disqualifiers)

These conditions automatically reject the customer from consideration:

### DPD (Days Past Due)
- **Condition 1:** 0+ DPD in Latest 6 Months → **REMOVE**
- **Condition 2:** Bureau: 30+ DPD in Latest 12 Months → **REMOVE**
- **Severity:** Auto-reject

### Bureau Vintage
- **Condition:** Bureau vintage < 12 Months → **REMOVE**
- **Severity:** Auto-reject

### Derogatory Flags
- **Conditions to REMOVE:**
  - Write-off in last 36 months
  - Settled in last 36 months
  - Restructured in last 36 months
  - Suit filed in last 36 months
  - Willful default in last 36 months
- **Severity:** Auto-reject

### Current Overdue
- **Condition:** Any current overdue on a tradeline
- **Severity:** Auto-reject (not allowed)

### Customer Leverage
- **Condition:** >3 Live Unsecured Loans with loan amount > ₹1,00,000
- **Severity:** Auto-reject

### Credit Hungry Check
- **Condition:** Number of unsecured enquiries in last 1 day >= 3
- **Severity:** Auto-reject

### MFI Status
- **Condition:** Active OR Closed MFI tradeline in last 36 months
- **Severity:** Auto-reject

### Identity Check
- **Requirements:**
  - Customer's mobile number must be available in bureau
  - Customer's PAN must be available in bureau
  - Dual PAN **NOT allowed**
- **Severity:** Auto-reject if any condition fails

## 5. Soft Reject Conditions (Credit-Impacted, Score-Negative)

These conditions do NOT automatically reject but negatively impact the credit score:

### Bureau Vintage (Soft Impact)
- **Condition:** Bureau Vintage <= 24 months
- **Impact:** Negative score adjustment
- **Severity:** Soft reject (not hard)

### Enquiry Ratio (Soft Impact)
- **Formula:** Enquiries in last 3 months ÷ Lifetime enquiries
- **Threshold:** >= 60%
- **Impact:** Negative score adjustment
- **Severity:** Soft reject

### Unsecured Loan Ratio (Soft Impact)
- **Formula:** Total unsecured loans opened ÷ Total unsecured enquiries
- **Threshold:** <= 10%
- **Impact:** Negative score adjustment
- **Severity:** Soft reject

## 6. Credit-Impacted Variables - Binning

Score adjustments based on binned variables (Credit Card Users vs Non-Credit Card):

### For Credit Card Users

**Variable 1:** Max DPD in last 9 months
- Binning: No DPD | <10 | >=10

**Variable 2:** PL Enquiries (3m) ÷ All PL Enquiries
- Binning: <20% | 20-50% | >=50%

**Variable 3:** Unsecured loans ÷ Unsecured enquiries
- Binning: <30% | 30-100% | >=100%

### For Non-Credit Card Users

**Variable 1:** Max DPD in last 12 months
- Binning: <2 | >=2

**Variable 2:** All Enquiries (3m) ÷ All Enquiries
- Binning: <30% | >30%

## 7. Eligibility Check Workflow

```
START
  ↓
[Check Pincode] → Not serviceable? → REJECT
  ↓ OK
[Check Age] → Outside 24-55? → REJECT
  ↓ OK
[Check Income] → < ₹3 Lac? → REJECT
  ↓ OK
[Check CIBIL Score] → < 720? → REJECT
  ↓ OK
[Check Hunter Score] → < 850? → REJECT
  ↓ OK
[Check Hard Rejects] → Any found? → REJECT (log reason)
  ↓ No
[Check Soft Rejects] → Any found? → Flag (continue with reduced score)
  ↓
[Check Identity] → Mobile/PAN missing or Dual PAN? → REJECT
  ↓ OK
ELIGIBLE → APPROVE
```

## 8. API Endpoints

### Health Check
```bash
GET /api/gating/health
```

Response:
```json
{
  "success": true,
  "status": "connected",
  "message": "Pincode gating database connected"
}
```

### Validate Single Pincode
```bash
POST /api/gating/validate
Content-Type: application/json

{
  "pincode": "400001",
  "lenderType": "poonawala"
}
```

Response:
```json
{
  "success": true,
  "valid": true,
  "data": {
    "pincode": "400001",
    "lender_type": "poonawala",
    "state": "Maharashtra",
    "city": "Mumbai"
  }
}
```

### Check Full Eligibility
```bash
POST /api/gating/check-eligibility
Content-Type: application/json

{
  "lenderType": "poonawala",
  "customerData": {
    "phone": "919876543210",
    "pincode": "400001",
    "age": 32,
    "income": 500000,
    "cibilScore": 750,
    "hunterScore": 880,
    "dpdData": {
      "dpdLatest6m": 0,
      "dpdLatest12m": 5
    },
    "bureauVintage": 36,
    "derogFlags": [],
    "currentOverdue": false,
    "liveLoans": 2,
    "enquiriesCount": 1,
    "mfiStatus": "none",
    "mobileInBureau": true,
    "panInBureau": true,
    "dualPan": false
  }
}
```

Response:
```json
{
  "success": true,
  "eligible": true,
  "eligibility": {
    "pincode": true,
    "age": true,
    "income": true,
    "cibilScore": true,
    "hunterScore": true,
    "hardRejects": [],
    "softRejects": [],
    "eligible": true
  }
}
```

### Bulk Upload Pincodes
```bash
POST /api/gating/bulk-upload-pincodes
Content-Type: application/json

{
  "lenderType": "poonawala",
  "pincodes": [
    "400001",
    "400002",
    "400003",
    "400004",
    "400005"
  ]
}
```

Response:
```json
{
  "success": true,
  "count": 5,
  "message": "5 pincodes uploaded for poonawala"
}
```

### Get Pincode Statistics
```bash
GET /api/gating/stats?lenderType=poonawala
```

Response:
```json
{
  "success": true,
  "lenderType": "poonawala",
  "count": 160
}
```

### List All Serviceable Pincodes (Paginated)
```bash
GET /api/gating/pincodes?lenderType=poonawala&limit=50&offset=0
```

Response:
```json
{
  "success": true,
  "lenderType": "poonawala",
  "pincodes": [
    {
      "pincode": "400001",
      "lender_type": "poonawala",
      "state": "Maharashtra",
      "city": "Mumbai"
    }
  ],
  "limit": 50,
  "offset": 0,
  "count": 50
}
```

### Search Specific Pincode
```bash
POST /api/gating/search-pincode
Content-Type: application/json

{
  "pincode": "400001",
  "lenderType": "poonawala"
}
```

Response:
```json
{
  "success": true,
  "pincode": "400001",
  "found": true,
  "data": [
    {
      "pincode": "400001",
      "lender_type": "poonawala",
      "state": "Maharashtra",
      "city": "Mumbai"
    }
  ]
}
```

## 9. Eligibility Check Examples

### Example 1: Eligible Customer
```javascript
const customerData = {
  phone: "919876543210",
  pincode: "400001",        // ✓ Serviceable
  age: 32,                  // ✓ In range 24-55
  income: 500000,           // ✓ > 3 lac
  cibilScore: 750,          // ✓ >= 720
  hunterScore: 880,         // ✓ >= 850
  dpdData: {
    dpdLatest6m: 0,         // ✓ No DPD
    dpdLatest12m: 0
  },
  bureauVintage: 36,        // ✓ >= 12 months
  derogFlags: [],           // ✓ None
  currentOverdue: false,    // ✓ None
  liveLoans: 2,             // ✓ <= 3 loans
  enquiriesCount: 1,        // ✓ < 3 in last day
  mfiStatus: "none",        // ✓ No MFI
  mobileInBureau: true,     // ✓ Available
  panInBureau: true,        // ✓ Available
  dualPan: false            // ✓ Single PAN
};

// Result: ELIGIBLE
```

### Example 2: Rejected Due to Pincode
```javascript
const customerData = {
  phone: "919876543211",
  pincode: "999999",        // ✗ NOT serviceable
  age: 28,
  income: 400000,
  cibilScore: 750,
  hunterScore: 880
  // ... other fields
};

// Result: REJECTED - Pincode not in serviceable list
```

### Example 3: Rejected Due to DPD
```javascript
const customerData = {
  phone: "919876543212",
  pincode: "400001",        // ✓ Serviceable
  age: 32,
  income: 500000,
  cibilScore: 750,
  hunterScore: 880,
  dpdData: {
    dpdLatest6m: 5,         // ✗ Has DPD in last 6 months
    dpdLatest12m: 20
  }
  // ... other fields
};

// Result: REJECTED - 0+ DPD in Latest 6 Months
```

### Example 4: Soft Rejects (Score-Negative)
```javascript
const customerData = {
  phone: "919876543213",
  pincode: "400001",
  age: 32,
  income: 500000,
  cibilScore: 750,
  hunterScore: 880,
  dpdData: { dpdLatest6m: 0, dpdLatest12m: 0 },
  bureauVintage: 18,        // ⚠ <= 24 months (soft reject)
  derogFlags: [],
  currentOverdue: false,
  liveLoans: 2,
  enquiriesCount: 1,
  mfiStatus: "none",
  mobileInBureau: true,
  panInBureau: true,
  dualPan: false
};

// Result: ELIGIBLE (with flag for soft rejects affecting score)
```

## 10. Integration with Campaign Flow

### Workflow: PreQualification → Campaign → Eligibility

```javascript
import PincodeGatingClient from './lib/pincodeGatingClient.js';

const gatingClient = new PincodeGatingClient();

// Step 1: When IVR call connects
app.post("/voice", async (req, res) => {
  const phone = req.body.From;
  const customer = await db.getCustomer(phone);
  
  // Step 2: Quick pincode check
  const pincodeCheck = await gatingClient.validatePincode(
    customer.pincode, 
    "poonawala"
  );
  
  if (!pincodeCheck.valid) {
    // Not eligible - provide alternate offer
    return res.type("text/xml").send(`
      <Response>
        <Say>Unfortunately, we're not operating in your area yet. Thank you!</Say>
      </Response>
    `);
  }
  
  // Step 3: Full eligibility check (with bureau data)
  const eligibility = await gatingClient.checkEligibility(
    customer,
    "poonawala"
  );
  
  if (!eligibility.eligible) {
    console.log("Hard rejects:", eligibility.hardRejects);
    return res.type("text/xml").send(`
      <Response>
        <Say>We're unable to process your request at this time. Thank you!</Say>
      </Response>
    `);
  }
  
  // Step 4: Eligible - proceed with campaign
  res.type("text/xml").send(`
    <Response>
      <Say>You're pre-qualified for a ₹${customer.loanAmount} loan offer!</Say>
      <Gather numDigits="1" action="/voice/accept" method="POST">
        <Pause length="1"/>
      </Gather>
    </Response>
  `);
});
```

## 11. Testing

### Test Pincode Upload (160 Pincodes)

```bash
# Create pincodes.json with 160 pincodes
curl -X POST http://localhost:3000/api/gating/bulk-upload-pincodes \
  -H "Content-Type: application/json" \
  -d '{
    "lenderType": "poonawala",
    "pincodes": [
      "400001", "400002", "400003", ..., "400160"
    ]
  }'
```

### Test Eligibility Checks

```bash
# Test 1: Eligible customer
curl -X POST http://localhost:3000/api/gating/check-eligibility \
  -H "Content-Type: application/json" \
  -d '{
    "lenderType": "poonawala",
    "customerData": {
      "phone": "919876543210",
      "pincode": "400001",
      "age": 32,
      "income": 500000,
      "cibilScore": 750,
      "hunterScore": 880,
      "dpdData": {"dpdLatest6m": 0, "dpdLatest12m": 0},
      "bureauVintage": 36,
      "derogFlags": [],
      "currentOverdue": false,
      "liveLoans": 2,
      "enquiriesCount": 1,
      "mfiStatus": "none",
      "mobileInBureau": true,
      "panInBureau": true,
      "dualPan": false
    }
  }'
```

## 12. Monitoring & Analytics

### Query Gating Logs

```sql
-- Total eligibility checks
SELECT COUNT(*) as total_checks FROM gating_logs 
WHERE lender_type = 'poonawala';

-- Approval rate
SELECT 
  COUNT(CASE WHEN eligible = true THEN 1 END) * 100.0 / COUNT(*) as approval_rate
FROM gating_logs 
WHERE lender_type = 'poonawala';

-- Common hard rejects
SELECT 
  UNNEST(hard_rejects) as reject_reason, 
  COUNT(*) as count
FROM gating_logs 
WHERE lender_type = 'poonawala' AND eligible = false
GROUP BY reject_reason 
ORDER BY count DESC;

-- Soft reject patterns
SELECT 
  UNNEST(soft_rejects) as soft_reject, 
  COUNT(*) as count
FROM gating_logs 
WHERE lender_type = 'poonawala'
GROUP BY soft_reject 
ORDER BY count DESC;
```

## 13. Configuration

Add to `.env`:

```bash
# Gating Configuration
GATING_LENDER_TYPE=poonawala
GATING_MIN_PINCODE_COUNT=160
GATING_ENABLE_SOFT_REJECTS=true
GATING_LOGGING_ENABLED=true
```

## 14. Error Handling

### Common Errors

**"Pincode not in serviceable list"**
- Verify pincode exists in database
- Check if customer's address is entered correctly
- Contact support if customer disputes location

**"Hard reject: CIBIL Score < 720"**
- Suggest improving credit score before reapplying
- Recommend alternative products if available

**"Hard reject: 0+ DPD in Latest 6 Months"**
- Wait for past dues to clear
- Reapply after 6-month clear period

**"Hard reject: Active MFI tradeline"**
- Wait for MFI loan to be settled or closed
- Can reapply after 36 months from closure

## 15. Next Steps

1. ✅ Create Supabase tables (`serviceable_pincodes`, `gating_logs`, `lenders`)
2. ✅ Bulk upload 160 Poonawala pincodes
3. ✅ Test eligibility checks with sample customers
4. ✅ Integrate with IVR call flow
5. ✅ Set up monitoring and analytics
6. ✅ Configure alerts for approval/rejection patterns
7. ✅ Document SLA requirements per lender

## Support

- **Poonawala Partnership:** updates.instapl@poonawallafincorp.com
- **Gating Engine:** See code in `lib/pincodeGatingClient.js`
- **Issues:** Check `gating_logs` table for detailed eligibility decisions

---

Last Updated: 2026-08-25
