# DeerFlow Subagents and Tools — Source Analysis (commit 0950924)

Source-analysis notes for the Claude Code port plan. All paths are relative to
`backend/packages/harness/deerflow/` unless prefixed. Every claim carries a
`[Verified from source: path:lines]` citation.

---

## 1. The `task` tool

### 1.1 Model-facing schema

Registered as `@tool("task", parse_docstring=True)` on `async def task_tool(runtime, description, prompt, subagent_type, tool_call_id)` — the model sees three arguments (`description`, `prompt`, `subagent_type`; `runtime` and `tool_call_id: Annotated[str, InjectedToolCallId]` are injected). [Verified from source: tools/builtins/task_tool.py:230-237]

The full model-facing description (the docstring) is, verbatim:

> Delegate a bounded task to a specialized subagent in its own context.
>
> Delegate only when expected benefit clearly exceeds delegation overhead.
> Useful benefits are:
> - Material wall-clock savings from independent parallel work
> - Specialist tools, skills, models, or domain instructions
> - Context isolation for a bounded, unusually context-heavy investigation
>
> Built-in subagent types:
> - **general-purpose**: A capable agent for bounded exploration and action. Use
>   when the assignment has clear specialist or context-isolation benefit, or is
>   one of several independent, non-overlapping tasks that can actually run in
>   parallel.
> - **bash**: Command execution specialist for running bash commands. This is only
>   available when host bash is explicitly allowed or when using an isolated shell
>   sandbox such as `AioSandboxProvider`. Use it only for a bounded shell workflow
>   with clear context-isolation or independent-parallel benefit.
>   Routine git, build, test, or deploy operations are not sufficient reason to delegate.
>
> Additional custom subagent types may be defined in config.yaml under
> `subagents.custom_agents`. Each custom type can have its own system prompt,
> tools, skills, model, and timeout configuration. If an unknown subagent_type
> is provided, the error message will list all available types.
>
> When to use this tool:
> - Independent tasks that materially reduce wall-clock time when run in parallel
> - A specialist subagent provides capability unavailable on the direct path
> - Bounded exploration that would otherwise displace important parent context
>
> When NOT to use this tool:
> - Merely because a task is complex, multi-step, verbose, or touches a large repo
> - Splitting dependent steps across parallel subagents; keep the chain together
>   and delegate it as one bounded task only when specialist or context-isolation
>   benefit clearly wins
> - Parallel work with overlapping files, shared mutable state, or external side effects
> - Tasks requiring user interaction or clarification
>
> Costs to include in the delegation decision:
> - Repeating the same repository discovery in multiple contexts
> - Coordination, verification, and synthesis of returned results
> - Any task the parent can complete more cheaply with direct tools
>
> Args:
>     description: A short (3-5 word) description of the task for logging/display. ALWAYS PROVIDE THIS PARAMETER FIRST.
>     prompt: The task description for the subagent. Be specific and clear about what needs to be done. ALWAYS PROVIDE THIS PARAMETER SECOND.
>     subagent_type: The type of subagent to use. ALWAYS PROVIDE THIS PARAMETER THIRD.

[Verified from source: tools/builtins/task_tool.py:238-284]

### 1.2 Dispatch flow

1. Resolve `app_config` from `runtime.context["app_config"]` when present; token-usage caching gate read from `app_config.token_usage.enabled`. [Verified from source: tools/builtins/task_tool.py:47-53, 178-184, 285-287]
2. `get_subagent_config(subagent_type)` — unknown type returns a `failed` `_task_result_command` whose error lists `get_available_subagent_names()`. [Verified from source: tools/builtins/task_tool.py:287-298]
3. `subagent_type == "bash"` additionally requires `is_host_bash_allowed()`; otherwise fails with `LOCAL_BASH_SUBAGENT_DISABLED_MESSAGE`. [Verified from source: tools/builtins/task_tool.py:299-306]
4. Parent context extracted from runtime: `sandbox` and `thread_data` from `runtime.state`; `thread_id` from `runtime.context` falling back to `runtime.config["configurable"]["thread_id"]`; `parent_model` from `runtime.config["metadata"]["model_name"]`; `trace_id` from metadata or a fresh `uuid4()[:8]`. [Verified from source: tools/builtins/task_tool.py:316-337]
5. Identity/attribution propagation: `user_id = resolve_runtime_user_id(runtime)`; `user_role`, `oauth_provider`, `oauth_id`, `run_id`, `channel_user_id` from `runtime.context`; `is_internal = context.get("is_internal") is True` (strict bool); `authz_attributes = normalize_authz_attributes(...)`; `deerflow_trace_id` from context → metadata → `get_current_trace_id()`. [Verified from source: tools/builtins/task_tool.py:339-363]
6. Skill allowlist intersection: `metadata["available_skills"]` (parent) is merged with the subagent config's `skills` by `_merge_skill_allowlists` — child list is intersected with the parent set (parent `None` → child; child `None` → copy of parent). [Verified from source: tools/builtins/task_tool.py:187-195, 365-370]
7. Tool assembly for the child: `get_available_tools(model_name=effective_model, groups=parent_tool_groups, subagent_enabled=False, include_upload_tool=False)` — subagents never get `task` (no nesting) nor `list_uploaded_files` (independent ThreadState makes the current-run file exclusion impossible). [Verified from source: tools/builtins/task_tool.py:372-395]
8. `SubagentExecutor(**executor_kwargs)` built with config, tools, parent_model, sandbox_state, thread_data, thread_id, trace_id, and all identity fields. [Verified from source: tools/builtins/task_tool.py:397-418]
9. `executor.execute_async(prompt, task_id=tool_call_id)` — the **tool_call_id is reused as task_id** for traceability. [Verified from source: tools/builtins/task_tool.py:420-422]

### 1.3 Polling loop and events

- The tool itself polls (`while True` + `await asyncio.sleep(5)`); the LLM never polls. Polling cap = `(config.timeout_seconds + 60) // 5` polls. [Verified from source: tools/builtins/task_tool.py:424-431, 593-600]
- Custom events via `aemit_custom_event(..., writer=get_stream_writer())`:
  - `task_started` `{type, task_id, description, model_name}` at dispatch. [Verified from source: tools/builtins/task_tool.py:433-443]
  - `task_running` `{type, task_id, message, message_index (1-based), total_messages, usage, model_name}` for each newly captured step message in `result.ai_messages`. [Verified from source: tools/builtins/task_tool.py:473-493]
  - Terminal: `task_completed` `{result, usage, model_name}` / `task_failed` `{error, ...}` / `task_cancelled` / `task_timed_out`. [Verified from source: tools/builtins/task_tool.py:496-591]
  - `task_failed` is also emitted with error `"Task disappeared from background tasks"` when the registry no longer holds the task. [Verified from source: tools/builtins/task_tool.py:449-461]
- `usage` is `_summarize_usage(result.token_usage_records)` — a cumulative `{input_tokens, output_tokens, total_tokens}` snapshot reused for both live and terminal events so consumers replace rather than add. [Verified from source: tools/builtins/task_tool.py:146-154, 469-471]
- Usage reporting to the parent journal: `_report_subagent_usage` locates a callback with `record_external_llm_usage_records` in `runtime.config["callbacks"]` (unwrapping `BaseCallbackManager.handlers`), guarded by `result.usage_reported` so a task is reported once. [Verified from source: tools/builtins/task_tool.py:114-175]
- Per-`tool_call_id` usage cache for TokenUsageMiddleware write-back: `_subagent_usage_cache` / `pop_cached_subagent_usage`. [Verified from source: tools/builtins/task_tool.py:42-62, 497, 523]
- **Polling timeout** (`poll_count > max_poll_count`): emits `task_timed_out`, calls `request_cancel_background_task(task_id)`, schedules `_schedule_deferred_subagent_cleanup`, and returns status `polling_timed_out` with message `"Task polling timed out after {timeout_minutes} minutes. This may indicate the background task is stuck. Status: {status}"`. [Verified from source: tools/builtins/task_tool.py:600-627]
- **Parent cancellation** (`asyncio.CancelledError`): signals cooperative cancel, `asyncio.shield`-waits (`_await_subagent_terminal`) for a terminal state so final token usage is reported before the parent worker persists completion data, cleans up or defers cleanup, pops the usage cache, and re-raises. [Verified from source: tools/builtins/task_tool.py:70-79, 628-650]
- Terminal cleanup: `cleanup_background_task(task_id)` after every terminal return; cancelled-but-still-running tasks use `_deferred_cleanup_subagent_task` (5s polls, bounded by `max_polls`). [Verified from source: tools/builtins/task_tool.py:82-111, 510, 536, 562, 584]

### 1.4 Result formatting — `format_subagent_result_message`

