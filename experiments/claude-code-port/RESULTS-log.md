# Proof-of-capability experiments — raw evidence log

Environment: Claude Code CLI 2.1.220, macOS (Darwin 25.2.0), Node v22.22.0, Python 3.14.5.
Auth: `claude auth status` → `{"loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty", "subscriptionType": "max"}`.
`env | grep -c ANTHROPIC_API_KEY` → 0 (no API key anywhere in the environment).
Date: 2026-08-01.

## E7-a: Headless model execution on Max subscription (Verified experimentally)

Command:
```
claude -p "Reply with exactly: HEADLESS-OK" --model haiku --output-format json --no-session-persistence
```
Result: `"result":"HEADLESS-OK"`, `"is_error":false`, session_id returned, structured usage JSON returned.
Conclusion: non-interactive (`-p`) model execution runs through official CLI on subscription OAuth, no API key.

## E1-a: Plugin skill loading + invocation (Verified experimentally)

Built minimal plugin at `experiments/claude-code-port/exp1-plugin/deerflow-poc/`:
`.claude-plugin/plugin.json`, `skills/hello/SKILL.md`, `agents/echo-agent.md`, `hooks/hooks.json`.

Command:
```
claude -p "/deerflow-poc:hello" --plugin-dir ../exp1-plugin/deerflow-poc --model haiku --output-format json --no-session-persistence
```
Result: `"result":"PLUGIN-SKILL-OK"`, num_turns=1.
Conclusion: a plugin loaded from a directory provides a namespaced slash skill (`/plugin:skill`) that executes headlessly.

## E1-b + E4-a + E5-a: Plugin agent + deterministic hooks (Verified experimentally)

Command:
```
claude -p "First run the bash command: echo hook-test. Then use the Agent tool to launch the echo-agent subagent with the token FOO42. Report its reply." \
  --plugin-dir ../exp1-plugin/deerflow-poc --model haiku --output-format json --no-session-persistence --allowedTools "Bash(echo *)" "Agent"
```
Results:
- Subagent launched and returned `ECHO: FOO42` (plugin-provided custom agent dispatched via Agent tool).
- `/tmp/deerflow-poc-hook.log` after run:
  ```
  PRE Bash echo hook-test
  POST Bash
  ```
  → plugin-provided PreToolUse and PostToolUse hooks fired deterministically around the tool call (hook received structured JSON on stdin: tool_name, tool_input).
Conclusion: plugin can bundle custom agents + lifecycle hooks; hooks are deterministic (external process, not model-dependent).

## E3-a: Session persistence + resume, headless (Verified experimentally)

```
SID=$(claude -p "Remember this token: ZEBRA-77. Reply OK." --model haiku --output-format json | jq -r .session_id)
claude -p --resume "$SID" "What token did I give you earlier? Reply with the token only."
```
Result: second run replied `ZEBRA-77` and kept the same session_id.
Conclusion: native session state persists and resumes non-interactively; conversation state is not lost between processes.

## E2-a: Dynamic Workflow — deterministic 3-stage orchestration (Verified experimentally)

Workflow `exp2-deterministic-orchestration` (run ID wf_7b12b2c7-99d), stages:
1. Map: one agent lists repo top level (structured output via JSON schema).
2. Fan-out: `parallel([...])` two independent agents counting .py files in different trees.
3. Synthesize: plain script code (no model) merges results.

Completed in 15.8s, 3 agents, 0 errors. Returned structured JSON:
```
{"stage1_top_level_count":31,
 "stage2_counts":[{"dir":"backend/app","pyFiles":92},{"dir":"backend/packages","pyFiles":425}],
 "stage3_total_py_files":517,
 "deterministic_transition_proof":"stage boundaries and synthesis executed by script code, not model"}
```
Conclusions: stage transitions controlled by code; fan-out/fan-in works; structured result collection works (schema-validated agent outputs); runs in current paid-plan session.

## E3-b: Workflow resume without re-running completed stages

Edited stage 3 of the persisted script (added `resume_proof` field), re-invoked with `resumeFromRunId: wf_7b12b2c7-99d`.
Expected: stages 1-2 replay from journal cache (no live agents), only edited tail executes.
Result (Verified experimentally): resumed run completed in **14 ms** with `subagent_tokens: 0`, `tool_uses: 0`, `agent_count: 3, agents_done: 3` — all three completed agents replayed from the persisted journal cache; only the edited deterministic tail executed, and the output gained the new `resume_proof` field:
```
{"stage1_top_level_count":31, ..., "resume_proof":"stage 3 edited after completion; stages 1-2 must come from cache"}
```
Conclusions: workflow state persists as structured journal entries (`journal.jsonl`, one result line per agent); resume does not re-run completed stages; changed-code invalidation is prefix-based (first edited agent call and everything after re-runs). Git-commit staleness detection is NOT built in — the port must key cached state on commit SHA itself (e.g. pass the SHA via `args` so prompts change when the tree changes).

## E4-b: Deterministic pre-tool authorization via hook (Verified experimentally)

Added `hooks/deny-guard.sh` to the plugin (PreToolUse, matcher Bash): reads hook JSON on stdin, if command contains `FORBIDDEN-MARKER` returns `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",...}}`.

Run: model asked to run `echo FORBIDDEN-MARKER-test` then `echo allowed-test` (both inside `--allowedTools "Bash(echo *)"`).
Result: first call BLOCKED with the guard's reason surfaced to the model and recorded in `permission_denials` (tool_use_id + full tool_input); second call executed normally.
Conclusion: PreToolUse hooks provide deterministic, code-enforced tool authorization independent of the model and of the static permission list — equivalent in kind to DeerFlow's pre-tool authorization/guardrail middlewares. Hook uses `${CLAUDE_PLUGIN_ROOT}` for plugin-relative paths.

## E1-c: Workflow packaged INSIDE a plugin (Verified experimentally) — Gate 1 evidence

Added `workflows/wf-hello.js` to the plugin (meta + one phase + one schema-validated agent).

Run 1: `claude -p "/deerflow-poc:wf-hello" --plugin-dir ...` → workflow was discovered and name-resolved (`deerflow-poc:wf-hello`), execution stopped only on Workflow-tool permission in headless dontAsk-style mode.
Run 2: same + `--allowedTools "Workflow" "Agent"` → completed: result `{"workflow_from_plugin":"WF-IN-PLUGIN-OK"}`, 1 agent, 0 errors, ~3s, ~11K subagent tokens.
Conclusions: plugins CAN distribute code-defined Dynamic Workflows; invocation is namespaced (`/plugin:workflow`); workflow agents run on the Max subscription; permission for the Workflow tool must be granted (allowedTools or interactive approval) — an installation-time note for the port.
