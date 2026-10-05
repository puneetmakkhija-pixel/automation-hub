#!/usr/bin/env bash
# PreToolUse guard for mcp__Supabase__execute_sql.
# Allows read-only SQL to run without a prompt; anything that can change
# data or schema (INSERT/UPDATE/DELETE/DDL/etc.) still asks for confirmation.
set -euo pipefail

input="$(cat)"
query="$(printf '%s' "$input" | jq -r '.tool_input.query // ""')"

# Strip leading whitespace/comments/parens, take the first keyword.
first_word="$(printf '%s' "$query" \
  | sed -E 's/--[^\n]*//g; s#/\*.*\*/##g' \
  | sed -E 's/^[[:space:](]+//' \
  | awk '{print toupper($1)}')"

# A read-only start is not enough: "WITH x AS (DELETE ...)" and "SELECT 1; DELETE ..."
# both begin harmlessly. Anything that mentions a write keyword as a whole word
# (so updated_at / created_at do not count) is asked about, whatever it starts with.
writes='(insert|update|delete|merge|drop|alter|create|truncate|grant|revoke|copy|vacuum|call|do)'
if printf '%s' "$query" | tr '[:upper:]' '[:lower:]' | grep -Eq "(^|[^a-z0-9_])${writes}([^a-z0-9_]|$)"; then
  first_word="WRITE"
fi

case "$first_word" in
  SELECT|WITH|SHOW|EXPLAIN|DESC|DESCRIBE|"")
    decision="allow"
    reason="Read-only SQL"
    ;;
  *)
    decision="ask"
    reason="SQL may change data or schema ($first_word ...) - confirm before running"
    ;;
esac

jq -n --arg decision "$decision" --arg reason "$reason" \
  '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:$decision,permissionDecisionReason:$reason}}'
