# Repository Inventory — Claude Code Port Planning

- **Repository:** deer-flow (branch `port/claude-code-architecture`)
- **Commit:** `095092418ccf072aa866c0a663c4056c206091e5`
- **Total tracked files (`git ls-files`):** 2115
- **Date:** 2026-08-01

Architecture grounding (per `AGENTS.md`): `backend/packages/harness/` is the engine (agent framework, import `deerflow.*`), `backend/app/` is gateway delivery (FastAPI + IM channels), `frontend/` is the Next.js web UI. The port targets the harness engine; gateway/frontend delivery layers are replaced by Claude Code itself.

## Summary — files per classification

| Classification | Files |
|---|---:|
| orchestration runtime | 70 |
| lead agent | 5 |
| subagents | 11 |
| middleware | 44 |
| state and schemas | 8 |
| model adapters | 14 |
| tools | 47 |
| skills | 153 |
| memory | 43 |
| summarization | 3 |
| sandbox | 42 |
| MCP | 6 |
| configuration | 62 |
| gateway and HTTP | 95 |
| frontend | 408 |
| persistence and checkpoints | 63 |
| tests | 652 |
| build and packaging | 99 |
| deployment | 47 |
| documentation | 181 |
| fixtures and examples | 56 |
| generated or vendored content | 2 |
| unrelated project assets | 4 |
| **Total** | **2115** |

## Summary — files per disposition

| Disposition | Files |
|---|---:|
| preserve | 183 |
| translate | 142 |
| adapt | 707 |
| replace with native Claude Code primitive | 130 |
| exclude | 945 |
| investigate | 8 |
| **Total** | **2115** |

## Inventory

Rules: every tracked file is covered by exactly one row (first matching row wins, verified by script); `(rest)` rows exclude files claimed by earlier rows in the same directory.

### Harness — root modules

| Path (or glob) | Count | Classification | Relevance | Read in full? | Kind | Disposition | Note |
|---|---:|---|---|---|---|---|---|
| `backend/packages/harness/deerflow/__init__.py` | 1 | orchestration runtime | low | no | runtime code | exclude | package export surface |
| `backend/packages/harness/deerflow/checkpoint_patches.py` | 1 | persistence and checkpoints | high | yes | runtime code | investigate | LangGraph checkpointer monkey-patches |
| `backend/packages/harness/deerflow/client.py` | 1 | orchestration runtime | medium | yes | runtime code | replace with native Claude Code primitive | embedded client; engine API surface — behavior replaced by native session runtime |
| `backend/packages/harness/deerflow/constants.py` | 1 | orchestration runtime | low | yes | runtime code | adapt | shared constants |
| `backend/packages/harness/deerflow/logging_config.py` | 1 | configuration | low | no | runtime code | exclude | logging setup |
| `backend/packages/harness/deerflow/trace_context.py` | 1 | orchestration runtime | low | no | runtime code | exclude | trace-id context propagation |
| `backend/packages/harness/pyproject.toml` | 1 | build and packaging | medium | yes | config | adapt | harness package dependency manifest |

### Harness — agents

| Path (or glob) | Count | Classification | Relevance | Read in full? | Kind | Disposition | Note |
|---|---:|---|---|---|---|---|---|
| `backend/packages/harness/deerflow/agents/__init__.py` | 1 | lead agent | low | no | runtime code | exclude | package exports |
| `backend/packages/harness/deerflow/agents/factory.py` | 1 | lead agent | high | yes | runtime code | translate | assembles lead agent: middleware chain + toolset |
| `backend/packages/harness/deerflow/agents/features.py` | 1 | configuration | medium | yes | runtime code | adapt | feature-flag resolution |
| `backend/packages/harness/deerflow/agents/goal_state.py` | 1 | state and schemas | medium | yes | runtime code | adapt | goal tracking state |
| `backend/packages/harness/deerflow/agents/human_input.py` | 1 | orchestration runtime | medium | yes | runtime code | replace with native Claude Code primitive | HITL interrupt -> CC permission/ask flow |
| `backend/packages/harness/deerflow/agents/thread_state.py` | 1 | state and schemas | high | yes | runtime code | translate | core thread state schema |
| `backend/packages/harness/deerflow/agents/lead_agent/**` | 3 | lead agent | high | yes | runtime code | translate | lead agent graph + system prompt |
| `backend/packages/harness/deerflow/agents/middlewares/summarization_middleware.py` | 1 | summarization | high | yes | runtime code | replace with native Claude Code primitive | context summarization -> CC auto-compaction |
| `backend/packages/harness/deerflow/agents/middlewares/** (rest)` | 40 | middleware | high | yes | runtime code | translate | ~28 agent-loop behaviors -> CC hooks/loop features |
| `backend/packages/harness/deerflow/agents/memory/summarization_hook.py` | 1 | summarization | high | yes | runtime code | adapt | memory capture on summarization boundary |
| `backend/packages/harness/deerflow/agents/memory/** (rest)` | 43 | memory | high | key files | runtime code | adapt | pluggable backends: deermem, mem0, openviking, noop |

