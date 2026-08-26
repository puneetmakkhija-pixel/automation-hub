# Poonawala STPL Gating - Quick Start

Get the Poonawala pincode gating and eligibility engine running in 5 minutes.

## 1. Database Setup

Run these SQL queries in Supabase SQL Editor:

### Create Tables

```sql
CREATE TABLE IF NOT EXISTS serviceable_pincodes (
  id BIGSERIAL PRIMARY KEY,
  pincode TEXT NOT NULL,
  lender_type TEXT NOT NULL,
  state TEXT,
  city TEXT,
  region TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE UNIQUE INDEX ON serviceable_pincodes(pincode, lender_type);
CREATE INDEX ON serviceable_pincodes(lender_type);
CREATE INDEX ON serviceable_pincodes(state);

CREATE TABLE IF NOT EXISTS gating_logs (
  id BIGSERIAL PRIMARY KEY,
  phone TEXT NOT NULL,
  lender_type TEXT NOT NULL,
  eligible BOOLEAN DEFAULT false,
  checks_passed JSONB DEFAULT '{}',
  hard_rejects TEXT[] DEFAULT '{}',
  soft_rejects TEXT[] DEFAULT '{}',
  logged_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX ON gating_logs(phone);
CREATE INDEX ON gating_logs(lender_type);
CREATE INDEX ON gating_logs(eligible);
CREATE INDEX ON gating_logs(logged_at);

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

## 2. Upload Pincodes

### Option A: Bulk Upload (Recommended for 160 pincodes)

Create `pincodes.json`:

```json
{
  "lenderType": "poonawala",
  "pincodes": [
    "400001", "400002", "400003", "400004", "400005",
    "400006", "400007", "400008", "400009", "400010",
    "400011", "400012", "400013", "400014", "400015",
    "400016", "400017", "400018", "400019", "400020"
  ]
}
```

Upload:

```bash
curl -X POST http://localhost:3000/api/gating/bulk-upload-pincodes \
  -H "Content-Type: application/json" \
  -d @pincodes.json
```

**Response:**

```json
{
  "success": true,
  "count": 20,
  "message": "20 pincodes uploaded for poonawala"
}
```

### Option B: Individual Pincode Upload

Use the database directly:

```sql
INSERT INTO serviceable_pincodes (pincode, lender_type, state, city)
VALUES 
  ('400001', 'poonawala', 'Maharashtra', 'Mumbai'),
  ('400002', 'poonawala', 'Maharashtra', 'Mumbai'),
  ('400003', 'poonawala', 'Maharashtra', 'Mumbai');
```

## 3. Verify Pincode Data

### Check Total Pincodes

```bash
curl -X GET http://localhost:3000/api/gating/stats?lenderType=poonawala
```

**Response:**

```json
{
  "success": true,
  "lenderType": "poonawala",
  "count": 160
}
```

### Search Specific Pincode

```bash
curl -X POST http://localhost:3000/api/gating/search-pincode \
  -H "Content-Type: application/json" \
  -d '{
    "pincode": "400001",
    "lenderType": "poonawala"
  }'
```

**Response:**

```json
{
  "success": true,
  "pincode": "400001",
  "found": true,
  "data": [
    {
      "id": 1,
      "pincode": "400001",
      "lender_type": "poonawala",
      "state": "Maharashtra",
      "city": "Mumbai",
      "region": null,
      "created_at": "2026-08-25T10:00:00Z",
      "updated_at": "2026-08-25T10:00:00Z"
    }
  ]
}
```

## 4. Test Eligibility Checks

### Test 1: Eligible Customer

```bash
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
      "dpdData": {
        "dpdLatest6m": 0,
        "dpdLatest12m": 0
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
  }'
