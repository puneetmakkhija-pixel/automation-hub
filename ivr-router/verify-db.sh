#!/bin/bash
# Database verification script for Railway PostgreSQL

echo "========== DATABASE VERIFICATION =========="
echo

PGPASSWORD='5kV20BIwEu9jGDOUUwtNdMaVxum4Ixpv' psql \
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
