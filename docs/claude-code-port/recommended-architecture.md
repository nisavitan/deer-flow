# Recommended architecture — "DeerFlow for Claude Code"

Selected: **Option B** (plugin as packaging + Dynamic Workflows as orchestration core + hooks as deterministic middleware + native sessions for thread state). Rationale and rejected options: `architecture-options.md`. Evidence: `claude-code-capabilities.md`, `experiment-results.md`. Source basis: commit `095092418ccf072aa866c0a663c4056c206091e5`, 2026-08-01.

## 1. Plugin structure (exact)

```
deerflow-claude/                          # the distributable plugin (new repo dir: ports/claude-code/)
├── .claude-plugin/
│   └── plugin.json                       # name: "deerflow", version synced to upstream release, license/attribution
├── skills/
│   ├── run/SKILL.md                      # /deerflow:run — entry command; injects the ported lead-agent policy
│   ├── plan/SKILL.md                     # /deerflow:plan — plan-mode entry (todos discipline, is_plan_mode analog)
│   ├── goal/SKILL.md                     # /deerflow:goal — set/clear goal (goal.json), mirrors /goal command semantics
│   ├── status/SKILL.md                   # /deerflow:status — render run-meta/delegation ledger/goal state
│   ├── compact/SKILL.md                  # /deerflow:compact — manual compaction analog (native /compact + summary.json update)
│   └── <ported public skills>/…          # skills/public/* carried over (bodies verbatim; frontmatter adapted)
├── agents/
│   ├── deerflow-general-purpose.md       # translation of subagents/builtins/general_purpose.py (prompt verbatim, tools mapped)
│   └── deerflow-bash.md                  # translation of subagents/builtins/bash_agent.py (5 exec/file tools only)
├── workflows/
│   └── deep-run.js                       # THE ORCHESTRATION CORE — port of run-worker + SubagentExecutor semantics
├── hooks/
│   ├── hooks.json                        # event wiring (PreToolUse/PostToolUse/UserPromptSubmit/Stop/SessionStart)
│   └── bin/ (TS/JS compiled or node scripts)
│       ├── pre-tool-guard                # authz/guardrail + sandbox-audit + read-before-write gate
│       ├── post-tool-meta                # deerflow_tool_meta normalization + tool-output budget + result sanitization
│       ├── loop-progress-guard           # loop-detection + tool-progress state machines (state under .deerflow/state)
│       ├── turn-context                  # UserPromptSubmit: date reminder + memory/durable-context injection (additionalContext)
│       └── stop-goal-evaluator           # Stop hook: goal-continuation loop (cap 8, no-progress breaker 2)
├── src/                                  # shared TS sources for hooks + workflow helpers (state lib, reducers)
│   ├── state/ (delegations.ts, goal.ts, skill-context.ts, todos.ts, run-meta.ts, atomic-io.ts)
│   ├── policy/ (caps.ts: 3-concurrent/6-total/1800s; loop.ts: window 20, warn 3, hard 5, freq 30/50; meta.ts: 8-type taxonomy)
│   └── prompts/ (lead sections ported from lead_agent/prompt.py, parameterized like the original)
├── config/deerflow.json                  # behavior knobs preserved from config.yaml (thresholds only; no endpoints/DB)
└── ATTRIBUTION.md + LICENSE              # upstream MIT/Apache attribution, commit provenance
```

Per-project state (created at runtime, never distributed): `.deerflow/state/<thread>/…` per `state-checkpoint-resume.md`.

## 2. Runtime sequence

