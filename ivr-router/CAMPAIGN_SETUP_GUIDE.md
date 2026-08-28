# IVR Campaign Setup Guide

Complete guide for creating IVR campaigns with recordings for Flexiloans and Poonawala, managing campaign bases, and filtering contacts by segment.

## Quick Start

### 1. Create IVR Recordings

Upload custom voice recordings for your campaign:

```bash
curl -X POST http://localhost:3000/api/campaigns/recordings \
  -H "Content-Type: application/json" \
  -d '{
    "lenderId": "flexiloans",
    "recordings": {
      "welcome": {
        "text": "Hi! This is FlexiLoans. We offer flexible personal loans up to 25 lakhs."
      },
      "menu": {
        "text": "Press 1 for eligibility check, Press 2 to apply, Press 3 for agent."
      },
      "thanks": {
        "text": "Thank you for choosing FlexiLoans. Your application is being processed."
      },
      "noInput": {
        "text": "Sorry, we did not receive any input. Please try again."
      },
      "wrongInput": {
        "text": "Invalid option. Please select 1, 2, or 3."
      }
    }
  }'
```

### 2. Filter Campaign Base (SME Circle & Self-Employed)

Extract relevant contacts from Supabase matching your target segment:

```bash
curl -X POST http://localhost:3000/api/campaigns/filter-base \
  -H "Content-Type: application/json" \
  -d '{
    "lenderId": "flexiloans",
    "filterCriteria": {
      "smeLoanCircle": true,
      "selfEmployedBase": true
    }
  }'
```

Response includes:
- Total contacts in database
- Filtered contacts matching criteria
- Filtration ratio
- Sample of first 10 contacts

### 3. Export Filtered Base

Download filtered contacts as CSV for upload to OBD:

```bash
curl -X GET "http://localhost:3000/api/campaigns/export-base?lenderId=flexiloans&format=csv" \
  -o flexiloans_base.csv
```

### 4. Create Campaign

Setup campaign with recordings and base:

```bash
curl -X POST http://localhost:3000/api/campaigns/create \
  -H "Content-Type: application/json" \
  -d '{
    "lenderId": "flexiloans",
    "campaignName": "FlexiLoans - SME Eligibility Campaign",
    "baseId": "UPLOADED_BASE_ID",
    "recordings": {
      "welcome": {"promptId": "954"},
      "menu": {"promptId": "955"},
      "thanks": {"promptId": "956"},
      "noInput": {"promptId": "957"},
      "wrongInput": {"promptId": "958"}
    }
  }'
```

## Automated Setup Script

Run the complete workflow automatically:

```bash
node ivr-router/scripts/setupIvrCampaigns.js
```

This script:
1. Creates IVR recordings for both lenders
2. Uploads recordings to OBD
3. Queries Supabase for contacts
4. Filters by SME Circle and Self-Employed segments
5. Uploads filtered base to OBD
6. Creates campaigns with all recordings
7. Exports summary reports

## Campaign Types

### Simple IVR
Basic announcement campaign with welcome and thanks prompts.

```javascript
{
  campaignType: 'simple-ivr',
  welcomePromptId: '954',
  thanksPromptId: '956'
}
```

### DTMF (Interactive Menu)
Menu-driven campaign with digit input handling.

```javascript
{
  campaignType: 'dtmf',
  welcomePromptId: '954',
  menuPromptId: '955',
  noInputPromptId: '957',
  wrongInputPromptId: '958',
  thanksPromptId: '956',
  dtmf: '1',
  menuWaitTime: 5,
  rePrompt: 2
}
```

### Call Patch (Agent Routing)
Route calls to agent groups based on DTMF selection.

```javascript
{
  campaignType: 'call-patch',
  agentGroups: [
    { groupId: '4', agentDtmf: '1', groupName: 'Sales' },
    { groupId: '5', agentDtmf: '2', groupName: 'Support' }
  ]
}
```

## Supported Lenders

### FlexiLoans
- **ID**: `flexiloans`
- **Service**: Flexible personal loans up to 25 lakhs
- **Target Segment**: SME Circle, Self-Employed professionals
- **Recording Focus**: Loan eligibility and quick application

### Poonawala Finance
- **ID**: `poonawala`
- **Service**: Business, auto, and personal financing
- **Target Segment**: SME businesses, Self-Employed entrepreneurs
- **Recording Focus**: Product variety and specialist access

## Base Filtering Criteria

### SME Loan Circle
Targets small and medium enterprise segments:
- `loan_circle === 'sme_circle'`
- `segment === 'sme'`
- `business_type === 'sme'`

### Self-Employed Base
Targets self-employed professionals:
- `employment_type === 'self_employed'` or `'se'`
- `base_type === 'self_employed_base'`

## API Endpoints

### Campaigns Management

#### POST `/api/campaigns/recordings`
Create IVR recordings for a campaign.

**Request:**
```json
{
  "lenderId": "flexiloans",
  "recordings": {
    "welcome": { "text": "..." },
    "menu": { "text": "..." }
  }
}
```

**Response:**
```json
{
  "success": true,
  "lenderId": "flexiloans",
  "recordings": {
    "welcome": { "status": "created" },
    "menu": { "status": "created" }
  }
}
```