### Harness — subsystems

| Path (or glob) | Count | Classification | Relevance | Read in full? | Kind | Disposition | Note |
|---|---:|---|---|---|---|---|---|
| `backend/packages/harness/deerflow/runtime/checkpointer/**, runtime/store/**, runtime/checkpoint_mode.py, runtime/checkpoint_state.py` | 9 | persistence and checkpoints | high | yes | runtime code | replace with native Claude Code primitive | checkpointer/store providers -> CC session persistence |
| `backend/packages/harness/deerflow/runtime/context_compaction.py` | 1 | summarization | high | yes | runtime code | replace with native Claude Code primitive | history compaction |
| `backend/packages/harness/deerflow/runtime/** (rest)` | 29 | orchestration runtime | high | yes | runtime code | translate | run lifecycle, event catalog/stores, stream bridge |
| `backend/packages/harness/deerflow/subagents/**` | 10 | subagents | high | yes | runtime code | replace with native Claude Code primitive | registry/executor/status -> CC Agent tool + agent defs |
| `backend/packages/harness/deerflow/tools/builtins/task_tool.py` | 1 | subagents | high | yes | runtime code | replace with native Claude Code primitive | Task delegation tool -> CC Agent tool |
| `backend/packages/harness/deerflow/tools/builtins/tool_search.py` | 1 | tools | high | yes | runtime code | replace with native Claude Code primitive | deferred tool discovery -> CC ToolSearch |
| `backend/packages/harness/deerflow/tools/** (rest)` | 15 | tools | high | yes | runtime code | translate | builtin tools, registry, sync, MCP metadata |
| `backend/packages/harness/deerflow/skills/**` | 31 | skills | high | yes | runtime code | replace with native Claude Code primitive | skill engine native in CC; keep review/security scanner |
| `backend/packages/harness/deerflow/sandbox/**` | 16 | sandbox | high | yes | runtime code | adapt | local sandbox, FS tools, path security; overlaps CC native tools |
| `backend/packages/harness/deerflow/models/**` | 13 | model adapters | high | yes | runtime code | adapt | provider factory incl. claude_provider, vllm, patched OpenAI-likes |
| `backend/packages/harness/deerflow/mcp/**` | 6 | MCP | high | yes | runtime code | replace with native Claude Code primitive | MCP client/oauth/session pool -> CC native MCP |
| `backend/packages/harness/deerflow/config/**` | 44 | configuration | high | key files | runtime code | translate | per-subsystem config schema -> settings/env mapping |
| `backend/packages/harness/deerflow/persistence/**` | 53 | persistence and checkpoints | medium | key files | runtime code | replace with native Claude Code primitive | SQL stores + alembic migrations |
| `backend/packages/harness/deerflow/guardrails/**` | 4 | middleware | medium | yes | runtime code | adapt | guardrail provider + middleware -> CC hooks |
| `backend/packages/harness/deerflow/utils/**` | 11 | orchestration runtime | medium | key files | runtime code | adapt | message/file/LLM text helpers |
| `backend/packages/harness/deerflow/workspace_changes/**` | 6 | orchestration runtime | medium | key files | runtime code | investigate | workspace diff recorder for UI |
| `backend/packages/harness/deerflow/community/{aio_sandbox,boxlite,e2b_sandbox,tenki}/**, community/warm_pool_lifecycle.py` | 26 | sandbox | medium | key files | runtime code | exclude | remote sandbox providers (E2B/AIO/boxlite/tenki) |
| `backend/packages/harness/deerflow/community/** (rest)` | 31 | tools | medium | key files | runtime code | adapt | search/crawl providers -> MCP servers or CC WebSearch |
| `backend/packages/harness/deerflow/tui/**` | 15 | frontend | low | no | runtime code | replace with native Claude Code primitive | Textual TUI client; CC is the TUI |
| `backend/packages/harness/deerflow/authz/**` | 8 | orchestration runtime | low | no | runtime code | exclude | multi-user RBAC; out of CC scope |
| `backend/packages/harness/deerflow/tracing/**` | 4 | orchestration runtime | low | no | runtime code | exclude | monocle/langfuse tracing |
| `backend/packages/harness/deerflow/integrations/**` | 3 | gateway and HTTP | none | no | runtime code | exclude | Lark CLI broker integration |
| `backend/packages/harness/deerflow/uploads/**` | 2 | orchestration runtime | low | no | runtime code | exclude | upload manager (gateway feature) |
| `backend/packages/harness/deerflow/scheduler/**` | 2 | orchestration runtime | low | no | runtime code | exclude | cron schedule model |
| `backend/packages/harness/deerflow/reflection/**` | 2 | orchestration runtime | low | no | runtime code | exclude | dynamic import resolvers + dep hints |

