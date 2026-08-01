# Proof-of-capability experiment results

DeerFlow source basis: commit `095092418ccf072aa866c0a663c4056c206091e5`.

Environment: Claude Code CLI **2.1.220**, macOS Darwin 25.2.0, Node v22.22.0, Python 3.14.5. Account: Claude **Max** subscription (`claude auth status` → `authMethod: claude.ai`, `subscriptionType: max`), **no** `ANTHROPIC_API_KEY` present. Date: 2026-08-01. Raw command transcript: `experiments/claude-code-port/RESULTS-log.md`. Experiment plugin: `experiments/claude-code-port/exp1-plugin/deerflow-poc/`.

All results below were actually executed; nothing here is documentation inference unless explicitly marked.

## Experiment 1 — packaged workflow (Verified experimentally)

Built a minimal plugin (`.claude-plugin/plugin.json`, `skills/hello/SKILL.md`, `agents/echo-agent.md`, `hooks/hooks.json`, `workflows/wf-hello.js`).

| Check | Result |
|---|---|
| Installation / loading | ✅ `--plugin-dir <path>` loads the plugin for a session (executed). `claude plugin install` / `claude plugin init` auto-load paths: CLI-surface-verified only, not exercised — see "Experiments that could not run" below |
| Command invocation | ✅ `/deerflow-poc:hello` → `PLUGIN-SKILL-OK`; `/deerflow-poc:wf-hello` resolves the plugin-packaged workflow |
| Access to current repository | ✅ workflow agents ran `ls`/`find` against the repo working directory |
| Subagent launch | ✅ plugin agent `echo-agent` dispatched via Agent tool → `ECHO: FOO42` |
| Parallel fan-out / fan-in | ✅ see Experiment 2 |
| Structured result collection | ✅ JSON-schema-validated agent outputs; workflow returned typed JSON |
| Failure propagation | ◐ contract-verified (erroring agents resolve to `null`, stage throw drops item); not force-tested with a live failing agent |
| Output persistence | ✅ per-run `journal.jsonl`, one result line per agent |
| Max-plan behavior | ✅ every model execution above ran on subscription OAuth; no API key in env |

Gate 1 evidence: a plugin **can** distribute and invoke a code-defined Dynamic Workflow (`/deerflow-poc:wf-hello` → `{"workflow_from_plugin":"WF-IN-PLUGIN-OK"}`, 1 agent, 0 errors). Note: the Workflow tool needs permission in headless runs (`--allowedTools "Workflow"`); interactively it's a normal permission prompt.

## Experiment 2 — deterministic orchestration (Verified experimentally)

Workflow `exp2-deterministic-orchestration` (run `wf_7b12b2c7-99d`): map repository → two independent agents in `parallel()` → validate/synthesize **in plain script code with no model call**. Completed 15.8 s, 3 agents, 0 errors. Output:

```json
{"stage1_top_level_count":31,
 "stage2_counts":[{"dir":"backend/app","pyFiles":92},{"dir":"backend/packages","pyFiles":425}],
 "stage3_total_py_files":517,
 "deterministic_transition_proof":"stage boundaries and synthesis executed by script code, not model"}
```

Conclusion: stage transitions are controlled by code, not prompts. This is the property DeerFlow gets from LangGraph graph edges; the workflow runtime provides it natively.

## Experiment 3 — state and resume (Verified experimentally)

