# Parity Discrepancies

Every place the Claude Code port knowingly behaves differently from the original DeerFlow
harness at `bytedance/deer-flow@0950924`. A discrepancy belongs here when the port cannot
reproduce the original behaviour, or reproduces it only through a different mechanism with an
observable consequence. Silent divergence is a defect; a divergence recorded here is a
decision.

Each entry states: what the original does, what the port does, why, the blast radius, and how
it is verified (or why it cannot be).

Legend for **Kind**:

- **blocked** — the platform provides no mechanism; the behaviour is absent.
- **degraded** — the behaviour exists but is weaker or differently triggered.
- **relocated** — the behaviour is fully preserved but produced somewhere else.
- **intentionally omitted** — the port deliberately does not carry it, with a reason.

---

## M6 — subagents, delegation, deep-run orchestration

### 1. Per-agent cancellation on timeout — **degraded**

| | |
|---|---|
| **Original** | `SubagentExecutor.execute_async` catches `FuturesTimeoutError`, sets `result.cancel_event`, marks the holder `TIMED_OUT` and cancels the execution future. The subagent's stream loop checks `cancel_event` at every super-step boundary and stops cooperatively. [executor.py:1100-1161, 895-907] |
| **Port** | `workflows/deep-run.js` races each `agent()` against a real `setTimeout` (`withTimeout`). When the timer wins, the task is recorded `timed_out` with `Execution timed out after N seconds` and `stop_reason` stays `null` — matching the original exactly. But the losing `agent()` **keeps running to completion in the background**: the workflow runtime exposes no per-agent cancel handle (`TaskStop` kills the whole workflow, not one agent). |
| **Blast radius** | Model-visible contract is identical — the timed-out result is discarded either way and the formatter renders `Task timed out.` byte-for-byte. The cost is wasted tokens and wall-clock on an abandoned agent, plus any side effects it performs after the deadline. |
| **Verified** | Timeout mapping: `src/deeprun/workflow-sync.test.ts`. Timer availability probed live (Claude Code 2.1.220): a 30 ms `setTimeout` inside a workflow script fired and resolved. The non-cancellation is a documented absence, not a test. |

**Note — the timeout is NOT blocked.** An earlier assumption that workflow scripts have no timer
API was disproven by direct probe: `setTimeout` and `clearTimeout` are both present and real.
The original's 1800 s (`subagents.timeout_seconds`) is therefore genuinely enforced, not merely
delegated to the runtime lifecycle.

### 2. `max_turns` and the token budget — **blocked**

| | |
|---|---|
| **Original** | `recursion_limit = config.max_turns` (150 general-purpose, 60 bash); exceeding it raises `GraphRecursionError`, which the executor converts into `turn_capped` — recovering the last non-empty AIMessage as a *usable partial* (`completed` + partial + cap) or, failing that, `failed` + cap. `TokenBudgetMiddleware` (1M/2M) sets `token_capped` and `LoopDetectionMiddleware` sets `loop_capped`, both as hard stops that strip tool calls without raising. [executor.py:950-1008, 592-608] |
| **Port** | Claude Code agent frontmatter has no turn limit, no token budget and no loop detector, and the harness surfaces no equivalent signal to the caller. The three cap values remain in the contract and in the result schema, but they can only arrive **self-reported by the subagent**, never observed by the dispatcher. |
| **Blast radius** | A runaway subagent is bounded only by Claude Code's own context limit, not at 150 turns. Partial-work recovery on a turn cap does not happen: an agent that exhausts its context returns whatever it returns. Cap-aware lead behaviour (the `statusGuidance` line "retry with a tighter scope or raise the per-agent budget") still renders correctly when a cap IS reported — it just fires less often than in the original. |
| **Verified** | The vocabulary and every rendering path are pinned by `src/deeprun/result-format.test.ts` (60/60 golden renders including all three caps). The *detection* is what is absent. |

