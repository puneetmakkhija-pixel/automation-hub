# IVR Voice Bot System - Monitoring & Logging Guide

## Overview

The IVR system implements structured JSON logging with comprehensive event tracking, performance monitoring, and integration logging. All logs are sent to stdout in JSON format for easy consumption by log aggregation systems.

## Log Levels

- **error** (0): Critical failures requiring immediate attention
- **warn** (1): Warnings that may need investigation
- **info** (2): Informational events (default)
- **debug** (3): Detailed diagnostic information

Configure via environment variable: `LOG_LEVEL=info`

## Log Structure

Every log entry contains:
```json
{
  "timestamp": "2026-08-26T10:30:45.123Z",
  "level": "info",
  "service": "ivr-voice-bot-system",
  "context": "CALL_CONNECT",
  "message": "Incoming call received",
  "data": {
    "phone": "919876543210",
    "lenderId": "flexiloans",
    "callSid": "CALL_001",
    "type": "voice_call"
  },
  "environment": "production"
}
```

## Event Categories

### Call Flow Events
- **CALL_CONNECT**: Incoming call received
- **DTMF_INPUT**: User pressed a digit
- **ROUTING_DECISION**: System routed call to a destination
- **VOICE_BOT_START**: Voice bot initiated
- **CALL_HANGUP**: Call ended
- **CAMPAIGN_COMPLETION**: Campaign completed

### Messaging Events
- **WHATSAPP_SEND**: WhatsApp message sent
- **SMS_CONFIRMED**: SMS delivery confirmed
- **ANANTA_MESSAGE**: Ananta WhatsApp event

### Eligibility & Routing Events
- **ELIGIBILITY_CHECK**: Multi-lender eligibility assessment
- **ROUTING_DECISION**: Route to dual channels, WhatsApp, or voice bot

### Conversation Events
- **CONVERSATION_START**: WhatsApp conversation initiated
- **CONVERSATION_MESSAGE**: Message exchanged in conversation

### Error Events
- **WEBHOOK_ERROR**: Webhook processing failed
- **VALIDATION_ERROR**: Input validation failed
- **ERROR**: General application error

### Performance Events
- **API_LATENCY**: API endpoint response time
- **DB_QUERY**: Database query execution
- **HEALTH_CHECK**: Service health check

### Integration Events
- **ORISERVE_CALL**: Oriserve voice agent called
- **SUPABASE_SYNC**: Supabase database operation

## Key Metrics to Monitor

### Response Times
- **Webhook processing**: `/webhooks/obd`, `/webhooks/sms`, `/webhooks/ananta`
- **Routing API**: `/api/routing/check-eligibility`
- **Eligibility checks**: Should complete within 1-2 seconds

### Error Rates
- **Webhook errors**: Monitor for repeated failures from OBD, Ananta, or Oriserve
- **Validation errors**: Track malformed webhook payloads
- **Database errors**: Monitor Supabase connection issues

### Call Volume
- **Incoming calls**: Count of CALL_CONNECT events per hour
- **DTMF inputs**: User interaction rate
- **Dual-channel routes**: Successful simultaneous voice bot + WhatsApp sends

### Integration Health
- **OBD connectivity**: Monitor OBD webhook delivery
- **Ananta delivery**: Track WhatsApp message success rate
- **Oriserve callbacks**: Monitor voice agent campaign status
- **Supabase sync**: Track database operation success

## Log Queries in Railway

### Recent Errors
```
level:error
```

### Call Flow for a Specific Phone
```
data.phone:919876543210
```

### Webhook Performance
```
context:API_LATENCY endpoint:"/webhooks"
```

### Failed Eligibility Checks
```
context:ELIGIBILITY_CHECK data.eligible:false
```

### Message Delivery Status
```
type:sms_delivery OR type:whatsapp
```

## Deployment Log Access

### View Live Logs
```bash
# In Railway dashboard under your service
# Select "Logs" tab
# Filter by level, context, or specific fields
```

### Query Patterns
1. **Troubleshoot failed call**: Filter by phone number, review CALL_CONNECT → DTMF_INPUT → ROUTING_DECISION flow
2. **Monitor integration health**: Filter by `type:voice_provider` or `type:sms_provider`
3. **Check eligibility engine**: Filter by `context:ELIGIBILITY_CHECK` and review `data.totalEligible`
4. **Track WhatsApp delivery**: Filter by `type:sms_delivery` and `context:WHATSAPP_SEND`

## Alert Thresholds

### Critical Alerts (Immediate Action Required)
- More than 10 webhook errors in 5 minutes
- Eligibility check response time > 5 seconds
- Ananta message delivery failure rate > 5%
- Oriserve campaign callback failures

