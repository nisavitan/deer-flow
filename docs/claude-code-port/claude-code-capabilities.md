# Claude Code capability matrix (for the DeerFlow port)

DeerFlow source basis: commit `095092418ccf072aa866c0a663c4056c206091e5`.

Evidence base: official documentation (code.claude.com/docs, fetched 2026-08-01), installed CLI **2.1.220** (`claude --version`), and local proof experiments (see `experiment-results.md` / `experiments/claude-code-port/RESULTS-log.md`). Account under test: Claude **Max** subscription, `authMethod: claude.ai`, **no** `ANTHROPIC_API_KEY` in the environment (`claude auth status`, verified experimentally).

Legend for "Evidence": **DOC** = official documentation page; **CLI** = installed CLI behavior (`--help`, subcommands); **EXP** = local experiment run in this planning phase. Each row states Max availability: yes / no / conditional / unknown.

## 1. Plugins

| Capability | Status | Max | Packageable | Evidence |
|---|---|---|---|---|
| Plugin manifest `.claude-plugin/plugin.json` (name/description/version/author) | Verified | yes | — | DOC plugins-reference.md; EXP E1-a (manifest written and loaded) |
| Plugin bundles skills, agents, hooks, MCP servers, LSP, output styles, `bin/` executables | Verified (skills/agents/hooks by EXP; rest by DOC) | yes | yes | DOC plugins.md; EXP E1-a/E1-b |
| Plugin bundles **workflows** (`workflows/*.js`) | **Verified experimentally** | yes | yes | EXP E1-c: `/deerflow-poc:wf-hello` ran a plugin-packaged Dynamic Workflow headlessly |
| Install: marketplace / git / `--plugin-dir` / `--plugin-url` / `~/.claude/skills/<name>` auto-load | Verified (CLI + DOC); `--plugin-dir` by EXP | yes | — | CLI `claude plugin --help` (install/init/eval/details/enable/disable); DOC |
| `${CLAUDE_PLUGIN_ROOT}` in hooks | **Verified experimentally** | yes | — | EXP E4-b (deny-guard.sh resolved via plugin root) |
| Command namespacing `/plugin:name` | **Verified experimentally** | yes | — | EXP E1-a (`/deerflow-poc:hello`), E1-c (`/deerflow-poc:wf-hello`) |

Replaces in DeerFlow: packaging + distribution layer (pip package / Docker image), Gateway-managed extension config.

## 2. Skills

| Capability | Status | Max | Evidence |
|---|---|---|---|
| `SKILL.md` frontmatter: `name`, `description`, `allowed-tools`, `disable-model-invocation`, `context`, `agent` | Verified from docs | yes | DOC skills.md |
| Slash invocation `/skill args` with `$ARGUMENTS` | Verified from docs; plugin-namespaced form by EXP | yes | DOC; EXP E1-a |
| Model auto-invocation by description | Verified from docs | yes | DOC |
| User (`~/.claude/skills`), project (`.claude/skills`), plugin scopes | Verified from docs | yes | DOC |

Mapping note: DeerFlow `SKILL.md` frontmatter (`name`, `description`, `license`, `allowed-tools`, `required-secrets`) is near-isomorphic to Claude Code `SKILL.md` (`name`, `description`, `allowed-tools`). `required-secrets` has no native equivalent (gap — see risks). DeerFlow slash activation `/skill-name task` maps directly to native `/skill-name $ARGUMENTS`.

## 3. Custom agents / subagents

| Capability | Status | Max | Evidence |
|---|---|---|---|
| `.claude/agents/*.md` and plugin `agents/*.md` (frontmatter: name, description, tools, model, background, memory) | Verified; plugin agent by EXP | yes | DOC sub-agents.md; EXP E1-b (echo-agent launched via Agent tool) |
| Context isolation (own window; no parent history) | Verified from docs | yes | DOC |
| Foreground + background execution; agent panel (`claude agents`, `--bg`) | Verified from docs + CLI | yes | DOC; CLI |
| Parallel dispatch (multiple Agent calls in one message) | Verified from docs + in-session harness behavior | yes | DOC |
| Programmatic launch from a workflow (`agent()` with `agentType`) | Verified from docs + in-session tool contract | yes | DOC workflows.md |

Replaces in DeerFlow: `SubagentExecutor` process machinery (thread pools, polling, SSE events). Preserved behavior must come from the port's workflow layer: concurrency caps (3), per-run total cap (6), timeout, stop_reason taxonomy.

## 4. Dynamic Workflows

