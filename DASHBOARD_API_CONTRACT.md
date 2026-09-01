# Dashboard API Contract

> **The IVR Campaigns, Lenders and Recordings contracts below were retired on
> 1 Sep 2026**, along with the dashboard tabs that called them. See
> `docs/RETIRED_ENDPOINTS.md`. Every other contract here still holds.

**Purpose:** Define expected request/response formats for all dashboard endpoints  
**Status:** Complete - Dashboard expects these exact formats  
**Last Updated:** August 28, 2026

---

## Response Format Standard

All endpoints should return this JSON format:

```json
{
  "success": true,
  "data": { /* endpoint-specific data */ },
  "message": "Optional success message",
  "timestamp": "2026-08-28T10:30:00Z"
}
```

On error:
```json
{
  "success": false,
  "error": "Error message here",
  "timestamp": "2026-08-28T10:30:00Z"
}
```

---

## Endpoint Specifications

### 1. GET /api/analytics/metrics
**Purpose:** Get real-time dashboard metrics

**Expected Response:**
```json
{
  "success": true,
  "data": {
    "leadsProcessed": 2450,
    "whatsappDelivery": 85,
    "callsConnected": 70,
    "dtmfCaptured": 60,
    "interested": 850,
    "notInterested": 980
  }
}
```

**Dashboard Usage:** Updates 6 metric cards on Dashboard tab, auto-refreshes every 30s

---

### 2. GET /api/campaigns
**Purpose:** List all campaigns with status

