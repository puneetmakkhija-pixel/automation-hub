#!/bin/bash

# Railway Environment Variables Setup Script
# Run this from your local machine where Railway CLI is installed
# Usage: ./setup-railway-vars.sh

echo "🚀 Adding environment variables to Railway..."
echo ""

# Check if railway CLI is installed
if ! command -v railway &> /dev/null; then
    echo "❌ Railway CLI not found. Install it first:"
    echo "   npm install -g @railway/cli"
    exit 1
fi

# Ensure linked to project
echo "📍 Linking to Railway project..."
railway link

echo ""
echo "📝 Adding CRITICAL variables..."
echo ""

# Oriserve (ORI voice bot) Variables
# The API key is a live credential and is never stored in this repo. Supply it
# on the command line for this run:
#   ORISERVE_API_KEY=vx_... ./setup-railway-vars.sh
if [ -n "$ORISERVE_API_KEY" ]; then
    echo "Adding ORISERVE_API_KEY..."
    railway variables set ORISERVE_API_KEY "$ORISERVE_API_KEY"
else
    echo "⏭️  Skipping ORISERVE_API_KEY — not set in this shell."
    echo "   Re-run as: ORISERVE_API_KEY=vx_... ./setup-railway-vars.sh"
    echo "   Or set it directly: railway variables set ORISERVE_API_KEY 'vx_...'"
fi

echo "Adding ORISERVE_BASE_URL..."
railway variables set ORISERVE_BASE_URL "https://api-buddy-loan-vox.oriserve.com/api/v1"

echo "Adding ORISERVE_CAMPAIGN_ID..."
railway variables set ORISERVE_CAMPAIGN_ID "6a969a1c91b08220629d6b88"

echo "Adding ORISERVE_WEBHOOK_URL..."
railway variables set ORISERVE_WEBHOOK_URL "https://automation-hub-production.up.railway.app/webhooks/oriserve"

echo ""
echo "📝 Adding Webhook URLs..."
echo ""

echo "Adding OBD_WEBHOOK_URL..."
railway variables set OBD_WEBHOOK_URL "https://automation-hub-production.up.railway.app/webhooks/obd"

echo "Adding OBD_SMS_WEBHOOK_URL..."
railway variables set OBD_SMS_WEBHOOK_URL "https://automation-hub-production.up.railway.app/webhooks/sms"

echo "Adding ANANTA_WEBHOOK_URL..."
railway variables set ANANTA_WEBHOOK_URL "https://automation-hub-production.up.railway.app/webhooks/ananta"

echo "Adding SUPABASE_WEBHOOK_URL..."
railway variables set SUPABASE_WEBHOOK_URL "https://automation-hub-production.up.railway.app/api/db/webhooks/log"

echo ""
echo "📝 Adding Logging Configuration..."
echo ""

echo "Adding LOG_LEVEL..."
railway variables set LOG_LEVEL "debug"

echo "Adding NODE_ENV..."
railway variables set NODE_ENV "production"

echo ""
echo "📝 Ananta WhatsApp (requires your actual values)..."
echo ""
echo "⚠️  MANUAL STEP: Add these with actual values from Ananta:"
echo "   - ANANTA_API_TOKEN"
echo "   - ANANTA_API_SECRET_KEY"
echo "   - ANANTA_PHONE_NUMBER"
echo ""
echo "Run: railway variables set ANANTA_API_TOKEN 'your_token'"
echo "Run: railway variables set ANANTA_API_SECRET_KEY 'your_secret'"
echo "Run: railway variables set ANANTA_PHONE_NUMBER 'your_phone'"

echo ""
echo "✅ Core variables added!"
echo ""
echo "📊 Verify by running: railway variables"
echo ""
echo "🚀 Service will auto-redeploy. Wait 2-3 minutes for completion."