```

**Response:**

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

### Test 2: Rejected - Age Outside Range

```bash
curl -X POST http://localhost:3000/api/gating/check-eligibility \
  -H "Content-Type: application/json" \
  -d '{
    "lenderType": "poonawala",
    "customerData": {
      "phone": "919876543211",
      "pincode": "400001",
      "age": 60,
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

**Response:**

```json
{
  "success": true,
  "eligible": false,
  "eligibility": {
    "pincode": true,
    "age": false,
    "income": true,
    "cibilScore": true,
    "hunterScore": true,
    "hardRejects": ["Age not in range 24-55"],
    "softRejects": [],
    "eligible": false
  }
}
```

### Test 3: Rejected - Low CIBIL Score

```bash
curl -X POST http://localhost:3000/api/gating/check-eligibility \
  -H "Content-Type: application/json" \
  -d '{
    "lenderType": "poonawala",
    "customerData": {
      "phone": "919876543212",
      "pincode": "400001",
      "age": 32,
      "income": 500000,
      "cibilScore": 650,
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

**Response:**

```json
{
  "success": true,
  "eligible": false,
  "eligibility": {
    "pincode": true,
    "age": true,
    "income": true,
    "cibilScore": false,
    "hunterScore": true,
    "hardRejects": ["CIBIL Score < 720"],
    "softRejects": [],
    "eligible": false
  }
}
```

### Test 4: Rejected - DPD in Last 6 Months

```bash
curl -X POST http://localhost:3000/api/gating/check-eligibility \
  -H "Content-Type: application/json" \
  -d '{
    "lenderType": "poonawala",
    "customerData": {
      "phone": "919876543213",
      "pincode": "400001",
      "age": 32,
      "income": 500000,
      "cibilScore": 750,
      "hunterScore": 880,
      "dpdData": {
        "dpdLatest6m": 5,
        "dpdLatest12m": 20
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
  }'
```

**Response:**

```json
{
  "success": true,
  "eligible": false,
  "eligibility": {
    "pincode": true,
    "age": true,
    "income": true,
    "cibilScore": true,
    "hunterScore": true,
    "hardRejects": ["0+ DPD in Latest 6 Months"],
    "softRejects": [],
    "eligible": false
  }
}
```

### Test 5: Soft Rejects (Eligible But Score-Negative)

```bash
curl -X POST http://localhost:3000/api/gating/check-eligibility \
  -H "Content-Type: application/json" \
  -d '{
    "lenderType": "poonawala",
    "customerData": {
      "phone": "919876543214",
      "pincode": "400001",
      "age": 32,
      "income": 500000,
      "cibilScore": 750,
      "hunterScore": 880,
      "dpdData": {"dpdLatest6m": 0, "dpdLatest12m": 0},
      "bureauVintage": 18,
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

**Response:**

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
    "softRejects": ["Bureau vintage <= 24 months (soft negative)"],
    "eligible": true
  }
}
```

## 5. Query Gating Logs

### Total Checks

```sql
SELECT COUNT(*) as total_checks FROM gating_logs 
WHERE lender_type = 'poonawala';
```

### Approval Rate

```sql
SELECT 
  COUNT(CASE WHEN eligible = true THEN 1 END) * 100.0 / COUNT(*) as approval_rate
FROM gating_logs 
WHERE lender_type = 'poonawala';
```

### Common Hard Rejects

```sql
SELECT 
  UNNEST(hard_rejects) as reject_reason, 
  COUNT(*) as count
FROM gating_logs 
WHERE lender_type = 'poonawala' AND eligible = false
GROUP BY reject_reason 
ORDER BY count DESC;
```

## 6. Integration Points

### IVR Call Flow

```javascript
import PincodeGatingClient from './lib/pincodeGatingClient.js';

const gatingClient = new PincodeGatingClient();

app.post("/voice", async (req, res) => {
  const phone = req.body.From;
  const customer = await db.getCustomer(phone);
  
  // Quick pincode check
  const pincodeCheck = await gatingClient.validatePincode(
    customer.pincode, 
    "poonawala"
  );
  
  if (!pincodeCheck.valid) {
    return res.type("text/xml").send(`
      <Response>
        <Say>Unfortunately, we're not operating in your area. Thank you!</Say>
      </Response>
    `);
  }
  
  // Full eligibility check
  const eligibility = await gatingClient.checkEligibility(
    customer,
    "poonawala"
  );
  
  if (!eligibility.eligible) {
    return res.type("text/xml").send(`
      <Response>
        <Say>We're unable to process your request. Thank you!</Say>
      </Response>
    `);
  }
  
  // Eligible - proceed with offer
  res.type("text/xml").send(`
    <Response>
      <Say>You're pre-qualified! Press 1 to accept the offer.</Say>
    </Response>
  `);
});
```

### WhatsApp Campaign Integration

```javascript
// In Ananta WhatsApp handler
app.post("/webhooks/ananta", async (req, res) => {
  const { phone, status } = req.body;
  
  if (status === "delivered") {
    const customer = await db.getCustomer(phone);
    const eligibility = await gatingClient.checkEligibility(
      customer,
      "poonawala"
    );
    
    // Log eligibility with campaign result
    await db.logCampaignResult({
      phone,
      channel: "ananta",
      status: "delivered",
      metadata: {
        poonawalaEligible: eligibility.eligible,
        hardRejects: eligibility.hardRejects
      }
    });
  }
});
```

## 7. Monitoring Dashboard

### Check Health

```bash
curl -X GET http://localhost:3000/api/gating/health
```

### List Pincodes (Paginated)

```bash
curl -X GET "http://localhost:3000/api/gating/pincodes?lenderType=poonawala&limit=10&offset=0"
```

## 8. Configuration (.env)

```bash
# Supabase (already configured)
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key

# Optional: Gating-specific settings
GATING_ENABLE_LOGGING=true
GATING_MIN_PINCODE_COUNT=160
```

## 9. Common Issues

**"Supabase credentials not found"**
- Ensure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set in .env
- Run `source .env` to load variables

**"Pincodes not uploading"**
- Verify pincode format (6 digits, zero-padded)
- Check Supabase table permissions
- Ensure unique constraint is not violated

**"Eligibility checks always returning false"**
- Verify pincode is uploaded correctly
- Check that all required customer fields are provided
- Look at hard_rejects array for specific reason

## 10. Sample CURL Commands File

Save as `test_gating.sh`:

```bash
#!/bin/bash

# Health check
echo "=== Health Check ==="
curl -X GET http://localhost:3000/api/gating/health

# Check stats
echo -e "\n=== Pincode Stats ==="
curl -X GET "http://localhost:3000/api/gating/stats?lenderType=poonawala"

# Test eligible customer
echo -e "\n=== Test Eligible Customer ==="
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

# Test rejected customer
echo -e "\n=== Test Rejected Customer (Age) ==="
curl -X POST http://localhost:3000/api/gating/check-eligibility \
  -H "Content-Type: application/json" \
  -d '{
    "lenderType": "poonawala",
    "customerData": {
      "phone": "919876543211",
      "pincode": "400001",
      "age": 60,
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

Run with: `bash test_gating.sh`

## Next Steps

1. ✅ Set up Supabase tables
2. ✅ Upload 160 Poonawala pincodes
3. ✅ Test eligibility checks
4. ✅ Integrate with IVR call flow
5. ✅ Monitor gating logs and approval rates
6. ✅ Set up alerts for rejection patterns

---

**Need Help?**
- Refer to `POONAWALA_GATING_GUIDE.md` for detailed policy documentation
- Check gating logs: `SELECT * FROM gating_logs LIMIT 10;`
- Contact support: updates.instapl@poonawallafincorp.com

Last Updated: 2026-08-25