| Capability | Status | Max | Evidence |
|---|---|---|---|
| GA, v2.1.154+, all paid plans, runs on the user's subscription in-session | Verified | **yes** | DOC workflows.md; EXP E2-a (3 agents ran in-session on Max) |
| Script: `meta` + `agent()/parallel()/pipeline()/phase()/log()`, schema-validated structured agent outputs | **Verified experimentally** | yes | EXP E2-a |
| Deterministic code-controlled stage transitions, fan-out/fan-in, deterministic synthesis without a model call | **Verified experimentally** | yes | EXP E2-a |
| Failure propagation: erroring/skipped agents resolve to `null` in `parallel()`; stage throw drops the item | Verified from tool contract docs; not force-tested live | yes | DOC/tool contract; marked partially verified |
| Persistence: per-run `journal.jsonl` with one result per agent | **Verified experimentally** | yes | EXP E3-b |
| Resume (`resumeFromRunId`): unchanged prefix returns cached results, no re-execution | **Verified experimentally** (14 ms, 0 tokens, 0 tool calls on resume of a 3-agent run) | yes | EXP E3-b |
| Changed-code invalidation: prefix-based (first edited call and everything after re-runs) | Verified from tool contract + EXP E3-b design | yes | EXP E3-b |
| Git-commit staleness detection | **Not built in** — must be implemented by keying prompts/args on the commit SHA | — | EXP E3-b conclusion |
| Concurrency: min(16, cores−2) per workflow; 1000-agent lifetime cap | Verified from docs/tool contract | yes | DOC |
| Named workflows: `.claude/workflows/` (project), `~/.claude/workflows/` (personal), plugin `workflows/` | Verified (plugin form by EXP) | yes | DOC; EXP E1-c |
| Cancellation (TaskStop), live progress (/workflows) | Verified from docs | yes | DOC |
| Cross-session resume | **Not supported** per docs ("same-session only" for resumeFromRunId) | — | DOC/tool contract. Port implication: durable cross-session state must live in files keyed by run identity |

Replaces in DeerFlow: LangGraph graph execution + RunManager worker loop as the deterministic orchestration substrate.

## 5. Hooks

| Capability | Status | Max | Evidence |
|---|---|---|---|
| Events: PreToolUse, PostToolUse, UserPromptSubmit, Stop, SubagentStop/StopFailure, SessionStart/End, PreCompact, Notification, PermissionRequest, FileChanged, Worktree lifecycle | Verified from docs (superset varies by version) | yes | DOC hooks.md |
| PreToolUse deny with reason (`permissionDecision: deny`) | **Verified experimentally** | yes | EXP E4-b (FORBIDDEN-MARKER blocked, reason surfaced to model, recorded in `permission_denials`) |
| PreToolUse input rewrite (`updatedInput`) | Verified from docs | yes | DOC |
| PostToolUse output rewrite (`updatedToolOutput`) + `additionalContext` injection | Verified from docs | yes | DOC |
| Structured JSON on stdin (session_id, transcript_path, tool_name, tool_input) | **Verified experimentally** | yes | EXP E4-a (jq parsed the payload) |
| Plugin-provided hooks (`hooks/hooks.json`) | **Verified experimentally** | yes | EXP E4-a/E4-b |
| Stop-hook forced continuation | Verified from docs | yes | DOC |

Replaces in DeerFlow (deterministically): pre-tool authorization (authz/guardrails), sandbox audit, tool-result sanitization/interception, read-before-write gate. Cannot replace: middlewares that rewrite the *model request* (message-list projection) — those have no native hook point; see middleware-port-plan.md.

## 6. Sessions

| Capability | Status | Max | Evidence |
|---|---|---|---|
| `--continue` / `--resume <id>` incl. headless | **Verified experimentally** | yes | EXP E3-a (token recalled across processes, same session_id) |
| `--fork-session` (branching) | Verified from docs + CLI flag | yes | DOC; CLI |
| `--session-id <uuid>` explicit identity | Verified from CLI | yes | CLI |
| Session files `~/.claude/projects/<proj>/<id>.jsonl` (format internal/unstable) | Verified from docs | yes | DOC |
| Checkpointing + `/rewind` (conversation & file checkpoints) | Verified from docs | yes | DOC checkpointing.md |

Replaces in DeerFlow: LangGraph thread checkpoints for the *conversation* dimension (thread identity, resume, branching). Does NOT replace: DeerFlow's structured `ThreadState` extension channels (delegations ledger, skill_context, goal, artifacts) — those need explicit file-backed state in the port.

## 7. Headless / programmatic

| Capability | Status | Max | Evidence |
|---|---|---|---|
| `claude -p` runs the full agentic loop on **subscription OAuth**, no API key | **Verified experimentally** | **yes** | EXP E7-a (`HEADLESS-OK`; `claude auth status` shows claude.ai/max; env has no key) |
| `--output-format json/stream-json`, `--input-format stream-json`, `--json-schema` structured output | Verified (json by EXP; others CLI) | yes | EXP E7-a; CLI |
| `--allowedTools/--disallowedTools/--permission-mode/--tools` | **Verified experimentally** | yes | EXP E1-b/E4-b |
| `--agents <json>`, `--append-system-prompt`, `--system-prompt`, `--settings` | Verified from CLI | yes | CLI |
| Session resume headless | **Verified experimentally** | yes | EXP E3-a |

## 8. Agent SDK (TypeScript / Python)