```mermaid
sequenceDiagram
  participant U as User
  participant S as Claude Code session (lead)
  participant H as Hooks (deterministic)
  participant W as deep-run workflow
  participant A as Subagents (plugin agents)
  U->>S: /deerflow:run <task>
  S->>S: run skill loads lead policy (ported prompt.py sections), run-meta.json created (run_id, commit SHA)
  S->>H: every tool call passes PreToolUse guard / PostToolUse meta
  alt task warrants delegation (benefit-based routing policy, ported verbatim)
    S->>W: Workflow(deep-run, args={task decomposition, commit SHA, caps})
    W->>A: agent() fan-out (≤3 concurrent, ≤6 per run — enforced in script code)
    A-->>W: schema-validated results (status, stop_reason, result, usage)
    W->>W: deterministic collection, ledger writes (delegations.json), timeout/failure mapping
    W-->>S: structured result set
  end
  S->>S: synthesis in lead thread (terminal-response discipline from ported prompt)
  S->>H: Stop hook → goal evaluator (goal.json; ≤8 continuations, no-progress breaker)
  H-->>S: continue silently or finish
  S-->>U: final answer + artifacts (outputs/ delivery contract)
```

## 3. Command invocation sequence

```
cd /path/to/project
claude                      # normal interactive Max session
/deerflow:run <objective>   # main entry
/deerflow:plan …            # plan-mode entry (todo discipline)
/deerflow:goal set|clear …  # goal loop control
/deerflow:status            # ledger/goal/run state
```
Install: `claude plugin install deerflow@<marketplace>` (or `--plugin-dir` / git). One-time permission grant for the Workflow tool (verified installation note, E1-c).

## 4. Layer mapping (who owns what)

| DeerFlow layer | Port owner | Mechanism |
|---|---|---|
| Lead agent policy + system prompt | `skills/run` + `src/prompts/` | ported prompt sections; session = lead thread |
| Middleware: tool boundary (authz, audit, read-before-write, tool-meta, output budget, sanitization) | hooks | PreToolUse deny/rewrite, PostToolUse rewrite [verified E4] |
| Middleware: loop detection / tool progress | hooks + state files | deterministic counters over tool_input hashes |
| Middleware: dynamic/durable context | UserPromptSubmit hook `additionalContext` + state files | turn-boundary injection |
| Middleware: summarization | native auto-compaction (+ summary.json for durable digest) | approximate parity, documented delta |
| Middleware: LangGraph artifacts (SystemMessageCoalescing, DanglingToolCall, model-length detectors, provider patches) | platform-native / obsolete | Claude Code loop already guarantees these |
| Subagent executor + task tool | `workflows/deep-run.js` + plugin agents | caps/timeout/stop_reason in script code |
| Run worker (goal loop, title, receipts) | Stop hook + workflow code + state files | behavioral port |
| Checkpointer/threads | native sessions (+ state files for structured channels) | `state-checkpoint-resume.md` |
| Skills subsystem | native skills | bodies verbatim; frontmatter adapted |
| Memory (DeerMem) | auto-memory dir with DeerMem-shaped layout (facts as single-fact files + index) | structural adaptation |
| Sandbox | native tools + permission rules + `outputs/` convention + env scrub in hook | adapted path contract |
| MCP subsystem | native MCP | direct |
| Models, gateway, frontend, channels, DB, Redis | excluded | `engine-boundary.md` |

## 5. Lifecycles (port form)

- **State**: two layers — sessions (conversation) + `.deerflow/state/<thread>/` JSON channels with reducer semantics; atomic temp+rename writes; commit-SHA binding; schema_version. Full design: `state-checkpoint-resume.md`.
- **Middleware**: per-middleware plan with parity levels: `middleware-port-plan.md`.
- **Subagents**: plugin agents carry the verbatim role prompts; deep-run.js enforces MAX_CONCURRENT=3, total 6/run, timeout 1800 s, stop_reason ∈ {token_capped, turn_capped, loop_capped} mapped from schema fields; failure → null-result mapping to task_failed semantics; ledger append with terminal-never-downgraded rule.
- **Errors**: hook-normalized `deerflow_tool_meta` (8-type taxonomy) attached via PostToolUse rewrite; terminal-response discipline in lead prompt; workflow retries per original policy.
- **Resume**: session `--resume`/`--continue` for the thread; workflow `resumeFromRunId` in-session; cross-session deep-run resume from state files + journal (recovery procedure in `state-checkpoint-resume.md`).
- **Repository access**: the port operates on the user's cwd exactly like Claude Code natively does; worktree isolation available per delegation (`isolation: worktree`) mirroring DeerFlow's per-thread workspace isolation intent.
- **Permissions**: plugin ships a recommended allowlist; deny rules + hooks reproduce env scrubbing (secret-name patterns) and outputs-only delivery.
- **Artifacts**: `outputs/` directory convention replaces `/mnt/user-data/outputs`; delivery = final message lists produced files (present_files contract, behaviorally).

