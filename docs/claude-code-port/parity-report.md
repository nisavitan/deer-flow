# Parity Report — DeerFlow harness → Claude Code port

- **Original engine:** `bytedance/deer-flow@095092418ccf072aa866c0a663c4056c206091e5`
- **Port:** `ports/claude-code/` (milestones M1–M13 landed; M14 added the O3 hook log, the compaction-boundary memory flush, and the traceability-matrix status hygiene)
- **Date:** 2026-08-01 (M14)
- **Sources of truth, in precedence order:**
  1. `ports/claude-code/src/**` and its tests — what actually runs.
  2. `ports/claude-code/parity/baseline/*.json` — vectors extracted by executing the original Python at `0950924` (`parity/baseline/extract_vectors.py`).
  3. `ports/claude-code/parity/DISCREPANCIES.md` — every knowing divergence, with its declared kind.
  4. `docs/claude-code-port/traceability-matrix.md` — the planning-time row inventory.
- **Rule applied throughout:** where the matrix (planning) and the implementation disagree, the implementation wins and the delta is named in §5.3. Where a classification is arguable, the **pessimistic** reading is taken — the same bias `src/summary/context-loss.ts` applies to recall scoring. A parity number that flatters the port is worthless.

Everything below is machine-counted from the files named. No number in this report is an estimate.

> **Final five-way computation (post-closure): §8.** Recomputed with an `unverified` class under an evidence-tier rule; for any claim about what the port *demonstrably* does, §8 supersedes the four-way split in §5.

---

## 1. Traceability-matrix accounting

### 1.1 Rows by status

Counted by parsing every 16-column data row in `docs/claude-code-port/traceability-matrix.md` (§1–§11), classifying on the leading token of the **Status** column.

| Status class | Rows | Share of 199 |
|---|---:|---:|
| implemented (M2–M13) | 44 | 22.1% |
| partial | 7 | 3.5% |
| deferred | 1 | 0.5% |
| omitted / intentionally omitted | 4 | 2.0% |
| confirmed replace-with-native | 1 | 0.5% |
| platform-native (no port code; capability verified) | 44 | 22.1% |
| excluded (delivery) | 9 | 4.5% |
| needs-investigation | 11 | 5.5% |
| planned | 78 | 39.2% |
| **Total data rows** | **199** | **100%** |

The matrix's own summary block claimed **195** rows. Four rows were added during implementation (§1 +1, §3 +1, §4 +1, §6 +1) and the summary was never recounted. Task 2 of this milestone fixes that; the matrix summary now reads 199.

**Status hygiene applied at M14.** The first edition of this report counted `planned 131` and flagged that the number conflated three different things (§1.3 caveat 1). The matrix Status cells have since been corrected — **and only the Status cells**:

