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

case "$first_word" in
  SELECT|SHOW|EXPLAIN|DESC|DESCRIBE|"")
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