## 6. Installation / upgrade / upstream sync / licensing

- **Install**: plugin marketplace or git; zero servers, zero keys; requires Claude Code ≥ 2.1.154 (workflows GA), verified against 2.1.220.
- **Upgrade**: plugin version tracks upstream DeerFlow releases; `ports/claude-code/` lives in the fork so `git fetch upstream && merge` pulls engine changes; a sync checklist maps upstream diffs to port units via the traceability matrix.
- **Prompt/skill sync**: prompts and skills are reused assets — upstream edits merge near-mechanically; logic translations (middleware/executor) are guarded by parity tests (`parity-test-plan.md`).
- **Licensing**: upstream license preserved in ATTRIBUTION.md with commit SHA provenance; translated files carry origin headers (`Ported from backend/packages/harness/deerflow/...:<symbol>@0950924`).

## 7. Original → target mapping (representative; full table in traceability-matrix.md)

```
Original: backend/packages/harness/deerflow/agents/lead_agent/prompt.py  (apply_prompt_template + section builders)
Target:   ports/claude-code/src/prompts/lead.ts + skills/run/SKILL.md
Method:   Structural translation preserving section order, delegation policy text, clamped-limit rendering, escaping rules.

Original: backend/packages/harness/deerflow/subagents/executor.py  (_aexecute)
Target:   ports/claude-code/workflows/deep-run.js
Method:   Structural JS translation preserving caps, timeout, stop_reason taxonomy, step/result contract; process machinery (thread pools, event loop isolation) replaced by the workflow runtime.

Original: backend/packages/harness/deerflow/agents/middlewares/loop_detection_middleware.py
Target:   ports/claude-code/hooks/bin/loop-progress-guard + src/policy/loop.ts
Method:   Mechanical TS translation of the two-layer algorithm (md5 multiset window 20, warn 3 / hard 5; per-tool freq 30/50); enforcement point moves from after_model to PreToolUse deny.

Original: backend/packages/harness/deerflow/tools/builtins/task_tool.py (result formatting, additional_kwargs contract)
Target:   ports/claude-code/workflows/deep-run.js (result schema) + contracts/subagent_status_contract.json (reused unchanged)
Method:   Reuse contract JSON; translate formatting.

Original: skills/public/**  (SKILL.md packages)
Target:   ports/claude-code/skills/**
Method:   Reuse with frontmatter adaptation (allowed-tools name mapping; required-secrets → documented env contract).
```

## 8. What is knowingly different (honest deltas)

1. Summarization: native auto-compaction is not threshold-configurable; DeerFlow's exact trigger/keep policy is approximated (durable digest kept in summary.json). Exact parity only inside deep-run (workflow layer can implement it) — accepted cost.
2. Message-request rewriting middlewares have no hook point; relocated to turn-boundary injection (UserPromptSubmit) — same information, different insertion point.
3. LangGraph checkpoint granularity (per-superstep) → stage/turn granularity + explicit state files (documented guarantee table).
4. Provider-compat middlewares (SystemMessageCoalescing, patched providers, model-length detectors) are obsolete on a Claude-only platform — behavior N/A by design.
5. Multi-worker/HTTP concerns (leases, stream bridge, receipts-as-SQL-rows) collapse to single-process semantics with the same observable invariants (receipt-before-status → state-file ordering).