### 3. `subagent_limit_capped` excluded from the subagent result schema — **intentionally omitted**

| | |
|---|---|
| **Original** | `subagent_limit_capped` is a **run-level** stop reason stamped by `SubagentLimitMiddleware` when the per-run delegation budget truncates a response. It is not a member of `SUBAGENT_STOP_REASON_VALUES` and never appears in `subagent_stop_reason`. [subagent_limit_middleware.py; contracts/subagent_status_contract.json:1-6] |
| **Port** | `DEEP_RUN_TASK_RESULT_SCHEMA.stop_reason` allows only the contract's three values plus `null`. `subagent_limit_capped` rides on the **batch plan** (`BatchPlan.stopReason`, and the workflow's top-level `stop_reason`) instead. |
| **Why** | A subagent can never observe this reason about itself, and `format_subagent_result_message` has no label for it — accepting it in the agent-facing schema would let an agent emit a cap the formatter silently renders as "no cap at all". Keeping the layers separate is what the contract already does. |
| **Blast radius** | None on the wire. It is a narrowing of an input the original never produced. |
| **Verified** | `src/deeprun/task-schema.test.ts` asserts the exclusion in both the enum and the JSON Schema; `src/deeprun/result-format.test.ts` asserts the producer boundary rejects it. |

### 4. Per-run limit note fires on drop, not on re-request — **relocated**

| | |
|---|---|
| **Original** | The cap is enforced once **per model response**, in an `after_model` hook that rewrites the AIMessage's `tool_calls` and appends `[SUBAGENT LIMIT REACHED]` when the run budget is exhausted. The model is free to ask again on its next turn. |
| **Port** | The workflow owns the whole dispatch loop, so `planBatches` replays that same per-response decision **once per batch**, feeding each batch's launches back in as `priorDelegations`. Tasks past the budget are dropped permanently and reported in `dropped_tasks` + `limit_note`. |
| **Why it is exact, not approximate** | `allowed = min(maxConcurrent, max(0, maxTotal − prior))` with `maxConcurrent ≥ 1` means `allowed == 0` **iff** `remainingTotal == 0` — precisely the condition under which the original appends the note. So the composition drops a task only when the budget is genuinely gone, and never while budget remains. |
| **Blast radius** | The note text, the `subagent_limit_capped` stop reason and the per-response allowance are all identical. What differs is recovery: the original's model can retry next turn; the port's dropped tasks are returned to the lead, which decides. Never silent. |
| **Verified** | `src/deeprun/batching.test.ts` and `src/deeprun/workflow-sync.test.ts` replay all 9 `allowed_this_response` vectors from `parity/baseline/caps_clamping.json` against the first batch, then check the multi-batch composition. Live: smoke (d), 4 tasks with `max_total: 3` → 3 delegated, 1 dropped, verbatim note, `stop_reason: subagent_limit_capped`. |

### 5. Malformed cap arguments degrade instead of raising — **degraded**

| | |
|---|---|
| **Original** | `max(1, min(4, None))` raises `TypeError`. `parity/baseline/caps_clamping.json` records that as the real behaviour rather than a fabricated clamped value. |
| **Port (TypeScript)** | `src/policy/caps.ts` faithfully refuses with `SubagentLimitTypeError` — it sits at a typed API boundary. **No divergence.** |
| **Port (workflow)** | `deep-run.js`'s inline `clampConcurrency` / `clampTotal` fall back to the documented defaults (3 / 6) for a non-integer. |
| **Why** | The workflow reads an untyped tool-call payload authored by a model. Aborting an entire delegation run over one malformed cap field trades a recoverable input error for a total failure. |
| **Blast radius** | Only reachable when a caller passes a non-integer `max_concurrent` / `max_total`. The run proceeds under documented defaults instead of dying. |
| **Verified** | `src/deeprun/workflow-sync.test.ts` pins both behaviours side by side and labels the divergence. |

### 6. `args` passed as a JSON string is parsed, not rejected — **degraded (defensive)**

