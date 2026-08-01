#!/bin/bash
# Deterministic pre-tool guard: deny any Bash command containing FORBIDDEN-MARKER.
input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""')
if [[ "$cmd" == *FORBIDDEN-MARKER* ]]; then
  printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"blocked by deerflow-poc deterministic guard"}}'
fi
exit 0