### Backend app (gateway)

| Path (or glob) | Count | Classification | Relevance | Read in full? | Kind | Disposition | Note |
|---|---:|---|---|---|---|---|---|
| `backend/app/gateway/**` | 69 | gateway and HTTP | low | key files | runtime code | exclude | FastAPI gateway, auth, routers; CC needs no HTTP layer |
| `backend/app/channels/**` | 20 | gateway and HTTP | none | no | runtime code | exclude | IM channel bridges (Slack/Feishu/Telegram/...) |
| `backend/app/scheduler/**` | 2 | gateway and HTTP | low | no | runtime code | exclude | scheduled-task background service |
| `backend/app/__init__.py` | 1 | gateway and HTTP | none | no | runtime code | exclude | package marker |

### Backend tests

| Path (or glob) | Count | Classification | Relevance | Read in full? | Kind | Disposition | Note |
|---|---:|---|---|---|---|---|---|
| `backend/tests/*.py (top level)` | 467 | tests | medium | key files | test code | adapt | behavioral specs of harness; mine for port acceptance tests |
| `backend/tests/blocking_io/**` | 29 | tests | none | no | test code | exclude | asyncio blocking-IO guard (Python-specific) |
| `backend/tests/support/**` | 7 | tests | medium | no | test code | adapt | shared test helpers |
| `backend/tests/monocle/**` | 6 | tests | none | no | test code | exclude | tracing eval traces |
| `backend/tests/fixtures/**` | 2 | fixtures and examples | low | no | generated | exclude | recorded replay fixtures |

### Backend misc

| Path (or glob) | Count | Classification | Relevance | Read in full? | Kind | Disposition | Note |
|---|---:|---|---|---|---|---|---|
| `backend/docs/**` | 37 | documentation | high | key files | docs | preserve | architecture, middleware flow, summarization docs — port reference |
| `backend/{AGENTS,CLAUDE,CONTRIBUTING,README}.md` | 4 | documentation | high | yes | docs | preserve | backend module guide |
| `backend/scripts/**` | 15 | build and packaging | low | no | runtime code | exclude | benchmarks, data migrations, replay recorders |
| `backend/Dockerfile` | 1 | deployment | none | no | config | exclude | container build |
| `backend/langgraph.json` | 1 | configuration | medium | yes | config | exclude | LangGraph server graph entry |
| `backend/debug.py` | 1 | orchestration runtime | low | no | runtime code | exclude | VS Code debug entrypoint |
| `backend/samples/**` | 2 | fixtures and examples | low | no | docs | exclude | memory backend demo sample |
| `backend/.vscode/**` | 2 | configuration | none | no | config | exclude | editor settings |
| `backend/uv.lock` | 1 | generated or vendored content | none | no | generated | exclude | uv lockfile |
| `backend/{Makefile,pyproject.toml,ruff.toml,.python-version,.gitignore,sitecustomize.py}` | 6 | build and packaging | medium | no | config | exclude | uv workspace, lint, interpreter bootstrap |

### Frontend

| Path (or glob) | Count | Classification | Relevance | Read in full? | Kind | Disposition | Note |
|---|---:|---|---|---|---|---|---|
| `frontend/src/content/**` | 88 | documentation | medium | key files | docs | preserve | MDX docs site: harness/app guides (en+zh) |
| `frontend/public/demo/**` | 52 | fixtures and examples | none | no | generated | exclude | recorded demo replay data |
| `frontend/tests/**` | 138 | tests | none | no | test code | exclude | unit + playwright e2e |
| `frontend/{AGENTS,CLAUDE,README}.md` | 3 | documentation | medium | yes | docs | preserve | frontend module guide |
| `frontend/src/** (rest)` | 385 | frontend | low | no | runtime code | exclude | Next.js web UI (components, core, app routes) |
| `frontend/public/** (rest)` | 8 | frontend | none | no | runtime code | exclude | static assets |
| `frontend/pnpm-lock.yaml` | 1 | generated or vendored content | none | no | generated | exclude | pnpm lockfile |
| `frontend/* (root config, rest)` | 21 | build and packaging | low | no | config | exclude | Next/pnpm/playwright/eslint config, Dockerfile |