Returns `(model_visible_content, normalized_metadata_error)`. Formats, verbatim [Verified from source: subagents/status_contract.py:196-246]:

- `completed`, no cap: `"Task Succeeded. Result: {result_text}"`
- `completed`, capped: `"Task Succeeded (capped: {label}). Result: {result_text}"`
- `cancelled`: `"Task cancelled by user."` or `"Task cancelled by user. Error: {detail}"`
- `timed_out`: `"Task timed out."` or `"Task timed out. Error: {detail}"`
- `polling_timed_out`: the error detail itself (or `"Task polling timed out."`)
- `failed`, capped: `"Task failed (capped: {label})."` / `"Task failed (capped: {label}). Error: {detail}"`
- `failed`, no cap: `"Task failed."` / `"Task failed. Error: {detail}"`

Cap labels: `token_capped → "token budget"`, `turn_capped → "turn budget"`, `loop_capped → "repeated tool-call loop"`. [Verified from source: subagents/status_contract.py:82-86]

`_task_result_command` wraps that into `Command(update={"messages": [ToolMessage(content=..., tool_call_id=..., name="task", additional_kwargs=make_subagent_additional_kwargs(...))]})`. [Verified from source: tools/builtins/task_tool.py:198-227]

### 1.5 `additional_kwargs` stamped on the terminal ToolMessage

Keys (from `make_subagent_additional_kwargs`) [Verified from source: subagents/status_contract.py:34-41, 130-171]:

| Key | When present | Content |
|---|---|---|
| `subagent_status` | always | one of `completed / failed / cancelled / timed_out / polling_timed_out` |
| `subagent_stop_reason` | only when a guardrail cap fired | `token_capped / turn_capped / loop_capped` (additive v2 field) |
| `subagent_result_brief` | `status == "completed"` with non-empty result | result middle-truncated to 2000 chars (`SUBAGENT_METADATA_TEXT_MAX_CHARS`, head=2/3, tail=1/3 around `"\n...\n"`) |
| `subagent_result_sha256` | with result_brief | `hashlib.sha256(result).hexdigest()` of the FULL result |
| `subagent_error` | `status != "completed"` with non-empty error | error middle-truncated to 2000 chars |
| `subagent_model_name` | when known | effective resolved model name |
| `subagent_token_usage` | when provider reported usage | normalized `{input_tokens, output_tokens, total_tokens}` (non-negative ints, bool rejected) |

