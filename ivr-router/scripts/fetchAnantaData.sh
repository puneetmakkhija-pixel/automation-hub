#!/usr/bin/env bash
#
# fetchAnantaData.sh
# ------------------
# Fetches approved templates, campaign links, and webhooks from the Ananta
# data-api and saves each response as a timestamped JSON file.
#
# Requires: curl, jq
#
# Credentials: set these as environment variables before running (never
# hardcode them in this file):
#
#   export ANANTA_API_TOKEN="..."
#   export ANANTA_API_SECRET_KEY="..."
#
# Usage:
#   ./scripts/fetchAnantaData.sh [output_dir]
#   (output_dir defaults to ./ananta_data)
#
# Examples:
#   ./scripts/fetchAnantaData.sh
#   ./scripts/fetchAnantaData.sh ./data/ananta
#   ANANTA_API_TOKEN=xxx ANANTA_API_SECRET_KEY=yyy ./scripts/fetchAnantaData.sh

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Check for required tools
for cmd in curl jq; do
  if ! command -v "$cmd" &> /dev/null; then
    echo -e "${RED}Error: $cmd is not installed${NC}" >&2
    exit 1
  fi
done

# Check for credentials
if [[ -z "${ANANTA_API_TOKEN:-}" || -z "${ANANTA_API_SECRET_KEY:-}" ]]; then
  echo -e "${RED}Error: ANANTA_API_TOKEN and ANANTA_API_SECRET_KEY must be set as environment variables.${NC}" >&2
  echo ""
  echo "Usage:"
  echo "  export ANANTA_API_TOKEN='your_token'"
  echo "  export ANANTA_API_SECRET_KEY='your_secret'"
  echo "  ./scripts/fetchAnantaData.sh"
  exit 1
fi

OUT_DIR="${1:-./ananta_data}"
mkdir -p "$OUT_DIR"

TS="$(date +%Y%m%d_%H%M%S)"
BASE="https://data-api.anantadot.com"
BODY=$(cat <<EOF
{
  "api_token": "${ANANTA_API_TOKEN}",
  "api_sec_key": "${ANANTA_API_SECRET_KEY}"
}
EOF
)

echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║          Ananta WhatsApp API - Fetch Data                 ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo "Output directory: $OUT_DIR"
echo "Timestamp: $TS"
echo ""

fetch() {
  local method="$1" path="$2" outfile="$3" description="$4"
  echo -n "📋 Fetching ${description}... "

  if curl -sS -X "${method}" "${BASE}${path}" \
    -H "Content-Type: application/json" \
    -d "${BODY}" \
    -o "${outfile}"; then

    if jq -e . "${outfile}" >/dev/null 2>&1; then
      local count=$(jq '.data | length' "${outfile}" 2>/dev/null || echo "?")
      echo -e "${GREEN}✓${NC} ($count items)"
      echo "   Saved: $outfile"
    else
      echo -e "${RED}⚠${NC} (invalid JSON response)"
      echo "   Saved: $outfile"
    fi
  else
    echo -e "${RED}✗${NC} (request failed)"
  fi
}

# Fetch all endpoints
fetch "GET"  "/WhatsApp/templates/approved" "${OUT_DIR}/templates_approved_${TS}.json" "Approved Templates"
fetch "POST" "/WhatsApp/list-templates"     "${OUT_DIR}/templates_list_${TS}.json"     "Template List"
fetch "GET"  "/Campaigns/links"             "${OUT_DIR}/campaign_links_${TS}.json"     "Campaign Links"
fetch "POST" "/Webhooks/list"               "${OUT_DIR}/webhooks_${TS}.json"           "Webhooks"

echo ""
echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║                        Summary                            ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Count items in each file
echo "📊 Data Summary:"
echo ""

if [[ -f "${OUT_DIR}/templates_approved_${TS}.json" ]]; then
  template_count=$(jq '.data | length' "${OUT_DIR}/templates_approved_${TS}.json" 2>/dev/null || echo "0")
  echo "  Templates: $template_count"
  jq -r '.data[] | "    - \(.template_id): \(.template_name) [\(.status)]"' "${OUT_DIR}/templates_approved_${TS}.json" 2>/dev/null | head -5
  [[ $template_count -gt 5 ]] && echo "    ... and $((template_count - 5)) more"
  echo ""
fi

if [[ -f "${OUT_DIR}/campaign_links_${TS}.json" ]]; then
  link_count=$(jq '.data | length' "${OUT_DIR}/campaign_links_${TS}.json" 2>/dev/null || echo "0")
  echo "  Campaign Links: $link_count"
  jq -r '.data[] | "    - \(.link_id): \(.link_name)"' "${OUT_DIR}/campaign_links_${TS}.json" 2>/dev/null | head -5
  [[ $link_count -gt 5 ]] && echo "    ... and $((link_count - 5)) more"
  echo ""
fi

if [[ -f "${OUT_DIR}/webhooks_${TS}.json" ]]; then
  webhook_count=$(jq '.data | length' "${OUT_DIR}/webhooks_${TS}.json" 2>/dev/null || echo "0")
  echo "  Webhooks: $webhook_count"
  jq -r '.data[] | "    - \(.webhook_url)"' "${OUT_DIR}/webhooks_${TS}.json" 2>/dev/null | head -5
  [[ $webhook_count -gt 5 ]] && echo "    ... and $((webhook_count - 5)) more"
  echo ""
fi

echo -e "${GREEN}✓ Done. Files saved under: ${OUT_DIR}${NC}"
echo ""
echo "Next steps:"
echo "  1. Review the JSON files in $OUT_DIR"
echo "  2. Use template IDs in your WhatsApp campaigns"
echo "  3. Add campaign links to your marketing materials"
echo "  4. Configure webhooks if needed"
echo ""
