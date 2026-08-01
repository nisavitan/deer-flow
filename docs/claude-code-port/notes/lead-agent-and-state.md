# Lead Agent, Prompt, State Schemas, and Embedded Client — Source Analysis

Source base: branch `port/claude-code-architecture`, commit `0950924`.
All paths are relative to `backend/packages/harness/deerflow/` unless absolute.
Every claim is marked `[Verified from source: path:lines]`. Unclear items are marked `[Unknown]`.

---

## 1. `make_lead_agent`

### Signature and entry point

```python
def make_lead_agent(config: RunnableConfig):
    """LangGraph graph factory; keep the signature compatible with LangGraph Server."""
```
[Verified from source: agents/lead_agent/agent.py:503-504]

`make_lead_agent` is a thin wrapper that (a) resolves the effective `AppConfig`, (b) freezes the process-wide checkpoint channel mode and snapshot frequency, (c) injects the mode marker into the run config, then (d) delegates to the private `_make_lead_agent(config, app_config=...)`:

- Runtime config merge: `_get_runtime_config(config)` merges `config["configurable"]` with `config["context"]` (context wins on key overlap). [Verified from source: agents/lead_agent/agent.py:114-120, 505]
- `app_config` may be injected via `configurable["app_config"]` if it is an `AppConfig` instance; otherwise `get_app_config()` is used. [Verified from source: agents/lead_agent/agent.py:506-508]
- Checkpoint mode selection precedence (pinned by `test_checkpoint_mode.py`): before first freeze, the app config owns the mode and any client-supplied configurable key is ignored; after freeze, only the internally injected `INTERNAL_CHECKPOINT_MODE_KEY` (run worker / gateway) or the app config are consulted, and `freeze_checkpoint_channel_mode` fails closed on mismatch. `freeze_checkpoint_snapshot_frequency(...)` freezes the delta snapshot cadence from `database.checkpoint_delta.snapshot_frequency` (deliberately not client-injectable). `inject_checkpoint_mode(config, mode)` stamps the mode into the config before delegation. [Verified from source: agents/lead_agent/agent.py:509-531]

### `_make_lead_agent(config, *, app_config)` — step by step

[Verified from source: agents/lead_agent/agent.py:534-788]