| | |
|---|---|
| **Original** | No analogue — DeerFlow's `task` tool receives typed arguments from the LangChain tool layer. |
| **Port** | The Workflow tool documents that `args` must be a real JSON value and warns that a JSON-encoded **string** "reaches the script as one string". Observed live during the M6 smoke: the lead model sent `args` as a stringified object on **every** attempt, across three differently-worded prompts. deep-run.js therefore `JSON.parse`s a string `args` rather than ignoring it. |
| **Why** | Without this the workflow silently fell through to the planner with an empty objective and returned `{"totals":{"requested":0,...}}` — a run that looks successful but did nothing. That is the worst available failure mode. |
| **Blast radius** | Strictly widens what the workflow accepts. An unparseable string still degrades to `{}` (defaults), same as before. |
| **Verified** | `src/deeprun/workflow-sync.test.ts` (`coerceWorkflowArgs`). Live: smoke (c) failed with empty args before the fix and returned `PROBE-OK` after it. |

### 7. Delegation ledger is written by the lead session, not by a hook — **relocated**

| | |
|---|---|
| **Original** | `DurableContextMiddleware` / `delegation_ledger.py` derive the ledger by scanning message history: `task` tool calls become `in_progress` entries and the paired `ToolMessage` metadata upgrades them to terminal, all inside the graph run. |
| **Port** | `workflows/deep-run.js` **returns** ledger-shaped entries (`ledger_entries`); `src/deeprun/ledger-io.ts` maps and persists them through the atomic state library. The write happens in the lead session after the workflow returns. |
| **Why a PostToolUse hook cannot do it** | **Probed live and disproven.** A `PostToolUse` hook matching `Workflow` fires at *launch*, not at completion — workflows run in the background. The captured `tool_response` was:<br>`{"status": "async_launched", "taskId": "wxcwpt23j", "taskType": "local_workflow", "workflowName": "probe-caps", "runId": "wf_666b1cf4-60a", "summary": "...", "transcriptDir": "...", "scriptPath": "..."}`<br>It carries no result at all — the result arrives later as a `<task-notification>` to the model. A hook is therefore structurally incapable of capturing it, so `src/hooks/ledger-capture.ts` was **not** written and `hooks/hooks.json` was **not** modified. |
| **Blast radius** | The ledger is still durable and still enforces terminal-never-downgraded (the reducer is unchanged). It becomes durable one step later, and only if the lead session performs the recording step. A crash between the workflow returning and the lead recording loses the entries; the original had the same window narrowed to a checkpoint. |
| **Verified** | `src/deeprun/ledger-io.test.ts` (mapping + reducer interaction + on-disk write). Hook infeasibility verified by the live payload above. |

### 8. Timestamps and digests are stamped after the workflow returns — **relocated**

| | |
|---|---|
| **Original** | `_utc_now_iso()` at entry creation; `hashlib.sha256(result)` for `result_sha256`. |
| **Port** | Workflow scripts cannot call `Date.now()` / argless `new Date()` (they throw — "they would break resume") and have no crypto. `deep-run.js` emits `created_at: null` and `result_sha256: null`; `src/deeprun/ledger-io.ts` fills both when the lead persists the entries. |
| **Blast radius** | None on the final on-disk record. The intermediate workflow return value is not a complete ledger entry and must not be written verbatim. |
| **Verified** | `src/deeprun/workflow-sync.test.ts` asserts deep-run.js contains no clock or RNG call; `src/deeprun/ledger-io.test.ts` asserts the stamped record. |

### 9. Delegation id derivation — **relocated**

| | |
|---|---|
| **Original** | The `task` tool reuses `tool_call_id` as `task_id` "for traceability". |
| **Port** | `<run_id>:<task_index>` (`delegationId`). There is no `tool_call_id`, and a UUID is impossible — `Math.random()` throws in the sandbox and the id must survive a workflow resume unchanged. |
| **Blast radius** | Ids are deterministic, unique within a run, and stable across resume — strictly better for resume, and they no longer correlate to a transcript tool-call id. |
| **Verified** | `src/deeprun/ledger-io.test.ts`. |