| Question | Answer | Evidence |
|---|---|---|
| Runs on Max subscription? | **No.** Official docs: "Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Please use the API key authentication methods." | DOC agent-sdk/overview.md (Verified from official documentation) |
| Requires API key? | Yes (`ANTHROPIC_API_KEY` or Bedrock/Vertex/Foundry credentials) | DOC |
| Counts as "official Claude Code execution" for this port's constraints? | It is an official Anthropic product, but it **violates this project's constraints** (no API key, subscription-only). | Constraint analysis |
| Verdict | **Architecture Option C (Agent SDK port) is disqualified** for the target user experience. No SDK spike needed — the auth constraint is decisive from primary documentation. | — |

## 9. MCP

| Capability | Status | Max | Evidence |
|---|---|---|---|
| `.mcp.json` (stdio/SSE/HTTP), plugin-bundled MCP servers, `mcp__server__tool` naming, OAuth for remote servers | Verified from docs + CLI (`claude mcp`) | yes | DOC mcp.md; CLI |
| Deferred tool loading (ToolSearch over deferred MCP tools) | Verified from in-session harness contract | yes | Session tool contract |

Direct functional match for DeerFlow's MCP subsystem (which also uses lazy loading + `tool_search` deferral).

## 10. Memory & context

| Capability | Status | Max | Evidence |
|---|---|---|---|
| CLAUDE.md + `@imports` (4-hop) | Verified from docs | yes | DOC memory.md |
| Auto-memory directory (`~/.claude/projects/<proj>/memory/`, MEMORY.md index + topic files) | Verified from docs + this session's own system contract | yes | DOC |
| Auto-compaction (~85% trigger), `/compact [focus]`, microcompaction | Verified from docs | yes | DOC context-window.md |
| Per-agent memory (`memory: true`, v2.1.214+) | Verified from docs | yes | DOC |

Maps to DeerFlow: memory injection (`<memory>` block) → CLAUDE.md/auto-memory; SummarizationMiddleware → auto-compaction (behavioral differences documented in middleware-port-plan.md — DeerFlow's trigger thresholds and keep-policy are config-precise, native compaction is not tunable).

## 11. Permissions & sandboxing

| Capability | Status | Max | Evidence |
|---|---|---|---|
| settings.json allow/deny/ask rules, `Bash(pattern)` prefix rules, MCP rules | Verified (allow rules by EXP) | yes | DOC permissions.md; EXP E1-b |
| Permission modes: default/plan/acceptEdits/dontAsk/bypassPermissions/auto | Verified from CLI | yes | CLI `--permission-mode` choices |
| Sandbox settings (bash/runtime isolation), OS-level sandboxing | Verified from docs | yes | DOC |
| Worktree isolation (`-w/--worktree`, EnterWorktree, agent `isolation: worktree`) | Verified from CLI + session tools | yes | CLI |

## 12. Background agents / Agent Teams

- Background subagents + `claude agents` panel: available, Max yes (DOC + CLI).
- Agent Teams: **experimental, opt-in env var** (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`), one team per session, no nesting, no in-process resumption — **not suitable as the port's core substrate**; noted as comparison only. (DOC agent-teams.md.)

## Capability → DeerFlow component replacement summary

| DeerFlow component | Native replacement | Fit |
|---|---|---|
| LangGraph create_agent loop (model+tools+middleware) | Claude Code agentic loop (session or workflow agent) | High — loop itself is native |
| RunManager/worker + StreamBridge | Dynamic Workflow runtime + task notifications | High for orchestration; SSE/HTTP concerns drop out |
| LangGraph checkpointer (threads, resume, branching) | Sessions (`--resume`, `--fork-session`) + workflow journal + explicit state files | Medium — conversation resume native; structured channels need file state |
| SubagentExecutor + task tool | Agent tool / workflow `agent()` + custom agents | High — caps/timeouts re-implemented in workflow code |
| Middleware chain (35) | Hooks (tool-boundary, deterministic) + workflow wrapper code + skills/CLAUDE.md (prompt-level) + native compaction | Mixed — per-middleware plan required |
| Skills subsystem | Native skills (+ plugin packaging) | High — near-isomorphic format |
| Memory (DeerMem) | Auto-memory dir + CLAUDE.md (+ optional port of DeerMem file layout) | Medium |
| Sandbox (`/mnt/user-data` virtual paths) | Native Bash/Read/Write/Edit + permission rules + sandbox settings + worktrees | Medium — virtual path contract must be adapted |
| MCP subsystem | Native MCP | High |
| Gateway/FastAPI/Frontend/Nginx/Redis/Postgres | Not needed (delivery infrastructure) | Dropped by design |
| Model factory (OpenAI/vLLM/DeepSeek providers) | Claude models via subscription (`--model`, per-agent `model:`) | Replaced — platform constraint |

## Confirmed constraint compliance

- No API key: verified (subscription OAuth only) — EXP E7-a.
- No servers/daemons: plugin + workflows + hooks are all in-process with the CLI — EXP E1-c.
- No OAuth credential handling by the port: the CLI owns auth; the port never reads tokens — by construction.
- Agent SDK excluded: DOC-verified auth constraint (section 8).