1. **Workflow resume**: edited stage 3 of the persisted script, re-invoked with `resumeFromRunId`. Resumed run: **14 ms, 0 subagent tokens, 0 tool uses**, all 3 completed agents replayed from the journal cache, only the edited deterministic tail executed; output gained the new field. → Structured state persists; completed stages are not re-run; invalidation is prefix-based on the first changed `agent()` call.
2. **Session resume (headless)**: `claude -p` stored token `ZEBRA-77`; `claude -p --resume <session_id>` recalled it in a separate process with the same session id.
3. **Changed-commit detection**: **not built in** to either mechanism. Port design consequence: cache/state keys must incorporate the Git commit SHA (e.g. pass `git rev-parse HEAD` through workflow `args`/prompts so a changed tree invalidates the prefix, and stamp SHA into the port's state files for explicit staleness checks). Marked as a port-side requirement, not a platform gap that blocks anything.
4. Cross-session workflow resume: not supported per official docs (same-session only). Durable cross-run state in the port therefore lives in explicit state files (see `state-checkpoint-resume.md`).

## Experiment 4 — middleware parity (Verified experimentally, partial)

| DeerFlow middleware behavior | Native mechanism | Result |
|---|---|---|
| Pre-tool authorization (authz/guardrail) | PreToolUse hook returning `permissionDecision: deny` | ✅ deterministic block: command containing `FORBIDDEN-MARKER` denied with reason surfaced to model and recorded in `permission_denials`; sibling allowed command executed |
| Post-tool result handling | PostToolUse hook | ✅ fired deterministically with structured JSON input (`tool_name`, `tool_input`); output-rewrite (`updatedToolOutput`) documented but not live-tested |
| Tool error normalization | PostToolUse / PostToolUse-on-error path | ◐ documented; not live-tested |
| Loop detection | No native equivalent at tool-call-pattern level | ✗ must be implemented (hook-side state over the transcript, or workflow-wrapper counting) — deterministic implementation is possible since hooks see every tool call with full input |
| Dangling tool-call recovery | Handled natively by the CLI conversation layer | ◐ platform-internal; parity test needed at black-box level only |
| Context summarization trigger | Native auto-compaction (~85%) + `/compact` | ◐ exists but thresholds/keep-policy are not configurable like DeerFlow's; behavioral difference documented in middleware-port-plan.md |

Deterministic vs model-dependent split: everything at the **tool boundary** can be enforced deterministically (hooks are external processes). Everything that rewrites the **model request** (message projection, durable-context injection as DeerFlow does it) has no native interception point and must move to prompt/skill/state-file mechanisms or workflow-wrapper structure.

## Experiment 5 — subagent semantics (Verified experimentally + from docs)

| Property | DeerFlow subagent | Claude Code custom agent (Agent tool) | Workflow `agent()` |
|---|---|---|---|
| Context isolation | fresh ThreadState per task | ✅ own context window per docs; experiment consistent with isolation (echo-agent behaved as prompt-only) but no negative control was run | ✅ same |
| Structured result | ToolMessage + additional_kwargs metadata | final text report | ✅ JSON-schema-validated object (closest match) |
| Concurrency | 3 concurrent / 6 per run (middleware-enforced) | parallel tool calls allowed; no numeric cap | min(16, cores−2), 1000 lifetime; **caps must be re-implemented in port code to preserve 3/6 semantics** |
| Cancellation | abort + task_cancelled event | TaskStop | TaskStop / user skip |
| Resumption | none (one-shot, checkpointer=False) | SendMessage continues an agent | cached replay on workflow resume |
| Failure signal | task_failed + deerflow_error_fallback marker | error text in report | `null` result |
| Timeouts | 1800 s default | none built in | none built in — port must implement |
| Agent Teams | — | experimental, opt-in env var, no nesting/resume | not suitable as substrate (comparison only) |

## Experiment 6 — Agent SDK (resolved from primary documentation; spike not needed)

Official Agent SDK docs state API-key-only authentication and explicitly prohibit claude.ai-subscription login for SDK-built agents. That fails this project's hard constraints (no API key, Max subscription only) regardless of technical capability, so **no SDK spike was built** — the decisive evidence is the auth policy, which a spike cannot change. Verdict: Architecture Option C is disqualified; the CLI's own runtime (interactive session + Dynamic Workflows + `claude -p` for parity harnesses) is the compliant execution path and was verified to run on the subscription (Experiment 7).

## Experiment 7 — plugin-only operation (Verified experimentally)

The entire experiment suite above ran with: no DeerFlow Python process, no FastAPI, no local HTTP server, no Redis, no database, no OAuth handling by any experiment code (the CLI owns auth), no API key, no external model provider. Every model execution was an official Claude Code execution (session, headless `-p`, workflow agent, or custom subagent) billed to the Max subscription.

## Experiments that could not run / partial

- Live failure-propagation inside `parallel()` (forcing a real agent error): not exercised; contract-verified only.
- PostToolUse `updatedToolOutput` rewrite: documented, not live-tested.
- Native auto-compaction trigger at 85%: not driven to overflow in a live session (cost-prohibitive for a planning spike); documented behavior recorded.
- `claude plugin install` from a real marketplace: not exercised (no marketplace published yet); `--plugin-dir` + CLI surface verified.

## Gate verdicts from experiments

| Gate | Verdict | Evidence |
|---|---|---|
| 1. Plugin can package/invoke code-defined workflow | **PASS** | E1-c |
| 2. Workflow launches + collects official subagents on the paid plan | **PASS** | E2-a, E1-c |
| 3. Deterministic state transitions in code | **PASS** | E2-a |
| 4. Resume without re-running completed work | **PASS** (in-session workflow resume + cross-process session resume; cross-session workflow state via port-owned files) | E3-a/E3-b |
| 5. Middleware parity acceptable | **PASS with defined deltas** (tool-boundary deterministic; model-request-rewrite class relocated; summarization approximated) | E4-a/E4-b + middleware-port-plan.md |
| 6. No API key / OAuth handling / server / DeerFlow process | **PASS** | E7-a + whole suite |
| 7. Natural install + invocation from Claude Code | **PASS** (plugin + `/deerflow:...` commands; Workflow-tool permission is a one-time install note) | E1-a/E1-c |