#### POST `/api/campaigns/filter-base`
Filter campaign contacts from Supabase.

**Query Parameters:**
- `lenderId` (required): Lender identifier
- `filterCriteria` (optional): Filter options

**Response:**
```json
{
  "success": true,
  "baseStats": {
    "totalContacts": 5000,
    "filteredContacts": 1250,
    "filtrationRatio": "25.00%"
  },
  "sampleContacts": [...]
}
```

#### GET `/api/campaigns/export-base`
Export filtered base as CSV or JSON.

**Query Parameters:**
- `lenderId` (required): Lender identifier
- `format` (optional): 'csv' or 'json' (default: 'csv')

**Response:** CSV file or JSON array of contacts

#### POST `/api/campaigns/create`
Create new campaign.

**Request:**
```json
{
  "lenderId": "flexiloans",
  "campaignName": "Campaign Name",
  "baseId": "BASE_ID",
  "recordings": {...}
}
```

**Response:**
```json
{
  "success": true,
  "campaign": {
    "id": "CAMP_123456",
    "name": "Campaign Name",
    "lenderId": "flexiloans",
    "status": "active"
  }
}
```

#### GET `/api/campaigns/list`
List available lenders and campaign options.

#### GET `/api/campaigns/health`
Check campaign service health.

## Database Schema

### Required Supabase Tables

#### campaign_contacts
```sql
CREATE TABLE campaign_contacts (
  id BIGSERIAL PRIMARY KEY,
  phone VARCHAR(20) NOT NULL,
  name VARCHAR(255),
  lender_id VARCHAR(50),
  segment VARCHAR(50), -- 'sme', 'enterprise', etc.
  loan_circle VARCHAR(50), -- 'sme_circle', 'general', etc.
  employment_type VARCHAR(50), -- 'self_employed', 'salaried', 'business_owner'
  business_type VARCHAR(50),
  base_type VARCHAR(50),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_campaign_lender ON campaign_contacts(lender_id);
CREATE INDEX idx_campaign_segment ON campaign_contacts(segment);
CREATE INDEX idx_campaign_employment ON campaign_contacts(employment_type);
```

## Workflow Example

### Complete Setup for FlexiLoans

```bash
# 1. Create recordings
curl -X POST http://localhost:3000/api/campaigns/recordings \
  -H "Content-Type: application/json" \
  -d @flexiloans_recordings.json

# 2. Filter base for SME + Self-Employed
curl -X POST http://localhost:3000/api/campaigns/filter-base \
  -H "Content-Type: application/json" \
  -d '{
    "lenderId": "flexiloans",
    "filterCriteria": {
      "smeLoanCircle": true,
      "selfEmployedBase": true
    }
  }'

# 3. Export filtered base
curl -X GET "http://localhost:3000/api/campaigns/export-base?lenderId=flexiloans&format=csv" \
  -o flexiloans_base.csv

# 4. Upload base to OBD (via OBD dashboard or API)
# BASE_ID = result from upload

# 5. Create campaign
curl -X POST http://localhost:3000/api/campaigns/create \
  -H "Content-Type: application/json" \
  -d '{
    "lenderId": "flexiloans",
    "campaignName": "FlexiLoans - SME & SE Campaign",
    "baseId": "BASE_ID",
    "recordings": {
      "welcome": {"promptId": "954"},
      "menu": {"promptId": "955"},
      "thanks": {"promptId": "956"},
      "noInput": {"promptId": "957"},
      "wrongInput": {"promptId": "958"}
    }
  }'

# Campaign is now active and ready to run!
```

## Monitoring and Logging

All campaign operations are logged with structured JSON logging:

```json
{
  "timestamp": "2026-08-26T14:30:00.000Z",
  "level": "info",
  "context": "CAMPAIGN_CREATE",
  "message": "Campaign created successfully",
  "data": {
    "lenderId": "flexiloans",
    "campaignName": "...",
    "type": "campaign_creation"
  }
}
```

Filter logs in Railway by:
- `context:CAMPAIGN_*` - All campaign operations
- `data.lenderId:flexiloans` - FlexiLoans campaigns
- `data.lenderId:poonawala` - Poonawala campaigns
- `type:campaign_error` - Campaign errors

## Troubleshooting

### Base Not Filtering Results
1. Check Supabase table exists: `campaign_contacts`
2. Verify records have proper fields: `lender_id`, `segment`, `employment_type`
3. Check filter criteria matches your data

### Recordings Not Uploading
1. Ensure OBD credentials are set in `.env`
2. Verify audio file format (WAV recommended)
3. Check prompt categories are valid

### Campaign Creation Fails
1. Verify `baseId` is correct and already uploaded to OBD
2. Confirm prompt IDs are valid in your OBD system
3. Check schedule time is in future

## Performance Notes

- Base filtering: ~100ms per 1000 contacts
- CSV export: ~50ms per 1000 contacts
- Campaign creation: ~500ms (includes OBD API call)
- Recommended batch size: 5000 contacts per campaign

## Security Considerations

- All endpoints validate `lenderId` parameter
- Phone numbers are stored but not exposed in list endpoints
- Supabase queries use service role for data access
- OBD API credentials stored in environment variables
- All operations logged with full audit trail
