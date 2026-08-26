# Ananta WhatsApp Integration Guide

Complete guide for integrating Ananta WhatsApp and customer data management with the IVR Router.

## Table of Contents

1. [Overview](#overview)
2. [Setup](#setup)
3. [Customer Management](#customer-management)
4. [WhatsApp Messaging](#whatsapp-messaging)
5. [Campaign Targeting](#campaign-targeting)
6. [Delivery Tracking](#delivery-tracking)
7. [API Endpoints](#api-endpoints)
8. [Examples](#examples)
9. [Best Practices](#best-practices)
10. [Troubleshooting](#troubleshooting)

## Overview

Ananta is a WhatsApp and customer data platform that enables:

- **Customer Data Management**: Store and manage customer demographics (age, gender, state, city, marital status)
- **WhatsApp Messaging**: Send templated WhatsApp messages at scale
- **Campaign Targeting**: Segment customers by demographics for targeted campaigns
- **Delivery Tracking**: Monitor message delivery, read rates, and engagement
- **Bulk Operations**: Send to customer segments with rate limiting

### Key Features

- 10-digit Indian phone number validation (format: starting with 6-9)
- Demographic segmentation by age, state, gender, marital status
- Customizable customer attributes
- Webhook delivery notifications
- Batch customer sync with automatic rate limiting
- Read/delivery/click rate analytics

## Setup

### 1. Environment Configuration

Add to `.env` file:

```bash
# Ananta API Configuration
ANANTA_BASE_URL=https://data-api.anantadot.com
ANANTA_API_TOKEN=your_api_token_here
ANANTA_API_SEC_KEY=your_api_secret_key_here
```

### 2. Verify Integration

Health check endpoint:

```bash
curl http://localhost:3000/api/ananta/health
```

Response:
```json
{
  "success": true,
  "message": "Ananta API integration healthy",
  "timestamp": "2024-08-25T10:00:00.000Z"
}
```

## Customer Management

### Add or Update Customers

Sync customer demographic data to Ananta:

```bash
curl -X POST http://localhost:3000/api/ananta/customers/sync \
  -H "Content-Type: application/json" \
  -d '{
    "customers": [
      {
        "mobile": "9876543210",
        "state": "Maharashtra",
        "city": "Mumbai",
        "pincode": "400001",
        "age": 32,
        "dob": "1992-05-15",
        "gender": 1,
        "marital_status": 1,
        "custom": {
          "tier": "premium",
          "category": "finance"
        }
      },
      {
        "mobile": "9123456789",
        "state": "Delhi",
        "city": "New Delhi",
        "pincode": "110001",
        "age": 28,
        "gender": 2,
        "marital_status": 2
      }
    ]
  }'
```

**Response:**
```json
{
  "success": true,
  "uploaded": 2,
  "dataIds": ["id_123456"],
  "message": "Customer data synchronized successfully"
}
```

### Gender Codes
- `1` = Male
- `2` = Female
- `3` = Others
- `4` = Prefer not to say

### Marital Status Codes
- `1` = Married
- `2` = Single
- `3` = Divorced
- `4` = Widowed
- `5` = Others

### Bulk Sync Customers

Sync large customer lists with automatic batching:

```bash
curl -X POST http://localhost:3000/api/ananta/customers/bulk-sync \
  -H "Content-Type: application/json" \
  -d '{
    "customers": [...array of 10000 customers...],
    "batchSize": 100
  }'
```

**Response:**
```json
{
  "successful": 10000,
  "failed": 0,
  "batches": [
    {
      "batchNumber": 1,
      "count": 100,
      "status": "success"
    }
  ]
}
```

### Retrieve Customer

Get customer data by phone number:

```bash
curl http://localhost:3000/api/ananta/customers/9876543210
```

**Response:**
```json
{
  "success": true,
  "customer": {
    "mobile": "9876543210",
    "state": "Maharashtra",
    "city": "Mumbai",
    "age": 32,
    "gender": 1,
    "custom": {
      "tier": "premium"
    }
  },
  "phoneNumber": "9876543210"
}
```

## WhatsApp Messaging

### Send Single Message

Send WhatsApp message to one customer:

```bash
curl -X POST http://localhost:3000/api/ananta/messages/send \
  -H "Content-Type: application/json" \
  -d '{
    "phoneNumber": "9876543210",
    "templateId": "template_123",
    "messageText": "Hello, this is a test message"
  }'
```

**Response:**
```json
{
  "success": true,
  "messageId": "msg_987654",
  "status": "sent",
  "timestamp": "2024-08-25T10:15:00.000Z"
}
```

### Bulk Send to Segment

Send WhatsApp messages to a customer segment (with 1 second rate limiting between messages):

```bash
curl -X POST http://localhost:3000/api/ananta/messages/bulk-send \
  -H "Content-Type: application/json" \
  -d '{
    "segment": [
      {
        "mobile": "9876543210",
        "name": "Raj",
        "state": "Maharashtra"
      },
      {
        "mobile": "9123456789",
        "name": "Priya",
        "state": "Delhi"
      }
    ],
    "templateId": "template_123",
    "messageText": "Limited time offer: Get 50% off today!"
  }'
```

**Response:**
```json
{
  "success": true,
  "successful": 2,
  "failed": 0,
  "messages": [
    {
      "phoneNumber": "9876543210",
      "messageId": "msg_001",
      "status": "sent"
    },
    {
      "phoneNumber": "9123456789",
      "messageId": "msg_002",
      "status": "sent"
    }
  ],
  "message": "Bulk WhatsApp sending completed: 2 successful, 0 failed"
}
```

## Campaign Targeting

### Search Customers by Demographics

Find customers matching specific criteria:

```bash
curl -X POST http://localhost:3000/api/ananta/customers/search \
  -H "Content-Type: application/json" \
  -d '{
    "state": "Maharashtra",
    "city": "Mumbai",
    "ageMin": 25,
    "ageMax": 40,
    "gender": 1,
    "maritalStatus": 1,
    "custom": {
      "tier": "premium"
    }
  }'
```

**Response:**
```json
{
  "success": true,
  "count": 1245,
  "customers": [
    {
      "mobile": "9876543210",
      "name": "Raj Kumar",
      "age": 32,
      "state": "Maharashtra",
      "custom": {"tier": "premium"}
    }
  ],
  "criteria": {...}
}
```

### Create Demographic Segment

Define a reusable customer segment:

```bash
curl -X POST http://localhost:3000/api/ananta/segments \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Premium Mumbai Customers",
    "states": ["Maharashtra"],
    "cities": ["Mumbai"],
    "ageMin": 25,
    "ageMax": 50,
    "genders": [1, 2],
    "maritalStatuses": [1, 2],
    "customAttributes": {
      "tier": "premium"
    }
  }'
```

**Response:**
```json
{
  "success": true,
  "segment": {
    "segmentName": "Premium Mumbai Customers",
    "criteria": {
      "states": ["Maharashtra"],
      "cities": ["Mumbai"],
      "ageRange": {"min": 25, "max": 50},
      "genders": [1, 2],
      "maritalStatuses": [1, 2],
      "customAttributes": {"tier": "premium"}
    },
    "createdAt": "2024-08-25T10:00:00.000Z"
  },
  "message": "Segment created successfully"
}
```

### Segment by Age Groups

Automatically group customers into age brackets:

```bash
curl -X POST http://localhost:3000/api/ananta/segments/by-age \
  -H "Content-Type: application/json" \
  -d '{
    "customers": [
      {"mobile": "9876543210", "age": 18},
      {"mobile": "9123456789", "age": 35},
      {"mobile": "9988776655", "age": 55}
    ]
  }'
```

**Response:**
```json
{
  "success": true,
  "segments": {
    "13-20": [{"mobile": "9876543210", "age": 18}],
    "21-30": [],
    "31-40": [{"mobile": "9123456789", "age": 35}],
    "41-50": [],
    "51+": [{"mobile": "9988776655", "age": 55}]
  },
  "message": "Customers segmented by age"
}
```

### Segment by State

Group customers by geographical location:

```bash
curl -X POST http://localhost:3000/api/ananta/segments/by-state \
  -H "Content-Type: application/json" \
  -d '{
    "customers": [
      {"mobile": "9876543210", "state": "Maharashtra"},
      {"mobile": "9123456789", "state": "Delhi"},
      {"mobile": "9988776655", "state": "Maharashtra"}
    ]
  }'
```

**Response:**
```json
{
  "success": true,
  "segments": {
    "Maharashtra": [
      {"mobile": "9876543210", "state": "Maharashtra"},
      {"mobile": "9988776655", "state": "Maharashtra"}
    ],
    "Delhi": [
      {"mobile": "9123456789", "state": "Delhi"}
    ]
  },
  "message": "Customers segmented by state"
}
```

### Segment by Gender

Group customers by gender:

```bash
curl -X POST http://localhost:3000/api/ananta/segments/by-gender \
  -H "Content-Type: application/json" \
  -d '{
    "customers": [
      {"mobile": "9876543210", "gender": 1},
      {"mobile": "9123456789", "gender": 2}
    ]
  }'
```

**Response:**
```json
{
  "success": true,
  "segments": {
    "male": [{"mobile": "9876543210", "gender": 1}],
    "female": [{"mobile": "9123456789", "gender": 2}],
    "others": [],
    "preferNotToSay": []
  },
  "message": "Customers segmented by gender"
}
```

## Delivery Tracking

### Get Campaign Statistics

Monitor message delivery and engagement metrics:

```bash
curl "http://localhost:3000/api/ananta/campaigns/camp_123/stats?startDate=2024-08-01&endDate=2024-08-25"
```

**Response:**
```json
{
  "success": true,
  "campaignId": "camp_123",
  "stats": {
    "sent": 5000,
    "delivered": 4950,
    "read": 3200,
    "clicked": 1850,
    "failed": 50,
    "deliveryRate": "99.00%",
    "readRate": "64.65%",
    "clickRate": "37.37%"
  },
  "period": {
    "startDate": "2024-08-01",
    "endDate": "2024-08-25"
  }
}
```

## API Endpoints

### Customer Management

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/ananta/customers/sync` | Sync customer demographics |
| POST | `/api/ananta/customers/bulk-sync` | Bulk sync with batching |
| GET | `/api/ananta/customers/:phone` | Get customer by phone |
| POST | `/api/ananta/customers/search` | Search by demographics |

### Segmentation

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/ananta/segments` | Create demographic segment |
| POST | `/api/ananta/segments/by-age` | Group by age |
| POST | `/api/ananta/segments/by-state` | Group by state |
| POST | `/api/ananta/segments/by-gender` | Group by gender |

### Messaging

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/ananta/messages/send` | Send single message |
| POST | `/api/ananta/messages/bulk-send` | Send to segment |

### Analytics

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/ananta/campaigns/:campaignId/stats` | Campaign statistics |

### Webhooks

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/webhooks/ananta` | Receive delivery webhooks |

### Validation

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/ananta/validate/phone` | Validate phone number |
| POST | `/api/ananta/validate/age` | Validate age value |
| POST | `/api/ananta/validate/gender` | Validate gender code |
| POST | `/api/ananta/validate/marital-status` | Validate marital status code |

## Examples

### Example 1: Campaign to Premium Customers

1. **Sync customer data:**
   ```bash
   curl -X POST http://localhost:3000/api/ananta/customers/sync \
     -H "Content-Type: application/json" \
     -d '{
       "customers": [
         {
           "mobile": "9876543210",
           "state": "Maharashtra",
           "city": "Mumbai",
           "age": 35,
           "gender": 1,
           "custom": {"tier": "premium"}
         }
       ]
     }'
   ```

2. **Search premium customers:**
   ```bash
   curl -X POST http://localhost:3000/api/ananta/customers/search \
     -H "Content-Type: application/json" \
     -d '{
       "custom": {"tier": "premium"}
     }'
   ```

3. **Send targeted message:**
   ```bash
   curl -X POST http://localhost:3000/api/ananta/messages/bulk-send \
     -H "Content-Type: application/json" \
     -d '{
       "segment": [...premium customers...],
       "templateId": "premium_offer_123",
       "messageText": "Exclusive offer for premium members!"
     }'
   ```

4. **Track delivery:**
   ```bash
   curl "http://localhost:3000/api/ananta/campaigns/camp_premium/stats?startDate=2024-08-25&endDate=2024-08-25"
   ```

### Example 2: Regional Campaign

1. **Search customers by state:**
   ```bash
   curl -X POST http://localhost:3000/api/ananta/customers/search \
     -H "Content-Type: application/json" \
     -d '{
       "state": "Delhi",
       "ageMin": 25,
       "ageMax": 45
     }'
   ```

2. **Create segment:**
   ```bash
   curl -X POST http://localhost:3000/api/ananta/segments \
     -H "Content-Type: application/json" \
     -d '{
       "name": "Delhi Young Professionals",
       "states": ["Delhi"],
       "ageMin": 25,
       "ageMax": 45
     }'
   ```

3. **Send campaign:**
   ```bash
   curl -X POST http://localhost:3000/api/ananta/messages/bulk-send \
     -H "Content-Type: application/json" \
     -d '{
       "segment": [...Delhi customers...],
       "templateId": "delhi_campaign",
       "messageText": "Special Delhi promotion"
     }'
   ```

### Example 3: OBD + Ananta Combined Campaign

Integrate voice calls (OBD) with WhatsApp messages (Ananta):

```javascript
// 1. Create OBD voice campaign
const voiceCampaign = await obdClient.composeCampaign({
  campaignName: "Loan Offer - Voice + WhatsApp",
  baseId: "152499",
  welcomePromptId: "954",
  thanksPromptId: "956",
  scheduleTime: "2024-08-25 10:00:00"
});

// 2. Get eligible customers
const customers = await anantaClient.getCustomersByDemographics({
  ageMin: 25,
  ageMax: 50,
  custom: { loan_eligible: true }
});

// 3. Send WhatsApp follow-up after voice call
const whatsappResult = await anantaClient.bulkSendWhatsApp(
  customers.customers,
  "loan_offer_template",
  "Your loan offer is ready! Apply now."
);

// 4. Track both channels
const voiceStats = await obdClient.analyzeCampaign("2024-08-25", "2024-08-25", voiceCampaign.campaignId);
const whatsappStats = await anantaClient.getDeliveryStats(voiceCampaign.campaignId, "2024-08-25", "2024-08-25");
```

## Best Practices

### Phone Number Handling

- Always validate phone numbers before syncing:
  ```bash
  curl -X POST http://localhost:3000/api/ananta/validate/phone \
    -H "Content-Type: application/json" \
    -d '{"phoneNumber": "9876543210"}'
  ```
- Accept only 10-digit numbers starting with 6-9
- Store in international format: +91XXXXXXXXXX

### Customer Data Validation

- Validate age (1-120): Use `/validate/age` endpoint
- Validate gender (1-4): Use `/validate/gender` endpoint
- Validate marital status (1-5): Use `/validate/marital-status` endpoint
- Use batch sync for large datasets

### Rate Limiting

- Bulk send includes 1 second delay between messages (1000 msg/hour max)
- Batch sync includes 2 second delay between batches
- Adjust as needed based on Ananta API limits

### Error Handling

Always check the `success` flag in responses:

```javascript
const response = await fetch('http://localhost:3000/api/ananta/customers/sync', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ customers: [...] })
});

const data = await response.json();
if (!data.success) {
  console.error('Error:', data.error);
  // Handle error
}
```

### Webhook Security

- Validate webhook source
- Implement webhook signature verification
- Store webhook events for audit trail
- Handle retries gracefully

### Campaign Strategy

1. **Segment First**: Define clear customer segments
2. **Validate Data**: Ensure phone and demographic data quality
3. **Test Small**: Start with small test segment
4. **Monitor Metrics**: Track delivery and engagement rates
5. **Optimize**: Adjust messaging based on performance

## Troubleshooting

### Phone Number Validation Fails

**Error:** "Phone must be 10 digits starting with 6-9"

**Fix:**
- Ensure no country code prefix
- Check length is exactly 10 digits
- First digit must be 6, 7, 8, or 9

### Bulk Send Shows 100% Failure

**Possible causes:**
- Invalid template ID
- Ananta API not authenticated
- Phone numbers invalid

**Debug:**
1. Check environment variables are set
2. Validate individual phone numbers
3. Check template ID exists in Ananta

### Delivery Stats Empty

**Possible causes:**
- Campaign ID doesn't exist
- Date range has no data
- Campaign not yet started

**Debug:**
1. Verify campaign ID
2. Check date format (YYYY-MM-DD)
3. Ensure campaign was scheduled

### Webhook Not Received

**Possible causes:**
- Webhook URL not configured in Ananta
- Network connectivity issues
- Firewall blocking webhooks

**Debug:**
1. Check `/webhooks/ananta` endpoint is accessible
2. Verify in Ananta dashboard webhooks are enabled
3. Check server logs for webhook events

## Support

For issues with:
- **Ananta API**: Contact Ananta support
- **Integration**: Check logs and error responses
- **Phone validation**: Verify Indian phone format (10 digits, 6-9 start)
- **Webhooks**: Test with curl before production
