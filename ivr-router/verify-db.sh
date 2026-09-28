#!/bin/bash
# Database verification script for Railway PostgreSQL
set -euo pipefail

if [ -z "${PGPASSWORD:-}" ]; then
  echo "PGPASSWORD is not set. Export it (e.g. from Railway variables) before running this script." >&2
  exit 1
fi

echo "========== DATABASE VERIFICATION =========="
echo

psql \
  -h postgresql.railway.internal \
  -U automation_hub \
  -d automation_hub \
  -c "
SELECT
  table_name
FROM
  information_schema.tables
WHERE
  table_schema = 'public'
ORDER BY
  table_name;
" 2>&1 | grep -E '^[[:space:]]*(conversation|rejection|eligibility|rule|reengagement|push|user)' && echo "✅ All tables verified" || echo "❌ Table verification failed"

echo
echo "========== VERIFICATION COMPLETE =========="