**Expected Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "camp_001",
      "name": "Test Campaign - Day 1",
      "leadsCount": 100,
      "delivered": 85,
      "connected": 59,
      "interested": 24,
      "createdAt": "2026-08-28T06:00:00Z",
      "status": "active",
      "lenders": ["poonawala", "hero_fincorp"]
    },
    {
      "id": "camp_002",
      "name": "Scaled Campaign - Day 2",
      "leadsCount": 1000,
      "delivered": 850,
      "connected": 590,
      "interested": 240,
      "createdAt": "2026-08-28T12:00:00Z",
      "status": "created",
      "lenders": ["poonawala"]
    }
  ]
}
```

**Dashboard Usage:** Populates campaigns table with status badges and launch buttons

---

### 3. POST /api/campaigns
**Purpose:** Create new campaign

**Request Body:**
```json
{
  "name": "Test Campaign - Dashboard API",
  "leadsCount": 100,
  "lenders": ["poonawala", "hero_fincorp"],
  "template": "Hi {name}! Quick 1-min call to check your ₹{loanAmount} loan eligibility?"
}
```

**Expected Response:**
```json
{
  "success": true,
  "data": {
    "id": "camp_001",
    "name": "Test Campaign - Dashboard API",
    "leadsCount": 100,
    "status": "created",
    "createdAt": "2026-08-28T10:30:00Z"
  },
  "message": "Campaign created successfully"
}
```

**Dashboard Usage:** Form submission on Campaigns tab → shows success alert → refreshes campaign list

---

### 4. POST /api/campaigns/:id/launch
**Purpose:** Launch campaign to send messages

**Request:** No body required

**Expected Response:**
```json
{
  "success": true,
  "data": {
    "id": "camp_001",
    "status": "active",
    "launchTime": "2026-08-28T10:31:00Z",
    "whatsappQueued": 100,
    "callsScheduled": 100
  },
  "message": "Campaign launched successfully"
}
```

**Dashboard Usage:** Launch button on campaign row → updates status to "active" → shows success alert

---

### 5. GET /api/leads
**Purpose:** List leads with pagination

**Query Params:** `?page=1&limit=50`

**Expected Response:**
```json
{
  "success": true,
  "data": [
    {
      "phone": "919876543210",
      "name": "Rajesh Kumar",
      "income": 500000,
      "loanAmount": 500000,
      "lenderId": "poonawala",
      "status": "new",
      "disposition": "pending",
      "lastContact": null,
      "createdAt": "2026-08-28T08:00:00Z"
    },
    {
      "phone": "919876543211",
      "name": "Priya Singh",
      "income": 300000,
      "loanAmount": 200000,
      "lenderId": "hero_fincorp",
      "status": "new",
      "disposition": "interested",
      "lastContact": "2026-08-28T09:00:00Z",
      "createdAt": "2026-08-28T08:01:00Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 2450,
    "totalPages": 49
  }
}
```

**Dashboard Usage:** Leads tab table → displays 50 leads per page with pagination

---

### 6. GET /api/leads/search?phone=X
**Purpose:** Search leads by phone number

**Query Params:** `?phone=919876543210`

**Expected Response:**
```json
{
  "success": true,
  "data": [
    {
      "phone": "919876543210",
      "name": "Rajesh Kumar",
      "income": 500000,
      "loanAmount": 500000,
      "lenderId": "poonawala",
      "status": "new",
      "disposition": "pending",
      "lastContact": null,
      "createdAt": "2026-08-28T08:00:00Z"
    }
  ]
}
```

**Dashboard Usage:** Lead search box → filters table → shows matching leads only

---

### 7. POST /api/leads/bulk
**Purpose:** Upload CSV file with leads

**Request Body:**
```json
{
  "data": "phone,name,income,loanAmount,lenderId,status\n919876543210,Rajesh Kumar,500000,500000,poonawala,new\n919876543211,Priya Singh,300000,200000,hero_fincorp,new"
}
```

**Expected Response:**
```json
{
  "success": true,
  "data": {
    "imported": 100,
    "failed": 0,
    "errors": []
  },
  "message": "100 leads imported successfully"
}
```

**Dashboard Usage:** Lead upload modal → processes CSV file → shows count of imported leads

---

### 8. GET /api/lenders/status
**Purpose:** Get lender webhook connection status

**Expected Response:**
```json
{
  "success": true,
  "data": [
    {
      "lenderId": "poonawala",
      "name": "Poonawala Finance",
      "status": "connected",
      "lastUpdate": "2026-08-28T10:00:00Z",
      "webhookUrl": "https://...",
      "apiStatus": "active"
    },
    {
      "lenderId": "hero_fincorp",
      "name": "Hero FinCorp",
      "status": "connected",
      "lastUpdate": "2026-08-28T09:45:00Z",
      "webhookUrl": "https://...",
      "apiStatus": "active"
    }
  ]
}
```

**Dashboard Usage:** Lenders tab → updates status badges (connected/disconnected)

---

### 9. GET /api/lenders/:lenderId/stats
**Purpose:** Get lender approval/rejection stats

**Expected Response:**
```json
{
  "success": true,
  "data": {
    "lenderId": "poonawala",
    "name": "Poonawala Finance",
    "approvalRate": 48.9,
    "rejectionRate": 51.1,
    "totalApplications": 325,
    "approved": 159,
    "rejected": 166,
    "lastUpdate": "2026-08-28T10:00:00Z"
  }
}
```

**Dashboard Usage:** Lenders tab → displays approval rate % in progress bar

---

### 10. GET /api/mis/reports
**Purpose:** Get MIS reports for all campaigns

**Expected Response:**
```json
{
  "success": true,
  "data": [
    {
      "campaignId": "camp_001",
      "lenderId": "poonawala",
      "applicationCount": 85,
      "approvalRate": 45.9,
      "rejectionRate": 54.1,
      "date": "2026-08-28",
      "reportUrl": "https://..."
    },
    {
      "campaignId": "camp_001",
      "lenderId": "hero_fincorp",
      "applicationCount": 75,
      "approvalRate": 52.0,
      "rejectionRate": 48.0,
      "date": "2026-08-28",
      "reportUrl": "https://..."
    }
  ]
}
```

**Dashboard Usage:** Lenders tab → MIS Reports table → shows approval/rejection rates per lender

---

### 11. GET /api/analytics/conversion
**Purpose:** Get conversion funnel data

**Expected Response:**
```json
{
  "success": true,
  "data": {
    "leadsSent": 2450,
    "whatsappDelivered": 2082,
    "callsConnected": 1435,
    "interested": 588,
    "notInterested": 847,
    "noResponse": 0
  }
}
```

**Dashboard Usage:** Analytics tab → Conversion Funnel chart → shows 4-step funnel with bars

---

### 12. GET /api/analytics/rejections
**Purpose:** Get rejection reason breakdown

**Expected Response:**
```json
{
  "success": true,
  "data": [
    {
      "reason": "CIBIL Score Low",
      "count": 450,
      "percentage": 45.9,
      "trend": "↑ +2%"
    },
    {
      "reason": "Too Many Inquiries",
      "count": 280,
      "percentage": 28.6,
      "trend": "↓ -1%"
    },
    {
      "reason": "Existing Loan",
      "count": 180,
      "percentage": 18.4,
      "trend": "→ Stable"
    },
    {
      "reason": "Income Low",
      "count": 70,
      "percentage": 7.1,
      "trend": "↓ -1%"
    }
  ]
}
```

**Dashboard Usage:** Analytics tab → Rejection Breakdown table

---

### 13. GET /api/health
**Purpose:** Check system health

**Expected Response:**
```json
{
  "success": true,
  "status": "ok",
  "timestamp": "2026-08-28T10:30:00Z",
  "services": {
    "database": "connected",
    "webhooks": "active",
    "cache": "running",
    "uptime": "99.95%"
  }
}
```

**Dashboard Usage:** Settings tab → Health Status indicator

---

### 14. GET /api/database/status
**Purpose:** Get database connection status

**Expected Response:**
```json
{
  "success": true,
  "data": {
    "status": "connected",
    "type": "PostgreSQL",
    "host": "supabase.co",
    "poolSize": 20,
    "activeConnections": 12,
    "database": "automation_hub",
    "lastHealthCheck": "2026-08-28T10:30:00Z"
  }
}
```

**Dashboard Usage:** Settings tab → Database Status display

---

## Error Response Examples

### 400 Bad Request
```json
{
  "success": false,
  "error": "Invalid campaign data",
  "details": "leadsCount must be a positive integer"
}
```

### 404 Not Found
```json
{
  "success": false,
  "error": "Campaign not found",
  "campaignId": "camp_999"
}
```

### 500 Internal Server Error
```json
{
  "success": false,
  "error": "Database connection error",
  "timestamp": "2026-08-28T10:30:00Z"
}
```

---

## Data Format Notes

### Phone Numbers
- Format: 11 digits starting with 91
- Example: `919876543210` (India mobile)
- Dashboard expects: same format for search

### Currency
- Display: `₹` + number formatted with Indian commas
- Example: `₹5,00,000` (5 lakhs)
- API returns: plain numbers (500000)

### Percentages
- Range: 0-100
- Display: with % sign (e.g., "85%")
- API returns: numeric value (85)

### Dates
- Format: ISO 8601 (2026-08-28T10:30:00Z)
- Dashboard converts to: Indian locale (28/8/2026)
- Uses JavaScript `toLocaleDateString('en-IN')`

### Status Values
- Campaign: `"created"`, `"active"`, `"paused"`, `"completed"`
- Lead: `"new"`, `"contacted"`, `"interested"`, `"rejected"`, `"approved"`
- Disposition: `"pending"`, `"interested"`, `"not_interested"`, `"callback_later"`, `"no_response"`

---

## Testing Individual Endpoints

### Using curl (bash)

**Get metrics:**
```bash
curl https://ivr-voice-bot-system-production.up.railway.app/api/analytics/metrics
```

**Create campaign:**
```bash
curl -X POST https://ivr-voice-bot-system-production.up.railway.app/api/campaigns \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test",
    "leadsCount": 100,
    "lenders": ["poonawala"],
    "template": "Hello {name}"
  }'
```

**Upload leads:**
```bash
curl -X POST https://ivr-voice-bot-system-production.up.railway.app/api/leads/bulk \
  -H "Content-Type: application/json" \
  -d '{
    "data": "phone,name,income,loanAmount,lenderId,status\n919876543210,Test,500000,500000,poonawala,new"
  }'
```

---

## Implementation Checklist

- [ ] All endpoints return `success: true/false`
- [ ] All responses include `timestamp`
- [ ] Errors include descriptive `error` message
- [ ] Data fields match exact names (case-sensitive)
- [ ] Pagination includes `total` and `totalPages`
- [ ] Numbers are numeric (not strings)
- [ ] Dates are ISO 8601 format
- [ ] Lender IDs are lowercase (poonawala, hero_fincorp)
- [ ] Percentages are 0-100 numeric values
- [ ] Phone numbers are 11-digit strings

---

**Dashboard depends on these exact formats. Any deviation causes display issues or errors.**