- Producer-side validation raises `ValueError` for any status/stop_reason not in the contract enums. [Verified from source: subagents/status_contract.py:152-155]
- Read side (`read_subagent_result_metadata`) normalizes the legacy checkpointed `max_turns_reached` status (#3949 Phase 1) into `completed+turn_capped` (if `result_brief` survives) or `failed+turn_capped`, and enforces the sha256 shape with `[0-9a-f]{64}`. [Verified from source: subagents/status_contract.py:44-46, 96-105, 249-286]
- Cross-language contract fixture pins the enums: `{"version": 2, "valid_status_values": ["completed","failed","cancelled","timed_out","polling_timed_out"], "valid_stop_reason_values": ["token_capped","turn_capped","loop_capped"]}`. [Verified from source: contracts/subagent_status_contract.json:1-6]

---

## 2. SubagentExecutor

File: `subagents/executor.py` (1237 lines).

### 2.1 Data model

- `SubagentStatus` enum: `PENDING / RUNNING / COMPLETED / FAILED / CANCELLED / TIMED_OUT`; `is_terminal` = the last four. [Verified from source: subagents/executor.py:56-73]
- `SubagentResult`: `task_id`, `trace_id`, `status`, `result`, `error`, `stop_reason` (`token_capped`/`turn_capped`/`loop_capped` or `None`), `started_at`, `completed_at`, `ai_messages` (captured step dicts), `token_usage_records`, `usage_reported`, `cancel_event: threading.Event`, plus a `_state_lock`. `try_set_terminal` guarantees exactly-once terminal transition (background timeout/cancel and the worker race on the same holder; first terminal write wins). `update_token_usage_records` publishes cumulative collector snapshots only while non-terminal. [Verified from source: subagents/executor.py:76-158]

### 2.2 Construction

`SubagentExecutor.__init__(config, tools, app_config, parent_model, sandbox_state, thread_data, thread_id, trace_id, user_id, user_role, oauth_provider, oauth_id, run_id, channel_user_id, is_internal, authz_attributes, deerflow_trace_id)`:

- Model resolution deferred if it would require loading config.yaml (unit-test friendliness); otherwise `resolve_subagent_model_name(config, parent_model)` eagerly. [Verified from source: subagents/executor.py:483-489]
- Tools name-filtered up front by `_filter_tools(tools, config.tools, config.disallowed_tools)` — allowlist (if not None) then denylist. [Verified from source: subagents/executor.py:403-430, 512-517]
- `trace_id = trace_id or str(uuid4())[:8]`. [Verified from source: subagents/executor.py:493-494]
- `_stop_reason_middlewares: list` collected later in `_create_agent` — every middleware exposing `consume_stop_reason` (duck-typed via `hasattr`, no import coupling to the guard classes). [Verified from source: subagents/executor.py:522-529, 573-579]

### 2.3 `_build_initial_state(task)` → `(state, final_tools, deferred_setup)`

1. `_load_skills()`: `config.skills == []` → skip entirely; otherwise loads enabled skills from `get_or_new_user_skill_storage(user_id or DEFAULT_USER_ID)` (via `asyncio.to_thread`) and filters by the `config.skills` whitelist. [Verified from source: subagents/executor.py:610-640]
2. `build_skill_search_setup(...)` for deferred skill discovery (per `skills.deferred_discovery`). [Verified from source: subagents/executor.py:668-674]
3. Authorization Layer 1: `apply_tool_authorization(candidates, context={user_id, user_role, oauth_provider, oauth_id, channel_user_id, is_internal, authz_attributes}, ...)` runs *before* deferred assembly "so denied tools can never enter the DeferredToolCatalog". [Verified from source: subagents/executor.py:677-699]
4. `assemble_deferred_tools(configured_tools, enabled=app_config.tool_search.enabled)` — mirrors the lead path so subagents stop binding full MCP schemas; the generated `tool_search` helper is deliberately not subject to the subagent's name allow/deny. Late (post-authz-added) tools are appended after. [Verified from source: subagents/executor.py:701-713]
5. One combined `SystemMessage` (system prompt + skill index/metadata section + `<available-deferred-tools>` + `<mcp_routing_hints>`) because "Some LLM APIs reject multiple SystemMessages"; then `HumanMessage(content=task)`. [Verified from source: subagents/executor.py:715-755]
6. State: `{"messages": messages}` plus `state["sandbox"] = self.sandbox_state` and `state["thread_data"] = self.thread_data` passed through from parent. [Verified from source: subagents/executor.py:757-767]

### 2.4 `_create_agent(tools, deferred_setup)`

- `model = create_chat_model(name=self.model_name, thinking_enabled=False, attach_tracing=False)` — thinking disabled, tracing attached at graph level instead. [Verified from source: subagents/executor.py:540-543]
- Optional `build_mcp_routing_middleware(tools, deferred_setup, top_k=app_config.tool_search.auto_promote_top_k)`. [Verified from source: subagents/executor.py:549-557]
- `middlewares = build_subagent_runtime_middlewares(app_config, model_name, lazy_init=True, deferred_setup, agent_name=config.name, available_skills=..., user_id=..., [authorization_provider], [mcp_routing_middleware])`. [Verified from source: subagents/executor.py:558-572]
- `create_agent(model=model, tools=..., middleware=middlewares, system_prompt=None, state_schema=ThreadState, checkpointer=False)` — **`system_prompt=None`** (prompt lives in initial state messages) and **`checkpointer=False`** ("Subagent graphs are compiled with checkpointer=False to avoid inheriting the parent run's checkpointer, since subagents are one-shot and never resume" — from backend/AGENTS.md; the code comment says the same about avoiding multiple SystemMessages). [Verified from source: subagents/executor.py:581-590]

**Subagent middleware chain** (`build_subagent_runtime_middlewares`), in order [Verified from source: agents/middlewares/tool_error_handling_middleware.py:155-293, 314-531]:

1. Shared base (`_build_runtime_middlewares` with `include_uploads=False`, `include_dangling_tool_call_patch=True`): InputSanitizationMiddleware, ToolOutputBudgetMiddleware, ToolResultSanitizationMiddleware, ThreadDataMiddleware, SandboxMiddleware, DanglingToolCallMiddleware, LLMErrorHandlingMiddleware, [GuardrailMiddleware(authorization adapter) if `authorization.enabled`], [GuardrailMiddleware(provider) if `guardrails.enabled`], SandboxAuditMiddleware, [ReadBeforeWriteMiddleware if enabled], [ToolProgressMiddleware if enabled], ToolErrorHandlingMiddleware.
2. SkillActivationMiddleware + SkillToolPolicyMiddleware (shared `slash_source_owner_token = secrets.token_urlsafe(24)`).
3. [ViewImageMiddleware if the model supports vision].
4. [McpRoutingMiddleware if provided] then [DeferredToolFilterMiddleware if `deferred_setup.deferred_names`], with `assert_mcp_routing_before_deferred_filter`.
5. [LoopDetectionMiddleware if `loop_detection.enabled`] — sets `loop_capped`.
6. [TokenBudgetMiddleware if effective budget enabled] — from `subagents.get_token_budget_for(agent_name, summarization_enabled=summarization.enabled)`; default budget is enabled with `max_tokens` = 1,000,000 when summarization is on, 2,000,000 when off, `warn_threshold=0.7`; hard-stop strips tool_calls (does not raise) and records `token_capped`. [Verified from source: config/subagents_config.py:28-55, 220-248; agents/middlewares/tool_error_handling_middleware.py:411-437]
7. Configured extension middlewares.
8. [SafetyFinishReasonMiddleware if enabled].
9. DurableContextMiddleware (projects `summary_text` + skill refs).
10. [DeerFlowSummarizationMiddleware if `summarization.enabled`], built with `skip_memory_flush=True` (subagents share the parent `thread_id`; the flush would pollute the parent's durable memory) and `run_model_name=model_name`.
11. SystemMessageCoalescingMiddleware (always last; merges every SystemMessage into one leading one for strict backends).

### 2.5 `_aexecute(task, result_holder)` — the execution flow

1. Result holder: provided (background path) or created fresh with `task_id = uuid4()[:8]`, status RUNNING. [Verified from source: subagents/executor.py:779-790]
2. Step-capture bookkeeping: `seen_message_ids` set (O(1) dedup because `stream_mode="values"` re-yields full history each super-step) and `processed_message_count` cursor. [Verified from source: subagents/executor.py:791-803]
3. `state, final_tools, deferred_setup = await self._build_initial_state(task)`; `agent = self._create_agent(final_tools, deferred_setup=deferred_setup)`. [Verified from source: subagents/executor.py:807-808]
4. `collector = SubagentTokenCollector(caller=f"subagent:{config.name}")`. [Verified from source: subagents/executor.py:810-812]
5. Run config: `{"recursion_limit": self.config.max_turns, "callbacks": [collector], "tags": [collector_caller]}` — **`recursion_limit` = `max_turns`**. Checkpoint coordinates (`thread_id`/`checkpoint_ns`/etc.) are deliberately NOT set: "LangGraph inherits those coordinates from the ambient parent run so this execution keeps its subgraph namespace. Business consumers receive thread_id via `context`". [Verified from source: subagents/executor.py:814-823]
6. Tracing: `build_tracing_callbacks()` appended at graph level; `inject_langfuse_metadata(run_config, thread_id, user_id, assistant_id=f"subagent:{normalized_name}" (lowercase, `_`→`-`), model_name, environment, deerflow_trace_id)`. [Verified from source: subagents/executor.py:826-853]
7. Runtime `context` dict: `thread_id`, `app_config`, `user_id`, `user_role`, `oauth_provider`, `oauth_id`, `run_id`, optional `channel_user_id`, `is_internal` (written unconditionally including False), `authz_attributes` (copied dict), optional `DEERFLOW_TRACE_METADATA_KEY`, and `context["is_subagent"] = True`. [Verified from source: subagents/executor.py:855-877]
8. Pre-stream cancel check: if `result.cancel_event.is_set()`, terminal CANCELLED with `error="Cancelled by user"` before streaming. [Verified from source: subagents/executor.py:886-893]
9. Stream loop: `async for chunk in agent.astream(state, config=run_config, context=context, stream_mode="values")`:
   - Cooperative cancellation at iteration boundaries (long tool calls within a super-step are not interrupted mid-flight). [Verified from source: subagents/executor.py:895-907]
   - `final_state = chunk`; publish cumulative token snapshot to the holder. [Verified from source: subagents/executor.py:909-910]
   - `capture_new_step_messages(messages, ai_messages, seen_message_ids, processed_message_count)` — captures every newly appended AIMessage AND ToolMessage (a single super-step can append several ToolMessages, #3779). [Verified from source: subagents/executor.py:912-921]
10. Normal completion:
    - `_extract_llm_error_fallback(final_state)`: the last AIMessage carrying `additional_kwargs["deerflow_error_fallback"] is True` (only the last message is authoritative — deliberately not a full scan, to avoid stale parent-history markers) → terminal FAILED with the fallback's user-facing text (or `error_detail`, or `"LLM request failed"`). [Verified from source: subagents/executor.py:204-252, 925-931]
    - Else `_extract_final_result(final_state)`: last AIMessage's content via `message_content_to_text`, fallback to last message of any type, sentinel `"No response generated"` when nothing/empty. [Verified from source: subagents/executor.py:161-201, 933]
    - `stop_reason = self._consume_guard_stop_reason()` — first non-None from every `consume_stop_reason(run_id)` guard (TokenBudgetMiddleware → `token_capped`, LoopDetectionMiddleware → `loop_capped`); guard hard-stops don't raise, so this is how a capped completion is detected. Terminal COMPLETED with result + stop_reason. [Verified from source: subagents/executor.py:592-608, 933-948]
11. **`except GraphRecursionError`** (turn cap — `recursion_limit == max_turns`): `stop_reason = self._consume_guard_stop_reason() or "turn_capped"` (a guard that fired first was the binding constraint). Then: LLM error fallback check (a handled provider failure must not be misclassified as partial output, #4042) → FAILED + stop_reason; else last non-empty AIMessage text is the "usable partial" → COMPLETED + partial + stop_reason; else FAILED with `error=f"Reached max_turns={max_turns}"` + stop_reason. [Verified from source: subagents/executor.py:950-1008]
12. **`except Exception`**: terminal FAILED with `str(e)`. [Verified from source: subagents/executor.py:1010-1016]

### 2.6 Sync/async execution paths and event loops

- Module-level: `_background_tasks: dict[str, SubagentResult]` + lock; `_scheduler_pool = ThreadPoolExecutor(max_workers=3, thread_name_prefix="subagent-scheduler-")`. [Verified from source: subagents/executor.py:255-260]
- A **persistent isolated event loop** on a daemon thread (`subagent-persistent-loop`) hosts all subagent coroutines when a parent loop is already running; created lazily, revived if dead, closed at `atexit` (with a hot-reload guard that unregisters/executes the previous shutdown hook). [Verified from source: subagents/executor.py:50-53, 262-349]
  - Note: the file defines only the 3-worker `_scheduler_pool` plus this single persistent loop thread. (The "dual thread pool 3+3" wording in backend/AGENTS.md describes an older shape; at commit 0950924 there is no `_execution_pool` in executor.py — execution coroutines run on the persistent isolated loop.) [Verified from source: subagents/executor.py:255-268, 1126-1161]
- `_copy_isolated_subagent_context()`: `copy_context()` of ambient ContextVars, then strips callbacks marked `deerflow_loop_bound` (e.g. the parent `RunJournal`) from the inherited runnable config while preserving framework streaming callbacks and checkpoint lineage. [Verified from source: subagents/executor.py:365-400]
- `execute(task, result_holder)` (sync): if a loop is running → `_execute_in_isolated_loop` (submits `_aexecute` to the persistent loop, `future.result(timeout=config.timeout_seconds)`; on `FuturesTimeoutError` sets `cancel_event` and cancels the future, then re-raises); else `asyncio.run(_aexecute(...))`. Any exception → FAILED result. [Verified from source: subagents/executor.py:1020-1098]
- `execute_async(task, task_id)` (background — the path task_tool uses): registers a PENDING `SubagentResult` in `_background_tasks`, submits `run_task` to `_scheduler_pool`; `run_task` flips to RUNNING, submits `_aexecute` to the persistent loop within the copied context, and waits with `execution_future.result(timeout=self.config.timeout_seconds)`. On `FuturesTimeoutError`: sets `cancel_event`, `try_set_terminal(TIMED_OUT, error=f"Execution timed out after {timeout} seconds")`, cancels the future. Any other exception → FAILED. [Verified from source: subagents/executor.py:1100-1161]
- Module-level helpers: `request_cancel_background_task` (sets `cancel_event`; checked cooperatively — threads cannot be force-killed), `get_background_task_result`, `list_background_tasks`, `cleanup_background_task` (only removes terminal entries to avoid races). [Verified from source: subagents/executor.py:1167-1237]

### 2.7 Concurrency and caps

- `MAX_CONCURRENT_SUBAGENTS = 3` constant lives in executor.py; enforcement is by `SubagentLimitMiddleware` on the lead (runtime `max_concurrent_subagents` clamped 1–4 via `clamp_subagent_concurrency`). [Verified from source: subagents/executor.py:1164; config/subagents_config.py:14-20]
- Per-run total delegation cap: `subagents.max_total_per_run` default `DEFAULT_MAX_TOTAL_SUBAGENTS_PER_RUN = 6`, schema range 1–50 (`clamp_total_subagents_per_run`). [Verified from source: config/subagents_config.py:11-13, 23-25, 136-141]
- Global timeout default for built-ins: `SubagentsAppConfig.timeout_seconds = 1800` (30 min); custom agents keep their own value (default 900) unless per-agent override. [Verified from source: config/subagents_config.py:126-130, 116-120; subagents/config.py:28-32, 42]

---

## 3. Built-in subagent definitions

`BUILTIN_SUBAGENTS = {"general-purpose": GENERAL_PURPOSE_CONFIG, "bash": BASH_AGENT_CONFIG}`. [Verified from source: subagents/builtins/__init__.py:12-15]

### 3.1 `general-purpose`

Config: `tools=None` (inherit all), `disallowed_tools=["task", "ask_clarification", "present_files"]`, `model="inherit"`, `max_turns=150` (timeout: dataclass default 900, layered to global 1800 by the registry). [Verified from source: subagents/builtins/general_purpose.py:66-70; subagents/config.py:41-42; subagents/registry.py:83-90]

Description (verbatim):

> A capable agent for bounded exploration and action when there is clear delegation benefit.
>
> Use this subagent when:
> - Its specialist tools, skills, model, or instructions materially improve the result
> - It owns one independent, non-overlapping part of genuinely parallel work
> - A bounded, context-heavy investigation should be isolated from the lead context
>
> Do NOT use merely because work is complex or multi-step, or merely because it is sequential;
> a bounded dependent chain may still be delegated when specialist or context-isolation benefit
> clearly wins. Do not use when it would duplicate repository discovery or overlap side effects.

[Verified from source: subagents/builtins/general_purpose.py:7-16]

System prompt (verbatim):

> You are a general-purpose subagent working on a delegated task. Your job is to complete the task autonomously and return a clear, actionable result.
>
> \<guidelines>
> - Focus on completing the delegated task efficiently
> - Use available tools as needed to accomplish the goal
> - Think step by step but act decisively
> - If you encounter issues, explain them clearly in your response
> - Return a concise summary of what you accomplished
> - Do NOT ask for clarification - work with the information provided
> \</guidelines>
>
> \<tool_restrictions>
> You are a subagent - the `task` tool is NOT available to you.
> You must NEVER attempt to call `task` or dispatch further subagents.
> Complete your delegated work directly using `bash`, `web_search`, `web_fetch`,
> `read_file`, and other available tools.
> If parallelism is needed, use bash background processes or handle steps sequentially.
> \</tool_restrictions>
>
> \<file_editing_workflow>
> When revising an existing file, prefer `str_replace` over `write_file` —
> it sends only the diff and avoids re-emitting the whole file (mirrors
> Claude Code's Edit and Codex's apply_patch). When writing long new
> content from scratch, split it into sections: the first `write_file`
> call creates the file, then use `write_file` with append=True to extend
> it section by section. This keeps each tool call small and avoids
> mid-stream chunk-gap timeouts on oversized single-shot writes.
> (See issue #3189.)
> \</file_editing_workflow>
>
> \<output_format>
> When you complete the task, provide:
> 1. A brief summary of what was accomplished
> 2. Key findings or results
> 3. Any relevant file paths, data, or artifacts created
> 4. Issues encountered (if any)
> 5. Citations: Use `[citation:Title](URL)` format for external sources
> \</output_format>
>
> \<working_directory>
> You have access to the same sandbox environment as the parent agent:
> - User uploads: `/mnt/user-data/uploads`
> - User workspace: `/mnt/user-data/workspace`
> - Output files: `/mnt/user-data/outputs`
> - Deployment-configured custom mounts may also be available at other absolute container paths; use them directly when the task references those mounted directories
> - Treat `/mnt/user-data/workspace` as the default working directory for coding and file IO
> - Prefer relative paths from the workspace, such as `hello.txt`, `../uploads/input.csv`, and `../outputs/result.md`, when writing scripts or shell commands
> \</working_directory>

[Verified from source: subagents/builtins/general_purpose.py:17-65]

### 3.2 `bash`

Config: `tools=["bash", "ls", "read_file", "write_file", "str_replace"]` (sandbox tools only — note: no `glob`/`grep`), `disallowed_tools=["task", "ask_clarification", "present_files"]`, `model="inherit"`, `max_turns=60`. [Verified from source: subagents/builtins/bash_agent.py:46-49]

Description (verbatim):

> Command execution specialist for bounded shell workflows with clear delegation benefit.
>
> Use this subagent when:
> - A multi-command workflow's logs or intermediate state would materially displace lead context
> - It owns an independent, non-overlapping shell workload that can run in parallel
> - Keeping a justified sequential command chain in one isolated context reduces coordination cost
>
> Routine git, build, test, or deploy operations are not sufficient reason to delegate.
> Use the direct bash tool when delegation and synthesis cost more than the bounded workflow.

[Verified from source: subagents/builtins/bash_agent.py:7-15]

System prompt (verbatim):

> You are a bash command execution specialist. Execute the requested commands carefully and report results clearly.
>
> \<guidelines>
> - Execute commands one at a time when they depend on each other
> - Use parallel execution when commands are independent
> - Report both stdout and stderr when relevant
> - Handle errors gracefully and explain what went wrong
> - Use workspace-relative paths for files under the default workspace, uploads, and outputs directories
> - Use absolute paths only when the task references deployment-configured custom mounts outside the default workspace layout
> - Be cautious with destructive operations (rm, overwrite, etc.)
> \</guidelines>
>
> \<output_format>
> For each command or group of commands:
> 1. What was executed
> 2. The result (success/failure)
> 3. Relevant output (summarized if verbose)
> 4. Any errors or warnings
> \</output_format>
>
> \<working_directory>
> You have access to the sandbox environment:
> - User uploads: `/mnt/user-data/uploads`
> - User workspace: `/mnt/user-data/workspace`
> - Output files: `/mnt/user-data/outputs`
> - Deployment-configured custom mounts may also be available at other absolute container paths; use them directly when the task references those mounted directories
> - Treat `/mnt/user-data/workspace` as the default working directory for file IO
> - Prefer relative paths from the workspace, such as `hello.txt`, `../uploads/input.csv`, and `../outputs/result.md`, when composing commands or helper scripts
> \</working_directory>

[Verified from source: subagents/builtins/bash_agent.py:16-45]

The `bash` subagent is hidden entirely (`get_available_subagent_names` filters it) when host bash is not allowed. [Verified from source: subagents/registry.py:150-165]

---

## 4. Registry + custom agent config

### 4.1 `SubagentConfig` dataclass

Fields: `name`, `description`, `system_prompt=None`, `tools=None` (allowlist, None = inherit all), `disallowed_tools=default ["task"]`, `skills=None` (None = all enabled, `[]` = disabled), `model="inherit"`, `max_turns=50`, `timeout_seconds=900`. [Verified from source: subagents/config.py:10-42]

Model resolution: `resolve_subagent_model_name` — explicit config model wins; `"inherit"` → parent model → first configured model (`app_config.models[0].name`; raises when no models configured). [Verified from source: subagents/config.py:45-63]

### 4.2 Resolution order (`get_subagent_config`)

1. Built-ins (`BUILTIN_SUBAGENTS`), then `config.yaml → subagents.custom_agents.<name>` (`_build_custom_subagent_config` maps description/system_prompt/tools/disallowed_tools/skills/model/max_turns/timeout_seconds into a `SubagentConfig`).
2. Per-agent overrides from `subagents.agents.<name>` (`SubagentOverrideConfig`: timeout_seconds, max_turns, model, skills, token_budget).
3. Global defaults (`subagents.timeout_seconds`, `subagents.max_turns`) apply **only to built-ins** — custom agents keep their own values ("Global defaults ... must NOT override custom agents' own values"). Applied via `dataclasses.replace`.

[Verified from source: subagents/registry.py:22-116]

### 4.3 Custom subagent config schema (`config.yaml → subagents.custom_agents.<name>`)

`CustomSubagentConfig` (pydantic): `description` (required), `system_prompt` (required), `tools: list[str] | None = None`, `disallowed_tools` default `["task", "ask_clarification", "present_files"]`, `skills: list[str] | None`, `model="inherit"`, `max_turns=50 (ge=1)`, `timeout_seconds=900 (ge=1)`. [Verified from source: config/subagents_config.py:86-121]

Top-level `SubagentsAppConfig`: `timeout_seconds=1800`, `max_turns=None`, `max_total_per_run=6 (1..50)`, `token_budget` (default factory, enabled, 1M/2M coupled to summarization), `agents: dict[str, SubagentOverrideConfig]`, `custom_agents: dict[str, CustomSubagentConfig]`; helper getters `get_timeout_for`, `get_model_for`, `get_max_turns_for`, `get_skills_for`, `get_token_budget_for`. [Verified from source: config/subagents_config.py:123-248]

---

## 5. Built-in tools (tools/builtins/)

Exports: `setup_agent`, `update_agent`, `present_file_tool`, `review_skill_package`, `ask_clarification_tool`, `view_image_tool`, `task_tool`, `list_uploaded_files`. [Verified from source: tools/builtins/__init__.py:1-19]

Always-on set (`BUILTIN_TOOLS`): `present_files`, `ask_clarification`, `review_skill_package`; conditionally added: `list_uploaded_files` (unless subagent assembly), `skill_manage` (if `skill_evolution.enabled`), `task` (if `subagent_enabled`), `view_image` (if the model `supports_vision`), `invoke_acp_agent` (if ACP agents configured). [Verified from source: tools/tools.py:15-24, 96-118, 149-164]

### 5.1 `present_files`

- Schema: `filepaths: list[str]` (+ injected runtime and tool_call_id). Description (key parts, verbatim): "Make files visible to the user for viewing and rendering in the client interface. ... You should call this tool after creating files and moving them to the `/mnt/user-data/outputs` directory. ... This tool can be safely called in parallel with other tools. State updates are handled by a reducer to prevent conflicts. Args: filepaths: List of absolute file paths to present to the user. **Only** files in `/mnt/user-data/outputs` can be presented." [Verified from source: tools/builtins/present_file_tool.py:83-107]
- Restriction enforced in `_normalize_presented_filepath`: every path (virtual `/mnt/user-data/outputs/...` or host-side thread-outputs path) must resolve under the thread's `outputs_path` (`relative_to(outputs_dir)`), else `ValueError` → error ToolMessage `"Error: Only files in /mnt/user-data/outputs can be presented: {path}"`. Success returns `Command(update={"artifacts": normalized_paths, "messages": [ToolMessage("Successfully presented files", ...)]})` — deduped by the `merge_artifacts` reducer. [Verified from source: tools/builtins/present_file_tool.py:33-80, 108-121]
- Denied to both built-in subagents via `disallowed_tools`. [Verified from source: subagents/builtins/general_purpose.py:67; subagents/builtins/bash_agent.py:47]

### 5.2 `ask_clarification` — middleware-intercepted

- `@tool("ask_clarification", parse_docstring=True, return_direct=True)`. Args: `question` (required), `clarification_type: Literal["missing_info","ambiguous_requirement","approach_choice","risk_confirmation","suggestion"]`, `context: str | None`, `options: list[str] | None`, `fields: list[ClarificationFormField] | None` (`fields` takes precedence over `options`). `ClarificationFormField`: `name` (Required), `label`, `type: Literal["text","textarea","number","select","multi_select","checkbox","date"]`, `required`, `options`, `placeholder`. [Verified from source: tools/builtins/clarification_tool.py:6-35]
- Description key parts (verbatim): "Ask the user for clarification when you need more information to proceed. ... The execution will be interrupted and the question will be presented to the user. Wait for the user's response before continuing." Interaction-shape guidance: "One open question -> just `question` ... Pick exactly one option -> `options` ... Pick several options -> a single `fields` entry of type `multi_select` ... Collect several values at once ... -> `fields`". Form limits documented in-schema: "at most 16 fields, 24 options per field, and 200 characters per name/label/option/placeholder — exceeding a limit degrades the whole request to a plain-text question." [Verified from source: tools/builtins/clarification_tool.py:36-88]
- **The body is a placeholder** returning `"Clarification request processed by middleware"` — "The actual logic is handled by ClarificationMiddleware which intercepts this tool call and interrupts execution". [Verified from source: tools/builtins/clarification_tool.py:89-92]
- Denied to built-in subagents; also excluded from lead toolset on `context.non_interactive=true` runs (scheduler). [Verified from source: subagents/builtins/general_purpose.py:67; deer-flow/AGENTS.md (scheduled-task note)]

### 5.3 `view_image`

- Args: `image_path` — "Absolute /mnt/user-data virtual path to the image file. Common formats supported: jpg, jpeg, png, webp, gif." Description: "Read an image file. ... When NOT to use ...: For non-image files (use present_files instead); For multiple files at once (use present_files instead)." [Verified from source: tools/builtins/view_image_tool.py:51-70]
- Restrictions/behavior: path must be under `/mnt/user-data/{workspace,uploads,outputs}`; path validation via `validate_local_tool_path` + `resolve_and_validate_user_data_path`; 20 MB cap; extension→MIME map (jpg/jpeg/png/webp/gif); magic-byte sniffing must match the extension MIME; re-read size mismatch rejected ("Image file changed during read"). Only lightweight metadata `{mime_type, size, actual_path}` is stored in state under `viewed_images` (not base64, #4138); ViewImageMiddleware injects the base64 payload later. [Verified from source: tools/builtins/view_image_tool.py:13-48, 78-176]
- Added only when the model supports vision. [Verified from source: tools/tools.py:114-118]

### 5.4 `setup_agent` (bootstrap-only)

- Args: `soul` ("Full SOUL.md content defining the agent's personality and behavior"), `description` ("One-line description of what the agent does"), `skills` ("Optional list of skill names ... None means use all enabled skills, empty list means no skills"). [Verified from source: tools/builtins/setup_agent_tool.py:16-29]
- Behavior: rejects empty/whitespace soul (#3549); persists a custom agent's `config.yaml` + `SOUL.md` through `get_agent_store().update(...)` under the resolved user; falls back to the global-base-dir `SOUL.md` when no `agent_name` in context. Returns `Command` with `created_agent_name` state update. Bound only when `is_bootstrap=True` (per backend/AGENTS.md tool list). [Verified from source: tools/builtins/setup_agent_tool.py:31-84]

### 5.5 `update_agent` (custom-agent-only)

- Args (all optional, nullish strings `"null"/"none"/"undefined"` normalized to None via `BeforeValidator`): `soul` (FULL replacement, no patch semantics), `description`, `skills` (`[]` = no skills, omit = unchanged), `tool_groups`, `model` (must exist in config.yaml models). [Verified from source: tools/builtins/update_agent_tool.py:46-108]
- Behavior/restrictions: refuses on untrusted webhook channels (`_UNTRUSTED_CHANNELS = {"github"}`, defence-in-depth mirror of the factory's withholding); requires at least one field; rejects empty soul; requires `agent_name` in runtime context; blocks legacy-shared-layout agents (migration required); rejects unknown model before touching disk; carries forward `_MODEL_BEHAVIOR_FIELDS` (`model_settings`, `thinking_enabled`, `reasoning_effort`) and all non-managed AgentConfig fields (`preserve_non_managed_fields`) so self-updates cannot erase them; persists via `get_agent_store().update(...)`; "The new configuration takes effect on the next user turn." [Verified from source: tools/builtins/update_agent_tool.py:46-62, 110-268]

### 5.6 `invoke_acp_agent`

- Built dynamically per configured `acp_agents` by `build_invoke_acp_agent_tool(agents)`; args schema `_InvokeACPAgentInput`: `agent` ("Name of the ACP agent to invoke"), `prompt` ("The concise task prompt to send to the agent"). [Verified from source: tools/builtins/invoke_acp_agent_tool.py:16-19, 140-273]
- Description (generated, verbatim template): "Invoke an external ACP-compatible agent and return its final response.\n\nAvailable agents:\n{agent_lines}\n\nIMPORTANT: ACP agents operate in their own independent workspace. Do NOT include /mnt/user-data paths in the prompt. Give the agent a self-contained task description — it will produce results in its own workspace. After the agent completes, its output files are accessible at /mnt/acp-workspace/ (read-only)." [Verified from source: tools/builtins/invoke_acp_agent_tool.py:152-161]
- Behavior: spawns the configured agent binary via `spawn_agent_process` in a per-thread workspace `{base_dir}/users/{uid}/threads/{tid}/acp-workspace/`; converts DeerFlow's enabled MCP servers into ACP `mcpServers` wire format; permission requests auto-approved only when `auto_approve_permissions` (prefers `allow_once` then `allow_always`), else denied/cancelled; collects streamed text; `asyncio.wait_for(..., timeout=agent_config.timeout_seconds)` with an actionable timeout message; `FileNotFoundError` produces a remediation message (special-cases `codex-acp` vs the non-ACP `codex` CLI). [Verified from source: tools/builtins/invoke_acp_agent_tool.py:21-137, 166-266]

### 5.7 `skill_manage` (if `skill_evolution.enabled`)

- Args: `action` ("One of create, patch, edit, delete, write_file, remove_file"), `name` ("Skill name in hyphen-case"), `content`, `path`, `find`, `replace`, `expected_count`. Description: "Manage custom skills under skills/custom/." [Verified from source: tools/skill_manage_tool.py:262-296]
- Behavior: per-`(user_id, skill_name)` asyncio lock; every content write goes through `enforce_static_scan` (SkillScan, blocking on CRITICAL) plus `scan_skill_content` (LLM scan; blocks on `block`, and executables require explicit `allow`); each mutation appends a history record and refreshes the user's skills prompt cache; public/legacy skills are read-only ("To customise it, create your own version with the same name"). A sync wrapper is attached via `make_sync_tool_wrapper`. [Verified from source: tools/skill_manage_tool.py:33-259, 296]

### 5.8 `tool_search` (generated) — see §7.

### 5.9 Which tools are middleware-intercepted

- `ask_clarification` → ClarificationMiddleware short-circuits before execution and interrupts via `Command(goto=END)`. [Verified from source: tools/builtins/clarification_tool.py:89-92; deer-flow/backend/AGENTS.md middleware #35]
- `task` results are re-read by TokenUsageMiddleware via `pop_cached_subagent_usage`, and delegations captured by DurableContextMiddleware/SubagentLimitMiddleware; the tool itself executes normally. [Verified from source: tools/builtins/task_tool.py:42-62; backend/AGENTS.md middlewares #17, #20, #27]
- `write_file`/`str_replace` are gated by ReadBeforeWriteMiddleware; `read_file` stamps the content hash. [Verified from source: agents/middlewares/tool_error_handling_middleware.py:258-266; sandbox/tools.py:2243-2249 (docstring)]
- `view_image` writes `viewed_images` state; ViewImageMiddleware injects/removes the actual base64 message. [Verified from source: tools/builtins/view_image_tool.py:163-176]
- Deferred MCP tools are hidden/promoted by DeferredToolFilterMiddleware/McpRoutingMiddleware. [Verified from source: agents/middlewares/tool_error_handling_middleware.py:375-389]

---

## 6. Sandbox tools (sandbox/tools.py)

All seven tools share the pattern: sync `@tool(..., parse_docstring=True)` function + an attached `.coroutine` (`_x_tool_async`) that runs `ensure_sandbox_initialized_async` then executes the sync body via `asyncio.to_thread` (`_run_sync_tool_after_async_sandbox_init`). [Verified from source: sandbox/tools.py:1482-1498, 1845-1849, 1913-1917, 1978-1997, 2079-2102, 2205-2215, 2321-2331, 2390-2409]

Every tool takes `description` as its FIRST model-facing arg: "Explain why you are ... in short words. ALWAYS PROVIDE THIS PARAMETER FIRST." [Verified from source: sandbox/tools.py:1782, 1857, 1932, 2014, 2139, 2272, 2350]

### 6.1 `bash`

- Description (verbatim): "Execute a bash command in a Linux environment.\n\n- Use `python` to run Python code.\n- Prefer a thread-local virtual environment in `/mnt/user-data/workspace/.venv`.\n- Use `python -m pip` (inside the virtual environment) to install Python packages.\n- To start a long-lived process such as a web server, ALWAYS run it in the background with its output redirected, e.g. `your-command > /mnt/user-data/workspace/server.log 2>&1 &`, then check the log file or poll the port. A long-lived process run in the foreground blocks the turn until it is killed at the command timeout." Args: `description`, `command` ("The bash command to execute. Always use absolute paths for files and directories."). [Verified from source: sandbox/tools.py:1768-1784]
- Behavior:
  - Env injection order: request-scoped skill secrets (`read_active_secrets`, #3861) + GitHub token overlay (`GH_TOKEN`/`GITHUB_TOKEN`, string or refreshing callable) + Lark CLI overlay (only when the command matches `lark-cli`); injected as `execute_command(env=...)`, never in the command string. [Verified from source: sandbox/tools.py:1786-1798, 1694-1765]
  - IM channel identity: `DEERFLOW_CHANNEL_USER_ID` rides an `export VAR=<quoted>; ` or `unset VAR; ` command-string prefix (not env=), per-call, POSIX only (skipped on Windows), value capped at 256 chars. [Verified from source: sandbox/tools.py:1645-1691, 1809-1810, 1827-1828]
  - Local sandbox path: requires `is_host_bash_allowed()`; `validate_local_bash_command_paths` (best-effort absolute-path/`file://`/traversal/cd-target guard — explicitly "not a secure sandbox boundary"); `replace_virtual_paths_in_command` rewrites `/mnt/user-data/*` to host paths; `_apply_cwd_prefix` prepends `cd <workspace> && `. [Verified from source: sandbox/tools.py:1799-1810, 1205-1246, 1249-1294, 1297-1310]
  - Non-local (AIO etc.): command prefixed `cd /mnt/user-data/workspace; `. [Verified from source: sandbox/tools.py:1825-1826]
  - **Timeout**: `sandbox.bash_command_timeout` config, default **600s**, passed as `execute_command(..., timeout=command_timeout)` on the local path; LocalSandbox runs the command with `start_new_session=True` (own process group) and on timeout kills the **whole process group** (`os.killpg(..., SIGKILL)`); stdin is `/dev/null`, output drained via bounded pipe threads so backgrounded processes return immediately. [Verified from source: sandbox/tools.py:1811-1820; config/sandbox_config.py:183-190; sandbox/local/local_sandbox.py:553-572, 618-626]
  - Output post-processing: `mask_local_paths_in_output` (host→virtual path masking), `mask_secret_values` (injected secret values ≥8 chars replaced with `[redacted]`, longest first), `_truncate_bash_output` (middle-truncation 50/50, cap `bash_output_max_chars` default 20000). [Verified from source: sandbox/tools.py:1538-1594, 1820-1836]
  - Errors returned as strings (`"Error: ..."`), never raised to the model. [Verified from source: sandbox/tools.py:1837-1842]

### 6.2 `read_file`

- Description: "Read the contents of a text file. Use this to examine source code, configuration files, logs, or any text-based file." Args: `description`, `path` (absolute), `start_line` / `end_line` (optional, 1-indexed inclusive). [Verified from source: sandbox/tools.py:2128-2143]
- Behavior: disabled-skill gate first (fail-closed on unreadable state); range validation with friendly sentinels (`"(start_line must be >= 1)"`, `"(start_line > end_line — no lines in range)"`, `"(empty)"`, `"(start_line exceeds file length)"`); local path resolution — skills paths via `_resolve_skills_path`, ACP workspace via `_resolve_acp_workspace_path`, user-data via `_resolve_and_validate_user_data_path`, custom mounts left to `LocalSandbox._resolve_path()`; head-truncation to `read_file_output_max_chars` (default 50000) with marker suggesting `start_line/end_line`; binary/`UnicodeDecodeError` produces an actionable message steering to bash/pandas or `view_image`. `read_current_file_content` is shared with ReadBeforeWriteMiddleware "so the gate hashes exactly the bytes the read tool would see". [Verified from source: sandbox/tools.py:2105-2202, 1597-1619]

### 6.3 `write_file`

- Description (verbatim head): "Write text content to a file. By default this overwrites the target file; set append=True to add content to the end without replacing existing content." Then documented in-schema: READ-BEFORE-WRITE (#3857 — must have read the CURRENT version first; writes never refresh marks) and SIZE POLICY (#3189 — a single non-append call must not exceed **80 KB** UTF-8; strategies: (1) incremental `str_replace` edits, (2) append-in-chunks with `append=True`, which is exempt from the cap; operator override `DEERFLOW_WRITE_FILE_MAX_BYTES`, 0 disables). Args: `description`, `path`, `content`, `append: bool = False`. [Verified from source: sandbox/tools.py:2235-2276, 63-71, 2218-2232]
- Behavior: oversized non-append payload returns an actionable error without touching the sandbox; local path validation (write access — skills/ACP paths are rejected by `validate_local_tool_path`); write under `get_file_operation_lock(sandbox, path)`; returns `"OK"`; failures return bounded, sanitized error strings (`_format_write_file_error`, 2000-char middle-truncation). [Verified from source: sandbox/tools.py:2277-2318, 642-675]

### 6.4 `str_replace`

- Description (verbatim head): "Replace a substring in a file with another substring. If `replace_all` is False (default), the substring to replace must appear **exactly once** in the file." Plus the READ-BEFORE-WRITE note. Args: `description`, `path`, `old_str`, `new_str`, `replace_all: bool = False`. [Verified from source: sandbox/tools.py:2334-2354]
- Behavior: read-modify-write under `get_file_operation_lock` (lock scoped to `(sandbox.id, path)` per backend/AGENTS.md); empty `old_str` is a no-op `"OK"` (guards against `str.replace("", ...)` inserting everywhere); missing target → `"Error: String to replace not found in file: {path}"`; **note the actual implementation replaces the FIRST occurrence when `replace_all=False` rather than enforcing uniqueness** — the docstring's "must appear exactly once" is prompt guidance, the code does `content.replace(old_str, new_str, 1)` without an occurrence-count check. [Verified from source: sandbox/tools.py:2356-2387]

### 6.5 `ls`

- Description: "List the contents of a directory up to 2 levels deep in tree format." Args: `description`, `path` (absolute). [Verified from source: sandbox/tools.py:1852-1858]
- Behavior: disabled-skill gate on the requested path AND on every returned entry (`_drop_disabled_skill_paths` — listings descend, so a root above a disabled skill would otherwise expose its files; verdict memoized per skill); host-path masking; head-truncation to `ls_output_max_chars` (default 20000); `"(empty)"` for empty results. [Verified from source: sandbox/tools.py:1860-1910, 257-287; config/sandbox_config.py:178-182]

### 6.6 `glob`

- Description: "Find files or directories that match a glob pattern under a root directory." Args: `description`, `pattern` ("relative to the root path, for example `**/*.py`"), `path` (absolute root), `include_dirs: bool = False`, `max_results: int = 200`. [Verified from source: sandbox/tools.py:1920-1936]
- Behavior: effective max = min(requested clamp, per-tool config clamp), default 200, hard upper bound 1000; disabled-skill gates on root and results; masked output; formatted `"Found N paths under {root}"` with truncation hint "Narrow the path or pattern to see fewer matches." [Verified from source: sandbox/tools.py:56-60, 557-595, 1938-1975]

### 6.7 `grep`

- Description: "Search for matching lines inside a text file or files under a root directory." Args: `description`, `pattern` ("string or regex"), `path` (absolute file or root dir), `glob` (optional filter), `literal: bool = False`, `case_sensitive: bool = False`, `max_results: int = 100`. [Verified from source: sandbox/tools.py:2000-2021]
- Behavior: default 100, hard upper bound 500; results are `GrepMatch(path, line_number, line)` rendered `"{path}:{line}: {text}"`; paths masked; disabled-skill result filtering; `re.error` → `"Error: Invalid regex pattern: ..."`. [Verified from source: sandbox/tools.py:59-60, 598-608, 2022-2076]

### 6.8 Path translation contract (`/mnt/user-data/*`)

- Virtual roots: `/mnt/user-data/{workspace,uploads,outputs}` map to `thread_data['{workspace,uploads,outputs}_path']`; the bare virtual root maps to their common parent when all share one. Longest-prefix-first replacement with segment-boundary checks (`/mnt/user-data` must not match inside `/mnt/user-data-backup`, #4035/#4053 class). [Verified from source: sandbox/tools.py:678-736, 1272-1293]
- `validate_local_tool_path` — the security gate: `/mnt/user-data/*` read+write; `/mnt/skills/*` and `/mnt/acp-workspace/*` read-only; custom mounts honor per-mount `read_only`; anything else → `PermissionError`; `..` segments always rejected. [Verified from source: sandbox/tools.py:848-908]
- Resolved user-data paths are re-validated against the thread's workspace/uploads/outputs roots (`relative_to`) so a resolved path cannot escape. [Verified from source: sandbox/tools.py:911-947]
- Reverse direction: `mask_local_paths_in_output` maps host paths back to virtual in all tool output (skills, per-user custom/integration skills, ACP workspace, user-data; compiled patterns LRU-cached). [Verified from source: sandbox/tools.py:744-845]

---

## 7. Tool assembly

### 7.1 `get_available_tools` composition and dedup

Signature: `get_available_tools(groups=None, include_mcp=True, model_name=None, subagent_enabled=False, *, include_upload_tool=True, app_config=None)`. Assembly order:

1. **Config-defined tools** from `config.yaml → tools[]`, group-filtered, host-bash tools dropped when `is_host_bash_allowed()` is False, resolved via `resolve_variable(cfg.use, BaseTool)`; a config-name/tool-`.name` mismatch logs a warning (#1803, the tool's own `.name` wins). Async-only tools get a sync wrapper (`_ensure_sync_invocable_tool` → `make_sync_tool_wrapper`, which runs the coroutine via `asyncio.run` or a 10-worker `tool-sync` ThreadPoolExecutor when a loop is already running).
2. **Built-ins**: `present_files`, `ask_clarification`, `review_skill_package`; + `list_uploaded_files` (if `include_upload_tool`); + `skill_manage` (if `skill_evolution.enabled`); + `task` (if `subagent_enabled`); + `view_image` (if resolved model `supports_vision`; model defaults to `models[0]`).
3. **MCP tools** (if `include_mcp` and enabled servers exist): `get_cached_mcp_tools()`, each tagged with `tag_mcp_tool` (metadata `deerflow_mcp: True`) so deferred assembly can identify them.
4. **ACP tools**: one `invoke_acp_agent` when `acp_agents` configured.
5. **Dedup by tool name, first wins**, in that priority order (config → builtin → MCP → ACP), with a warning per duplicate (#1803).

[Verified from source: tools/tools.py:45-183; tools/sync.py:17-92; tools/mcp_metadata.py:25-33]

### 7.2 `tool_search` — deferred-tool mechanics

- A tool is "deferred" iff it carries the `deerflow_mcp` metadata tag (source-agnostic). `build_deferred_tool_setup(candidates, enabled)` returns `DeferredToolSetup(tool_search_tool, deferred_names: frozenset, catalog_hash)` — empty triple when disabled or no MCP candidates; invariant: all three populated together. [Verified from source: tools/builtins/tool_search.py:12-17, 120-197]
- **Catalog hash**: sha256 (first 16 hex chars) over the sorted, canonical JSON of `{name, schema: convert_to_openai_function(t)}` per tool — schema changes change the hash, which scopes promotions in graph state (`merge_promoted` is "catalog-hash-scoped"). [Verified from source: tools/builtins/tool_search.py:69-77; backend/AGENTS.md ThreadState reducers]
- Search modes (`DeferredToolCatalog.search`): `select:Name1,Name2` (exact names, **uncapped** — capping would silently drop schemas asked for by name); `+prefix rest` (require substring in name, rank by regex-findall count of remainder); free text (regex, case-insensitive, invalid regex degrades to literal; name hit scores 2, description hit 1); ranked modes capped at `MAX_RESULTS = 5`. [Verified from source: tools/builtins/tool_search.py:42-114]
- The generated `tool_search` tool's model-facing description (verbatim):
  > Fetches full schema definitions for deferred tools so they can be called.
  >
  > Deferred tools appear by name in \<available-deferred-tools> in the system prompt. Until fetched, only the name is known. This tool matches a query against the deferred tools and returns the matched tools complete schemas; once returned, a tool becomes callable.
  >
  > Query forms:
  >   - "select:Read,Edit" -- fetch these exact tools by name
  >   - "notebook jupyter" -- keyword search, up to max_results best matches
  >   - "+slack send" -- require "slack" in the name, rank by remaining terms

  [Verified from source: tools/builtins/tool_search.py:145-158]
- **Promotion**: the tool returns `Command(update={"promoted": {"catalog_hash": ..., "names": [...]}, "messages": [ToolMessage(schemas-as-JSON, ...)]})` — promotion lives in per-thread graph state, no ContextVar; `DeferredToolFilterMiddleware` then reveals promoted schemas to the bound model. No match → `"No tools found matching: {query}"` with empty names. [Verified from source: tools/builtins/tool_search.py:159-172]
- `assemble_deferred_tools` is the fail-closed shared entry (lead/client/subagent): if enabled and MCP candidates exist but no deferred set was recovered, it raises rather than silently binding full MCP schemas; otherwise appends `tool_search` to the final tool list. [Verified from source: tools/builtins/tool_search.py:200-218]
- Prompt sections: `get_deferred_tools_prompt_section` renders `<available-deferred-tools>` (names sorted, HTML-escaped so a crafted MCP tool name cannot forge a framework tag); `get_mcp_routing_hints_prompt_section` renders `<mcp_routing_hints>` and points at `tool_search` promotion when the hinted tool is currently deferred. [Verified from source: tools/builtins/tool_search.py:282-341]
- `build_mcp_routing_middleware` builds the PR2 auto-promote middleware from a flat serializable routing index (`{priority, keywords}` per deferred `mode="prefer"` tool with keywords); `top_k` = global `tool_search.auto_promote_top_k`. [Verified from source: tools/builtins/tool_search.py:239-276]

---

## 8. Port-relevant observations (DeerFlow → Claude Code native)

Mapping candidates with behavioral deltas to watch:

| DeerFlow | Claude Code native | Behavioral deltas to watch |
|---|---|---|
| `task` tool | `Agent` tool (Task) | CC's Agent tool takes `description/prompt/subagent_type` too — near drop-in schema. Deltas: DeerFlow polls in-tool every 5s and streams `task_running` step events + cumulative token usage; CC's agents report only a final message. DeerFlow stamps structured `additional_kwargs` (`subagent_status`, `subagent_stop_reason`, `result_brief`+sha256, model, usage) — CC has no equivalent structured terminal metadata channel, so the port must fold cap/status info into the returned text (DeerFlow already does this: `"Task Succeeded (capped: ...)"`, so the model-visible contract survives). DeerFlow reuses `tool_call_id` as `task_id`; polling-timeout (`polling_timed_out`) and cooperative-cancel semantics have no CC analog. [task_tool.py:420-627; status_contract.py:196-246] |
| `general-purpose` subagent | CC `general-purpose` agent | DeerFlow's is `max_turns=150`, timeout 1800s, denies `task`/`ask_clarification`/`present_files`; CC subagents cannot spawn Agent either (parity). DeerFlow's prompt bakes in `/mnt/user-data/*` working-directory contract and `[citation:Title](URL)` format — needs rewriting for host-FS semantics. [general_purpose.py:17-70] |
| `bash` subagent | no direct CC analog (Bash-restricted agent def) | Port as a custom `.claude/agents` definition with `tools: Bash, Read, Write, Edit`; note DeerFlow's bash agent lacks glob/grep. [bash_agent.py:46-49] |
| `bash` sandbox tool | `Bash` | Deltas: DeerFlow default timeout 600s vs CC 120s default/600s max (ms-denominated); DeerFlow returns errors as strings, masks host paths and secrets in output, middle-truncates at 20k chars; CC Bash has `run_in_background` as a first-class arg vs DeerFlow's prompt-guidance-only "background with redirect" pattern; DeerFlow injects per-call env (secrets, GH token, channel-user-id export prefix) — CC has no per-call env injection channel. Both kill the process group on timeout. [sandbox/tools.py:1768-1842; sandbox_config.py:183-190; local_sandbox.py:553-626] |
| `read_file` | `Read` | Deltas: DeerFlow is text-only (binary → error steering to bash/view_image) vs CC Read handling images/PDF/notebooks; DeerFlow uses `start_line`/`end_line` (1-indexed inclusive) vs CC `offset`/`limit`; DeerFlow head-truncates at 50k chars; virtual-path (`/mnt/user-data`) contract disappears on host FS. [sandbox/tools.py:2128-2202] |
| `write_file` (+append) | `Write` | Deltas: CC Write has no append mode and no size cap; DeerFlow enforces 80 KB non-append cap (#3189, a streaming-timeout mitigation that may be unnecessary in CC) and read-before-write is middleware-enforced in DeerFlow vs harness-enforced ("must Read before Write") in CC. [sandbox/tools.py:2235-2318] |
| `str_replace` | `Edit` | Near-identical semantics (`old_string/new_string`, `replace_all`). Delta: CC Edit fails on non-unique `old_string`; DeerFlow's code replaces the first occurrence without a uniqueness check despite the docstring — porting to CC Edit *tightens* behavior. [sandbox/tools.py:2334-2387] |
| `ls` | Bash `ls`/CC file listing | DeerFlow `ls` is tree-format 2-levels with disabled-skill filtering; no CC equivalent needed beyond Bash/Glob. |
| `glob` | `Glob` | Similar. Deltas: DeerFlow caps 200/1000 with truncation hints and `include_dirs` flag; result masking irrelevant on host. [sandbox/tools.py:1920-1975] |
| `grep` | `Grep` | Deltas: DeerFlow defaults case-INsensitive (`case_sensitive=False`) vs ripgrep-backed CC Grep default case-sensitive; DeerFlow `literal` flag ↔ CC `-F` equivalent absent (CC uses regex); output caps 100/500 lines. [sandbox/tools.py:2000-2076] |
| `tool_search` | `ToolSearch` (deferred MCP tools) | CC already has this exact mechanism (this session's ToolSearch mirrors DeerFlow's query forms `select:`/`+`/keyword). Deltas: DeerFlow promotion is per-thread graph state scoped by a 16-hex catalog hash and returns OpenAI-function JSON in the ToolMessage; behavior maps cleanly. [tool_search.py:63-218] |
| `present_files` | Artifact tool / plain file paths in replies | No CC analog for a state-reducer "artifacts" channel; port maps to returning absolute paths (CC convention) or Artifact publishing. The `/mnt/user-data/outputs`-only restriction has no meaning on host FS. [present_file_tool.py:83-121] |
| `ask_clarification` | `AskUserQuestion` / plain-text question | DeerFlow's v2 structured-form mode (fields, 16/24/200 caps) exceeds CC's question tool; middleware interrupt (`Command(goto=END)`) maps to CC's turn-ending question. [clarification_tool.py:22-92] |
| `view_image` | `Read` (images) | CC Read handles images natively; DeerFlow's deferred-injection ViewImageMiddleware (metadata in state, base64 injected/removed per call, #4138) is a checkpoint-size optimization CC does not need. [view_image_tool.py:51-176] |
| `setup_agent`/`update_agent` | `.claude/agents/*.md` files edited via Write/Edit | CC agent definitions are plain files; no dedicated tool needed. Preserve the "changes take effect next turn" and non-managed-field-preservation semantics if porting programmatic self-update. [update_agent_tool.py:75-268] |
| `invoke_acp_agent` | MCP servers / Bash-spawned CLIs | No CC analog; ACP adapters would be wrapped as MCP or invoked via Bash. |
| `skill_manage` | skill-creator skill + Write/Edit | CC skills are directories edited directly; DeerFlow's SkillScan+LLM-scan gate on every write has no CC counterpart — a port must decide whether to keep the scan gate. [skill_manage_tool.py:115-259] |
| SubagentExecutor caps | CC harness limits | DeerFlow's three-axis stop taxonomy (`turn_capped` via `recursion_limit=max_turns` + GraphRecursionError partial-recovery; `token_capped` via TokenBudgetMiddleware 1M/2M; `loop_capped` via LoopDetectionMiddleware) with partial-work recovery has no CC equivalent — CC subagents run until done or context limit. If cap semantics matter for the port, they must be re-implemented in the agent prompt or an SDK hook. [executor.py:950-1008; subagents_config.py:28-55] |
| Concurrency | CC parallel Agent calls | DeerFlow: 3 concurrent (clamp 1-4), 6 total per run (clamp 1-50), enforced by middleware truncating excess tool calls with a visible limit note. CC has no per-run delegation budget — port would rely on prompt guidance. [subagents_config.py:11-25, 136-141] |
| Checkpointer isolation | CC agents are stateless per invocation | Same one-shot model (`checkpointer=False`); CC's SendMessage continuation is *more* capable than DeerFlow subagents (which can never be resumed). [executor.py:589] |

Other port notes:

- **Tool descriptions are behavior-carrying.** The `description`-first argument convention ("ALWAYS PROVIDE THIS PARAMETER FIRST") on every sandbox tool is a DeerFlow-ism (streaming-display driven); CC tools have no such arg — dropping it is safe but any prompt copied verbatim must strip these instructions. [sandbox/tools.py:1782 etc.]
- **Status contract is cross-language.** Any consumer port must respect the additive-`stop_reason` compatibility rule (`contracts/subagent_status_contract.json` v2) and the legacy `max_turns_reached` read-side normalization. [status_contract.py:96-105]
- **Skill allowlist intersection** (`_merge_skill_allowlists`) means a subagent can never see a skill the parent's runtime denied — CC subagents inherit skills freely; parity requires per-agent `skills` frontmatter. [task_tool.py:187-195]
- **`is_subagent: True` in runtime context** gates behavior in downstream components; a port using CC's Agent tool gets this implicitly (subagent context) but any DeerFlow middleware logic keyed on it must be re-homed. [executor.py:877]