### Skills

| Path (or glob) | Count | Classification | Relevance | Read in full? | Kind | Disposition | Note |
|---|---:|---|---|---|---|---|---|
| `skills/public/**` | 104 | skills | high | key files | docs | adapt | 23 skill packs (SKILL.md + scripts); near-drop-in CC skills |
| `.agent/skills/**` | 18 | skills | medium | key files | docs | preserve | repo-maintainer skills (smoke-test, blocking-io-guard) |

### Scripts

| Path (or glob) | Count | Classification | Relevance | Read in full? | Kind | Disposition | Note |
|---|---:|---|---|---|---|---|---|
| `scripts/export_claude_code_oauth.py` | 1 | model adapters | medium | yes | runtime code | investigate | bridges Claude Code OAuth creds into DeerFlow |
| `scripts/wizard/**` | 9 | configuration | low | no | runtime code | exclude | interactive setup wizard |
| `scripts/* (rest)` | 31 | build and packaging | low | no | runtime code | exclude | stack orchestration, doctor, CI detectors |

### Docs

| Path (or glob) | Count | Classification | Relevance | Read in full? | Kind | Disposition | Note |
|---|---:|---|---|---|---|---|---|
| `docs/plans/**` | 9 | documentation | medium | key files | docs | preserve | design plans (authz, storage rewrite, tracing) |
| `docs/superpowers/**` | 17 | documentation | medium | key files | docs | preserve | feature plan/spec archive |
| `docs/tui/**` | 3 | documentation | none | no | docs | exclude | TUI preview SVGs |
| `docs/pr-evidence/**` | 2 | unrelated project assets | none | no | unrelated | exclude | PR evidence screenshots |
| `docs/* (rest incl. docs/agents/)` | 4 | documentation | low | key files | docs | preserve | misc design notes |
| `plans/subagent-card-runtime-metadata.md` | 1 | documentation | medium | yes | docs | preserve | active plan: subagent card runtime metadata |

### Deploy and CI

| Path (or glob) | Count | Classification | Relevance | Read in full? | Kind | Disposition | Note |
|---|---:|---|---|---|---|---|---|
| `deploy/helm/**` | 27 | deployment | none | no | config | exclude | Helm chart |
| `docker/**` | 19 | deployment | none | no | config | exclude | compose files, nginx, provisioner |
| `.github/**` | 20 | build and packaging | low | no | config | exclude | CI workflows, templates, labels |
| `contracts/**` | 6 | state and schemas | high | yes | config | translate | cross-component JSON contracts (event stream, subagent status, skill review) |
| `tests/skills/**` | 5 | tests | medium | yes | test code | adapt | public skill smoke tests |
| `pr-build/*.png` | 2 | unrelated project assets | none | no | unrelated | exclude | issue screenshots |

### Repo root

| Path (or glob) | Count | Classification | Relevance | Read in full? | Kind | Disposition | Note |
|---|---:|---|---|---|---|---|---|
| `README.md` | 1 | documentation | high | yes | docs | preserve | product overview |
| `AGENTS.md` | 1 | documentation | high | yes | docs | preserve | monorepo architecture map |
| `CLAUDE.md` | 1 | documentation | high | yes | docs | adapt | imports AGENTS.md |
| `config.example.yaml` | 1 | configuration | high | yes | config | translate | main app config template |
| `extensions_config.example.json` | 1 | configuration | high | yes | config | translate | MCP servers + skills registry -> .mcp.json/settings |
| `.env.example` | 1 | configuration | high | yes | config | translate | environment template |
| `{Makefile,.pre-commit-config.yaml,.gitignore,.gitattributes,.dockerignore}` | 5 | build and packaging | low | no | config | exclude | root orchestration + repo hygiene |
| `README translations, CHANGELOGs, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, RELEASING, Install.md, LICENSE` | 12 | documentation | low | no | docs | exclude | project meta-docs and translations |
| `deer-flow.code-workspace` | 1 | configuration | none | no | config | exclude | VS Code workspace |

## Reconciliation

Per-section row sums:

- Harness — root modules: 7
- Harness — agents: 94
- Harness — subsystems: 343
- Backend app (gateway): 92
- Backend tests: 511
- Backend misc: 70
- Frontend: 696
- Skills: 122
- Scripts: 41
- Docs: 36
- Deploy and CI: 79
- Repo root: 24

Total: 7 + 94 + 343 + 92 + 511 + 70 + 696 + 122 + 41 + 36 + 79 + 24 = **2115**, matching `git ls-files | wc -l` = 2115. 
Coverage was machine-verified: every tracked file matched exactly one row (first-match-wins rule set; zero unmatched, zero double-counted).
