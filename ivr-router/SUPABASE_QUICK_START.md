# Supabase Database Integration - Quick Start

> **The `/api/db/*` endpoints in this guide were retired on 1 Sep 2026.**
> They wrote to `customers` (which never took a row) and to `campaigns` and
> `campaign_results`, which do not exist in the database. Customer and campaign
> data lives in the CRM. The Supabase *setup* steps below are still accurate,
> and `lib/supabaseClient.js` — which the state machine and webhook handlers
> use — is untouched. See `docs/RETIRED_ENDPOINTS.md`.

Complete guide to use Supabase for customer data, campaign tracking, and webhook event logging.

## 1. Set Up Supabase Project

1. **Create Supabase Account:**
   - Visit https://supabase.com
   - Sign up with email or GitHub

2. **Create New Project:**
   - Click "New Project"
   - Select your region (choose closest to your users)
   - Set a strong password for postgres user

3. **Get Your Credentials:**
   - Go to Project Settings → API
   - Copy `Project URL` (SUPABASE_URL)
   - Copy `Service Role Secret` (SUPABASE_SERVICE_ROLE_KEY)

4. **Never commit these to git** - use environment variables

## 2. Create Database Tables

Run these SQL queries in the Supabase SQL Editor (Project → SQL Editor):

### Customers Table

```sql
CREATE TABLE IF NOT EXISTS customers (
  id BIGSERIAL PRIMARY KEY,
  phone TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  age INTEGER,
  gender TEXT,
  state TEXT,
  marital_status TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX ON customers(phone);
CREATE INDEX ON customers(state);
```

### Campaigns Table

```sql
CREATE TABLE IF NOT EXISTS campaigns (
  id BIGSERIAL PRIMARY KEY,
  campaign_name TEXT NOT NULL,
  campaign_id TEXT UNIQUE NOT NULL,
  campaign_type TEXT NOT NULL, -- 'voice', 'whatsapp', 'combined'
  channel TEXT,
  status TEXT DEFAULT 'active',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX ON campaigns(campaign_id);
```

### Campaign Results Table

```sql
CREATE TABLE IF NOT EXISTS campaign_results (
  id BIGSERIAL PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  phone TEXT NOT NULL,
  channel TEXT NOT NULL, -- 'obd', 'ananta', 'oriserve', 'chatsense'
  status TEXT, -- 'sent', 'delivered', 'read', 'failed'
  result JSONB DEFAULT '{}',
  metadata JSONB DEFAULT '{}',
  logged_at TIMESTAMP DEFAULT NOW(),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(campaign_id)
);

CREATE INDEX ON campaign_results(campaign_id);
CREATE INDEX ON campaign_results(phone);
CREATE INDEX ON campaign_results(channel);
```

### Webhook Events Table

```sql
CREATE TABLE IF NOT EXISTS webhook_events (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL, -- 'obd', 'ananta', 'oriserve', 'chatsense'
  event_data JSONB NOT NULL,
  received_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX ON webhook_events(source);
CREATE INDEX ON webhook_events(received_at);
```

## 3. Set Up Environment Variables

Create a `.env` file (never commit to git):

```bash
# Supabase Credentials
SUPABASE_URL=https://your-project-id.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

## 4. Customer Management

### Create/Update Customer

```bash
curl -X POST http://localhost:3000/api/db/customers \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "919876543210",
    "name": "John Doe",
    "email": "john@example.com",
    "age": 30,
    "gender": "male",
    "state": "Maharashtra",
    "maritalStatus": "married",
    "metadata": {
      "source": "campaign_001",
      "loanAmount": 50000
    }
  }'
```

### Get Customer

```bash
curl -X GET http://localhost:3000/api/db/customers/919876543210
```

### Search Customers

```bash
curl -X POST http://localhost:3000/api/db/customers/search \
  -H "Content-Type: application/json" \
  -d '{
    "state": "Maharashtra",
    "ageMin": 25,
    "ageMax": 50,
    "gender": "male"
  }'
```

### Bulk Create Customers

```bash
curl -X POST http://localhost:3000/api/db/customers/bulk \
  -H "Content-Type: application/json" \
  -d '{
    "customers": [
      {
        "phone": "919876543210",
        "name": "John Doe",
        "age": 30,
        "state": "Maharashtra"
      },
      {
        "phone": "919876543211",
        "name": "Jane Smith",
        "age": 28,
        "state": "Karnataka"
      }
    ]
  }'
```

## 5. Campaign Tracking

### Create Campaign

```bash
curl -X POST http://localhost:3000/api/db/campaigns \
  -H "Content-Type: application/json" \
  -d '{
    "campaignName": "Loan Offer - August",
    "campaignId": "campaign_aug_001",
    "campaignType": "combined",
    "channel": "voice+whatsapp",
    "status": "active",
    "metadata": {
      "targetAmount": "50000-100000",
      "startDate": "2026-08-25"
    }
  }'
```

### Log Campaign Result

```bash
curl -X POST http://localhost:3000/api/db/campaigns/results \
  -H "Content-Type: application/json" \
  -d '{
    "campaignId": "campaign_aug_001",
    "phone": "919876543210",
    "channel": "chatsense",
    "status": "delivered",
    "result": {
      "messageId": "msg_123456",
      "templateName": "loan_offer_followup"
    }
  }'
```

### Get Campaign Results

```bash
curl -X GET http://localhost:3000/api/db/campaigns/campaign_aug_001/results
```

### Get Campaign Statistics

```bash
curl -X GET http://localhost:3000/api/db/campaigns/campaign_aug_001/stats
```

## 6. Webhook Event Logging

### Log Webhook Event

```bash
curl -X POST http://localhost:3000/api/db/webhooks/log \
  -H "Content-Type: application/json" \
  -d '{
    "source": "chatsense",
    "eventData": {
      "phone": "919876543210",
      "status": "delivered",
      "messageId": "msg_123456",
      "templateName": "welcome_template"
    }
  }'