### 10. Unknown `subagent_type` falls back instead of failing — **degraded**

| | |
|---|---|
| **Original** | An unknown `subagent_type` returns a `failed` result whose error lists `get_available_subagent_names()`. |
| **Port** | `resolveAgentType` falls back to `deerflow-general-purpose`. |
| **Why** | The original fails one `task` call; the port would have to fail a whole `parallel()` batch, losing the sibling tasks with it. The planner agent is schema-constrained to the two valid types, so this path is reachable only from a hand-written `tasks` argument. |
| **Blast radius** | A typo silently runs on general-purpose instead of erroring. Bare `general-purpose` / `bash` (the original's own names) and the namespaced forms are accepted as aliases, which is the common case this protects. |
| **Verified** | `src/deeprun/batching.test.ts`, `src/deeprun/workflow-sync.test.ts`. |

### 11. Plugin agents are namespace-qualified at the call site — **relocated**

| | |
|---|---|
| **Original** | `BUILTIN_SUBAGENTS` keys are bare: `general-purpose`, `bash`. |
| **Port** | The agent files declare bare names (`deerflow-general-purpose`, `deerflow-bash`) and the ledger records those, but `agent({ agentType })` must be called with the plugin-qualified id. Verified live: the bare name fails with `agent type 'deerflow-general-purpose' not found. Available agents: ..., deerflow:deerflow-bash, deerflow:deerflow-general-purpose, ...`. `qualifyAgentType` adds the prefix at dispatch only. |
| **Blast radius** | None once qualified. The prefix is `plugin.json`'s `name`, so renaming the plugin without updating `PLUGIN_AGENT_NAMESPACE` would break dispatch. |
| **Verified** | `src/deeprun/workflow-sync.test.ts`; live smoke (c) and (d). |

### 12. Subagent step events — **intentionally omitted**

| | |
|---|---|
| **Original** | `subagents/step_events.py` shapes each captured AIMessage/ToolMessage into an 8192-char `step` payload, streamed in `task_running` and persisted as `subagent.step` / `subagent.end` run events (#3779), so a web user can review a subagent's tool calls after a page reload. |
| **Port** | Not carried. Claude Code covers the same requirement natively three times over: the live `/workflows` progress tree, `<transcriptDir>/journal.jsonl` (one row per agent return value), and per-agent `agent-<id>.jsonl` transcripts. The durable half is met by the delegation ledger. |
| **Blast radius** | No DeerFlow-shaped step payload exists to consume. Anything that parsed `subagent.step` rows must read the platform's transcripts instead. |
| **Verified** | Recorded in `docs/claude-code-port/traceability-matrix.md` §4 as `intentionally omitted (M6)`. |

### 13. Structured terminal metadata has no transport channel — **relocated**

| | |
|---|---|
| **Original** | `make_subagent_additional_kwargs` stamps `subagent_status`, `subagent_stop_reason`, `subagent_result_brief`, `subagent_result_sha256`, `subagent_error`, `subagent_model_name`, `subagent_token_usage` onto the terminal `ToolMessage.additional_kwargs`. |
| **Port** | Claude Code has no metadata channel on an agent result. The same fields are computed by `makeSubagentAdditionalKwargs` and carried on the workflow's returned result object and the ledger entry. `subagent_model_name` and `subagent_token_usage` are currently never populated: the workflow runtime does not report per-agent model or usage to the script. |
| **Blast radius** | Every model-visible fact survives (the original already folded status and caps into the text). Per-agent token accounting is lost at the ledger level; `budget.spent()` gives a workflow-wide figure only. |
| **Verified** | `src/deeprun/result-format.test.ts` asserts the full `additional_kwargs` object for all 60 vectors, including the model-name and usage paths when supplied. |