### Warning Alerts (Monitor & Investigate)
- Webhook processing time > 1000ms
- Database query time > 500ms
- Validation error rate > 2%
- Health check failures

## Log Rotation & Retention

Railway automatically handles log retention:
- **Active logs**: Kept indefinitely in Railway dashboard
- **Archived logs**: Export JSON via Railway API for long-term storage
- **Recommendation**: Set up weekly log exports to Supabase or S3 for compliance/audit

## Debugging Guide

### Incoming Call Not Working
1. Search for `context:CALL_CONNECT data.phone:XXX`
2. Check if message logged with correct `lenderId`
3. Look for ROUTING_DECISION log to see where call was routed
4. Search DTMF_INPUT to see if user pressed any key
5. Check CALL_HANGUP to see end reason

### WhatsApp Not Sending
1. Search for `context:WHATSAPP_SEND`
2. Check Ananta webhook for delivery status: `context:ANANTA_MESSAGE`
3. Verify journey URL: `context:ROUTING_DECISION data.journey_url`
4. Check for validation errors: `context:VALIDATION_ERROR`

### Eligibility Check Failing
1. Search `context:ELIGIBILITY_CHECK`
2. Review `data.totalEligible` count
3. Check for database errors: `type:database_sync error:true`
4. Verify input data is complete: phone, age, income, cibilScore required

### Voice Bot Not Starting
1. Search `context:VOICE_BOT_START`
2. Check for Oriserve errors: `context:ORISERVE_CALL`
3. Verify Ori API credentials in Railway environment
4. Look for routing decision: `data.route:voice_bot`

## Integration with Monitoring Tools

### Supabase Log Aggregation (Future)
Create a scheduled function to sync logs:
```sql
-- Store event logs for long-term querying
INSERT INTO event_logs (timestamp, level, context, data)
SELECT * FROM webhook_logs WHERE processed = false
```

### Custom Dashboards (Future)
Create Supabase dashboard to visualize:
- Call volume trends
- Error rate by context
- Response time percentiles (p50, p95, p99)
- Lender routing distribution

### Alerting Setup (Future)
Configure Railway alerts for:
- Service restart events
- High error rate detection
- Deployment failures
- Critical webhook errors

## Best Practices

1. **Always include phone number**: Helps trace user journey
2. **Use context field consistently**: Makes querying easier
3. **Include timing data**: Essential for performance analysis
4. **Track integration boundaries**: Monitor each provider separately
5. **Error context matters**: Include field names and validation rules

## Environment Variables for Logging

```env
# Log level (error, warn, info, debug)
LOG_LEVEL=info

# Service name appears in every log
SERVICE_NAME=ivr-voice-bot-system

# Environment identifier
NODE_ENV=production
```

## Example Log Entries

### Incoming Call
```json
{
  "timestamp": "2026-08-26T10:30:45.123Z",
  "level": "info",
  "context": "CALL_CONNECT",
  "message": "Incoming call received",
  "data": {
    "phone": "919876543210",
    "lenderId": "flexiloans",
    "callSid": "CALL_001",
    "type": "voice_call"
  }
}
```

### Dual Channel Routing
```json
{
  "timestamp": "2026-08-26T10:30:52.456Z",
  "level": "info",
  "context": "ROUTING_DECISION",
  "message": "Routing to: dual_channels",
  "data": {
    "phone": "919876543210",
    "lenderId": "flexiloans",
    "route": "dual_channels",
    "channels": [
      {"channel": "voice_bot", "provider": "oriserve"},
      {"channel": "whatsapp", "provider": "ananta"}
    ],
    "type": "routing_decision"
  }
}
```

### WhatsApp Delivery
```json
{
  "timestamp": "2026-08-26T10:30:55.789Z",
  "level": "info",
  "context": "ANANTA_MESSAGE",
  "message": "Ananta WhatsApp message",
  "data": {
    "phone": "919876543210",
    "status": "sent",
    "messageId": "msg_12345",
    "type": "sms_provider"
  }
}
```

### Error Example
```json
{
  "timestamp": "2026-08-26T10:31:00.123Z",
  "level": "error",
  "context": "WEBHOOK_ERROR",
  "message": "Webhook processing failed: OBD",
  "data": {
    "eventType": "DTMF",
    "error": "Missing required field: dtmfInput",
    "payloadKeys": ["phone", "lenderId", "callSid"],
    "type": "webhook_error"
  }
}
```

## Performance Baseline

Expected response times for key operations:
- Webhook processing: < 100ms
- Eligibility check: < 1000ms
- WhatsApp send: < 500ms
- Voice bot initiation: < 2000ms
- Health check: < 50ms

Monitor for increases above these baselines as indicators of problems.