```

## 7. Integration with IVR Router

### Automatic Webhook Logging

Update `index.js` webhook handlers to log events:

```javascript
// In /webhooks/ananta handler
app.post("/webhooks/ananta", async (req, res) => {
  try {
    const payload = req.body;

    // Log to Supabase
    await dbClient.logWebhookEvent('ananta', payload);

    // Log to campaign results
    await dbClient.logCampaignResult({
      campaignId: payload.campaignId,
      phone: payload.phone,
      channel: 'ananta',
      status: payload.status,
      result: payload
    });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});
```

> This example used `/webhooks/chatsense` until 1 Sep 2026, when that route was
> removed along with the rest of the Chatsense integration. The pattern is the
> same for any provider webhook. `'chatsense'` remains a valid `channel` /
> `source` value in the schema above — historical rows still carry it.

## 8. Common Workflows

### Workflow 1: Customer Onboarding

```javascript
import SupabaseClient from './lib/supabaseClient.js';

const db = new SupabaseClient();

// 1. Store customer
const customer = await db.createCustomer({
  phone: '919876543210',
  name: 'John Doe',
  age: 30,
  state: 'Maharashtra'
});

// 2. Create campaign
const campaign = await db.createCampaign({
  campaignName: 'Q3 Loan Offer',
  campaignType: 'voice',
  channel: 'obd'
});

// 3. Log campaign result when called
const result = await db.logCampaignResult({
  campaignId: campaign.campaign.campaign_id,
  phone: customer.customer.phone,
  channel: 'obd',
  status: 'delivered'
});
```

### Workflow 2: Campaign Analytics

```javascript
// Get all results for a campaign
const results = await db.getCampaignResults('campaign_aug_001');
console.log(`Total contacts: ${results.count}`);

// Get statistics
const stats = await db.getCampaignStats('campaign_aug_001');
// stats.stats contains breakdown by channel and status
```

### Workflow 3: Targeted Outreach

```javascript
// 1. Search for customers matching criteria
const customers = await db.searchCustomers({
  state: 'Maharashtra',
  ageMin: 25,
  ageMax: 45,
  gender: 'male'
});

// 2. Create campaign for this segment
const campaign = await db.createCampaign({
  campaignName: `Loan Offer - ${customers.count} customers`,
  campaignType: 'combined',
  metadata: { segment: 'maharashtra_professionals' }
});

// 3. Trigger campaigns for each customer
for (const customer of customers.customers) {
  // Call OBD/Ananta/Oriserve/Chatsense APIs
  // Log results to database
}
```

## 9. API Reference

### SupabaseClient Methods

```javascript
// Customers
await db.createCustomer(customerData)
await db.getCustomer(phone)
await db.searchCustomers(filters)
await db.bulkCreateCustomers(customers)

// Campaigns
await db.createCampaign(campaignData)
await db.logCampaignResult(resultData)
await db.getCampaignResults(campaignId)
await db.getCampaignStats(campaignId)

// Webhooks
await db.logWebhookEvent(source, eventData)

// Utilities
await db.healthCheck()
```

### REST Endpoints

```
POST   /api/db/customers                    - Create/update customer
GET    /api/db/customers/:phone             - Get customer by phone
POST   /api/db/customers/search             - Search customers
POST   /api/db/customers/bulk               - Bulk create customers

POST   /api/db/campaigns                    - Create campaign
POST   /api/db/campaigns/results            - Log campaign result
GET    /api/db/campaigns/:id/results        - Get campaign results
GET    /api/db/campaigns/:id/stats          - Get campaign statistics

POST   /api/db/webhooks/log                 - Log webhook event

GET    /api/db/health                       - Health check
```

## 10. Querying Data

### View Customers in Dashboard

1. Go to Supabase Dashboard
2. Click "SQL Editor"
3. Run queries:

```sql
-- All customers
SELECT * FROM customers;

-- Customers by state
SELECT * FROM customers WHERE state = 'Maharashtra';

-- Age distribution
SELECT age, COUNT(*) as count FROM customers GROUP BY age;
```

### View Campaign Results

```sql
-- Results by channel
SELECT channel, status, COUNT(*) as count 
FROM campaign_results 
WHERE campaign_id = 'campaign_aug_001'
GROUP BY channel, status;

-- Delivery rate
SELECT 
  COUNT(CASE WHEN status = 'delivered' THEN 1 END) * 100.0 / COUNT(*) as delivery_rate
FROM campaign_results
WHERE campaign_id = 'campaign_aug_001';
```

## 11. Backup and Security

### Enable Row Level Security (RLS)

1. Go to Supabase Dashboard → Authentication → Policies
2. Enable RLS on tables (optional for service role usage)

### Regular Backups

1. Supabase automatically backs up daily
2. You can also export data from SQL Editor

### Access Control

- Service Role Key = Full access (use only in backend)
- Anon Key = Limited access (use in frontend, if needed)

## 12. Next Steps

1. ✅ Create Supabase project
2. ✅ Create tables via SQL Editor
3. ✅ Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env
4. ✅ Create a test customer: `POST /api/db/customers`
5. ✅ Create a test campaign: `POST /api/db/campaigns`
6. ✅ Log results from your voice/WhatsApp campaigns
7. ✅ Query analytics: `GET /api/db/campaigns/:id/stats`

## Support

- **Supabase Docs:** https://supabase.com/docs
- **IVR Router:** See code examples in `lib/supabaseClient.js`
- **Troubleshooting:** Check `.env` file for correct credentials

---

Last Updated: 2026-08-25
