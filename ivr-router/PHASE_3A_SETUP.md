# Phase 3a: WhatsApp Bot Infrastructure Setup

This guide walks through setting up the WhatsApp bot infrastructure for the loan origination platform.

## Prerequisites

- Node.js 18+
- Supabase project
- Ananta API credentials
- PostgreSQL understanding

## 1. Installation

```bash
cd ivr-router
npm install
```

## 2. Database Setup

Run the SQL schema in your Supabase project:

```bash
# Copy the SQL from database-schema.sql
# Go to Supabase dashboard → SQL Editor
# Paste and execute the SQL
```

Or via the Supabase CLI:

```bash
supabase db push < database-schema.sql
```

## 3. Environment Variables

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

Update these variables:

```
# Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key

# Ananta WhatsApp
ANANTA_BASE_URL=https://api.ananta.com
ANANTA_API_KEY=your_api_key
ANANTA_API_TOKEN=your_api_token
ANANTA_API_SECRET_KEY=your_secret_key

# Server
PORT=3000
NODE_ENV=development
```

## 4. Start the Server

```bash
npm start
```

The server should start on `http://localhost:3000`

Health check:
```bash
curl http://localhost:3000/health
# Expected: { "status": "ok", "service": "ivr-router" }
```

## 5. Test Webhook Handler

Send a test WhatsApp message via cURL:

```bash
curl -X POST http://localhost:3000/api/webhooks/ananta/message \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "+919999999999",
    "message_text": "Hi",
    "message_type": "text"
  }'
```

Expected response:
```json
{
  "success": true,
  "phase": "product_selection"
}
```

## 6. Configure Ananta Webhook

In Ananta dashboard:
1. Go to Webhooks settings
2. Set webhook URL: `https://your-domain.com/api/webhooks/ananta/message`
3. Subscribe to: `message.received` event
4. Test the webhook connection

## 7. Debug Endpoints

After the bot receives messages, check the state:

```bash
# View conversation state
curl http://localhost:3000/api/debug/state/+919999999999

# View conversation events (audit trail)
curl http://localhost:3000/api/debug/events/+919999999999
```

## 8. Conversation Phases

The bot guides users through these phases:

1. **product_selection**: Does user have business bank account?
2. **eligibility_check**: Validate pincode
3. **lender_selection**: Choose preferred lender (Phase 3.5a integration pending)
4. **form_personal**: Collect personal details
5. **form_business**: Collect business details (Phase 3b)
6. **documents**: Upload documents (Phase 3c)
7. **kyc_verification**: Background processing (Phase 3.5d)
8. **lender_submission**: Route to lender (Phase 2 integration)
9. **approval**: Application status

## 9. Example Conversation Flow

```
User: "Hi"
Bot: "Do you have a business bank account?"
  
User: "Yes"
Bot: "What's your business registration pincode?"

User: "400001"
Bot: "Pincode verified! What's your annual business income?"
```

## 10. Database Queries

Check conversation states:

```sql
-- All active conversations
SELECT phone_number, current_phase, started_at 
FROM conversation_state 
WHERE status = 'active';

-- Conversations stuck in eligibility
SELECT * FROM conversation_state 
WHERE current_phase = 'eligibility_check' 
AND last_active_at < now() - interval '2 hours';

-- Audit trail for a user
SELECT * FROM conversation_events 
WHERE phone_number = '+919999999999' 
ORDER BY created_at DESC;
```

## 11. Troubleshooting

### Webhook not receiving messages

**Check:**
1. Is the server running? `curl http://localhost:3000/health`
2. Is the Ananta webhook URL correctly configured?
3. Check logs: `npm start` (look for "[Webhook] Message from...")

### Supabase connection errors

**Check:**
1. Is `.env` properly configured with `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`?
2. Can you connect to Supabase? Test the service role key in Supabase SQL editor
3. Check network access: `curl https://your-supabase-url/rest/v1/conversation_state -H "Authorization: Bearer your-key"`

### Messages not sending back

**Check:**
1. Are Ananta credentials correct in `.env`?
2. Is the phone number format valid? (Should be `+919999999999`)
3. Check Ananta logs for sending errors in console output

### State not persisting

**Check:**
1. Does `conversation_state` table exist? `\dt conversation_state` in Supabase SQL
2. Are the indexes created? `\di` in Supabase SQL
3. Is RLS policy correctly set? `SELECT * FROM conversation_state LIMIT 1;` should work

## 12. Next Steps

- **Phase 3b**: Implement multi-step forms for business details
- **Phase 3c**: Add document collection with media upload
- **Phase 3.5a**: Integrate Claude API for intent generation
- **Phase 3.5d**: Nightly batch jobs for rejection analysis

## 13. Deployment

### Staging

```bash
git checkout -b deploy/phase3a
git add -A
git commit -m "Phase 3a: WhatsApp bot infrastructure"
git push origin deploy/phase3a
# Create PR for review
```

### Production

```bash
git pull origin main
npm install
pm2 start index.js --name "ivr-router"
pm2 save
pm2 startup
```

Monitor logs:
```bash
pm2 logs ivr-router
```

## Support

For issues or questions, check:
- Supabase documentation: https://supabase.com/docs
- Ananta API docs: https://docs.ananta.com
- Node.js Express: https://expressjs.com/