- the **9 §11 excluded-group rows** now read `excluded (delivery)`. §11's own header says these subpackages are out of scope; `planned` was a label nobody ever set.
- **44 rows** whose Port method is `replace with native Claude Code primitive` now read `platform-native (no port code; capability verified)` — the native behaviour is covered by `claude-code-capabilities.md` / `experiment-results.md` (sessions, MCP, compaction, model invocation, vision, uploads-as-files, session titles, ToolSearch, native skill loading, the agentic loop's own pairing/retry/refusal handling) and there is no port code left to write.
- **12 replace-native rows deliberately stayed `planned`**, because the native replacement still needs port-side wiring: per-skill `allowed-tools` grants (`skill_tool_policy_middleware.py`, `skills/tool_policy.py`), the Stop-hook todo nudge (`todo_middleware.py`), AskUserQuestion form-mode (`clarification_middleware.py`, `clarification_tool.py`, `human_input.py` — and AskUserQuestion is not in the capabilities matrix at all), agent-file authoring (`setup_agent_tool.py`), permission-rule and cap authoring (`sandbox/security.py`, `local_sandbox.py`, `guardrails/builtin.py`), the ignore-list delta (`sandbox/search.py` — native Glob/Grep are not a capabilities-matrix row), and `top_k` in `deerflow.json` (`skills_config.py + tool_search_config.py`).

**No Behavior-preserved cell, Port-method cell, or row was changed.** Every percentage in §5 derives from the Behavior column, so §5 is byte-identical to the pre-hygiene edition; this section and §2 are the only places the numbers move.

### 1.2 Implemented rows by milestone

Attributed to the **first** milestone cited in the Status cell (a row that says `implemented (M5, contract doc; M13, enforcement restored)` counts once, at M5, and the M13 half is recorded as a delta in §5.3).

| Milestone | Rows | What landed |
|---|---:|---|
| M2 | 6 | state schema + reducers, goal schema, run-meta identity, checkpoint state, subagent clamps |
| M3 | 3 | lead system prompt (byte-exact after whitelist), TODO rules block, skill-index section |
| M4 | 2 | `skills/public/**` conversion (16 packs + 7 optional) |
| M5 | 9 | 7 sandbox-tool mappings, `present_file_tool` contract, `env_policy` scrub lists |
| M6 | 6 | subagent executor, status contract, both builtins, task tool, dispatch |
| M7 | 3 | loop detection, tool-meta taxonomy, read-before-write |
| M8 | 2 | summarization durable half, `context_compaction` digest CLI |
| M9 | 7 | DeerMem storage/updater/prompt/prompts-yaml, manager, queue, injection |
| M10 | 1 | worker orphan/crash-recovery subset |
| M11 | 1 | goal evaluation loop |
| M13 | 4 | `workspace_changes/{types,scanner,diff,recorder+api}` |
| **Total** | **44** | |

### 1.3 Rows by section

"native" is the single `confirmed replace-with-native` row (`runtime/checkpoint_mode.py`), which is kept separate from `platform-native` because it retains a port-side remnant — the `schema_version` fail-closed gate in `src/resume/staleness.ts`.

| § | Section | Rows | impl | partial | deferred | omitted | native | platform-native | excluded | needs-inv | planned |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | Lead agent, factory, state, client | 14 | 4 | 1 | — | — | — | 2 | — | — | 7 |
| 2 | Middlewares | 42 | 5 | 4 | 1 | — | — | 13 | — | 3 | 16 |
| 3 | Runtime | 23 | 5 | 1 | — | — | 1 | 3 | — | 1 | 12 |
| 4 | Subagents | 10 | 6 | — | — | 1 | — | — | — | — | 3 |
| 5 | Tools | 21 | 8 | — | — | — | — | 5 | — | 3 | 5 |
| 6 | Skills | 17 | 3 | — | — | — | — | 7 | — | 2 | 5 |
| 7 | Memory | 13 | 7 | — | — | 3 | — | — | — | — | 3 |
| 8 | Sandbox / workspace / uploads | 17 | 5 | — | — | — | — | 7 | — | — | 5 |
| 9 | MCP / authz / guardrails | 9 | — | — | — | — | — | 4 | — | 1 | 4 |
| 10 | Models / config | 24 | 1 | 1 | — | — | — | 3 | — | 1 | 18 |
| 11 | Excluded groups | 9 | — | — | — | — | — | — | 9 | — | — |
| | **Total** | **199** | **44** | **7** | **1** | **4** | **1** | **44** | **9** | **11** | **78** |

**Two honest caveats on this table.**

1. The mislabels are now fixed in the data, not annotated around. §11's 9 rows read `excluded (delivery)` and 44 replace-native rows read `platform-native`; what remains under `planned` is 78 rows of real port work. The correction cuts `planned` by 53 rows (131 → 78) **without porting a line of the original** — which is exactly why it is stated as hygiene and kept out of every parity percentage in §5.
2. §9 (MCP / authz / guardrails) has **zero** implemented rows — but 4 of its 9 are now `platform-native` (MCP client params, cache, session pool, OAuth), so the untouched engine surface there is 4 planned + 1 needs-investigation, not 8. §10 is now the largest genuinely-planned section (18 rows).

---

## 2. Not ported — the honest list

**84 rows are still `planned` (77) or `partial` (7).** Adding the rows that are neither ported nor plannable as-is — `needs-investigation` (11) and `deferred` (1) — gives **96 of 199 rows without a completed port**.

Before the M14 status hygiene (§1.1) these read 138 and 150. The 53-row difference is entirely the 44 `platform-native` and 9 `excluded (delivery)` rows, which were never port work: **no row moved because anything was implemented.** Both sets are listed in full at the end of this section so the shrunken count can be audited line by line.

Every one is listed below with the reason recorded in the matrix's own Reason column (for `planned` / `needs-investigation`) or the Status cell's qualifier (for `partial` / `deferred`, where the qualifier states precisely which half is done).

#### Still `partial` — 7 rows

| § | Original file | Symbol | Port target | Reason recorded in the matrix |
|---|---|---|---|---|
| §1 | `agents/lead_agent/prompt.py` | get_skills_prompt_section, _get_memory_context | src/prompts/lead.ts (renderSkillSystemSection) + turn-con… | partial (M3: deferred skill-index section rendered; `_get_memory_context` still pending with the turn-context hook) |
| §2 | `agents/middlewares/tool_error_handling_middleware.py` | ToolErrorHandlingMiddleware | src/hooks/post-tool-meta.ts | partial (M7: taxonomy classification + delivery done; `skill_context_entry` stamping on skill-file reads still pending with the skill-context lane) |
| §2 | `agents/middlewares/dynamic_context_middleware.py` | DynamicContextMiddleware | src/hooks/turn-context.ts (additionalContext) | partial (M7: date reminder verbatim + durable projection wired; the `<memory>` block is the M9 memory lane's and is deliberately absent) |
| §2 | `agents/middlewares/durable_context_middleware.py` | DurableContextMiddleware | src/summary/durable-context.ts (render) + src/hooks/turn-… | partial (M8 rendered it; M7 wired the UserPromptSubmit injection and the deep-run ledger capture; skill-context capture on skill-file reads still pending) |
| §2 | `agents/middlewares/terminal_response_middleware.py` | TerminalResponseMiddleware | skills/run terminal-response discipline (M3) + src/hooks/… | partial (M3 prompt discipline + M11 Stop-hook evidence gate; one-shot retry and error fallback remain absent — see note) |
| §3 | `runtime/runs/manager.py` | RunManager (create_or_reject, cancel, leases, reconciliation) | single-process admission in deep-run + state lock | partial (M10: the reconciliation subset — expired-active reclaim → `orphan_recovered` + receipt backfill — is implemented in src/resume/recovery.ts; admission, cancel actions and takeover remain planned) |
| §10 | `config/loop_detection_config.py` | LoopDetectionConfig | src/middleware/loop-detection.ts defaults + deerflow.json | partial (M7: every threshold is a named exported constant asserted against the baseline `config_defaults`, and `tool_freq_overrides` is honoured; the deerflow.json loader that would override them is not wired) |

#### Still `deferred` — 1 rows

| § | Original file | Symbol | Port target | Reason recorded in the matrix |
|---|---|---|---|---|
| §2 | `agents/middlewares/tool_progress_middleware.py` | ToolProgressMiddleware | loop-progress-guard hook + .deerflow/state | deferred (not in M7): `tool_progress.enabled` defaults False upstream and baseline G2 was skipped, so M7 ships the loop-detection layer only. NOT "intentionally omitted" — middleware-port-plan.md §13 judges deterministic parity… |

#### Still `needs-investigation` — 11 rows

| § | Original file | Symbol | Port target | Reason recorded in the matrix |
|---|---|---|---|---|
| §2 | `agents/middlewares/skill_activation_middleware.py` | SkillActivationMiddleware | native Skill tool / slash commands | CC skills activate natively |
| §2 | `agents/middlewares/mcp_routing_middleware.py` | McpRoutingMiddleware | ToolSearch + routing-hint prompt section | CC ToolSearch lacks auto-promote channel |
| §2 | `agents/middlewares/token_budget_middleware.py` | TokenBudgetMiddleware | loop-progress-guard hook + state counters | budget policy preserved; plumbing differs |
| §3 | `checkpoint_patches.py` | InMemorySaver/BinOp patches | none (no LangGraph in port) | verify no hidden semantic dependency |
| §5 | `tools/builtins/update_agent_tool.py` | update_agent | agent .md edit flow + guard notes in prompt | webhook-channel threat model differs in CC |
| §5 | `tools/builtins/invoke_acp_agent_tool.py` | invoke_acp_agent | MCP servers or Bash-spawned CLIs | no CC ACP analog (notes §8) |
| §5 | `tools/skill_manage_tool.py` | skill_manage | direct file edits + skill-creator skill | decide whether to keep scan gate |
| §6 | `skills/slash.py` | resolve_slash_skill, reserved names | native slash commands | CC slash commands are native |
| §6 | `skills/installer.py` | safe_extract_skill_archive + install flow | plugin/marketplace install (CC native) | CC plugin install replaces flow |
| §9 | `mcp/tools.py` | get_mcp_tools, result path translation, name gate | native MCP; path/cwd policy re-homed | transport native; policy is engine behavior |
| §10 | `scripts/export_claude_code_oauth.py` | OAuth bridge script | none (direction inverts) | bridge unnecessary inside CC |

#### Still `planned` — 78 rows

| § | Original file | Symbol | Port target | Reason recorded in the matrix |
|---|---|---|---|---|
| §1 | `agents/lead_agent/agent.py` | make_lead_agent, _make_lead_agent | skills/run + workflows/deep-run.js assembly | graph machinery is platform-owned |
| §1 | `agents/lead_agent/agent.py` | build_middlewares | hooks/hooks.json ordering + src/policy | AgentMiddleware semantics don't exist in CC |
| §1 | `agents/lead_agent/agent.py` | resolution helpers (_resolve_model_name, _resolve_runtime_option) | config/deerflow.json + run skill options | CC owns model layer |
| §1 | `agents/factory.py` | create_deerflow_agent | folded into deep-run.js + config flags | port unifies dual assembly (noted hazard) |
| §1 | `agents/features.py` | RuntimeFeatures, Next/Prev | config/deerflow.json feature knobs | no middleware objects in CC |
| §1 | `agents/human_input.py` | read_human_input_response | native AskUserQuestion reply flow | CC owns human-input transport |
| §1 | `constants.py` | shared constants | src/ constants module | trivial carrier |
| §2 | `agents/middlewares/input_sanitization_middleware.py` | InputSanitizationMiddleware | turn-context hook (UserPromptSubmit rewrite) | no per-model-call rewrite hook in CC |
| §2 | `agents/middlewares/tool_output_budget_middleware.py` | ToolOutputBudgetMiddleware | post-tool-meta hook (PostToolUse rewrite) | thresholds are model-visible policy |
| §2 | `agents/middlewares/tool_output_synopsis.py` | typed synopsis builders | post-tool-meta hook helper | deterministic formatting, portable |
| §2 | `agents/middlewares/tool_result_sanitization_middleware.py` | ToolResultSanitizationMiddleware | post-tool-meta hook | known name-allowlist gap carried over |
| §2 | `agents/middlewares/thread_data_middleware.py` | ThreadDataMiddleware | run skill init + src/state/run-meta.ts | host FS replaces virtual layout |
| §2 | `agents/middlewares/sandbox_audit_middleware.py` | SandboxAuditMiddleware | pre-tool-guard hook (PreToolUse deny/warn) | rule set is safety policy |
| §2 | `agents/middlewares/tool_error_handling_middleware.py` | _build_runtime_middlewares, build_lead/subagent_runtime_middlewares | hooks.json wiring + deep-run.js chain | assembly logic re-expressed |
| §2 | `agents/middlewares/skill_tool_policy_middleware.py` | SkillToolPolicyMiddleware | native skill allowed-tools frontmatter | CC treats allowed-tools as permission pre-grant |
| §2 | `agents/middlewares/todo_middleware.py` | TodoMiddleware | native todos + plan skill (Stop-hook nudge) | CC TodoWrite covers the discipline |
| §2 | `agents/middlewares/token_usage_middleware.py` | TokenUsageMiddleware | none (UI accounting) | CC surfaces usage natively |
| §2 | `agents/middlewares/memory_middleware.py` | MemoryMiddleware | Stop-hook memory capture (auto-memory dir) | no long-lived server process |
| §2 | `agents/middlewares/clarification_middleware.py` | ClarificationMiddleware | native AskUserQuestion | CC question tool lacks structured forms |
| §2 | `agents/middlewares/_bounded_dict.py` | BoundedDict | src/state helper (bounded map) | trivial utility used by guards |
| §2 | `agents/middlewares/configured_extensions.py` | load_configured_extension_middlewares | none | CC plugins are the extension model |
| §2 | `agents/middlewares/delegation_ledger.py` | extract_delegations, render_delegation_ledger | src/state/delegations.ts | ledger is durable-context core |
| §2 | `agents/middlewares/skill_context.py` | build_skill_entry_metadata_from_read, extractor, renderer | src/state/skill-context.ts | reference-not-body policy preserved |
| §3 | `runtime/runs/worker.py` | run_agent (admission→stream→terminal) | workflows/deep-run.js + Stop hook + state files | multi-worker HTTP concerns dropped (honest delta 5) |
| §3 | `runtime/runs/worker.py` | rollback + delta linearization (_capture_rollback_point, _linearize_delta_checkpoint_resume) | state-file snapshot/restore in deep-run | rollback = restore materialized capture rule kept |
| §3 | `runtime/runs/worker.py` | receipts/title/duration finalizers (_persist_delivery_receipt, _ensure_interrupted_title) | journal.json ordered writes in state lib | receipt-before-status is crash-safety contract |
| §3 | `runtime/runs/naming.py` | resolve_root_run_name | src/state/run-meta.ts | trivial |
| §3 | `runtime/journal.py` | RunJournal | journal writer in src/state (JSONL) | event feed identity (run_id, seq) preserved |
| §3 | `runtime/events/catalog.py` | EVENT catalog (13 types) | src/state event taxonomy | consumers rely on the taxonomy |
| §3 | `runtime/events/store/base.py` | RunEventStore ABC (seq, put_if_absent) | JSONL journal with same contract | seq + put_if_absent are correctness contracts |
| §3 | `runtime/events/store/jsonl.py` | JsonlRunEventStore | src/state journal impl | closest existing impl to port storage |
| §3 | `runtime/stream_bridge/**` | StreamBridge base/memory/redis | none (in-process rendering) | plain callback keeps END semantics |
| §3 | `runtime/serialization.py` | serialize_channel_values | display filtering in run skill output | hidden-message categories noted in port |
| §3 | `runtime/secret_context.py` | redact_config_secrets, read_active_secrets | env-contract docs + hook env scrub | secrecy policy kept, carrier differs |
| §3 | `runtime/context_keys.py` | __deerflow_pre_run_message_ids et al. | src/state key constants | boundary detection depends on these |
| §4 | `subagents/config.py` | SubagentConfig, resolve_subagent_model_name | src/policy/caps.ts + agent frontmatter | defaults 50 turns/900s are policy |
| §4 | `subagents/registry.py` | get_subagent_config, get_available_subagent_names | plugin agents/ dir + deep-run resolution | resolution precedence preserved |
| §4 | `contracts/subagent_status_contract.json` | v2 status/stop_reason fixture | contracts/ copied into plugin | already language-neutral JSON |
| §5 | `tools/tools.py` | get_available_tools | plugin tool mapping + permission allowlist | assembly precedence preserved as config |
| §5 | `tools/builtins/clarification_tool.py` | ask_clarification (schema only) | native AskUserQuestion | schema owned by CC tool |
| §5 | `tools/builtins/setup_agent_tool.py` | setup_agent | agent .md files via Write (bootstrap skill) | no dedicated tool needed |
| §5 | `community/** (search/crawl/browse: brave, ddg, exa, firecrawl, jina, serper, searxng, crawl4ai, readability, browser automation, …)` | provider tool modules | MCP servers or native WebSearch/WebFetch | CC natives cover common cases; rest via MCP |
| §5 | `utils/**` | message/file/LLM-text helpers | src/ shared helpers | small pure helpers used by translated code |
| §6 | `skills/validation.py` | install-time validation (name/description rules) | optional pre-install lint script | worth keeping for authoring quality |
| §6 | `skills/tool_policy.py` | allowed_tool_names_for_skills, framework exemptions | per-skill allowed-tools frontmatter | semantic model differs (notes §6) |
| §6 | `skills/skillscan/**` | scan_archive_preflight, scan_skill_dir, RuleSpecs | kept as scanner script (skill-authoring lint) | inventory: keep security scanner |
| §6 | `skills/review/** + tools/review_skill_package` | analyze_skill_package, CLI, schemas | skill-reviewer skill + reused review CLI | deterministic, engine-agnostic |
| §6 | `.agent/skills/**` | repo-maintainer skills | stay in repo unchanged | repo tooling, not shipped |
| §7 | `agents/memory/summarization_hook.py` | memory_flush_hook | PreCompact/Stop hook capture | compacted history must not be lost |
| §7 | `agents/memory/backends/noop/**` | NoopMemoryManager | none | template for a backend system the port drops |
| §7 | `agents/memory/backends/mem0/**, openviking/**` | hosted-service adapters | none | hosted multi-tenant backends out of scope |
| §8 | `sandbox/local/local_sandbox.py` | LocalSandbox | none; policy knobs move to hooks | host FS is native; policy preserved |
| §8 | `sandbox/security.py` | is_host_bash_allowed | permission rules (Bash allow/deny) | permission system owns this |
| §8 | `sandbox/search.py` | glob/grep engine + IGNORE_PATTERNS | native Glob/Grep (ignore list noted) | native tools equivalent |
| §8 | `config/paths.py` | Paths, resolve_virtual_path, ensure_thread_dirs | .deerflow/ + outputs/ convention (src/state) | outputs contract survives as convention |
| §8 | `uploads/manager.py` | upload helpers (staging, TOCTOU guards) | none | uploads are a gateway/HTTP feature |
| §9 | `guardrails/provider.py` | GuardrailProvider protocol, GuardrailRequest/Decision | src/policy guard interface (pre-tool-guard) | pluggable deny surface worth keeping |
| §9 | `guardrails/builtin.py` | AllowlistProvider | CC permission rules + hook fallback | permissions system covers allowlists |
| §9 | `guardrails/middleware.py` | GuardrailMiddleware | pre-tool-guard hook (PreToolUse deny) | verified hook capability (E4) |
| §9 | `authz/** (8 files)` | RBAC provider, Principal, two-layer enforcement | none | multi-user RBAC out of single-user CC scope |
| §10 | `models/openai_codex_provider.py` | Codex Responses-API model | none | non-Claude provider, Claude-only platform |
| §10 | `models/{vllm,mindie,patched_*}.py + assistant_payload_replay.py` | provider-compat adapters | none | provider-compat obsolete on Claude-only platform |
| §10 | `config/app_config.py` | AppConfig, get_app_config, reload | config/deerflow.json loader (knob subset) | infra sections dropped |
| §10 | `config/tool_progress_config.py` | ToolProgressConfig | deerflow.json + src/policy | same |
| §10 | `config/token_budget_config.py` | TokenBudgetConfig | deerflow.json | same |
| §10 | `config/tool_output_config.py` | ToolOutputConfig | deerflow.json | model-visible output policy |
| §10 | `config/summarization_config.py` | SummarizationConfig | deerflow.json (deep-run only) + native compaction | honest delta 1 |
| §10 | `config/skills_config.py + tool_search_config.py` | SkillsConfig, ToolSearchConfig | native skills + ToolSearch (top_k in deerflow.json) | native mechanisms exist |
| §10 | `config/memory_config.py` | MemoryConfig + legacy migration | deerflow.json memory knobs | knobs preserved (debounce→cadence, budgets) |
| §10 | `config/sandbox_config.py` | SandboxConfig | deerflow.json (caps only); provider fields dropped | caps are model-visible policy |
| §10 | `config/agents_config.py` | AgentConfig (custom agents) | .claude/agents frontmatter mapping | custom agents map to agent files |
| §10 | `config/{authorization,guardrails,read_before_write,safety_finish_reason,token_usage,title,suggestions,input_polish}_config.py` | small toggle schemas | deerflow.json subset (only surviving features) | follows each feature's row |
| §10 | `config/{database,checkpointer,run_events,stream_bridge,run_ownership,scheduler,agent_storage,agents_api,dedupe_storage,auth,channel_connections,acp}_config.py` | infra section schemas | none | multi-worker Gateway/DB infrastructure |
| §10 | `config/extensions_config.py` | ExtensionsConfig + atomic write | .mcp.json + plugin settings mapping | inventory: translate |
| §10 | `config.example.yaml (repo root)` | main config template | config/deerflow.json template (knob subset) | template for surviving knobs |
| §10 | `extensions_config.example.json (repo root)` | MCP+skills template | .mcp.json example | direct mapping |
| §10 | `.env.example (repo root)` | environment template | documented env contract (required-secrets doc) | secrets contract must be explicit |
| §10 | `backend/packages/harness/pyproject.toml` | dependency manifest | plugin package.json | dependency set is TS now |

#### Not counted above — `platform-native` (44) and `excluded (delivery)` (9)

These 53 rows carry no outstanding port work and are listed here so the 78 above cannot be read as a shrunken scope. They were `planned` until the M14 status hygiene (§1.1).

**`platform-native (no port code; capability verified)` — 44**

| § | Original file | Symbol | Native replacement | Reason recorded in the matrix |
|---|---|---|---|---|
| §1 | `agents/thread_state.py` | delta mode (merge_message_writes, DeltaChannel adapters) | native sessions (conversation store) | sessions own transcript storage |
| §1 | `client.py` | DeerFlowClient (stream/chat/goal APIs) | CC session + CLI (claude, --resume) | CC is the client |
| §2 | `agents/middlewares/uploads_middleware.py` | UploadsMiddleware | native file mentions / Read | CC users reference files directly |
| §2 | `sandbox/middleware.py` | SandboxMiddleware | none (host FS native) | CC tools run in cwd |
| §2 | `agents/middlewares/dangling_tool_call_middleware.py` | DanglingToolCallMiddleware | none (platform guarantees pairing) | provider-compat artifact |
| §2 | `agents/middlewares/llm_error_handling_middleware.py` | LLMErrorHandlingMiddleware | none (CC owns retries) | CC model layer handles transport errors |
| §2 | `agents/middlewares/title_middleware.py` | TitleMiddleware | none (CC session titles) | native session naming |
| §2 | `agents/middlewares/view_image_middleware.py` | ViewImageMiddleware | native Read (images) | Read handles images natively |
| §2 | `agents/middlewares/deferred_tool_filter_middleware.py` | DeferredToolFilterMiddleware | native ToolSearch deferral | CC has the same mechanism built in |
| §2 | `agents/middlewares/system_message_coalescing_middleware.py` | SystemMessageCoalescingMiddleware | none (platform guarantees) | honest delta 4 |
| §2 | `agents/middlewares/model_length_finish_reason_middleware.py` | ModelLengthFinishReasonMiddleware | none (platform surfaces max-tokens) | Claude-only platform |
| §2 | `agents/middlewares/model_length_termination_detectors.py` | 3 provider detectors | none | same as above |
| §2 | `agents/middlewares/safety_finish_reason_middleware.py` | SafetyFinishReasonMiddleware | none (CC surfaces refusals) | provider-compat artifact |
| §2 | `agents/middlewares/safety_termination_detectors.py` | OpenAI/Anthropic/Gemini detectors | none | Claude-only platform |
| §2 | `agents/middlewares/tool_call_metadata.py` | clone_ai_message_with_tool_calls | none (no message rewriting in port) | hooks deny before dispatch instead |
| §3 | `runtime/stream_modes.py` | normalize_stream_modes | none (CC streaming native) | CC owns streaming |
| §3 | `runtime/checkpointer/**, runtime/store/**` | provider factories (memory/sqlite/postgres) | native session persistence | sessions + state files replace savers |
| §3 | `runtime/user_context.py` | resolve_runtime_user_id | none (single-user machine) | identity collapses to OS user |
| §5 | `tools/sync.py` | make_sync_tool_wrapper | none | Python-runtime artifact |
| §5 | `tools/mcp_metadata.py` | tag_mcp_tool | none (native MCP tagging) | — |
| §5 | `tools/builtins/tool_search.py` | build_deferred_tool_setup, DeferredToolCatalog | native ToolSearch | CC ToolSearch mirrors query forms exactly |
| §5 | `tools/builtins/view_image_tool.py` | view_image | native Read (images) | deferred-injection optimization unneeded |
| §5 | `tools/builtins (list_uploaded_files)` | list_uploaded_files | none (native file listing) | Bash/Glob covers listing |
| §6 | `skills/types.py` | Skill dataclass, SkillCategory | native skill format (dir + SKILL.md) | CC skills are the same shape natively |
| §6 | `skills/frontmatter.py` | shared frontmatter regex/allowed keys | native frontmatter parsing | CC parses SKILL.md itself |
| §6 | `skills/parser.py` | parse_skill_file | native skill loading | same |
| §6 | `skills/storage/**` | LocalSkillStorage, UserScopedSkillStorage, template method | skills/ dir as source of truth | single-user; dirs are truth |
| §6 | `skills/catalog.py` | SkillCatalog (select:/+/keyword) | native skill discovery | CC loads name+description natively |
| §6 | `skills/projection.py` | ensure_skill_projections | none (skills dir is source of truth) | no mounts on host |
| §6 | `skills/permissions.py` | chmod policy 0555/0444 | none | — |
| §8 | `sandbox/sandbox.py` | Sandbox ABC (8 methods) | none (native tools are the interface) | Bash/Read/Write/Edit/Glob/Grep cover it |
| §8 | `sandbox/sandbox_provider.py` | SandboxProvider ABC + singleton | none | same |
| §8 | `sandbox/local/local_sandbox_provider.py` | LocalSandboxProvider | none | cwd replaces per-thread dirs |
| §8 | `sandbox/file_operation_lock.py` | get_file_operation_lock | none (single-writer process) | concurrency model differs |
| §8 | `sandbox/overwrite.py` | unwrap_sandbox | none | — |
| §8 | `sandbox/path_patterns.py` | build_output_mask_pattern | none (no virtual paths) | — |
| §8 | `sandbox/exceptions.py` | SandboxError hierarchy | none | — |
| §9 | `mcp/client.py` | build_server_params | native .mcp.json | CC MCP client is native |
| §9 | `mcp/cache.py` | get_cached_mcp_tools + signature staleness | native MCP config reload | CC manages MCP tool lifecycle |
| §9 | `mcp/session_pool.py` | MCPSessionPool | native MCP session management | CC owns MCP sessions |
| §9 | `mcp/oauth.py` | OAuthTokenManager + interceptor | native MCP OAuth | native capability |
| §10 | `models/factory.py` | create_chat_model | none (CC owns model creation) | model choice via CC `model` field |
| §10 | `models/claude_provider.py` | ClaudeChatModel | none (deleted, not translated) | port runs inside the real thing |
| §10 | `models/credential_loader.py` | load_claude_code_credential, is_oauth_token | none | — |

**`excluded (delivery)` — 9**

| § | Original file | Symbol | Port target | Reason recorded in the matrix |
|---|---|---|---|---|
| §11 | `persistence/run/model.py + thread_meta/model.py` | runs/threads_meta field lists | run-meta.json field schema | field list feeds run-meta design |
| §11 | `persistence/** (rest, 51 files: SQL stores, alembic)` | repositories + migrations | native sessions + state files | server database layer; sessions/state files replace it |
| §11 | `community/{aio_sandbox,boxlite,e2b_sandbox,tenki}/** + warm_pool_lifecycle.py (26)` | remote sandbox providers | none | remote isolation infra; CC runs on host (worktree isolation instead) |
| §11 | `tui/** (15)` | Textual TUI client | none (Claude Code IS the TUI) | CC interactive session replaces it; proves engine facade |
| §11 | `integrations/** (3)` | Lark CLI integration + broker | none | IM-platform delivery integration |
| §11 | `tracing/** (4)` | Langfuse/LangSmith/Monocle wiring | none (CC/OTEL native telemetry) | cross-cutting observability, not engine behavior |
| §11 | `scheduler/** (2)` | schedules.py cron math | none (native schedule skill / routines) | CC scheduled agents cover the use case |
| §11 | `reflection/** (2)` | resolve_variable/resolve_class | none | Python plugin-loading mechanism |
| §11 | `__init__.py, logging_config.py, trace_context.py` | package exports, logging, trace ids | none | packaging/observability glue |

---

## 3. Discrepancy accounting

`ports/claude-code/parity/DISCREPANCIES.md` carries **49 entries** across six milestone sections. Each entry declares a **Kind**; the file's own legend defines four (`blocked`, `degraded`, `relocated`, `intentionally omitted`) and the entries in practice use ten label variants. (Eleven before M14 closed §M8 entry 4, which was the sole `blocked (until M9)` — see §3.4.)

The labels exactly as written, before any mapping:

| Kind label as written | Entries |
|---|---:|
| `relocated` | 18 |
| `degraded` | 13 |
| `intentionally omitted` | 9 |
| `blocked` | 2 |
| `degraded (defensive)` | 2 |
| `declared absence` | 1 |
| `declared decision` | 1 |
| `degraded (declared naming deviation)` | 1 |
| `degraded (more sensitive)` | 1 |
| `relocated (required)` | 1 |
| **Total** | **49** |

### 3.1 Mapping the labels onto the requested classes

| Requested class | Definition applied | Entries | Mapped from |
|---|---|---:|---|
| **exact-replacement-not-needed** | The platform already guarantees the behaviour; the port's code is belt-and-braces, not a gap. | 1 | `declared decision` |
| **relocated** | Behaviour fully preserved, produced at a different point in the pipeline. | 19 | `relocated` (18) + `relocated (required)` (1) |
| **degraded** (= approximate) | Behaviour exists but is weaker, differently triggered, or more sensitive. | 17 | `degraded` (13) + `degraded (defensive)` (2) + `degraded (declared naming deviation)` (1) + `degraded (more sensitive)` (1) |
| **intentionally omitted** | Deliberately not carried, with a stated reason. | 9 | `intentionally omitted` |
| **deferred** | Not a decision to drop — carry-over work with a named owner. | 1 | `declared absence` (1) |
| **blocked** | The platform provides no mechanism; the behaviour is absent and cannot be recovered by more port work. | 2 | `blocked` |
| **approximate** (as a distinct label) | — | 0 | The file expresses "approximate" as `degraded`; no entry is labelled `approximate`. |
| **Total** | | **49** | |

### 3.2 Entry-by-entry classification

**exact-replacement-not-needed — 1**

| Milestone | # | Entry | Label as written |
|---|---:|---|---|
| M7 | 9 | The read-before-write hook duplicates a native rule, against the port plan's own judgment | declared decision |

**relocated — 19**

| Milestone | # | Entry | Label as written |
|---|---:|---|---|
| M6 | 4 | Per-run limit note fires on drop, not on re-request | relocated |
| M6 | 7 | Delegation ledger is written by the lead session, not by a hook | relocated |
| M6 | 8 | Timestamps and digests are stamped after the workflow returns | relocated |
| M6 | 9 | Delegation id derivation | relocated |
| M6 | 11 | Plugin agents are namespace-qualified at the call site | relocated |
| M6 | 13 | Structured terminal metadata has no transport channel | relocated |
| M8 | 4 | Memory flush at the compaction boundary (**relabelled at M14 — was `blocked (until M9)`**) | relocated |
| M8 | 6 | Durable-context projection uses one carrier, not two messages | relocated |
| M8 | 8 | `summary.json` carries fields the original channel did not | relocated |
| M11 | 2 | Hidden continuation message → Stop-hook block reason | relocated |
| M9 | 2 | Middleware-mode passive capture → Stop-hook queue | relocated |
| M7 | 1 | Loop enforcement moves from `after_model` to a PreToolUse deny | relocated |
| M7 | 3 | Warnings are context, not a queued `HumanMessage`; the hook never emits `allow` | relocated |
| M7 | 4 | Claude Code tool calls are translated into DeerFlow tool calls before hashing | relocated (required) |
| M7 | 5 | The `deerflow_tool_meta` taxonomy becomes model-visible | relocated |
| M7 | 8 | The block message names `Read`, not `read_file` | relocated |
| M7 | 11 | The delegation ledger is committed by a CLI, not by the graph write | relocated |
| M13 | 3 | Delivery enforcement blocks the turn instead of failing the run | relocated |
| M13 | 4 | "Presented" is read from the final message, not from a `present_files` call | relocated |

**degraded — 17**

| Milestone | # | Entry | Label as written |
|---|---:|---|---|
| M6 | 1 | Per-agent cancellation on timeout | degraded |
| M6 | 5 | Malformed cap arguments degrade instead of raising | degraded |
| M6 | 6 | `args` passed as a JSON string is parsed, not rejected | degraded (defensive) |
| M6 | 10 | Unknown `subagent_type` falls back instead of failing | degraded |
| M8 | 2 | The compaction summary is not DeerFlow's | degraded |
| M8 | 5 | The port parses the session transcript | degraded (defensive) |
| M8 | 7 | Manual compaction is two actions by two actors | degraded |
| M10 | 1 | Lease / heartbeat machinery → a single-process 2 h expiry constant | degraded |
| M10 | 3 | Orphans are terminalized `interrupted`, not `error` | degraded (declared naming deviation) |
| M11 | 1 | The goal evaluator is not independent | degraded |
| M11 | 3 | Durable-receipt and thread-unchanged predicates → evidence + CAS | degraded |
| M9 | 1 | 30-second debounce → batch-on-next-turn | degraded |
| M9 | 6 | Token counting is always the char estimate, never tiktoken | degraded |
| M7 | 2 | Detection is stepped per tool call, not per model response | degraded (more sensitive) |
| M7 | 7 | Read marks move from the message list to a state file | degraded |
| M7 | 10 | Turn context is injected every turn, not once per conversation | degraded |
| M13 | 2 | Snapshots are turn-level, not run-level | degraded |

**intentionally omitted — 9**

| Milestone | # | Entry | Label as written |
|---|---:|---|---|
| M6 | 3 | `subagent_limit_capped` excluded from the subagent result schema | intentionally omitted |
| M6 | 12 | Subagent step events | intentionally omitted |
| M8 | 3 | Summary-generation path is ported but unused | intentionally omitted |
| M10 | 2 | Per-superstep rollback → not applicable | intentionally omitted |
| M9 | 3 | FTS5/BM25 retrieval index → omitted | intentionally omitted |
| M9 | 4 | Locks, revisions, journal, v1→v2 migration → single-writer assumption | intentionally omitted |
| M9 | 5 | Fact Markdown omits the `# title` heading | intentionally omitted |
| M7 | 6 | Tool-output externalization is platform-native; only a soft warning survives | intentionally omitted |
| M13 | 1 | Unified diffs are not produced — only the summary and the receipt | intentionally omitted |

**deferred — 1**

| Milestone | # | Entry | Label as written |
|---|---:|---|---|
| M7 | 12 | ToolProgressMiddleware is deferred, not omitted | declared absence |

**blocked — 2**

| Milestone | # | Entry | Label as written |
|---|---:|---|---|
| M6 | 2 | `max_turns` and the token budget | blocked |
| M8 | 1 | Compaction trigger and keep policy | blocked |

### 3.3 The two genuinely blocked behaviours

1. **`max_turns` and the token budget** (M6 §2). Claude Code agent frontmatter has no turn limit and no token budget, and the harness surfaces no equivalent signal to the dispatcher. The original's `recursion_limit = 150 / 60`, `TokenBudgetMiddleware` (1M / 2M) and the partial-work recovery on a turn cap have no target. The *vocabulary* survives — all three cap values render correctly through `src/deeprun/result-format.ts` and are pinned by 60/60 golden renders — but the **detection** is absent, so a cap can only ever arrive self-reported by the subagent.
2. **Compaction trigger and keep policy** (M8 §1). Claude Code auto-compacts at ~85% of the window; there is no threshold, no OR-combined trigger list, no fraction-of-max, and no addressable keep window. The port never sees the token count, so the existing summary cannot weigh into the trigger either. A deployment cannot tune when compaction happens, and "the last 20 messages are intact" is no longer a guarantee the port can make.

### 3.4 The one unmet mitigation promise — closed at M14

`DISCREPANCIES.md` M8 §4 recorded the memory flush at the compaction boundary as **blocked (until M9)**, with the mitigation "the `PreCompact` hook already runs at exactly the right instant, so M9 adds the enqueue call at that point and nothing else."

**M9 did not add that call, and the first edition of this report found the promise unmet.** Verified at the time: `src/hooks/precompact-summary.ts` contained no reference to the memory queue. What M9 delivered instead was a **Stop-hook** capture path (`dist/hooks/memory-extract.js`), which runs at every turn boundary rather than at the compaction boundary. That narrowed the loss window substantially — most turns end before compaction fires — but did not close it: content that appeared and was compacted *within a single turn* was never enqueued.

**M14 added the call.** `src/hooks/precompact-summary.ts` now enqueues the conversation tail through `appendQueueEntry` after writing the digest, tagged `source: 'precompact-flush'` so a queue consumer can tell a boundary flush from the routine Stop capture. The Stop hook is unchanged and remains the routine path. Verified by `src/hooks/precompact-summary.test.ts` ("memory flush at the compaction boundary", 4 cases: tail enqueued on the digest path; half turn, malformed transcript and stand-down each queue nothing and still exit 0). The entry is relabelled **relocated** in §3.1/§3.2 above, and the residual differences are stated in the entry itself — the carrier is the transcript rather than the message list, and there is no `skip_memory_flush` counterpart for subagent sessions.

Resolution note (post-closure): the matrix row `agents/memory/summarization_hook.py :: memory_flush_hook` was flipped to `implemented (M14-fix: PreCompact enqueues conversation tail)` by orchestrator decision after the closure fixes landed; the count tables above include it as implemented (45). Its Behavior class is `approximate` either way, so no percentage depends on it.

---

## 4. Vector consumption

Every baseline JSON under `parity/baseline/` and the test file that replays it. "Vectors" are counted from the fixture; "tests" are the vitest test counts from the run recorded in §4.2.

### 4.1 Per fixture

| Baseline file | Vectors it holds | Consumed by | Tests |
|---|---|---|---:|
| `loop_detection.json` | 6 scenarios / **99 steps**; **9** hash relations; **8** `config_defaults` keys; **117** Python md5 literals (99 step `call_hash` + 2×9 relation hashes) | `src/middleware/loop-detection.test.ts` | 24 |
| `tool_meta.json` | **38** `normalize_tool_result_cases` + **4** `stamp_exception_meta_cases` | `src/middleware/tool-meta.test.ts` | 51 |
| `subagent_status_contract.json` | **60** `result_message_formats`; 5 status values; 3 stop-reason values; the contract JSON | `src/deeprun/result-format.test.ts` (60 renders × 2 passes: message text + `additional_kwargs`), `src/deeprun/task-schema.test.ts`, `src/deeprun/workflow-sync.test.ts` | 141 / 21 / 129 |
| `caps_clamping.json` | **39** list vectors (9 `allowed_this_response` + 10 concurrency clamps + 10 total clamps + 10 constructor) + 1 `missing_run_id` case = **40** | `src/policy/caps.test.ts` (all four lists), `src/deeprun/batching.test.ts` + `workflow-sync.test.ts` (the 9 `allowed_this_response` replayed against the first batch) | 47 / 29 |
| `goal_counters.json` | **34** list vectors (11 `gate_matrix` + 10 `continuation_cap_walk` + 6 continuation clamps + 4 no-progress clamps + 3 no-progress sequences) + 3 `_pinned_fields` groups = **37** | `src/goal-loop/orchestrate.test.ts`, `src/goal-loop/goal-cli.test.ts`, `src/state/goal.test.ts` | 18 / 15 / 37 |
| `state_reducers.json` | **18** (4 `merge_artifacts` + 3 `merge_goal` + 5 `merge_promoted` + 6 `merge_skill_context`) | `src/state/artifacts.test.ts`, `src/state/goal.test.ts`, `src/state/promoted.test.ts`, `src/state/skill-context.test.ts` | 7 / 37 / 8 / 11 |
| `delegations_ledger.json` | **15** (10 `operations` + 5 `sequence`) + the `ledger_max_entries: 50` cap | `src/state/delegations.test.ts`, `src/deeprun/ledger-io.test.ts` | 16 / 15 |
| `prompt_renders/` (9 `.txt` goldens) | **3** lead-prompt config renders + `task_tool_description` + 2 subagent system prompts + 2 subagent descriptions + `non_interactive_tool_filter` | `src/prompts/lead.test.ts` (3 goldens × whitelist coverage), `src/deeprun/task-schema.test.ts` (sha256 of `task_tool_description.txt`) | 22 / 21 |

**Correction to the M14 brief.** The brief cited "117 md5 literals" for `loop_detection.json`. The file contains **122** 12-hex digest literals in total: 117 in the surfaces the replay asserts (99 scenario steps + 18 hash-relation endpoints) plus **5** more inside `scenarios.tool_frequency_warn30_hard50.boundary_steps` (steps 29, 30, 31, 49, 50), which the boundary assertions consume separately. The digests are truncated md5 (12 hex chars), not full md5. The 117 figure the brief quotes is the number `src/middleware/python-json.ts` claims in its header comment, and it is correct for the surfaces it names.

The reason the digests can be asserted as **literals** rather than as equal/not-equal relations is `src/middleware/python-json.ts`, which reproduces `json.dumps(value, sort_keys=True)` byte-for-byte (Python's `', '` / `': '` separators and `ensure_ascii=True`). `JSON.stringify` would change every digest. Three known limits are recorded in that file's header and none is reachable from the ported call sites.

### 4.2 The `parity` script

`package.json` gains:

```json
"parity": "vitest run src/middleware/loop-detection.test.ts src/middleware/tool-meta.test.ts src/deeprun/result-format.test.ts src/deeprun/batching.test.ts src/deeprun/workflow-sync.test.ts src/deeprun/task-schema.test.ts src/deeprun/ledger-io.test.ts src/policy/caps.test.ts src/state src/prompts/lead.test.ts src/goal-loop/orchestrate.test.ts src/goal-loop/goal-cli.test.ts"
```

The list was derived, not assumed: `grep -rl "parity/baseline" src --include="*.test.ts"` returns exactly **16** test files, and the script covers all 16 (`src/state` expands to the five state tests that load `state_reducers.json`/`delegations_ledger.json`/`goal_counters.json`, plus their four siblings). Three files the M14 brief's draft list omitted — `src/deeprun/task-schema.test.ts`, `src/deeprun/ledger-io.test.ts`, `src/goal-loop/goal-cli.test.ts` — are vector-driven and were added.

**Result: 20 files, 629 tests, exit 0.** Output pasted in §7.

`npm test` (the full suite) is 53 files / 1354 tests; the parity subset is the vector-replay core of it.

---

## 5. Final parity percentages

### 5.1 The denominator

| Step | Rows | Derivation |
|---|---:|---|
| All matrix data rows | 199 | §1.1 |
| − rows whose Port method is `exclude as delivery infrastructure` | −19 | not engine behaviour (all 19 carry `n/a` in Behavior-preserved). **Not the same set as the 9 rows whose M14 Status is `excluded (delivery)`** — that status marks §11's nine subpackage groups, three of which carry a `replace with native` method and one a `structural translation`; this row filters on the Port-method column, which the hygiene did not touch. |
| = engine-disposition rows | **180** | |
| − rows whose Behavior-preserved is `n/a (obsolete)` | −22 | the platform guarantees these by construction (dangling tool calls, LLM retry, sandbox lifecycle, …) |
| = **in-scope engine behaviours** | **158** | the denominator for every percentage below |

The planning matrix computed 156 by the identical method over 195 rows (195 − 17 − 22). The +2 is arithmetic, not a scope change: of the 4 rows added during implementation, 2 landed in the excluded bucket (17 → 19) and 2 are in-scope.

### 5.2 The four numbers

Base classification is each row's **Behavior-preserved** column; six rows are reclassified by implementation evidence (§5.3, deltas D1–D5).

| Class | Numerator | Denominator | Percentage |
|---|---:|---:|---:|
| **exact** | 45 | 158 | **28.5%** |
| **approximate** | 88 | 158 | **55.7%** |
| **intentionally omitted** | 23 | 158 | **14.6%** |
| **blocked** | 2 | 158 | **1.3%** |
| **Total** | **158** | **158** | **100%** (100.1 with per-line rounding) |

- **exact + approximate = 133 / 158 = 84.2%** of in-scope engine behaviour has an equivalent on the target.
- Counting the 22 platform-obsolete rows as trivially satisfied: (133 + 22) / 180 = **155 / 180 = 86.1%**.
- Change vs the planning matrix (over 156): exact 28.8% → 28.5%, approximate 59.0% → 55.7%, intentionally omitted 12.2% → 14.6%, blocked 0% → 1.3%. **The port got measurably more honest, not more complete**: implementation moved four rows out of "approximate" into "omitted" or "blocked" and two out of "exact" into "omitted".
- **These are dispositions, not delivery.** 45 rows are classified `exact`, but only **16** of those 45 are implemented (§5.5); across the whole matrix only 44 of 199 rows are implemented at all. A row classed `exact` and still `planned` means "when someone ports it, byte parity is achievable" — it does not mean anything ships today. Anyone quoting the 28.5% must quote that alongside it.

### 5.3 Classification deltas applied (planning → implementation)

| # | Row | Planning | Now | Evidence |
|---|---|---|---|---|
| D1 | §2 `tool_output_budget_middleware.py :: ToolOutputBudgetMiddleware` and `tool_output_synopsis.py :: typed synopsis builders` (2 rows) | exact | **intentionally omitted** | DISCREPANCIES M7 §6: not re-implemented; Claude Code already truncates and externalizes, and a second copy under `outputs/.tool-results/` "would fight the platform for the same job while doubling the bytes on disk". Only a soft >20,000-char warning survives, in `src/hooks/post-tool-meta.ts`. |
| D2 | §3 `runtime/runs/worker.py :: rollback + delta linearization` | approximate | **intentionally omitted** | DISCREPANCIES M10 §2: "M10 implements no rollback at all". "Restore superstep N" has no referent in the port — Layer 1 is the native turn-granular transcript, Layer 2 is whole-file state. Recovery quantum is the stage. |
| D3 | §7 `deermem core/retrieval.py :: FTS5/BM25 adapter` | approximate | **intentionally omitted** | DISCREPANCIES M9 §3; the matrix Status cell already reads `omitted (M9)` but the Behavior-preserved column was never updated. |
| D4 | §2 `token_budget_middleware.py :: TokenBudgetMiddleware` | approximate (status `needs-investigation`) | **blocked** | DISCREPANCIES M6 §2. The investigation concluded: no token budget and no equivalent signal exist. This is the `needs-investigation` row that resolved to an absence. |
| D5 | §10 `config/summarization_config.py :: SummarizationConfig` | approximate | **blocked** | DISCREPANCIES M8 §1. Trigger and keep are not addressable, so the config schema has no target to configure. |

### 5.4 Deltas deliberately NOT applied (and why)

Two rows improved during implementation past their planning classification. Neither is promoted into the `exact` numerator, because each retains a declared behavioural difference at row granularity. Recording the improvement without banking it is the pessimistic reading this report commits to.

| Row | Planning | What improved | Why it stays `approximate` |
|---|---|---|---|
| §5 `tools/builtins/present_file_tool.py :: present_files` | approximate (recorded at M5 as a weakening) | M13 **restored delivery enforcement**: `src/hooks/delivery-gate.ts` computes the same produced set as `worker.py` and emits the **verbatim** `_DELIVERY_INCOMPLETE_ERROR` string; the receipt lands in `run-meta.json` in one atomic rename. DISCREPANCIES M13 §3 kinds it **relocated** — fully preserved, produced elsewhere. | `stop_hook_active` suppresses the block unconditionally, so at most one block per stop chain: if `stop-goal-evaluator.js` blocked first, the delivery verdict is recorded as evidence but **not enforced** for the rest of that chain. An enforcement that can be pre-empted is not byte-parity with a run-terminalizing check. |
| §2 `loop_detection_middleware.py :: LoopDetectionMiddleware` | approximate | The decision function turned out **byte-exact**: 117/117 recorded Python md5 literals reproduce, all 99 scenario steps replay, all 9 hash relations hold, all 8 config defaults match — asserted as literals, not relations, thanks to `src/middleware/python-json.ts`. | DISCREPANCIES M7 §2 is kinded **degraded (more sensitive)**: detection is stepped **per tool call**, not per model response. The hash function and the threshold table are exact; the *stepping* is not, so the row as a whole is not. |

Two further sub-behaviours are exact inside otherwise-approximate rows and are recorded for the same reason: §4 `subagents/builtins/*` (prompt text and tool allowlist are exact; `max_turns` is blocked per D4's evidence) and §2 `summarization_middleware.py` (the summary-input wrapper, its escaping, `_bound_text` and the LastValue/blank-preserve merge are verbatim; the digest and the trigger are not).

### 5.5 The gap between "classified exact" and "shipped"

A row's *classification* and its *delivery* are independent axes, and conflating them is the easiest way to overstate a port. Splitting the exact class by Status:

| | Rows | |
|---|---:|---|
| classified `exact` **and implemented** | 16 | `lead_agent/prompt.py` (M3), `factory.py` TODO rules (M3), `thread_state.py` reducers (M2), `goal_state.py` (M2), `tool_result_meta.py` (M7), `worker.py` orphan-recovery subset (M10), `runtime/goal.py` (M11), `subagents/status_contract.py` (M6), `deermem core/{storage+paths,updater,prompt,prompts/*.yaml}` (M9 ×4), `workspace_changes/{types,scanner,diff}` (M13 ×3), `config/subagents_config.py` clamps (M2) |
| classified `exact`, **not implemented** | 29 | 25 `planned` + 2 `partial` + 1 `deferred` + 1 `platform-native` |
| **Total exact** | **45** | |

The one `platform-native` row is `tools/builtins/tool_search.py` — classified `exact (behavioral)` because Claude Code's own ToolSearch mirrors the query forms exactly, and reclassified out of `planned` by the M14 status hygiene rather than by any port work. It is listed below with the other 28 for continuity, marked.

The 29 unshipped exact-classified rows are the cheapest remaining parity wins — pure translations with no design decision left:

`constants.py`; `tool_result_sanitization_middleware.py`; `sandbox_audit_middleware.py`; `tool_progress_middleware.py` *(deferred, not omitted)*; `durable_context_middleware.py` *(partial — capture half done)*; `_bounded_dict.py`; `delegation_ledger.py`; `skill_context.py`; `worker.py` receipts/title/duration finalizers; `runs/naming.py`; `events/catalog.py`; `events/store/base.py`; `events/store/jsonl.py`; `runtime/context_keys.py`; `subagents/config.py`; `subagents/registry.py`; `contracts/subagent_status_contract.json`; `tools/builtins/tool_search.py` *(platform-native — no port work left)*; `utils/**`; `skills/validation.py`; `skills/skillscan/**`; `skills/review/**`; `.agent/skills/**`; `guardrails/provider.py`; `guardrails/middleware.py`; `config/loop_detection_config.py` *(partial — constants pinned, loader unwired)*; `config/tool_progress_config.py`; `config/token_budget_config.py`; `config/tool_output_config.py`.

Note that `sandbox/env_policy.py` (M5) is implemented and its scrub **lists** are verbatim, but the row is classified `approximate` because its Behavior-preserved cell reads `exact (lists) / approx (enforcement)` — it is counted in the approximate numerator, not here.

### 5.6 Numerator lists

#### exact — 45

- **§1** (5): `agents/lead_agent/prompt.py` :: apply_prompt_template + SYSTEM_PROMPT_TEMPLATE; `agents/factory.py` :: _TODO_SYSTEM_PROMPT, _TODO_TOOL_DESCRIPTION; `agents/thread_state.py` :: ThreadState + reducers (merge_delegations, merge_promoted, …); `agents/goal_state.py` :: GoalState, GoalEvaluation, GoalBlocker; `constants.py` :: shared constants
- **§2** (8): `agents/middlewares/tool_result_sanitization_middleware.py` :: ToolResultSanitizationMiddleware; `agents/middlewares/sandbox_audit_middleware.py` :: SandboxAuditMiddleware; `agents/middlewares/tool_progress_middleware.py` :: ToolProgressMiddleware; `agents/middlewares/tool_result_meta.py` :: normalize_tool_result, 8-type taxonomy; `agents/middlewares/durable_context_middleware.py` :: DurableContextMiddleware; `agents/middlewares/_bounded_dict.py` :: BoundedDict; `agents/middlewares/delegation_ledger.py` :: extract_delegations, render_delegation_ledger; `agents/middlewares/skill_context.py` :: build_skill_entry_metadata_from_read, extractor, renderer
- **§3** (8): `runtime/runs/worker.py` :: receipts/title/duration finalizers (_persist_delivery_receipt, _ensure_interrupted_title); `runtime/runs/worker.py` :: orphan/crash recovery subset (`_finish_cancellation` interrupted path + the reconciler's `orphan_recovered` stamp and zero-receipt backfill it consumes); `runtime/runs/naming.py` :: resolve_root_run_name; `runtime/events/catalog.py` :: EVENT catalog (13 types); `runtime/events/store/base.py` :: RunEventStore ABC (seq, put_if_absent); `runtime/events/store/jsonl.py` :: JsonlRunEventStore; `runtime/goal.py` :: evaluate_goal_completion, write_thread_goal, caps; `runtime/context_keys.py` :: __deerflow_pre_run_message_ids et al.
- **§4** (4): `subagents/config.py` :: SubagentConfig, resolve_subagent_model_name; `subagents/registry.py` :: get_subagent_config, get_available_subagent_names; `subagents/status_contract.py` :: make_subagent_additional_kwargs, format_subagent_result_message, normalize_token_usage, _bound_metadata_text; `contracts/subagent_status_contract.json` :: v2 status/stop_reason fixture
- **§5** (2): `tools/builtins/tool_search.py` :: build_deferred_tool_setup, DeferredToolCatalog; `utils/**` :: message/file/LLM-text helpers
- **§6** (4): `skills/validation.py` :: install-time validation (name/description rules); `skills/skillscan/**` :: scan_archive_preflight, scan_skill_dir, RuleSpecs; `skills/review/** + tools/review_skill_package` :: analyze_skill_package, CLI, schemas; `.agent/skills/**` :: repo-maintainer skills
- **§7** (4): `deermem core/storage.py + core/paths.py` :: schema v2 storage (memory.json + fact .md files); `deermem core/updater.py` :: update worker + fact trim; `deermem core/prompt.py` :: format_memory_for_injection; `deermem core/prompts/*.yaml (4 files)` :: extraction/staleness/consolidation prompts
- **§8** (3): `workspace_changes/types.py` :: snapshot/change dataclasses + limits; `workspace_changes/scanner.py` :: snapshot scanner; `workspace_changes/diff.py` :: compare_snapshots, get_changed_output_paths
- **§9** (2): `guardrails/provider.py` :: GuardrailProvider protocol, GuardrailRequest/Decision; `guardrails/middleware.py` :: GuardrailMiddleware
- **§10** (5): `config/loop_detection_config.py` :: LoopDetectionConfig; `config/tool_progress_config.py` :: ToolProgressConfig; `config/token_budget_config.py` :: TokenBudgetConfig; `config/tool_output_config.py` :: ToolOutputConfig; `config/subagents_config.py` :: SubagentsAppConfig + clamps

#### approximate — 88

- **§1** (8): `agents/lead_agent/agent.py` :: make_lead_agent, _make_lead_agent; `agents/lead_agent/agent.py` :: build_middlewares; `agents/lead_agent/agent.py` :: resolution helpers (_resolve_model_name, _resolve_runtime_option); `agents/lead_agent/prompt.py` :: get_skills_prompt_section, _get_memory_context; `agents/factory.py` :: create_deerflow_agent; `agents/features.py` :: RuntimeFeatures, Next/Prev; `agents/human_input.py` :: read_human_input_response; `client.py` :: DeerFlowClient (stream/chat/goal APIs)
- **§2** (17): `agents/middlewares/input_sanitization_middleware.py` :: InputSanitizationMiddleware; `agents/middlewares/thread_data_middleware.py` :: ThreadDataMiddleware; `agents/middlewares/read_before_write_middleware.py` :: ReadBeforeWriteMiddleware; `agents/middlewares/tool_error_handling_middleware.py` :: ToolErrorHandlingMiddleware; `agents/middlewares/tool_error_handling_middleware.py` :: _build_runtime_middlewares, build_lead/subagent_runtime_middlewares; `agents/middlewares/dynamic_context_middleware.py` :: DynamicContextMiddleware; `agents/middlewares/skill_activation_middleware.py` :: SkillActivationMiddleware; `agents/middlewares/skill_tool_policy_middleware.py` :: SkillToolPolicyMiddleware; `agents/middlewares/summarization_middleware.py` :: DeerFlowSummarizationMiddleware; `agents/middlewares/todo_middleware.py` :: TodoMiddleware; `agents/middlewares/memory_middleware.py` :: MemoryMiddleware; `agents/middlewares/mcp_routing_middleware.py` :: McpRoutingMiddleware; `agents/middlewares/deferred_tool_filter_middleware.py` :: DeferredToolFilterMiddleware; `agents/middlewares/subagent_limit_middleware.py` :: SubagentLimitMiddleware; `agents/middlewares/loop_detection_middleware.py` :: LoopDetectionMiddleware; `agents/middlewares/terminal_response_middleware.py` :: TerminalResponseMiddleware; `agents/middlewares/clarification_middleware.py` :: ClarificationMiddleware
- **§3** (8): `runtime/runs/worker.py` :: run_agent (admission→stream→terminal); `runtime/runs/manager.py` :: RunManager (create_or_reject, cancel, leases, reconciliation); `runtime/runs/store/base.py + memory store` :: RunStore ABC + MemoryRunStore; `runtime/journal.py` :: RunJournal; `runtime/context_compaction.py` :: compact_thread_context; `runtime/checkpoint_mode.py` :: freeze/inject/gate mode helpers; `runtime/checkpoint_state.py` :: CheckpointStateAccessor, build_state_mutation_graph; `runtime/secret_context.py` :: redact_config_secrets, read_active_secrets
- **§4** (4): `subagents/executor.py` :: SubagentExecutor._aexecute, SubagentResult; `subagents/builtins/general_purpose.py` :: GENERAL_PURPOSE_CONFIG + prompt; `subagents/builtins/bash_agent.py` :: BASH_AGENT_CONFIG + prompt; `tools/builtins/task_tool.py` :: task_tool (dispatch, polling, events, usage)
- **§5** (15): `tools/tools.py` :: get_available_tools; `tools/builtins/present_file_tool.py` :: present_files; `tools/builtins/clarification_tool.py` :: ask_clarification (schema only); `tools/builtins/setup_agent_tool.py` :: setup_agent; `tools/builtins/update_agent_tool.py` :: update_agent; `tools/builtins/invoke_acp_agent_tool.py` :: invoke_acp_agent; `tools/skill_manage_tool.py` :: skill_manage; `sandbox/tools.py` :: bash_tool; `sandbox/tools.py` :: read_file_tool; `sandbox/tools.py` :: write_file_tool; `sandbox/tools.py` :: str_replace_tool; `sandbox/tools.py` :: ls_tool; `sandbox/tools.py` :: glob_tool; `sandbox/tools.py` :: grep_tool; `community/** (search/crawl/browse: brave, ddg, exa, firecrawl, jina, serper, searxng, crawl4ai, readability, browser automation, …)` :: provider tool modules
- **§6** (11): `skills/types.py` :: Skill dataclass, SkillCategory; `skills/frontmatter.py` :: shared frontmatter regex/allowed keys; `skills/parser.py` :: parse_skill_file; `skills/storage/**` :: LocalSkillStorage, UserScopedSkillStorage, template method; `skills/catalog.py` :: SkillCatalog (select:/+/keyword); `skills/describe.py` :: build_describe_skill_tool, skill index section; `skills/slash.py` :: resolve_slash_skill, reserved names; `skills/tool_policy.py` :: allowed_tool_names_for_skills, framework exemptions; `skills/installer.py` :: safe_extract_skill_archive + install flow; `skills/public/** (16 of 23 packs)` :: SKILL.md + scripts/assets; `skills/public/** (7 of 23 packs: image/music/podcast/video/ppt-generation, bootstrap, skill-reviewer)` :: SKILL.md + scripts/assets
- **§7** (4): `agents/memory/manager.py` :: MemoryManager ABC + factory; `agents/memory/summarization_hook.py` :: memory_flush_hook; `agents/memory/backends/deermem/deermem/deer_mem.py` :: DeerMem manager; `deermem core/queue.py` :: MemoryUpdateQueue
- **§8** (6): `sandbox/local/local_sandbox.py` :: LocalSandbox; `sandbox/env_policy.py` :: build_sandbox_env; `sandbox/security.py` :: is_host_bash_allowed; `sandbox/search.py` :: glob/grep engine + IGNORE_PATTERNS; `config/paths.py` :: Paths, resolve_virtual_path, ensure_thread_dirs; `workspace_changes/recorder.py + api.py` :: capture/record/read flows
- **§9** (4): `mcp/client.py` :: build_server_params; `mcp/tools.py` :: get_mcp_tools, result path translation, name gate; `mcp/oauth.py` :: OAuthTokenManager + interceptor; `guardrails/builtin.py` :: AllowlistProvider
- **§10** (10): `config/app_config.py` :: AppConfig, get_app_config, reload; `config/skills_config.py + tool_search_config.py` :: SkillsConfig, ToolSearchConfig; `config/memory_config.py` :: MemoryConfig + legacy migration; `config/sandbox_config.py` :: SandboxConfig; `config/agents_config.py` :: AgentConfig (custom agents); `config/{authorization,guardrails,read_before_write,safety_finish_reason,token_usage,title,suggestions,input_polish}_config.py` :: small toggle schemas; `config/extensions_config.py` :: ExtensionsConfig + atomic write; `config.example.yaml (repo root)` :: main config template; `extensions_config.example.json (repo root)` :: MCP+skills template; `.env.example (repo root)` :: environment template
- **§11** (1): `persistence/run/model.py + thread_meta/model.py` :: runs/threads_meta field lists

#### intentionally omitted — 23

- **§2** (3): `agents/middlewares/tool_output_budget_middleware.py` :: ToolOutputBudgetMiddleware **[D1]**; `agents/middlewares/tool_output_synopsis.py` :: typed synopsis builders **[D1]**; `agents/middlewares/title_middleware.py` :: TitleMiddleware
- **§3** (3): `runtime/runs/worker.py` :: rollback + delta linearization (_capture_rollback_point, _linearize_delta_checkpoint_resume) **[D2]**; `runtime/checkpointer/**, runtime/store/**` :: provider factories (memory/sqlite/postgres); `runtime/user_context.py` :: resolve_runtime_user_id
- **§5** (2): `tools/mcp_metadata.py` :: tag_mcp_tool; `tools/builtins (list_uploaded_files)` :: list_uploaded_files
- **§6** (1): `skills/permissions.py` :: chmod policy 0555/0444
- **§7** (1): `deermem core/retrieval.py` :: FTS5/BM25 adapter **[D3]**
- **§8** (5): `sandbox/sandbox.py` :: Sandbox ABC (8 methods); `sandbox/sandbox_provider.py` :: SandboxProvider ABC + singleton; `sandbox/local/local_sandbox_provider.py` :: LocalSandboxProvider; `sandbox/file_operation_lock.py` :: get_file_operation_lock; `sandbox/exceptions.py` :: SandboxError hierarchy
- **§9** (2): `mcp/cache.py` :: get_cached_mcp_tools + signature staleness; `mcp/session_pool.py` :: MCPSessionPool
- **§10** (3): `models/factory.py` :: create_chat_model; `models/credential_loader.py` :: load_claude_code_credential, is_oauth_token; `backend/packages/harness/pyproject.toml` :: dependency manifest
- **§11** (3): `persistence/** (rest, 51 files: SQL stores, alembic)` :: repositories + migrations; `tui/** (15)` :: Textual TUI client; `scheduler/** (2)` :: schedules.py cron math

#### blocked — 2

- **§2** (1): `agents/middlewares/token_budget_middleware.py` :: TokenBudgetMiddleware **[D4]**
- **§10** (1): `config/summarization_config.py` :: SummarizationConfig **[D5]**

---

## 6. Hook-observability contract

`docs/claude-code-port/parity-test-plan.md` §"Observable channels" defines five channels O1–O5 that every live scenario asserts against, and states of O3: *"This log is a port-defined observability contract; the port MUST implement it for this plan to be executable."*

Mapping each to what exists after M14:

| Channel | Planned surface | Status | What actually exists |
|---|---|---|---|
| **O1 transcript** | `transcript.jsonl` (stream-json): tool calls, Agent invocations, subagent results, final message, usage | **available (platform)** | `claude -p --output-format stream-json --verbose > transcript.jsonl`. Port-side, `src/hooks/precompact-summary.ts` and `src/summary/digest.ts` already parse the session transcript (declared as a defensive degradation in DISCREPANCIES M8 §5), so the format is a dependency the port has exercised. |
| **O2 state files** | `.deerflow/state/<thread>/` with 6 named files | **available and wider than planned — 12 files** | `run-meta.json`, `delegations.json`, `goal.json`, `summary.json`, `skill-context.json`, `todos.json` (the 6 planned), plus `artifacts.json`, `promoted.json`, `read-marks.json`, `loop-detection.json`, `workspace-pre.json`, `workspace-changes.json`. Constants: `src/state/{run-meta,delegations,goal,skill-context,todos,artifacts,promoted}.ts`, `src/summary/summary-state.ts`, `src/middleware/read-marks.ts`, `src/hooks/loop-guard.ts`, `src/artifacts/{snapshot,workspace-changes}.ts`. Path resolution and the thread-id guard: `src/state/paths.ts`. All writes go through `src/state/atomic-io.ts` (write-temp + rename), so a scenario can read any file mid-run without tearing. |
| **O3 hook logs** | `.deerflow/logs/hooks.jsonl` — one structured line per hook: event, decision allow/deny/rewrite, meta stamped | **implemented (M14)** | `src/middleware/hook-runtime.ts:appendHookLog` writes one JSON line per hook decision to `<CLAUDE_PROJECT_DIR‖cwd>/.deerflow/logs/hooks.jsonl`; **all 12 hooks call it** at their decision point. Record shape: `{ts, hook, event, thread, decision, summary?}` with `decision ∈ {silent, context, deny, block, error}`. See §6.1 for the per-hook decision map. |
| **O4 outputs** | `outputs/` contents incl. `outputs/.tool-results/` | **partially available** | `outputs/` is real and is the delivery contract: `src/artifacts/delivery.ts` + `src/hooks/delivery-gate.ts` compute the produced set and the presented set, and the receipt lands in `run-meta.json`. `outputs/.tool-results/` **does not exist** — externalization was intentionally omitted (delta D1). Any scenario asserting on `.tool-results/` is unrunnable as written. |
| **O5 process** | exit code, wall time, signals | **available (platform)** | Harness-level; no port surface required. |

### 6.1 O3, and what each hook now records

**Status: implemented at M14.** `appendHookLog(entry, env?)` in `src/middleware/hook-runtime.ts` appends one JSON line — `{ts, hook, event, thread, decision, summary?}` — to `<CLAUDE_PROJECT_DIR‖cwd>/.deerflow/logs/hooks.jsonl`, creating the directory on demand. It is an **observability channel, never a control path**: every failure is swallowed, so a hook whose log write fails emits exactly the same decision it would have emitted anyway. All twelve hooks call it once, at their decision point, after the decision is made.

**Thirteen** of the 24 live scenarios name O3 as an observable: S2, S3, S4, S5, S9, S10, S11, S14, S16, S19, S21, S23, S24. Six of them lead with it — **S9** (`meta stamp error_type=not_found`), **S10** (per-call allow×4-then-deny), **S11** (meta per case), **S14** (injection event + sha256), **S23** (deny records + reasons), **S24** (deny records for the read attempts) — and **S16** lists O3 as its *only* observable ("O3 (8 meta records)"). **S16 is now executable as written**: `post-tool-meta.js` writes one line per guarded tool result, carrying `error_type` even when the hook stays silent, so eight results produce eight records. The other five recover their primary evidence and no longer fall back to O1 inference. S14's "injection logged with content sha256" is satisfied literally — `turn-context.js` logs the sha256 of the injected block, not the block itself.

Per hook: the durable trace it already left, plus the O3 line it now writes.

| Hook | Registered on | Durable trace it leaves | O3 `decision` values | O3 `summary` carries |
|---|---|---|---|---|
| `loop-guard.js` | PreToolUse (Bash\|Edit\|Write\|Read\|Glob\|Grep\|WebFetch\|WebSearch\|mcp__.*) | `.deerflow/state/<thread>/loop-detection.json` (window, per-tool frequency, call hashes) + the deny payload in O1 | `silent` / `context` / `deny` | `tool=` |
| `write-gate.js` | PreToolUse (Write\|Edit) | `.deerflow/state/<thread>/read-marks.json` | `silent` / `deny` | `path=` |
| `read-mark.js` | PostToolUse (Read) | `.deerflow/state/<thread>/read-marks.json` | `silent` | `marked=` (normalized path, or `none`) |
| `env-guard.js` | PreToolUse (Bash) | none | `silent` / `deny` | the deny reason |
| `post-tool-meta.js` | PostToolUse (same matcher as loop-guard) | none (the taxonomy rides `additionalContext` to the model) | `silent` / `context` | `tool=` `status=` `error_type=` `oversized=` |
| `turn-context.js` | UserPromptSubmit | none (injection rides `additionalContext`) | `silent` / `context` | `chars=` `sha256=` of the injected block |
| `turn-snapshot.js` | UserPromptSubmit | `.deerflow/state/<thread>/workspace-pre.json` | `silent` / `error` | `files=` `truncated=` |
| `memory-extract.js` | Stop | `.deerflow/memory/` queue + fact files | `silent` | `queued=` |
| `stop-goal-evaluator.js` | Stop | `.deerflow/state/<thread>/goal.json` | `silent` / `block` / `error` | `continuations=` `no_progress=` `stand_down=` `persisted=` |
| `delivery-gate.js` | Stop | delivery receipt in `run-meta.json` | `silent` / `block` | `produced=` `missing=` `recorded=` `receipt=` |
| `precompact-summary.js` | PreCompact | `.deerflow/state/<thread>/summary.json` | `silent` / `error` | `trigger=` `objectives=` `todos=` `artifacts=` `messages=` `queued=` |
| `session-recover.js` | SessionStart (startup\|resume\|clear) | `run-meta.json` (`orphan_recovered`, receipt backfill) | `silent` / `context` | `recovered=` `threads=` |

**What this unblocks.** Before M14, 8 of 12 hooks were assertable from O2 + O1 alone; the three that were not — `env-guard`, `post-tool-meta`, `turn-context` — are exactly the three that produce *no durable artefact by design* (a deny, and two `additionalContext` injections). O3 exists precisely to observe those, and all three now write one. `error` is a real value, not decoration: `turn-snapshot`, `precompact-summary` and `stop-goal-evaluator` each distinguish "no thread to act on" (`silent`) from "had one and could not write" (`error`), which is otherwise invisible because all three are fail-open by design.

**Verified.** `src/middleware/hook-runtime.test.ts` — the writer (valid JSONL, `ts` stamped first, absent `summary` omitted rather than nulled, `CLAUDE_PROJECT_DIR` honoured, never throws on an uncreatable directory or an unwritable path) plus one **end-to-end** case: the sources are compiled to a temp dir, `hooks/write-gate.js` is run as a real subprocess with `cwd` inside a temp project and a payload on stdin, and the assertion is that stdout carries `permissionDecision: deny` **and** `.deerflow/logs/hooks.jsonl` gained the matching `decision: "deny"` line.

### 6.2 Live measurements this milestone sets up but does not run

`ports/claude-code/parity/fixtures/context-loss/` ships two fixtures and a runbook for the one parity number that cannot be computed from source:

- **case-01** — 12 items with exact-recall keys (4 facts, 5 decisions, 3 file paths). Measures **token** survival.
- **case-02** — 8 items with paraphrase-tolerant alias sets (3 facts, 4 decisions, 1 file). Measures **meaning** survival. The spread between the two scores is the interesting number.
- Both carry a `seed` sentence per item (the realistic briefing the runbook puts in the prompt) alongside the `text` match key. A test asserts every `seed` contains its own key, so a fixture edit can never brief the session on one string and grade it on another.
- **Kind mapping, declared:** the scorer knows `fact` / `decision` / `file` only. **Constraints are modelled as `decisions`** and tagged `constraint: true`. There is deliberately no `constraints` array — `parseContextSnapshot` ignores unknown top-level keys, so one would have silently dropped those items.
- `RUNBOOK.md` — the exact commands for (a) **resume-recall** (`claude -p --resume`), fully scriptable, and (b) **compaction-recall**, which requires an interactive `/compact` and is marked joint-session.

Scoring is `node dist/summary/context-loss-cli.js`, a thin stdin wrapper (`{fixture, answers}` → score JSON) over the pure scorer in `src/summary/context-loss.ts` that M8 shipped. The scorer is literal-with-aliases and biased **pessimistic** by construction: a model that recalls a fact in different words scores as lost unless an alias covers it. It can under-report recall; it can never over-report it.

---

## 7. Verification

Every count in §1, §3 and §5 is produced by parsing `docs/claude-code-port/traceability-matrix.md` and `ports/claude-code/parity/DISCREPANCIES.md` directly, and re-verified after the matrix edits — including the M14 status hygiene, which was applied by script and recounted from the file afterwards: 199 rows → 19 excluded → 22 obsolete → **158** in-scope, splitting **45 / 88 / 23 / 2**. Those four numbers are unchanged by the hygiene, because the hygiene touched only Status cells and every one of them derives from the Behavior-preserved column. Vector counts in §4.1 come from parsing each `parity/baseline/*.json`; test counts come from the run below.

Suite state at the time of writing, from `ports/claude-code/`:

```
$ npm run check
tsc -p tsconfig.json --noEmit && vitest run
 Test Files  54 passed (54)
      Tests  1393 passed (1393)
$ echo $?
0
```

(1354 before M14; +30 from `src/summary/context-loss-cli.test.ts`, +5 from the O3 hook-log tests in `src/middleware/hook-runtime.test.ts` — including the end-to-end built-hook subprocess case — and +4 from the compaction-boundary memory-flush tests in `src/hooks/precompact-summary.test.ts`.)

The parity script result:

```
$ npm run parity
> deerflow-claude-code@0.1.0 parity
> vitest run src/middleware/loop-detection.test.ts src/middleware/tool-meta.test.ts src/deeprun/result-format.test.ts src/deeprun/batching.test.ts src/deeprun/workflow-sync.test.ts src/deeprun/task-schema.test.ts src/deeprun/ledger-io.test.ts src/policy/caps.test.ts src/state src/prompts/lead.test.ts src/goal-loop/orchestrate.test.ts src/goal-loop/goal-cli.test.ts


 RUN  v3.2.7 /Users/nisavitan/Desktop/ClaudeCode-Deerflow/deer-flow/ports/claude-code

 ✓ src/state/paths.test.ts (8 tests) 4ms
 ✓ src/middleware/tool-meta.test.ts (51 tests) 8ms
 ✓ src/goal-loop/orchestrate.test.ts (18 tests) 10ms
 ✓ src/state/todos.test.ts (5 tests) 100ms
 ✓ src/deeprun/workflow-sync.test.ts (129 tests) 17ms
 ✓ src/deeprun/ledger-io.test.ts (15 tests) 102ms
 ✓ src/state/run-meta.test.ts (9 tests) 195ms
 ✓ src/middleware/loop-detection.test.ts (24 tests) 30ms
 ✓ src/deeprun/result-format.test.ts (141 tests) 21ms
 ✓ src/state/goal.test.ts (37 tests) 11ms
 ✓ src/deeprun/batching.test.ts (29 tests) 10ms
 ✓ src/deeprun/task-schema.test.ts (21 tests) 9ms
 ✓ src/prompts/lead.test.ts (22 tests) 16ms
 ✓ src/state/atomic-io.test.ts (16 tests) 423ms
 ✓ src/policy/caps.test.ts (47 tests) 9ms
 ✓ src/goal-loop/goal-cli.test.ts (15 tests) 434ms
 ✓ src/state/delegations.test.ts (16 tests) 5ms
 ✓ src/state/skill-context.test.ts (11 tests) 6ms
 ✓ src/state/promoted.test.ts (8 tests) 4ms
 ✓ src/state/artifacts.test.ts (7 tests) 3ms

 Test Files  20 passed (20)
      Tests  629 passed (629)
   Start at  18:09:28
   Duration  1.00s (transform 634ms, setup 0ms, collect 1.51s, tests 1.42s, environment 2ms, prepare 1.48s)

$ echo $?
0
```

---

## 8. Final five-way computation (post-closure)

§5 classified each in-scope row by what its port *would* preserve. This section reclassifies the same 158 rows by what the port can *prove* it preserves, adding a fifth class: **unverified**. The rule (user directive, 2026-08-01):

- A behavior whose port code exists but has **no evidence** is **unverified**, not approximate.
- A row classified `exact` stays `exact` only with **tier a–d** evidence; otherwise it demotes to `unverified` — exact claims need strong evidence.
- A row classified `approximate` keeps `approximate` with **any tier a–e** evidence; otherwise `unverified`.
- `intentionally omitted` and `blocked` are unchanged — they claim an absence, not a behavior, and §2/§3 already audit those claims.
- **Platform-native rows** count as approximate-with-platform-evidence when `claude-code-capabilities.md`'s Evidence column (DOC/CLI/EXP) verifies the native behavior; otherwise unverified.

Evidence tiers, strongest first:

| Tier | Definition | Where it lives |
|---|---|---|
| **a** | vector/golden-driven test (a `parity/baseline/*` fixture is consumed) | the 17 baseline-loading test files (`grep -rl "parity/baseline" src --include="*.test.ts"`) |
| **b** | frozen-copy drift test asserting byte/verbatim equality against cited original source lines | e.g. `evaluator-prompt.test.ts` (goal.py:299-308), `wrapper.test.ts` (summarization_middleware.py:415-435), `env-scrub.test.ts`, `extraction-prompt.test.ts` (sha256 vs upstream YAML), `snapshot.test.ts` (types.py:18-27), `injection.test.ts`/`write-gate.test.ts` (config.py line anchors), `durable-context.test.ts` (@ 0950924) |
| **c** | recorded adversarial-gate scenario | `parity/fixtures/adversarial/RESULTS.md` A1–A8 (all PASSED, dated) |
| **d** | recorded live smoke/measurement | PROGRESS.md milestone rows (M4 headless skill smoke, M5 allow+deny smokes, M6 caps smoke, M7 live smokes, M10 live orphan smoke, M13 block-then-pass + full receipt), `parity/fixtures/context-loss/RESULTS.md` (Measurement A: 12/12 resume recall; PreCompact subprocess smoke), the O3 `hooks.jsonl` end-to-end subprocess case |
| **e** | ordinary unit test directly asserting the ported behavior's contract | weakest tier; counts for `approximate` only, and rows whose ONLY evidence is this tier are tagged in §8.5 |

### 8.1 Per-row evidence map — rows that keep a verified class (56)

**exact, evidence tier a–d — 18 rows**

| Row | Status | Evidence |
|---|---|---|
| §1 `lead_agent/prompt.py` :: apply_prompt_template | implemented (M3) | **a** — 3 golden renders byte-exact (`prompt_renders/`, `lead.test.ts`) |
| §1 `factory.py` :: _TODO_SYSTEM_PROMPT | implemented (M3) | **a** — covered by the M3 golden renders ("0 unexplained diffs", PROGRESS M3) |
| §1 `thread_state.py` :: reducers | implemented (M2) | **a** — `state_reducers.json` (18 vectors) via the state tests |
| §1 `goal_state.py` | implemented (M2) | **a** — `goal_counters.json` + `state_reducers.json` via `goal.test.ts` |
| §2 `tool_result_meta.py` | implemented (M7) | **a** — all 38 + 4 baseline vectors, whole-object exact (`tool-meta.test.ts`) |
| §2 `durable_context_middleware.py` (exact = capture) | partial | **a** — `delegations_ledger.json` via `ledger-io.test.ts`; **b** — verbatim authority contract @ 0950924 (`durable-context.test.ts`); **d** — M7 live smokes |
| §3 `worker.py` :: orphan/crash recovery | implemented (M10) | **d** — recorded live orphan smoke (PROGRESS M10); **e** — `recovery.test.ts`, `session-recover.test.ts` |
| §3 `runtime/goal.py` | implemented (M11) | **b** — evaluator prompt byte-equal to goal.py:299-308; **a** — `goal_counters.json` gate matrix/cap walk replays |
| §4 `subagents/status_contract.py` | implemented (M6) | **a** — 60/60 golden renders × 2 passes; **c** — A5 |
| §7 `deermem core/storage.py + paths.py` | implemented (M9) | **b** — categories anchored to storage.py:39; sharding checked against independent sha256 (`store.test.ts`) |
| §7 `deermem core/updater.py` | implemented (M9) | **b** — thresholds/clamps anchored to config.py:87-105/116-175 (`write-gate.test.ts`) |
| §7 `deermem core/prompt.py` | implemented (M9) | **b** — budgets anchored to config.py; upstream labels/order/formula asserted (`injection.test.ts`) |
| §7 `deermem core/prompts/*.yaml` | implemented (M9) | **b** — sha256-verified byte-verbatim vs upstream; system message renders byte-exact (`extraction-prompt.test.ts`) |
| §8 `workspace_changes/types.py` | implemented (M13) | **b** — limits verbatim vs types.py:18-27 (`snapshot.test.ts`) |
| §8 `workspace_changes/scanner.py` | implemented (M13) | **d** — M13 live smoke (full receipt exercises the scan); **e** — `snapshot.test.ts` |
| §8 `workspace_changes/diff.py` | implemented (M13) | **d** — M13 live smoke (produced set in the receipt); **e** — `snapshot.test.ts` |
| §10 `config/loop_detection_config.py` | partial | **a** — every threshold asserted against baseline `config_defaults` |
| §10 `config/subagents_config.py` :: clamps | implemented (M2) | **a** — `caps_clamping.json` (40 vectors); **c** — A7 |

**approximate, any evidence — 38 rows** (10 of them platform-native, kept on the capabilities-matrix evidence column)

| Row | Status | Evidence |
|---|---|---|
| §1 `lead_agent/prompt.py` :: skills section | partial | **a** — skill-index section inside the M3 golden renders |
| §1 `client.py` | platform-native | **platform** (EXP E3-a/E7-a); **d** — context-loss Measurement A: 12/12 resume recall across processes |
| §2 `read_before_write_middleware.py` | implemented (M7) | **b** — frozen hash-gate rules (`read-marks`); **d** — O3 end-to-end write-gate subprocess case |
| §2 `tool_error_handling_middleware.py` (middleware) | partial | **a** — taxonomy rides the `tool_meta.json` vectors; **e** — `post-tool-meta.test.ts` |
| §2 `dynamic_context_middleware.py` | partial | **b** — date reminder frozen verbatim (`turn-context.ts`); **e** — `turn-context.test.ts` |
| §2 `summarization_middleware.py` | implemented (M8) | **b** — wrapper/escaping/`_bound_text`/`_nonempty_summary` frozen vs cited lines; **d** — PreCompact subprocess smoke (context-loss RESULTS) |
| §2 `deferred_tool_filter_middleware.py` | platform-native | **platform** — ToolSearch deferral verified (capabilities §9) |
| §2 `subagent_limit_middleware.py` | implemented (M2, policy) | **a** — caps vectors; **c** — A7 verbatim limit note live |
| §2 `loop_detection_middleware.py` | implemented (M7) | **a** — 99 steps/117 md5 literals; **c** — A8 live warn@3/hard-block@5 |
| §2 `terminal_response_middleware.py` | partial | **e** only — Stop-hook evidence gate (`stop-hook.test.ts`); tagged §8.5 |
| §3 `runs/manager.py` (reconciliation half) | partial | **d** — M10 live orphan smoke; **e** — `recovery.test.ts` |
| §3 `runs/store/base.py` | implemented (M2) | **e** only — `run-meta.test.ts` (identity + terminal/receipt invariants); tagged §8.5 |
| §3 `context_compaction.py` | implemented (M8) | **b** — write path anchored to `_nonempty_summary` lines; **e** — digest tests |
| §3 `checkpoint_mode.py` | confirmed replace-native | **platform** (sessions EXP E3-a); **e** — `staleness.test.ts` schema gate |
| §3 `checkpoint_state.py` | implemented (M2) | **e** only — `atomic-io.test.ts`; tagged §8.5 |
| §4 `subagents/executor.py` | implemented (M6) | **a** — workflow-sync/task-schema vectors; **c** — A3/A4/A5/A6; **d** — M6 smokes |
| §4 `subagents/builtins/general_purpose.py` | implemented (M6) | **c** — A5/A6 ran the agent live; **d** — M6 smokes |
| §4 `subagents/builtins/bash_agent.py` | implemented (M6) | **c** — A6/A6-variant; **d** — M6 smokes |
| §4 `tools/builtins/task_tool.py` | implemented (M6) | **a** — `task-schema.test.ts` (sha256 of the docstring golden) + caps replay; **c** — A6/A7 |
| §5 `tools/builtins/tool_search.py` (was **exact**) | platform-native | **platform** — ToolSearch query forms verified (capabilities §9); reclassified exact → approximate: platform evidence verifies the native capability, not byte-parity of the port |
| §5 `present_file_tool.py` | implemented (M5+M13) | **b** — `_DELIVERY_INCOMPLETE_ERROR` verbatim (`delivery.test.ts`); **d** — M13 block-then-pass + full-receipt smoke |
| §5 `sandbox/tools.py` :: bash_tool | implemented (M5, contract) | **c** — A2/A3/A4 (env deny, crash, hang all recorded); **d** — M5 allow+deny smokes |
| §5 `sandbox/tools.py` :: read_file_tool | implemented (M5, contract) | **c** — A1 (sensitive read prevented, no canary leak) |
| §6 `skills/types.py` | platform-native | **platform** — DOC skills.md + EXP E1-a |
| §6 `skills/frontmatter.py` | platform-native | **platform** — DOC skills.md |
| §6 `skills/parser.py` | platform-native | **platform** — DOC skills.md |
| §6 `skills/storage/**` | platform-native | **platform** — DOC (user/project/plugin scopes) |
| §6 `skills/catalog.py` | platform-native | **platform** — DOC (model auto-invocation by description) |
| §6 `skills/describe.py` | implemented (M3, index section) | **a** — skill-index section in the golden renders |
| §6 `skills/public/**` (16 packs) | implemented (M4) | **d** — recorded headless body-load smoke + `/deerflow:academic-paper-review` run |
| §7 `agents/memory/manager.py` | implemented (M9) | **e** only — the single impl covered by store/write-gate/injection tests; tagged §8.5 |
| §7 `agents/memory/summarization_hook.py` | implemented (M14-fix) | **d** — PreCompact subprocess smoke (context-loss RESULTS); **e** — 4 flush cases in `precompact-summary.test.ts` |
| §7 `deer_mem.py` | implemented (M9) | **e** only — capture/gate/persist/inject via `write-gate.test.ts` + `store.test.ts`; tagged §8.5 |
| §7 `deermem core/queue.py` | implemented (M9) | **e** only — `queue.test.ts` (24 tests); tagged §8.5 |
| §8 `sandbox/env_policy.py` | implemented (M5) | **b** — denylist + pattern set frozen vs original (93 tests); **c** — A2 live deny |
| §8 `workspace_changes/recorder.py + api.py` | implemented (M13) | **d** — M13 live smoke; **e** — `workspace-changes.test.ts`, `turn-snapshot.test.ts` |
| §9 `mcp/client.py` | platform-native | **platform** — DOC mcp.md + CLI `claude mcp` |
| §9 `mcp/oauth.py` | platform-native | **platform** — DOC (OAuth for remote servers) |

### 8.2 The recomputation, shown

| Move | Rows | Arithmetic |
|---|---:|---|
| exact, kept (tier a–d) | 18 | of §5's 45 |
| exact → approximate (platform-native, capability-verified) | 1 | `tools/builtins/tool_search.py` |
| exact → **unverified** (no tier a–d evidence) | 26 | 25 `planned` + 1 `deferred` — none has port code, so none can have evidence |
| approximate, kept (tier a–e or platform) | 37 | of §5's 88 |
| approximate → **unverified** | 51 | 36 `planned` + 8 `needs-investigation` + 7 with code/contract-docs but no evidence (§8.4 group D) |
| intentionally omitted, unchanged | 23 | absence claims, audited in §2/§3 |
| blocked, unchanged | 2 | §3.3 |

Check: 18 + 1 + 26 = 45 ✓ · 37 + 51 = 88 ✓ · exact 18 + approximate (37 + 1) 38 + omitted 23 + blocked 2 + unverified (26 + 51) 77 = **158** ✓

### 8.3 The five numbers

| Class | Numerator | Denominator | Percentage |
|---|---:|---:|---:|
| **exact** (evidence tier a–d) | 18 | 158 | **11.4%** |
| **approximate** (evidence tier a–e / platform-verified) | 38 | 158 | **24.1%** |
| **intentionally omitted** | 23 | 158 | **14.6%** |
| **blocked** | 2 | 158 | **1.3%** |
| **unverified** | 77 | 158 | **48.7%** |
| **Total** | **158** | **158** | **100%** (100.1 with per-line rounding) |

- **Evidenced equivalence: exact + approximate = 56 / 158 = 35.4%.** This is the number that survives the evidence rule; §5.2's 84.2% was a *disposition* figure (what the port would preserve if every planned row were built and proven).
- Of the 56, **46** carry strong evidence (tier a–d or platform), **10** ride on ordinary unit tests or platform-doc verification alone at their weakest link (§8.5 lists the 6 tier-e-only rows; the 10 platform-native rows are itemized in §8.1).

### 8.4 The complete unverified list — 77 rows, each with why

**Group A — no port code exists (`planned`): 61 rows.** Nothing to test; evidence is impossible until someone ports them. Three carry partial code for a *different* row's half and are marked †.

| § | Row (was exact — 25) |
|---|---|
| §1 | `constants.py` |
| §2 | `tool_result_sanitization_middleware.py` · `sandbox_audit_middleware.py` · `_bounded_dict.py` · `delegation_ledger.py`† · `skill_context.py`† |
| §3 | `worker.py` :: receipts/title/duration finalizers · `runs/naming.py` · `events/catalog.py` · `events/store/base.py` · `events/store/jsonl.py` · `runtime/context_keys.py` |
| §4 | `subagents/config.py` · `subagents/registry.py` · `contracts/subagent_status_contract.json` (enums are vector-asserted via `result-format.test.ts`, but the row's own deliverable — the contract copied into the plugin — has not happened) |
| §5 | `utils/**` |
| §6 | `skills/validation.py` · `skills/skillscan/**` · `skills/review/**` · `.agent/skills/**` |
| §9 | `guardrails/provider.py` · `guardrails/middleware.py` |
| §10 | `config/tool_progress_config.py` · `config/token_budget_config.py` · `config/tool_output_config.py` |

† `delegation_ledger.py` and `skill_context.py`: `delegations_ledger.json` / `state_reducers.json` vectors do pass against `src/state/*.ts`, but those vectors exercise the state-channel halves owned by the `thread_state.py` and `durable_context` rows; the extraction-from-messages and render surfaces these rows name are still `planned` (report §5.5 counts both unshipped), so the rows get no row-scope credit.

| § | Row (was approximate — 36) |
|---|---|
| §1 | `lead_agent/agent.py` :: make_lead_agent · `lead_agent/agent.py` :: build_middlewares · `lead_agent/agent.py` :: resolution helpers · `factory.py` :: create_deerflow_agent · `features.py` · `human_input.py` |
| §2 | `input_sanitization_middleware.py` · `thread_data_middleware.py` · `tool_error_handling_middleware.py` :: _build_runtime_middlewares · `skill_tool_policy_middleware.py` · `todo_middleware.py` · `memory_middleware.py` (the Stop-hook capture path exists — `memory-extract.js` — but no test or recorded run asserts the enqueue-on-Stop contract, and the row is still `planned`) · `clarification_middleware.py` |
| §3 | `worker.py` :: run_agent · `journal.py` · `secret_context.py` |
| §5 | `tools/tools.py` · `clarification_tool.py` · `setup_agent_tool.py` · `community/**` |
| §6 | `skills/tool_policy.py` |
| §8 | `local_sandbox.py` · `sandbox/security.py` · `sandbox/search.py` · `config/paths.py` |
| §9 | `guardrails/builtin.py` |
| §10 | `app_config.py` · `skills_config.py + tool_search_config.py` · `memory_config.py` · `sandbox_config.py` · `agents_config.py` · small toggle schemas · `extensions_config.py` · `config.example.yaml` · `extensions_config.example.json` · `.env.example` |

**Group B — deferred: 1 row.** §2 `tool_progress_middleware.py` — no port code by declared deferral (not omission); no evidence possible.

**Group C — needs-investigation, unresolved: 8 rows.** The investigation itself is the missing evidence: §2 `skill_activation_middleware.py`, §2 `mcp_routing_middleware.py`, §5 `update_agent_tool.py`, §5 `invoke_acp_agent_tool.py`, §5 `skill_manage_tool.py`, §6 `skills/slash.py`, §6 `skills/installer.py`, §9 `mcp/tools.py`.

**Group D — port surface exists, but no evidence of the behavior: 7 rows.** These are the rows the new rule was written for.

| Row | What exists | Why unverified |
|---|---|---|
| §5 `sandbox/tools.py` :: write_file_tool | M5 mapping contract (sandbox-contract.md §1, §4.2) | no test and no recorded scenario exercises the Write mapping or the dropped-append workarounds; A1–A4 and the M5 smokes never invoked it |
| §5 `sandbox/tools.py` :: str_replace_tool | M5 mapping contract | same — the tightened-uniqueness delta is documented, never demonstrated |
| §5 `sandbox/tools.py` :: ls_tool | M5 mapping contract | no test, no recorded run |
| §5 `sandbox/tools.py` :: glob_tool | M5 mapping contract | no test, no recorded run; native Glob is not a capabilities-matrix row |
| §5 `sandbox/tools.py` :: grep_tool | M5 mapping contract | same, and the case-sensitivity flip is documented, never demonstrated (A8 used `grep` via Bash, not the Grep tool) |
| §6 `skills/public/**` (7 optional packs) | converted at M4, gated | matrix's own words: "not runnable without provider keys" — the M4 smoke covered the plugin-loaded set; no recorded run of any optional pack |
| §11 `persistence/run/model.py + thread_meta/model.py` | run-meta.json schema (M2) informed by its field lists | no test asserts the original field lists were carried; `run-meta.test.ts` asserts the *port's* invariants, which is the `runs/store` row's contract, and this row's status is `excluded (delivery)` |

Count: 61 + 1 + 8 + 7 = **77** ✓

### 8.5 Tier-e-only rows — kept `approximate` on the weakest evidence alone: 6

| Row | Only evidence |
|---|---|
| §2 `terminal_response_middleware.py` | `stop-hook.test.ts` (evidence-gate unit tests; the gate is port-authored, so no baseline vector can exist for it) |
| §3 `runs/store/base.py` | `run-meta.test.ts` (9 tests) |
| §3 `checkpoint_state.py` | `atomic-io.test.ts` (16 tests) |
| §7 `agents/memory/manager.py` | the single-impl collapse covered indirectly by store/write-gate/injection tests |
| §7 `deer_mem.py` | `write-gate.test.ts` + `store.test.ts` (the row's own admission/injection wiring has no vector, no frozen anchor of its own, no recorded run) |
| §7 `deermem core/queue.py` | `queue.test.ts` (24 tests) |

The 26 exact-classified rows demoted in §8.2 include **zero** tier-e-only demotions: every one of them has *no* evidence at any tier, because none is implemented. No implemented exact-classified row lost its class for having only unit tests — the M9/M13 rows all turned out to carry source-line-anchored (tier b) or recorded-live (tier d) evidence.

### 8.6 Deltas vs the four-way computation (§5.2)

| Class | §5.2 | §8.3 | Δ | Where it went |
|---|---:|---:|---:|---|
| exact | 45 (28.5%) | 18 (11.4%) | −27 | 26 → unverified (unimplemented), 1 → approximate (`tool_search`, platform-verified capability ≠ byte-parity evidence) |
| approximate | 88 (55.7%) | 38 (24.1%) | −50 | 51 → unverified, +1 from exact |
| intentionally omitted | 23 (14.6%) | 23 (14.6%) | 0 | — |
| blocked | 2 (1.3%) | 2 (1.3%) | 0 | — |
| unverified | — | 77 (48.7%) | +77 | 61 no-code + 8 needs-investigation + 1 deferred + 7 code-without-evidence |
| exact + approximate | 133 (84.2%) | 56 (35.4%) | −77 | the entire gap is the unverified class |

### 8.7 Honest reading

The 84.2% headline in §5.2 measured *dispositions*: how much of the engine's behavior has a viable equivalent on the target if every row is eventually built and proven. Under the evidence rule the number that survives is **35.4%** — 56 of 158 in-scope behaviors are both ported (or natively covered) *and* demonstrated, 46 of them by vectors, frozen source anchors, recorded adversarial gates, or recorded live runs, and only 6 resting on ordinary unit tests alone. The 48.7% now labeled unverified is not newly discovered loss: 61 of those 77 rows were always `planned` and have no code to test, 8 await an investigation that never ran, 1 is deferred, and only 7 have a real port surface (five M5 tool-mapping contracts, the optional skill packs, one schema-feed row) whose behavior nobody has yet demonstrated. What the recomputation actually changes is the burden of proof: the port's verified core — state reducers, prompts, caps, loop detection, tool-meta taxonomy, goal loop, memory guardrails, workspace delivery, the summarization wrapper — is exceptionally well evidenced, and everything outside it should be quoted as *unproven*, never as *approximately preserved*.

### 8.8 Post-A9 revision (recorded gate A9, commit b0df7ce1)

Gate **A9** landed after the computation above (`parity/fixtures/adversarial/RESULTS.md`, "A9 — tool-mapping live exercise", PASSED, 2026-08-01): one recorded headless run exercised Glob → Grep → Read (read-mark stamped) → Edit (write-gate silent-allow after read) → Write (new file), each wrapped by loop-guard and post-tool-meta with the full hook chain visible in `hooks.jsonl`. That is **tier-d recorded-live evidence** for exactly the five §8.4 Group D rows that had a mapping contract but no demonstration:

- §5 `sandbox/tools.py` :: `write_file_tool`, `str_replace_tool`, `ls_tool`, `glob_tool`, `grep_tool` — **unverified → approximate (tier d, A9)**. Their §8.4 Group D entries are superseded; Group D shrinks to 2 rows (the 7 optional skill packs, the `persistence/run+thread_meta` field lists) and the unverified total to 72.

The same run also fired the **delivery gate live end-to-end** (first Stop blocked with `produced=1 missing=1`, compliant re-answer, second Stop `receipt=written`). No class or tier changes: `present_file_tool` was already `approximate` with tier d (the M13 block-then-pass smoke); A9 is a second independent live record for it. The PreCompact *subprocess* smoke noted for `summarization_hook` is a memory row, not a delivery row, and is unaffected.

**Revised five-way table** (§8.3 superseded; pre-A9 numbers kept as the prior line):

| Class | Pre-A9 | Post-A9 | % of 158 |
|---|---:|---:|---:|
| exact (tier a–d) | 18 | 18 | 11.4% |
| approximate (tier a–e / platform) | 38 | **43** | **27.2%** |
| intentionally omitted | 23 | 23 | 14.6% |
| blocked | 2 | 2 | 1.3% |
| unverified | 77 | **72** | **45.6%** |
| **Total** | **158** | **158** | 100% (100.1 with per-line rounding) |

Check: 18 + 43 + 23 + 2 + 72 = **158** ✓ (arithmetic of the move: approximate 38 + 5 = 43; unverified 77 − 5 = 72; no other class touched).

- **Evidenced equivalence: exact + approximate = 61 / 158 = 38.6%** (was 56/158 = 35.4% pre-A9).
- The unverified breakdown becomes: 61 no-code (`planned`) + 8 needs-investigation + 1 deferred + 2 code-without-evidence = 72.
- The tier-e-only list (§8.5) is unchanged at 6 — the five promoted rows enter `approximate` on tier d, not tier e.