1. **Lazy imports** of `get_available_tools`, `setup_agent`, `update_agent`, and `assemble_deferred_tools` / `build_mcp_routing_middleware` / `get_mcp_routing_hints_prompt_section` (circular-dependency avoidance). [agent.py:535-538]
2. **Mode re-read**: `mode` comes from `configurable[INTERNAL_CHECKPOINT_MODE_KEY]` falling back to `app_config.database.checkpoint_channel_mode`. [agent.py:542-545]
3. **Identity**: `resolved_user_id = resolve_config_user_id(config)` — one authoritative user id; Agent Server reserved auth fields win over client-supplied context/configurable values. [agent.py:547-552]
4. **Runtime options** read from merged cfg: `model_name`/`model`, `is_plan_mode` (default False), `subagent_enabled` (default False), `max_concurrent_subagents` (default 3), `max_total_subagents` (default from `app_config.subagents.max_total_per_run` via `_default_max_total_subagents`, itself defaulting to `DEFAULT_MAX_TOTAL_SUBAGENTS_PER_RUN`), `is_bootstrap`, `non_interactive`, `agent_name` (validated by `validate_agent_name`). [agent.py:554-561, 80-82]
5. **Custom agent config**: `load_agent_config(agent_name, user_id=resolved_user_id)` unless bootstrap. `available_skills = _available_skill_names(agent_config, is_bootstrap)`: bootstrap → `{"bootstrap"}`; agent config with a `skills` list → that set; else `None` (all). [agent.py:563-564, 481-486, 68]
6. **Thinking / reasoning / sampling precedence** — `request > custom agent default > runtime default` via `_resolve_runtime_option` (`key in cfg` distinguishes omitted vs falsy, issue #4336): `thinking_enabled` default True, `reasoning_effort` default None; per-agent `model_settings` become `agent_model_overrides` (dict, `exclude_none`). [agent.py:566-579, 85-98]
7. **Model resolution**: `_resolve_model_name(requested or agent_model, app_config)` — falls back to `app_config.models[0].name` with a warning on unknown names, raises `ValueError` when no models are configured. `thinking_enabled` is force-disabled with a warning when the resolved model lacks `supports_thinking`. [agent.py:582-590, 123-135]
8. **Trace metadata**: `config["metadata"]` gains `agent_name`, `model_name`, `thinking_enabled`, `reasoning_effort`, `is_plan_mode`, `subagent_enabled`, `tool_groups`, `available_skills`. [agent.py:604-619]
9. **Tracing callbacks at graph root**: `build_tracing_callbacks()` appended to `config["callbacks"]`. Every in-graph `create_chat_model(...)` MUST pass `attach_tracing=False` (module docstring invariant; forgetting emits duplicate spans and breaks Langfuse session/user propagation). [agent.py:1-23, 621-632]
10. **Skills**: `enabled_skills = _load_enabled_available_skills(available_skills, app_config, user_id)` (loads via `get_enabled_skills_for_config`, filters to allowlist). Skill deferred discovery: `skill_search_enabled = app_config.skills.deferred_discovery`; `build_skill_search_setup(...)` yields `SkillSearchSetup(describe_skill_tool, skill_names)`. [agent.py:489-500, 634-641, 711-715]
11. **Bootstrap branch** (`is_bootstrap=True`, agent.py:643-704): skill set narrowed to `_BOOTSTRAP_SKILL_NAMES = {"bootstrap"}`; tools = `get_available_tools(model_name, subagent_enabled, app_config) + [setup_agent]`; `ask_clarification` removed when `non_interactive` (`_NON_INTERACTIVE_DISABLED_TOOL_NAMES`); authorization candidates = configured tools + optional `describe_skill` + memory tools (`_append_memory_tools_without_name_conflicts` skips name collisions with a warning); `apply_tool_authorization(candidates, context=cfg, app_config)` returns `(authorized_tools, _authz_provider)`; configured vs "late" tools are split by object identity so `describe_skill`/memory tools stay after `assemble_deferred_tools(configured_tools, enabled=tool_search.enabled)`; `build_mcp_routing_middleware(final_tools, setup, top_k=tool_search.auto_promote_top_k)`. Ends in `create_agent(...)` (see below). [agent.py:643-704, 69, 101-111]
12. **Normal branch** (agent.py:711-788): identical assembly plus:
    - `extra_tools = [update_agent]` only when `agent_name` is set AND the run is not from a webhook channel (`_WEBHOOK_CHANNELS = {"github"}`; `channel_name` from cfg, plumbed by `ChannelManager._resolve_run_params`). Rationale: webhook prompts come from arbitrary external commenters; `update_agent` mutating `SOUL.md`/`config.yaml` must stay on operator-trusted surfaces. [agent.py:71-77, 717-731]
    - `get_available_tools(model_name, groups=agent_config.tool_groups, subagent_enabled, app_config)`. [agent.py:733]
    - `mcp_routing_hints_section = get_mcp_routing_hints_prompt_section(authorized_tools, deferred_names=setup.deferred_names)` — passed into the prompt. [agent.py:757]
13. **Final `create_agent(...)` call** (both branches):
    - `model=create_chat_model(name=model_name, thinking_enabled=..., reasoning_effort=... (normal branch only), app_config=..., attach_tracing=False, model_overrides=agent_model_overrides (normal branch only))`. [agent.py:678, 759]
    - `tools=final_tools` (deferred-assembled + late tools). [agent.py:679, 760]
    - `middleware=normalize_middleware_state_schemas(build_middlewares(...), mode)` — see below. [agent.py:680-692, 761-774]
    - `system_prompt=apply_prompt_template(...)` with `subagent_enabled`, clamp inputs, `agent_name`, `available_skills`, `app_config`, `deferred_names`, `mcp_routing_hints_section` (normal branch), `user_id`, `skill_names`. [agent.py:693-702, 775-786]
    - `state_schema=get_thread_state_schema(mode)`. [agent.py:703, 787]
    - **No `checkpointer` argument is passed to `create_agent` in either branch** — persistence is attached by the hosting runtime (LangGraph Server / Gateway run worker), not by the factory. [Verified from source: agents/lead_agent/agent.py:677-704, 758-788 — no checkpointer kwarg appears]

### `build_middlewares(...)` — the lead middleware chain

```python
def build_middlewares(config, model_name, agent_name=None, custom_middlewares=None, *,
                      available_skills=None, app_config=None, deferred_setup=None,
                      mcp_routing_middleware=None, user_id=None, authorization_provider=None)
```
[Verified from source: agents/lead_agent/agent.py:273-285]

Public entry point shared with `DeerFlowClient` (the docstring explicitly pins the name as a cross-module import stability contract). [agent.py:286-291]

Assembly order (append order; items marked *(cond)* are conditional):

| # | Middleware | Condition / notes | Lines |
|---|---|---|---|
| 0 | `build_lead_runtime_middlewares(app_config, lazy_init=True, [authorization_provider], [deferred_setup])` | shared runtime base (sanitization, budgets, thread-data, uploads, sandbox, dangling-tool-call, LLM error, authz/guardrail, audit, read-before-write, tool progress, tool error handling — defined in `middlewares/tool_error_handling_middleware.py`) | 311-320 |
| 1 | `DynamicContextMiddleware(agent_name, app_config)` | always; injects current date (and optionally memory) as `<system-reminder>` into the first HumanMessage so the system prompt stays static for prefix caching | 322-326 |
| 2 | `SkillActivationMiddleware(available_skills, app_config, user_id, slash_source_owner_token)` | always; token is `secrets.token_urlsafe(24)`, shared with the next middleware | 328-341 |
| 3 | `SkillToolPolicyMiddleware(available_skills, app_config, user_id, slash_source_owner_token)` | always; applies `allowed-tools` after activation | 343-354 |
| 4 | `DurableContextMiddleware(skills_container_path, skill_file_read_tool_names)` | always; captures delegations/skill loads before summarization compaction | 356-366 |
| 5 | `DeerFlowSummarizationMiddleware` | *(cond)* `create_summarization_middleware(app_config, run_model_name=model_name)` is not None; `run_model_name` is source of truth for null summary model | 138-145, 368-371 |
| 6 | `TodoMiddleware(system_prompt=..., tool_description=...)` | *(cond)* `cfg["is_plan_mode"]`; long inline prompts defined in `_create_todo_list_middleware` | 148-260, 373-378 |
| 7 | `TokenUsageMiddleware()` | *(cond)* `app_config.token_usage.enabled` | 380-382 |
| 8 | `TitleMiddleware(app_config)` | always | 384-385 |
| 9 | `MemoryMiddleware(agent_name, memory_config)` | *(cond)* skipped in tool mode unless the backend `backend_requires_passive_writes_in_tool_mode`; warning if `mode=="tool"` but `enabled` false | 387-397 |
| 10 | `ViewImageMiddleware()` | *(cond)* resolved model `supports_vision` | 399-403 |
| 11 | `mcp_routing_middleware` | *(cond)* not None; must precede deferred filter | 405-408 |
| 12 | `DeferredToolFilterMiddleware(deferred_names, catalog_hash)` + ordering assertion `assert_mcp_routing_before_deferred_filter` | *(cond)* `deferred_setup.deferred_names` non-empty | 410-420 |
| 13 | `SystemMessageCoalescingMiddleware()` | always; strict providers reject non-leading SystemMessages | 422-427 |
| 14 | `SubagentLimitMiddleware(max_concurrent, max_total)` | *(cond)* `cfg["subagent_enabled"]`; defaults 3 / `subagents.max_total_per_run` | 429-434 |
| 15 | `LoopDetectionMiddleware.from_config(...)` | *(cond)* `loop_detection.enabled` | 436-439 |
| 16 | `TokenBudgetMiddleware.from_config(...)` | *(cond)* `token_budget.enabled` | 441-446 |
| 17 | `custom_middlewares` | *(cond)* caller-supplied (embedded client passes its `middlewares`) | 448-450 |
| 18 | `load_configured_extension_middlewares(app_config)` | *(cond)* config-declared extension classes | 452-454 |
| 19 | `TerminalResponseMiddleware()` | always; retries an empty terminal AIMessage once, then persists a visible error fallback | 456-459 |
| 20 | `ModelLengthFinishReasonMiddleware()` | always; stamps run-level `stop_reason` for length-capped completions | 461-465 |
| 21 | `SafetyFinishReasonMiddleware.from_config(...)` | *(cond)* `safety_finish_reason.enabled`; registered late so reverse-order `after_model` dispatch runs it first | 467-474 |
| 22 | `ClarificationMiddleware()` | always **last** | 476-477 |

Ordering rationale is documented in the comment block at agents/lead_agent/agent.py:263-272 (ThreadData before Sandbox; Uploads after ThreadData; DanglingToolCall before model; Summarization early; Todo before Clarification; ViewImage before Clarification; ToolErrorHandling before Clarification; Clarification last). [Verified from source: agents/lead_agent/agent.py:263-272]

---

## 2. Lead-agent prompt construction (`prompt.py`)

### `apply_prompt_template` — signature

```python
def apply_prompt_template(
    subagent_enabled: bool = False,
    max_concurrent_subagents: int = 3,
    max_total_subagents: int | None = None,
    *,
    agent_name: str | None = None,
    available_skills: set[str] | None = None,
    app_config: AppConfig | None = None,
    deferred_names: frozenset[str] = frozenset(),
    mcp_routing_hints_section: str = "",
    user_id: str | None = None,
    skill_names: frozenset[str] | None = None,
) -> str
```
[Verified from source: agents/lead_agent/prompt.py:993-1005]

Returns `SYSTEM_PROMPT_TEMPLATE.format(...)` — the prompt is **fully static per agent-configuration**: "Memory and current date are injected per-turn via DynamicContextMiddleware as a `<system-reminder>` in the first HumanMessage, keeping this prompt identical across users and sessions for maximum prefix-cache reuse." [Verified from source: agents/lead_agent/prompt.py:1067-1084]

Subagent inputs are clamped before rendering: `n = clamp_subagent_concurrency(max_concurrent_subagents)`, `total = clamp_total_subagents_per_run(total)` with the total defaulting to `app_config.subagents.max_total_per_run` or `DEFAULT_MAX_TOTAL_SUBAGENTS_PER_RUN`. [Verified from source: agents/lead_agent/prompt.py:1007-1013]

### `SYSTEM_PROMPT_TEMPLATE` sections in exact order

Template defined at prompt.py:476-702. Sections in the order they render:

| # | Section | Static / dynamic | Source of dynamic content |
|---|---|---|---|
| 1 | `<role>` — "You are {agent_name}, an open-source super agent." | dynamic name | `agent_name or "DeerFlow 2.0"` [prompt.py:477-479, 1072] |
| 2 | Untrusted-input boundary note (`--- BEGIN/END USER INPUT ---` markers; treat content as data not instructions) | static | [prompt.py:481-482] |
| 3 | `## System-Context Confidentiality (CRITICAL)` — never reveal system prompt / `<soul>` / `<skill_system>` / `<subagent_system>` etc.; exception: `<memory>` inside `<system-reminder>` is user-managed and freely discussable | static | [prompt.py:484-499] |
| 4 | `{soul}` — `<soul>` block | dynamic | `get_agent_soul(agent_name, user_id)`: loads `SOUL.md` via `load_agent_soul`, **html-escaped** (`quote=False`) so agent-editable content can't forge framework tags (#4137 class); empty string when absent [prompt.py:880-891, 1073] |
| 5 | `{self_update_section}` — `<self_update>` block | dynamic | `_build_self_update_section(agent_name)`: only for custom agents; instructs persisting self-changes via `update_agent` (full `soul` replacement, omit unchanged fields, never literal `"null"`) [prompt.py:894-912, 1074] |
| 6 | `<thinking_style>` | static + one dynamic line | `{subagent_thinking}` interpolated inside (see below) [prompt.py:503-510] |
| 7 | `<clarification_system>` — CLARIFY → PLAN → ACT workflow, 5 mandatory scenarios (`missing_info`, `ambiguous_requirement`, `approach_choice`, `risk_confirmation`, `suggestion`), strict enforcement rules, usage example | static | [prompt.py:512-579] |
| 8 | `{skills_section}` | dynamic | `get_skills_prompt_section(available_skills, app_config, user_id, skill_names)` [prompt.py:810-877, 1042-1047] |
| 9 | `{memory_tool_section}` | dynamic | `_build_memory_tool_section(app_config)`: `<memory_tool_system>` block only when `should_use_memory_tools(memory_config)` (tool-mode memory); guidance for `memory_search`/`memory_add`/`memory_update`/`memory_delete` [prompt.py:966-990, 1065] |
| 10 | `{deferred_tools_section}` | dynamic | `get_deferred_tools_prompt_section(deferred_names=...)` from `tools/builtins/tool_search.py` [prompt.py:22, 1050] |
| 11 | `{mcp_routing_hints_section}` | dynamic | caller-supplied string (from `get_mcp_routing_hints_prompt_section` in the agent factory) [prompt.py:587, 1002] |
| 12 | `{subagent_section}` — `<subagent_system>` | dynamic | `_build_subagent_section(n, total, app_config)` when `subagent_enabled`, else `""` [prompt.py:341-473, 1013] |
| 13 | `<working_directory existed="true">` — uploads / workspace / outputs contract, file-management rules | static + `{acp_section}` | `{acp_section}` = joined `_build_acp_section` (ACP agent guidance, only when ACP agents configured) + `_build_custom_mounts_section` (configured sandbox mounts) [prompt.py:591-608, 915-963, 1053-1055] |
| 14 | `<response_style>` — clear/concise, prose over bullets, action-oriented | static | [prompt.py:610-614] |
| 15 | `<citations>` — mandatory `[citation:Title](URL)` after web_search/web_fetch, Sources-section format rules, research workflow | static | [prompt.py:616-677] |
| 16 | `<critical_reminders>` | static + dynamic lines | `{subagent_reminder}` and `{skill_first_reminder}` interpolated [prompt.py:679-701] |

Note: `_get_memory_context` (prompt.py:705-757) builds the `<memory>` block but is **not called by `apply_prompt_template`** — memory injection happens per-turn (DynamicContextMiddleware path), consistent with the static-prompt design. [Verified from source: agents/lead_agent/prompt.py:705-757, 1067-1084 — no call site inside `apply_prompt_template`]

### Skills section detail (`get_skills_prompt_section`, prompt.py:810-877)

- **Deferred discovery path** (`skill_names is not None`): renders a compact `<skill_index>` via `deerflow.skills.describe.get_skill_index_prompt_section` — names only, discover via `describe_skill`. [prompt.py:846-854]
- **Legacy path**: loads ALL skills (enabled + disabled) from user-scoped or global storage; enabled list via `get_enabled_skills_for_config` (per-`(id(app_config), user_id)` LRU cache, cap 256, background-refresh worker thread, never blocks request paths — returns `[]` on cold miss). [prompt.py:29-211, 856-877]
- Rendered by `_get_cached_skills_prompt_section` (`lru_cache(maxsize=32)`, keyed by skill signatures): `<skill_system>` wrapper containing Progressive Loading Pattern (5 steps), Explicit Slash Skill Activation rules, `**Skills are located at:** {container_base_path}`, optional Skill Self-Evolution section (`skill_manage` tool rules incl. "⛔ NEVER write SKILL.md files to /mnt/user-data/..."), `<available_skills>` (per-skill `<skill><name/><description/><location/>` entries, html-escaped, with mutability label `[custom, editable]`/`[legacy, read-only]`/`[built-in]`), and `<disabled_skills>` ("You MUST NOT read, reference, or use any of these skills … even if their files exist on disk"). [prompt.py:214-230, 274-299, 760-807]

### Subagent / delegation policy block (`_build_subagent_section`, prompt.py:341-473)

Two renderings depending on clamped `n`:
- `n == 1`: no parallel guidance; benefit = "specialist capability + context isolation" only; single-call workflow. [prompt.py:370-389]
- `n > 1`: adds hard vetoes for parallel dispatch, parallel-latency benefit, multi-batch example. [prompt.py:390-423]

Subagent descriptions are built dynamically from the registry (`get_available_subagent_names` + `get_subagent_config`); custom agent descriptions are html-escaped (first line only). `bash` renders a "Not available in the current sandbox configuration" description when absent. [prompt.py:302-338, 356-363]

Key behavior-defining passages (verbatim, abridged):

> `Subagents are optional. **Default to direct execution.** Do not delegate merely because a task is complex, has many steps, produces verbose output, or touches a large repository.`
> `Expected cost = delegation and startup overhead + duplicate context and repository discovery + coordination and synthesis + state-conflict risk + side-effect risk`
> `**Delegate only when the expected benefit is clearly greater than the expected cost.** When uncertain, execute directly.`
[Verified from source: agents/lead_agent/prompt.py:427-435]

Hard limits / stop conditions:

> `- **MAXIMUM {n} `task` CALLS PER RESPONSE - NEVER emit more. VIOLATION IS A HARD ERROR.** Excess calls are discarded and their work is lost.`
> `- **MAXIMUM {total} `task` CALLS PER RUN - NEVER exceed it. VIOLATION IS A HARD ERROR.** Count only delegations for the current user request/run; older thread history does not consume this run's allowance.`
> (n>1) `- Never start a batch that would exceed either limit. When a limit is reached, synthesize existing results or continue directly.`
[Verified from source: agents/lead_agent/prompt.py:449-453, 403]

Parallel hard vetoes (n>1):

> `- **Inter-agent dependencies**: One delegated task needs another delegated task's result. Keep the dependency chain together instead of splitting it across parallel subagents.`
> `- **Unsafe shared state**: Tasks may touch overlapping files, shared mutable state, or external side effects without disjoint ownership.`
[Verified from source: agents/lead_agent/prompt.py:392-397]

Closing contract: `` The `task` tool waits for the subagent and returns its result directly; no polling is needed. `` [prompt.py:472]

### Artifact / `present_files` rules (verbatim fragments)

From `<working_directory>`:
> `- Final deliverables must be copied to /mnt/user-data/outputs and presented using `present_files` tool (⚠️ Skills are NOT deliverables — use `skill_manage` tool instead)`
[Verified from source: agents/lead_agent/prompt.py:606]

From `<critical_reminders>`:
> `- Output Files: Final deliverables must be in /mnt/user-data/outputs (⚠️ Skills are NOT deliverables — use skill_manage tool instead)`
> `- To render an output image in a final response, use its complete virtual artifact path … Never use a bare or workspace-relative filename. Call present_files for the image before referencing it.`
[Verified from source: agents/lead_agent/prompt.py:683, 693-697]

Also behavior-defining in `<critical_reminders>`: File Editing Workflow (prefer `str_replace` over `write_file`; split long new files into `append=True` sections, issue #3189) [prompt.py:684-691]; parallel tool calling encouragement [prompt.py:698]; language consistency [prompt.py:699]; "Always Respond: … You MUST always provide a visible response to the user after thinking." [prompt.py:700].

### Dynamic reminder fragments (computed in `apply_prompt_template`)

- `subagent_reminder` (only when `subagent_enabled`): "Benefit-Based Delegation: Default to direct execution … HARD LIMITS ARE NON-NEGOTIABLE: max {n} `task` calls per response, max {total} per run; excess calls are discarded and their work is lost." [prompt.py:1016-1023]
- `subagent_thinking` (thinking-style DELEGATION CHECK line; distinct wording for n==1 vs n>1; empty when disabled). [prompt.py:1026-1039]
- `skill_first_reminder`: deferred mode → "call describe_skill(name) to check if a matching skill exists, then read_file to load it"; legacy mode → "Always load the relevant skill before starting **complex** tasks." [prompt.py:1059-1063]

---

## 3. `RuntimeFeatures` (`agents/features.py`)

Declarative flags for `create_deerflow_agent` (a separate assembly path from `make_lead_agent`; pure data, no I/O). Most features accept `True` (built-in default middleware), `False` (disable), or an `AgentMiddleware` instance (custom); `summarization` and `guardrail` have **no built-in default** — only `False` or an instance. [Verified from source: agents/features.py:17-28]

| Flag | Type | Default |
|---|---|---|
| `sandbox` | `bool \| AgentMiddleware` | `True` |
| `memory` | `bool \| AgentMiddleware` | `False` |
| `memory_config` | `MemoryConfig \| None` | `None` (explicit config for direct callers; lead-agent path passes `app_config.memory`) |
| `summarization` | `Literal[False] \| AgentMiddleware` | `False` |
| `subagent` | `bool \| AgentMiddleware` | `False` |
| `vision` | `bool \| AgentMiddleware` | `False` |
| `auto_title` | `bool \| AgentMiddleware` | `False` |
| `guardrail` | `Literal[False] \| AgentMiddleware` | `False` |
| `loop_detection` | `bool \| AgentMiddleware` | `True` |
| `token_budget` | `bool \| AgentMiddleware` | `False` |

[Verified from source: agents/features.py:30-41]

The module also defines positioning decorators `Next(anchor)` / `Prev(anchor)` that stamp `_next_anchor` / `_prev_anchor` class attributes on `AgentMiddleware` subclasses (with type validation raising `TypeError`), used for declarative middleware ordering. [Verified from source: agents/features.py:49-70]

---

## 4. `ThreadState` schema (`agents/thread_state.py`)

`class ThreadState(AgentState)` — extends LangChain's `AgentState` (which carries `messages`). [Verified from source: agents/thread_state.py:264-277]

| Field | Type / reducer | Semantics |
|---|---|---|
| `sandbox` | `SandboxStateField = Annotated[NotRequired[SandboxState \| None], merge_sandbox]` | `{sandbox_id}`; reducer accepts **idempotent writes only** — identical ids merge, conflicting non-None ids raise `ValueError` (lifecycle/isolation bug fails closed) [thread_state.py:35-37, 59-80, 265] |
| `thread_data` | `NotRequired[ThreadDataState \| None]` (no reducer, LastValue) | `{workspace_path, uploads_path, outputs_path}` [thread_state.py:39-42, 266] |
| `title` | `NotRequired[str \| None]` (no reducer) | thread title written by TitleMiddleware [thread_state.py:267] |
| `artifacts` | `Annotated[list[str], merge_artifacts]` | merge + dedupe preserving order (`dict.fromkeys`) [thread_state.py:83-90, 268] |
| `todos` | `Annotated[list \| None, merge_todos]` | last-non-None wins; an explicit empty list is an update and replaces existing [thread_state.py:110-120, 269] |
| `goal` | `Annotated[GoalState \| None, merge_goal]` | preserve existing when node writes None; any non-None write replaces [thread_state.py:123-127, 270] |
| `uploaded_files` | `NotRequired[list[dict] \| None]` (no reducer) | uploads listing injected by UploadsMiddleware [thread_state.py:271] |
| `viewed_images` | `Annotated[dict[str, ViewedImageData], merge_viewed_images]` | `image_path -> {mime_type, size, actual_path}` (metadata only — no base64, avoids duplicating payloads across checkpoints, #4138); merge with new-wins per key; **empty dict `{}` clears all** [thread_state.py:45-57, 93-107, 272] |
| `promoted` | `Annotated[PromotedTools \| None, merge_promoted]` | `{catalog_hash, names}` deferred-tool promotions; None/empty preserves; changed `catalog_hash` replaces wholesale (drops stale names — prevents persisted bare names exposing different tools after catalog drift); same hash unions + dedupes names [thread_state.py:130-153, 273] |
| `delegations` | `Annotated[list[DelegationEntry], merge_delegations]` | ledger of `task` delegations: `{id, run_id?, description, subagent_type, status, result_brief?, result_sha256?, result_ref?, stop_reason?, created_at}`. Reducer: None/empty preserves; same-id latest wins keeping first-seen order and original `created_at`/`run_id`; a terminal status (from `SUBAGENT_STATUS_VALUES`) is never overwritten by a non-terminal one; capped to last `_DELEGATION_LEDGER_MAX_ENTRIES = 50`. `stop_reason` (token_capped/turn_capped/loop_capped, #3875 Phase 2) is additive [thread_state.py:156-204, 274] |
| `skill_context` | `Annotated[list[SkillEntry], merge_skill_context]` | active-skill references `{name, path, description, loaded_at}` — reference only, not the SKILL.md body; entries normalized (`_normalize_skill_entry` drops legacy payload keys, whitespace-collapses description, caps at 500 chars); dedupe by `path`, re-read refreshes recency, capped to most recent `_SKILL_CONTEXT_MAX_ENTRIES = 8`; `loaded_at` is observational only (message indices reset after compaction) [thread_state.py:207-261, 275] |
| `summary_text` | `NotRequired[str \| None]` (no reducer, LastValue) | compaction summary written by summarization, projected into model requests as durable context instead of a `messages` item [thread_state.py:276] |

`THREAD_STATE_REDUCER_FIELDS = frozenset({"messages", "sandbox", "artifacts", "todos", "goal", "viewed_images", "promoted", "delegations", "skill_context"})`. [Verified from source: agents/thread_state.py:381-393]

### Delta vs full mode

- `get_thread_state_schema(mode, snapshot_frequency=None)`: mode `"full"` (anything not `"delta"`) → `ThreadState`; `"delta"` → a delta schema whose `messages` field is `Annotated[list[AnyMessage], DeltaChannel(merge_message_writes, snapshot_frequency=...)]`. Default cadence keeps the static `DeltaThreadState` identity; other cadences build a cached `TypedDict` named `DeltaThreadState_f{n}`. Frequency resolves explicit-arg → process-frozen (`resolve_checkpoint_snapshot_frequency`, lazily imported to avoid a cycle) → `DEFAULT_CHECKPOINT_SNAPSHOT_FREQUENCY`. [Verified from source: agents/thread_state.py:24-32, 366-414]
- `merge_message_writes(state, writes)` folds DeltaChannel writes with full public `add_messages` parity (coercion, id allocation via uuid4, replacement-in-place, `RemoveMessage` handling with error on unknown id, `REMOVE_ALL_MESSAGES` reset, null-write errors reporting left/right) in linear time using position indexes and deferred tombstone compaction; LangGraph's private `_messages_delta_reducer` deliberately not used (omits some public semantics). [Verified from source: agents/thread_state.py:279-363]
- `adapt_state_schema_for_mode(schema, mode, freq)` / `normalize_middleware_state_schemas(middleware, mode, freq)`: in delta mode, any middleware exposing a `state_schema` gets a shallow copy with its `messages` annotation swapped to the delta field (cached per (schema, freq)); full mode passes through unchanged. [Verified from source: agents/thread_state.py:417-447]
- Module import side effect: `import deerflow.checkpoint_patches` applies import-time checkpoint saver fixes. [Verified from source: agents/thread_state.py:18]

---

## 5. Goal state (`agents/goal_state.py`)

Entire module is two TypedDicts and a Literal alias — schema only, no logic:

```python
GoalBlocker = Literal["none", "missing_evidence", "needs_user_input", "run_failed",
                      "external_wait", "goal_not_met_yet"]

class GoalEvaluation(TypedDict):
    satisfied: bool
    blocker: GoalBlocker
    reason: str
    evidence_summary: NotRequired[str]

class GoalState(TypedDict):
    objective: str
    status: Literal["active"]
    created_at: str
    updated_at: str
    continuation_count: int
    max_continuations: int
    no_progress_count: int
    max_no_progress_continuations: int
    last_evaluation: NotRequired[dict[str, Any]]
```
[Verified from source: agents/goal_state.py:1-31]

Semantics: `status` can only be `"active"` (a satisfied/cleared goal is removed from state rather than marked); `last_evaluation` is typed loosely (`dict[str, Any]`, not `GoalEvaluation`). The evaluation hooks that *consume* this schema (post-turn evaluator model, hidden `goal_not_met_yet` continuations, no-progress breaker, continuation cap 0–8) live in `runtime/goal.py` and the Gateway run worker, not in this module. [Schema verified from source: agents/goal_state.py:5-31; evaluator behavior is outside the files read for this note — described in backend/AGENTS.md ("Thread-scoped Gateway runs evaluate an active ThreadState.goal…"); implementation detail beyond that: [Unknown — runtime/goal.py not read]]

The client-side goal API (`DeerFlowClient.get_goal/set_goal/clear_goal`) uses `build_goal_state`, `read_thread_goal`, `write_thread_goal`, and `goal_thread_lock` from `deerflow.runtime.goal`, with `DEFAULT_MAX_GOAL_CONTINUATIONS` as the `max_continuations` default. [Verified from source: client.py:58, 527-566]

---

## 6. `human_input.py`

Defines the structured metadata contract for Human-Input-Card replies (v1 response protocol):

- `HUMAN_INPUT_RESPONSE_KEY = "human_input_response"` — the key under `HumanMessage.additional_kwargs`. [Verified from source: agents/human_input.py:8]
- `HumanInputTextResponse`: `{version: 1, kind: "human_input_response", source: str, request_id: str, response_kind: "text", value: str}`. [human_input.py:11-17]
- `HumanInputOptionResponse`: same envelope with `response_kind: "option"` plus `option_id: str`. [human_input.py:20-27]
- `HumanInputResponse = HumanInputTextResponse | HumanInputOptionResponse`. [human_input.py:30]
- `read_human_input_response(additional_kwargs) -> HumanInputResponse | None`: strict validating reader — requires `version == 1` and `kind == "human_input_response"`, non-empty (stripped) strings for `source`, `request_id`, `value` (and `option_id` for option responses); anything malformed returns `None` rather than raising. Output is re-normalized into a fresh dict (no passthrough of extra keys). [Verified from source: agents/human_input.py:33-77]

---

## 7. `DeerFlowClient` (`client.py`)

### Construction and config resolution

- `__init__(config_path=None, checkpointer=None, *, model_name=None, thinking_enabled=True, subagent_enabled=False, plan_mode=False, agent_name=None, available_skills=None, middlewares=None, environment=None)`. If `config_path` is given, `reload_app_config(config_path)` runs first; then `self._app_config = get_app_config()` snapshots the config. [Verified from source: client.py:160-199]
- Checkpoint mode + snapshot frequency are **frozen at construction** from the app config (`freeze_checkpoint_channel_mode`, `freeze_checkpoint_snapshot_frequency`) — same process-freeze contract as `make_lead_agent`. [client.py:200-201]
- `agent_name` validated against `AGENT_NAME_PATTERN` (raises `ValueError`). [client.py:203-204]
- Agent is lazy: `self._agent = None`, `self._agent_config_key = None`; `reset_agent()` clears both. [client.py:216-229]

### Per-call config: `_get_runnable_config`

Builds `RunnableConfig(configurable={thread_id, model_name, thinking_enabled, is_plan_mode, subagent_enabled}, recursion_limit=overrides.get("recursion_limit", 100))` — per-call kwargs override constructor defaults. [Verified from source: client.py:239-251]

### Agent cache key (`_ensure_agent`)

`cfg` = configurable merged with the run `context`. When `authorization.enabled`, a Principal is built via `build_principal_from_context(cfg, default_role=...)` and flattened into an `authorization_identity` tuple `(user_id, role, oauth_provider, oauth_id, channel_user_id, is_internal, deepcopy(attributes))` — the deep copy prevents caller mutation from making a stale tool set look current. The cache key is:

```python
key = (model_name, thinking_enabled, is_plan_mode, subagent_enabled,
       max_concurrent_subagents, max_total_subagents,
       self._agent_name,
       frozenset(self._available_skills) or None,
       self._checkpoint_channel_mode,
       self._checkpoint_snapshot_frequency,
       authorization_identity)
```
If `self._agent` exists and the key matches, the cached agent is reused; otherwise it is rebuilt. [Verified from source: client.py:253-289]

Rebuild mirrors `_make_lead_agent`'s normal branch: `get_available_tools` (lazy import), enabled skills filtered by `available_skills`, `build_skill_search_setup`, `apply_tool_authorization` **before** `assemble_deferred_tools`, `describe_skill` kept as a late tool re-appended after deferred assembly, `build_mcp_routing_middleware(top_k=tool_search.auto_promote_top_k)`, `get_mcp_routing_hints_prompt_section`. Then `create_agent(model=create_chat_model(attach_tracing=False), tools=final_tools, middleware=normalize_middleware_state_schemas(build_middlewares(..., custom_middlewares=self._middlewares, ...), mode, freq), system_prompt=apply_prompt_template(...), state_schema=get_thread_state_schema(mode, freq))`. `effective_user_id = cfg.get("user_id") or get_effective_user_id()` feeds both `build_middlewares` and `apply_prompt_template`. [Verified from source: client.py:291-371, 384-389]

Differences from `_make_lead_agent`: no `reasoning_effort`/`model_overrides` passed to `create_chat_model` [client.py:340 vs agent.py:759]; no `update_agent`/`setup_agent` extra tools; no memory tools appended in the authorization candidate list [client.py:297-331 — `_append_memory_tools_without_name_conflicts` is not referenced]; agent cache invalidated by `update_mcp_config()` and `update_skill()` (both set `_agent = None`, `_agent_config_key = None`) [client.py:1228-1229, 1338-1339].

### Checkpointer wiring

- In `_ensure_agent`: `checkpointer = self._checkpointer` (constructor arg); if `None`, fall back to `deerflow.runtime.checkpointer.get_checkpointer()`; only if the result is not `None` is `kwargs["checkpointer"]` passed to `create_agent`. Without any checkpointer each call is stateless (`thread_id` only isolates files). [Verified from source: client.py:130-137, 372-378]
- The same constructor-or-global resolution is used by `_get_thread_checkpointer()` for goal APIs and `list_threads`/`get_thread` (the latter via `CheckpointStateAccessor.bind(self._agent, checkpointer, mode=...)` for materialized history, plus a single streaming `checkpointer.list(config)` walk to collect `pending_writes` per checkpoint). [Verified from source: client.py:519-525, 620-665]

### `stream()` — trace wrapper

`stream(message, *, thread_id=None, **kwargs)` is a sync generator. When `is_trace_correlation_enabled(self._app_config)` is off, it delegates directly to `_stream_without_trace_context`. When on, it resolves `trace_id = get_current_trace_id() or generate_trace_id()` and binds the ContextVar **only around each `next()` step** (set/reset per step, never across a `yield`) to avoid leaking the id into the caller's context and to avoid cross-context Token reset errors on GC of abandoned generators; `finally: inner.close()`. [Verified from source: client.py:671-724]

### `_stream_without_trace_context()` — event contract

Setup per call [Verified from source: client.py:810-875]:
1. `thread_id = resolve_thread_id(thread_id)` (auto-generate when None).
2. `config = self._get_runnable_config(thread_id, **kwargs)`; `inject_checkpoint_mode(config, mode)`; if a checkpointer resolves, `ensure_checkpoint_mode_compatible(checkpointer, {"configurable": {"thread_id", "checkpoint_ns": ""}}, mode)` — fail-closed mode gate before streaming.
3. Tracing callbacks appended to `config["callbacks"]` at the graph invocation root (matches the gateway worker: one trace per `stream()` with Langfuse session/user propagation).
4. `run_id = str(uuid.uuid4())`; `context = {"thread_id": thread_id, "run_id": run_id}` plus any of the trusted embedded identity overrides `_EMBEDDED_AUTHORIZATION_CONTEXT_KEYS = {user_id, user_role, oauth_provider, oauth_id, channel_user_id, is_internal, authz_attributes}` present in kwargs (in-process caller is trusted). [client.py:79-89, 843-847]
5. `effective_user_id = context.get("user_id") or get_effective_user_id()`; when authorization is enabled, `context["user_id"]` is pinned to it so Layer 1, Layer 2, and the agent cache see the same actor. `inject_langfuse_metadata(config, thread_id=..., user_id=..., assistant_id=self._agent_name or "lead-agent", model_name=..., environment=self._environment or DEER_FLOW_ENV or ENVIRONMENT, deerflow_trace_id=...)`. [client.py:849-866]
6. `self._ensure_agent(config, context=context)`.
7. Input state: `{"messages": [HumanMessage(content=message, additional_kwargs={"run_id": run_id})]}` — the input message is tagged with the run id so durable-context capture can identify the current request boundary. `context` also gains `DEERFLOW_TRACE_METADATA_KEY` (when a trace id exists) and `agent_name`. [client.py:870-874]

Streaming loop: `self._agent.stream(state, config=config, context=context, stream_mode=["values", "messages", "custom"])`. Non-tuple items are treated as `values`. [Verified from source: client.py:928-938]

Event contract (yielded `StreamEvent(type, data)`; `StreamEventType = Literal["values", "messages-tuple", "custom", "end"]` [client.py:105-123]):

| Event | Emitted when | Payload |
|---|---|---|
| `custom` | LangGraph `custom` mode chunk (from `StreamWriter`) | the chunk dict, forwarded as-is [client.py:940-941] |
| `messages-tuple` (AI text) | LangGraph `messages` chunk with text — this is a **delta**; consumers accumulate per `id` | `{type:"ai", content:<delta>, id, [usage_metadata], [additional_kwargs]}` [client.py:404-412, 944-968] |
| `messages-tuple` (AI tool calls) | chunk with `tool_calls` | `{type:"ai", content:"", id, tool_calls:[{name,args,id}], [additional_kwargs]}` [client.py:414-425, 971-979] |
| `messages-tuple` (tool result) | `ToolMessage` chunk | `{type:"tool", content, name, tool_call_id, id, [artifact]}` — non-`None` native `artifact` preserved [client.py:427-439, 981-984] |
| `messages-tuple` (metadata-only follow-up) | values snapshot reveals unsent `additional_kwargs` for an already-streamed id | empty-content AI event; clients merge by id and ignore for text rendering [client.py:997-1010, 1035-1040] |
| `values` | every `values` snapshot | `{title, messages:[serialized], artifacts}` — AI text already delivered via `messages` mode is **not re-synthesized** (dedup via `seen_ids` / `streamed_ids`) [client.py:876-884, 987-1053] |
| `end` | after the graph stream completes | `{usage: {input_tokens, output_tokens, total_tokens}}` cumulative, counted **once per message id** (`counted_usage_ids` — identical cumulative usage appears in both the final `messages` chunk and the values snapshot; first arrival wins) [client.py:882-912, 1055] |

Dedup/accounting invariants: `seen_ids` (values messages emitted once), `streamed_ids` (cross-mode handoff: ids already delivered via `messages` mode are skipped in `values`), `counted_usage_ids` (usage counted once per id), `sent_additional_kwargs_by_id` (per-id delta of `additional_kwargs`, only changed keys re-emitted). [Verified from source: client.py:876-926]

The long docstring documents why this is a parallel path to Gateway's `run_agent` (sync `agent.stream()` vs async `astream`; in-process Python payloads vs JSON/SSE; no `StreamBridge` needed) and that mode-alignment with Gateway is pinned by `tests/test_client.py::test_messages_mode_emits_token_deltas` rather than a shared constant. [Verified from source: client.py:758-788]

`chat()` accumulates `messages-tuple` AI deltas per id (list-append, joined once — avoids O(n²) concat) and returns the last-completed AI message's text. [Verified from source: client.py:1057-1087]

### run_id / thread_id / user_id flow summary

- `thread_id`: resolved/validated per call (`resolve_thread_id` / `validate_thread_id` from `deerflow.utils.thread_id`); goes into `configurable.thread_id` (checkpointer coordinate) and `context.thread_id` (business lookup); also Langfuse `session_id`. [client.py:75, 810-812, 844, 858-866]
- `run_id`: minted per `stream()` call (`uuid.uuid4()`), placed in `context.run_id` and stamped on the input `HumanMessage.additional_kwargs.run_id` (delegation-ledger / durable-context request boundary; matches the Gateway contract that a runtime `run_id` is always provided). [client.py:843-844, 870]
- `user_id`: `context.user_id` override (trusted embedded caller) or `get_effective_user_id()`; feeds Langfuse `user_id`, the authorization Principal, agent-cache identity, prompt/user-scoped skill loading (`effective_user_id` into `build_middlewares`/`apply_prompt_template`), and — when authorization is enabled — is written back into `context["user_id"]` so runtime layers agree. [client.py:333, 851-857, 352, 367]

---

## 8. Port-relevant observations (LangGraph-specific vs platform-neutral)

### LangGraph-specific mechanics (must be re-implemented or replaced in a port)

- **Graph factory contract**: `make_lead_agent(config: RunnableConfig)` exists to satisfy LangGraph Server's graph-factory signature; `create_agent(...)` returns a compiled LangGraph graph. [agent.py:503-504, 677, 758]
- **State reducers / channels**: the whole `ThreadState` reducer system (`Annotated[..., reducer]`, `NotRequired` LastValue channels), delta mode's `DeltaChannel`, `merge_message_writes`'s `add_messages` parity, `REMOVE_ALL_MESSAGES`, and `normalize_middleware_state_schemas` are all LangGraph channel-table machinery. [thread_state.py:264-447]
- **Checkpoint mode freezing** (`freeze_checkpoint_channel_mode`, `inject_checkpoint_mode`, `ensure_checkpoint_mode_compatible`, snapshot frequency) is entirely a LangGraph-checkpointer storage concern. [agent.py:56-62, 509-530; client.py:200-201, 813-830]
- **Middleware chain as `AgentMiddleware`**: the ordering contract (reverse-order `after_model` dispatch, "Clarification last", coalescing innermost) is tied to `langchain.agents` middleware semantics. [agent.py:263-478]
- **Stream modes**: `stream_mode=["values", "messages", "custom"]`, the values/messages dedup dance, and the `messages` vs `messages-tuple` naming split across Graph/SDK/HTTP layers. [client.py:928-933, 758-788]
- **Config plumbing shape**: `configurable` vs `context` merge (`_get_runtime_config`), `config["callbacks"]`/`config["metadata"]` injection points. [agent.py:114-120, 604-632]

### Platform-neutral policy (portable as-is)

- **The entire system prompt**: role/confidentiality contract, clarify-first workflow, benefit-based delegation policy with clamped hard limits, working-directory + `present_files` deliverable contract, citation rules, `str_replace`-over-rewrite editing guidance, skill progressive-loading and disabled-skill prohibitions, self-update rules. All of it is model-facing text independent of LangGraph. [prompt.py:476-702, 341-473]
- **Static-prompt / dynamic-context split**: keep the system prompt byte-identical per agent config; inject date/memory per-turn into the first user message for prefix-cache reuse. [prompt.py:1067-1070; agent.py:322-326]
- **Resolution precedences**: model `request > agent config > global default` with fallback-and-warn; thinking/reasoning `request > agent default > runtime default` with falsy-vs-unset distinction (#4336); subagent limits clamped identically for prompt text and enforcement so model-visible limits match reality. [agent.py:85-98, 554-590; prompt.py:1007-1013]
- **Security boundaries**: html-escaping every agent-/skill-/user-editable string rendered into framework prompt blocks (soul, skill metadata, subagent descriptions — #4137/#4097/#4128 class); withholding `update_agent` on webhook channels; dropping `ask_clarification` in non-interactive runs; authorization Layer 1 before tool assembly with identity in the agent cache key (deep-copied attributes). [prompt.py:222-230, 332-336, 880-891; agent.py:69-77, 655-656, 729-736; client.py:259-286]
- **Durable-context data model**: delegation ledger semantics (same-id latest wins, terminal never downgraded, per-run budget via `run_id` tagging, 50-entry cap, additive `stop_reason`), skill-context reference-not-body with 8-entry recency cap, `summary_text` as out-of-band compressed history, idempotent-only sandbox identity, promoted-tools scoping by catalog hash. These are reducer *policies*; the reducer *mechanism* is LangGraph but the merge rules port directly. [thread_state.py:59-261]
- **Goal loop schema**: objective + continuation budget + no-progress breaker + typed blocker enum is engine-agnostic. [goal_state.py:5-31]
- **Human-input protocol**: versioned, strictly validated v1 text/option response envelope keyed in message metadata. [human_input.py:8-77]
- **Event contract semantics**: delta-vs-snapshot dedup by message id, usage counted once per id, artifact preservation on tool results, `end` with cumulative usage — the *contract* is portable even though the source stream modes are LangGraph's. [client.py:876-1055]
- **`RuntimeFeatures`** flag shape (`True`/`False`/instance) and `Next`/`Prev` ordering declarations are a portable composition idiom (though anchors reference `AgentMiddleware` types). [features.py:17-70]

### Notable port hazards

- `build_middlewares` is imported across a module boundary by `client.py`; renames ripple (explicit stability contract in its docstring). [agent.py:286-291]
- The tracing invariant (root-level callbacks + `attach_tracing=False` at all five in-graph model-creation sites) is easy to violate and produces silent duplicate-span / missing-session bugs. [agent.py:1-23]
- The client agent cache key omits `recursion_limit` and per-call `thread_id` (correct — neither affects agent shape) but includes authorization identity; a port must preserve that identity-sensitivity or risk cross-user tool-set reuse. [client.py:274-286]
- `_make_lead_agent` and `DeerFlowClient._ensure_agent` are parallel implementations of the same assembly (with deliberate deltas: no `update_agent`/`setup_agent`, no memory-tool appending, no `reasoning_effort`/`model_overrides` in the client) — a port should unify or at minimum test-pin the pair. [agent.py:534-788; client.py:253-382]
