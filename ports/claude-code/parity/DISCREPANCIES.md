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

---

## M8 — context & summarization

Full row-by-row comparison: `docs/claude-code-port/summarization-delta.md`. The entries below are
the ones with an observable consequence.

### 1. Compaction trigger and keep policy — **blocked**

| | |
|---|---|
| **Original** | `_prepare_compaction` counts tokens over `messages` **plus** a synthetic `HumanMessage(name="summary")` carrying the previous `summary_text`, then defers to the parent's `_should_summarize` / `_determine_cutoff_index`. `trigger` is configurable (tokens / messages / fraction-of-max, OR-combined); `keep` defaults to `("messages", 20)`. [summarization_middleware.py:458-481; config/summarization_config.py:36-53] |
| **Port** | Claude Code auto-compacts at ~85% of the context window. No threshold, no OR-list, no fraction, no addressable keep window; the port never sees the token count, so the existing summary cannot weigh into the trigger either. |
| **Blast radius** | A deployment cannot tune when compaction happens, and "the last 20 messages are always intact" is no longer a guarantee the port can make. |
| **Mitigation** | The port depends on no message-shaped guarantee — everything it needs after compaction lives in state files. The `PreCompact` hook refreshes the durable digest at *every* boundary, wherever the platform puts it, and `/deerflow:compact` lets a user force a refresh. |
| **Verified** | Absence, not a test. Hook behaviour at the boundary: `src/hooks/precompact-summary.test.ts`. |

### 2. The compaction summary is not DeerFlow's — **degraded**

| | |
|---|---|
| **Original** | `_create_summary` invokes an ordered candidate model (configured summary model → run model), with lazy guarded construction, cached construction failures, `TAG_NOSTREAM`, and blank-response-is-failure handling. The middleware owns the summary end to end. [summarization_middleware.py:127-212, 235-283] |
| **Port** | The prose summary is produced by Claude Code's native compaction, which the port neither controls nor inspects. The port contributes a **deterministic digest** of durable state instead: recent user objectives, open todos, delegation status counts, artifacts, message count (`src/summary/digest.ts`). No model is called — a hook has no credentials and must not block the turn. |
| **Blast radius** | Prose recall of the compacted conversation is platform behaviour and cannot be asserted equal to DeerFlow's. Anything that existed only as reasoning or intermediate tool output, and was never written to durable state, is not covered by the port's half. |
| **Mitigation** | `src/summary/context-loss.ts` **measures** the actual recall (`items_total` / `items_recalled` / `lost_items` / `by_kind`) rather than asserting survival. M14 runs the probe; M8 owns the scorer so the number cannot drift. |
| **Verified** | `src/summary/digest.test.ts` (determinism: two builds over the same state are byte-identical), `src/summary/context-loss.test.ts` (16 scoring vectors). |

### 3. Summary-generation path is ported but unused — **intentionally omitted**

| | |
|---|---|
| **Original** | `_build_summary_input_text` wraps the compaction window in `<existing_summary>` / `<new_messages>`, HTML-escaped (`quote=False`) against block breakout (#4162 / #4097), trim-then-escape, with the two `_CANNED_SUMMARIES` short-circuits; the whole thing is formatted into `summary_prompt`. |
| **Port** | `src/summary/wrapper.ts:buildSummaryRequest` is a verbatim port of that wrapper, drift-tested against a frozen copy of lines 415-435. Nothing in M8 calls it: the hook must not invoke a model. Two consequences: (a) the *base* instruction is LangChain-inherited, not DeerFlow's, so it is **not vendored** — `PORT_SUMMARY_BASE_INSTRUCTION` is port-authored replacement text, labelled in the file header; (b) the canned `"Previous conversation was too long to summarize."` branch is preserved but **unreachable**, because the char-budget trimmer (the original's fallback path, the only one available without a token counter) never empties a non-empty input. |
| **Blast radius** | None today. A future port path that does generate a summary inherits the exact wrapper and the exact escaping; only the wording of the base instruction differs from a DeerFlow deployment. |
| **Verified** | `src/summary/wrapper.test.ts` — frozen-source token extraction, escaping/breakout tests, and an explicit assertion that the unreachable branch is retained. |

### 4. Memory flush at the compaction boundary — **blocked (until M9)**

| | |
|---|---|
| **Original** | `before_summarization` hooks fire once a replacement summary exists; the lead chain attaches `memory_flush_hook` (when `memory.enabled`) so pre-compaction messages reach durable memory. Subagents pass `skip_memory_flush=True` so their internal turns do not pollute the parent thread. [summarization_middleware.py:508-518, 625-647, 743-747] |
| **Port** | Not implemented. The port's memory queue is M9. |
| **Blast radius** | **A real loss window, open until M9:** information that existed only inside the compacted window is not written to durable memory. |
| **Mitigation** | The `PreCompact` hook already runs at exactly the right instant, so M9 adds the enqueue call at that point and nothing else. |
| **Verified** | Declared absence. |

### 5. The port parses the session transcript — **degraded (defensive)**

| | |
|---|---|
| **Original** | Reads `state["messages"]` directly; there is no transcript. |
| **Port** | `src/summary/digest.ts:extractTranscriptTail` performs a defensive JSONL parse of the `transcript_path` supplied by the PreCompact payload, to recover recent user objectives and a message count. This deviates from `docs/claude-code-port/state-checkpoint-resume.md` §2.1, which records the transcript format as "internal/unstable — never parsed by the port". |
| **Blast radius** | An upstream format change could silently stop objectives appearing in the digest. Nothing else in the port reads the transcript. |
| **Mitigation** | Every level degrades: an unparseable line is skipped, an unexpected record shape is ignored, an unreadable file yields an empty tail — and the digest is still produced from state files alone. No downstream behaviour depends on a successful parse. |
| **Verified** | `src/summary/digest.test.ts` (malformed lines, missing file, tool_result blocks ignored). |

### 6. Durable-context projection uses one carrier, not two messages — **relocated**

| | |
|---|---|
| **Original** | `DurableContextMiddleware._inject` inserts, after the leading SystemMessages, a `SystemMessage(_AUTHORITY_CONTRACT)` **plus** one hidden `HumanMessage` carrying `<durable_context_data>` — precisely so runtime values never reach system-role authority. [durable_context_middleware.py:249-271] |
| **Port** | Claude Code exposes no per-model-call request rewrite. `src/summary/durable-context.ts` emits both halves as labelled sections of one string, for `UserPromptSubmit` `additionalContext` (M7 wires the injection). Order, texts, escaping and budgets are verbatim; `authorityContract` and `dataBlock` are exported separately so a future two-message carrier needs no re-derivation. |
| **Blast radius** | The authority rules arrive with user-turn weight rather than system weight. |
| **Mitigation** | The untrusted half stays fenced inside `<durable_context_data>` and is HTML-escaped, so a value cannot close its own block or forge a section. |
| **Verified** | `src/summary/durable-context.test.ts` — verbatim authority contract, section order, ledger/skill rendering, and two breakout attempts (summary value and delegation result) that fail to close the block. |

### 7. Manual compaction is two actions by two actors — **degraded**

| | |
|---|---|
| **Original** | `POST /threads/{id}/compact` → `compact_thread_context`: forces compaction, generates a summary, and rewrites `messages` + `summary_text` in one mutation-graph checkpoint write under a `checkpoint_write` reservation. |
| **Port** | `/deerflow:compact` runs `node dist/summary/digest-cli.js`, which rebuilds the durable digest only, then instructs the **user** to run native `/compact` — slash commands are not model-invocable, so a skill cannot compact the context itself. |
| **Blast radius** | Invoking the port's compact skill does not shrink the context. |
| **Mitigation** | The skill is explicitly forbidden from claiming otherwise and says so to the user; the durable half remains a single atomic write, as the original's was. |
| **Verified** | `skills/compact/SKILL.md` ("What this is not"); CLI write path covered by `src/summary/summary-state.test.ts`. |

### 8. `summary.json` carries fields the original channel did not — **relocated**

| | |
|---|---|
| **Original** | `summary_text` is a bare-string LangGraph LastValue channel. |
| **Port** | The file adds `updated_by` (`precompact` / `manual` / `deep-run`), `source_message_count`, `commit_sha`, the structured `digest`, and a `compactions` history bounded at 20, on top of the standard `{schema_version, rev, updated_at}` envelope. It also offers an optional port-authored `## Active goal` projection section, **off by default**. |
| **Blast radius** | Additive only. A reader comparing the two finds extra provenance data. |
| **Mitigation** | The ported LastValue rule governs `summary_text` unchanged — including `_nonempty_summary`'s "a blank summary is a generation failure", so a blank write preserves the previous text instead of clearing history. The goal section is default-off so the default rendering matches the original's format. |
| **Verified** | `src/summary/summary-state.test.ts` (16 tests, incl. blank-preserve and CAS), `src/summary/durable-context.test.ts` (goal section default-off). |

---

## M10 — checkpoints & resume

### 1. Lease / heartbeat machinery → a single-process 2 h expiry constant — **degraded**

| | |
|---|---|
| **Original** | Abandonment is decided by a **lease**. A heartbeat renews the run's lease every `lease_seconds/3` and fails closed at the last confirmed deadline (`ownership_lost`: abort + no further durable writes, the peer owns terminalization). Reconciliation runs at startup and every 3rd heartbeat cycle, single-flight, and claims expired- or NULL-lease active rows through the atomic `claim_for_takeover` CAS before terminalizing them. [manager.py:33-35, 1700-1784, 1845-2069] |
| **Port** | There is no lease, no heartbeat, no takeover and no fence. `src/resume/recovery.ts` decides abandonment from two facts a file scan can observe: the record's `session_id` is not the current session, **and** its `updated_at` is older than `ORPHAN_EXPIRY_MS` = **2 hours**. The scan runs once, at `SessionStart` (`src/hooks/session-recover.ts`), which is the port's startup. |
| **Why** | The port is single-process by design — the deployment collapse the runtime notes explicitly bless ("startup reclaims NULL-lease active rows", notes/runtime-and-persistence.md §9.9). With no second worker, a lease has nothing to arbitrate: there is no peer that could steal a run and no window in which two writers race for terminalization. What remains is the one question a lease also answered — *is anything still working on this?* — and the only evidence available is the record's own timestamp. |
| **Why 2 hours** | Deliberately far longer than any real lease (the original renews in seconds). Too short would terminalize a run whose session is merely idle; too long would leave the thread's single active-run slot blocked (`ActiveRunExistsError` on every subsequent run) for the rest of the day. The constant is named, commented, and pinned by a test rather than inlined. |
| **Blast radius** | A crashed run is reclaimed at the **next session start**, not within a lease period — between the crash and that session, `run-meta.json` still says `running`. A run abandoned less than 2 h ago is reported as a resume candidate instead of being terminalized, so its active-run slot stays held until the next scan after the expiry. Neither window exists in the original. Conversely, nothing can be *wrongly* fenced: with one writer, a stale terminalization cannot race a live worker, and every recovery write goes through the same `rev`-CAS as any other state write. |
| **Verified** | `src/resume/recovery.test.ts` (19 tests: expiry matrix, current-session exclusion, terminal-untouched, fresh-untouched, receipt preservation, single-rev write, failure collection); `src/hooks/session-recover.test.ts` (10 tests). |

### 2. Per-superstep rollback → not applicable — **intentionally omitted**

| | |
|---|---|
| **Original** | `_capture_rollback_point()` eagerly materializes the pre-run state (messages + every non-message channel + raw `pending_writes`) under `_checkpoint_thread_lock` into an immutable `RollbackPoint`; `_rollback_to_pre_run_checkpoint()` then either **forks** from that captured checkpoint config (full mode) or replaces every captured channel on the head (delta mode, which cannot fork once sibling writes are attached). Capture failure sets `snapshot_capture_failed` and disables rollback entirely (fail-closed). [worker.py:765-786, 1551-1599, 1721-1825] |
| **Port** | M10 implements **no rollback at all**, and the resume layer never claims one. There is no per-superstep anchor to roll back to: the recovery quantum is the stage, and the addressable anchors are the head state files plus the per-run `runs/<run_id>.pre/` snapshot that a deep run copies at run start (guarantee G4, a separate lane). Conversation and file rollback are native (`/rewind`), and the port does not wrap them. |
| **Why it is "not applicable" rather than "missing"** | Rollback in the original restores a *point inside a run* — the state as of superstep N, reconstructed from a checkpoint row. The port has no such point: Layer 1 is the session transcript (native, turn-granular) and Layer 2 is a set of files each rewritten wholesale. "Restore superstep N" has no referent here. The behavioral requirement that survives — eager capture, materialized copy, fail-closed on capture failure — is expressed at run granularity by `runs/<run_id>.pre/`, which is exactly what state-checkpoint-resume.md §3.3 and G11 record as accepted losses: every DeerFlow behavior the port must reproduce is defined at turn/stage/run boundaries, never mid-superstep. |
| **Blast radius** | A user who wants "undo the last half of this run" gets stage granularity, not superstep granularity: the interrupted stage re-runs from its beginning. There is no partial-superstep restore and no delta-linearization case (the fork-poisoning hazard class is designed out with the delta representation itself). Nothing in the resume path silently pretends otherwise — `restart_stale` re-runs whole stages. |
| **Verified** | Absence, not behaviour: `src/resume/*` contains no restore path. The stage-level recovery quantum is pinned by `src/resume/resume-plan.test.ts` (stage-skip predicate: terminal entry + matching `commit_sha`); `/deerflow:status` states the limitation in its "What this is not" section. |

### 3. Orphans are terminalized `interrupted`, not `error` — **degraded (declared naming deviation)**

| | |
|---|---|
| **Original** | Reconciliation marks a claimed orphan `error` with `stop_reason="orphan_recovered"`; `shutdown(timeout)` marks non-settled runs `interrupted`. Two different terminal statuses for two different abandonment paths. [manager.py:1845-2069, 2136-2234] |
| **Port** | Both paths produce `interrupted` + `stop_reason: "orphan_recovered"`, per state-checkpoint-resume.md §5 step 2. The port cannot distinguish "claimed from a dead peer" (an `error`-worthy fault) from "the process went away" (a clean `interrupted`) — with no lease and no peer, every orphan reaches recovery through the same door. |
| **Why not `error`** | `error` in the port's vocabulary means the run *failed*, and a run whose process was killed did not fail — recording it as an error would put a fabricated failure in the thread's history and in every downstream count. `interrupted` is the honest reading, and `stop_reason: orphan_recovered` preserves the exact provenance the original stamped, so nothing is lost about *why* the record is terminal. |
| **Blast radius** | Anything counting `error` runs sees fewer of them and correspondingly more `interrupted` ones. The `stop_reason` discriminates them exactly, so no information is destroyed. |
| **Verified** | `src/resume/recovery.test.ts` ("terminalizes an expired non-terminal run with orphan_recovered and a zero receipt"); the receipt half (existing receipt preserved, zero receipt backfilled put-if-absent) matches the original's `put_if_absent` singleton exactly. |

---

## M11 — errors & goal loop

### 1. The goal evaluator is not independent — **degraded**

| | |
|---|---|
| **Original** | After each visible turn, `runtime/runs/worker.py` calls `evaluate_goal_completion`, which sends the goal objective plus the last 30 visible messages to a **separate, non-thinking evaluator model** (`create_goal_evaluator_model`, `thinking_enabled=False`) under a strict rubric and parses its typed JSON verdict `{satisfied, blocker, reason, evidence_summary}`. The evaluator has no stake in the answer: it never produced the work it judges. [goal.py:242-327] |
| **Port** | A Claude Code hook is a short-lived subprocess with no model credentials and a blocking budget, so there is no second model to call. `src/hooks/stop-goal-evaluator.ts` runs the **deterministic** gates itself and, when they pass, emits `{"decision":"block"}` whose `reason` carries the **verbatim** rubric (`GOAL_EVALUATOR_SYSTEM_INSTRUCTION`) plus the same user content (`Active goal: … Visible conversation evidence: … Is the active goal fully satisfied?`). The **session model** then judges its own work under that rubric and acts: `goal-cli clear` when satisfied, keep working when `goal_not_met_yet`, `goal-cli record-evaluation '<json>'` for any other blocker. |
| **Blast radius** | Self-evaluation bias. The judging *standard* is byte-identical, but the judge is the author, so the realistic failure mode is declaring victory early (a `satisfied` verdict the original's evaluator would have refused) rather than looping forever. The typed blocker taxonomy, the fail-closed `missing_evidence` default and the "never assume state changed" clause are all preserved verbatim, and the skill restates the bias explicitly. |
| **Mitigation** | Everything that bounds the loop stays outside model control: continuation cap 8, no-progress breaker 2 keyed on SHA-256 of the latest visible assistant text, and the no-visible-evidence short circuit all run in the hook, on durable state the model does not write during the decision. The hook persists `continuation_count + 1` **before** it emits the block, so at most `max_continuations` blocks can ever be issued for one goal even if the model ignores every instruction in the reason. A second safeguard (`continuation_not_recorded`) stands the loop down if `stop_hook_active` is set while the counter is still 0, i.e. if the persistence itself is failing. |
| **Verified** | `src/goal-loop/evaluator-prompt.test.ts` re-parses the Python literals out of `runtime/goal.py` and asserts the rubric and the user-content template match byte-for-byte; `src/goal-loop/stop-hook.test.ts` pins cap-exhausted → no block, fresh evidence → block-with-rubric, breaker-tripped → no block + `no_progress_detected`, and a 50-iteration loop that terminates after exactly 8 blocks. The bias itself is a documented absence, not a test. |

### 2. Hidden continuation message → Stop-hook block reason — **relocated**

| | |
|---|---|
| **Original** | A continuable verdict produces `make_goal_continuation_message`: a `HumanMessage` wrapped in `<goal_continuation>` and marked `additional_kwargs={"hide_from_ui": True, "deerflow_goal_continuation": True}`, streamed into the graph as another turn on the same thread. The user never sees it. [goal.py:391-408; worker.py:908-932] |
| **Port** | There is no hidden-message channel and no way to inject a turn: the only control point at end-of-turn is the `Stop` hook, whose single lever is `{"decision":"block","reason":...}`. The same continuation instruction ("Continue working toward the active goal… Do not ask the user to continue unless you are genuinely blocked") therefore rides inside the block reason. `makeGoalContinuationMessage` is still ported verbatim and is what `goal-cli record-evaluation` returns for a continuable verdict. |
| **Blast radius** | The continuation text is **visible** to the user, where the original's was hidden — the port's block reason surfaces in the transcript. The turn boundary also differs: the original starts a fresh graph turn, the port refuses to end the current one. |
| **Mitigation** | The instruction text is unchanged, and the goal record (`continuation_count`, `no_progress_count`, `last_evaluation` including `stand_down_reason`) is written to `.deerflow/state/<thread>/goal.json` on every decision, so the loop remains as observable as the original's `values` frame. |
| **Verified** | `src/goal-loop/orchestrate.test.ts` renders `<goal_continuation>` byte-for-byte against goal.py:391-408 including both fallback strings; `src/goal-loop/stop-hook.test.ts` asserts the block reason carries the rubric and the rendered evidence. |

### 3. Durable-receipt and thread-unchanged predicates → evidence + CAS — **degraded**

| | |
|---|---|
| **Original** | Before continuing, the worker requires a durable end-of-turn receipt (`_has_durable_goal_turn_receipt`: a checkpoint id, **no** `pending_writes`, and a visible trailing AI message) and re-checks that the thread did not move during evaluation (`thread_changed_after_evaluation` / `thread_changed_before_continuation`), all under `goal_thread_lock` with checkpoint-id CAS. [worker.py:1229-1246, 1403-1450] |
| **Port** | There are no checkpoints and no `pending_writes`, so the receipt reduces to its observable half: the Stop hook fires only after the turn has ended, and the hook requires a non-empty **visible assistant** signature from the transcript before it will block (otherwise `blocked:missing_evidence`). Staleness protection is the state file's `rev` compare-and-set (`atomic-io.ts`), which is the port's `GoalWriteConflict`. |
| **Blast radius** | The port cannot distinguish "turn ended" from "turn ended and every write landed" — that distinction has no counterpart. The two thread-changed stand-down reasons (`thread_changed_after_evaluation`, `thread_changed_before_continuation`) therefore never appear in the port's vocabulary; a concurrent writer surfaces as a `rev` conflict on the goal file instead. |
| **Mitigation** | The evidence gate keeps the strongest half of the receipt (never continue on nothing), and every goal write is a CAS, so a racing writer loses rather than clobbers. |
| **Verified** | `src/goal-loop/stop-hook.test.ts` (`no visible assistant evidence`, `an unreadable transcript is treated as no evidence`); CAS behaviour by `src/state/atomic-io.test.ts`. |

---

## M9 — memory

### 1. 30-second debounce → batch-on-next-turn — **degraded**

| | |
|---|---|
| **Original** | `MemoryUpdateQueue` is a process-local list plus a `threading.Timer`. `debounce_seconds` defaults to **30** (range 1–300); updates coalesce per `(thread_id, user_id, agent_name)`; a dedicated 4-worker pool (`memory-updater-sync`) runs the extraction LLM call off the event loop. `queue_max_depth` 1000, with signal-bearing updates always admitted. [core/queue.py:1-133; config.py:76-86] |
| **Port** | The queue survives as a durable file (`.deerflow/memory/queue.jsonl`); the timer does not. A `Stop` hook appends the turn's last user message and last assistant response, and the batch is extracted by the model on the **next** `/deerflow:run` turn, or on an explicit `/deerflow:memory update`. |
| **Why** | Claude Code has no long-lived server process to host a timer thread or a worker pool, and a hook must not block the turn on an LLM call. Extraction needs a model and a token budget; the next turn is the first moment both exist. |
| **Blast radius** | Flush latency moves from "~30 s after the last turn" to "at the start of the next turn". Coalescing is preserved and in fact strengthened — several turns accumulate in one file and are extracted together. A session that ends and is never resumed leaves its final batch unextracted until the project is next opened; upstream would have flushed it via `shutdown_flush`. Backpressure is not ported: the queue file has no depth cap, because a per-turn append cannot outrun a per-turn drain the way a multi-tenant server queue can. |
| **Verified** | `src/memory/queue.test.ts` (append/read/coalesce/clear, corrupt-line tolerance); end-to-end hook → `queue-read` → gate → `apply` → `queue-clear` exercised against the built `dist/`. |

### 2. Middleware-mode passive capture → Stop-hook queue — **relocated**

| | |
|---|---|
| **Original** | `MemoryMiddleware` (lead slot 23). `aafter_agent` filters the conversation to user inputs plus the final AI response (`filter_messages_for_memory` → `filter_trivial` → require ≥1 human and ≥1 AI → `detect_signals`) and enqueues it. `memory.mode: tool` is the alternative, registering `memory_search/add/update/delete`. [memory_middleware.py; deer_mem.py:202-293; tools.py:31-250] |
| **Port** | A `Stop` hook performs the capture. The filter reduces to "last user message + last assistant response, both non-empty" — the ≥1-human/≥1-AI admission rule is preserved; the trivial-acknowledgment filter and the signal-detection patterns (`core/message_patterns/*.yaml`) are **not** ported. Tool mode is not ported at all. |
| **Why** | There is no per-model-call middleware insertion point in Claude Code; `Stop` is the end-of-turn boundary. Signal detection existed to prioritize admission under queue backpressure — with no depth cap (entry 1) it has nothing left to arbitrate. Tool mode would add a second, model-directed write path that bypasses the deterministic gate this milestone exists to build (upstream itself notes tool mode "deliberately bypasses the staleness guardrails"). |
| **Blast radius** | Pure-acknowledgment turns ("thanks", "ok") do reach the queue, so the model sees a little more noise at extraction time. The deterministic write gate rejects them anyway — no such turn yields a `user`+`durable`+`descriptive` fact — so the cost is tokens, not memory pollution. |
| **Verified** | `src/memory/queue.test.ts::extractTurn` (last-of-each selection, tool_result records excluded, both-required rule, corrupt lines). |

### 3. FTS5/BM25 retrieval index → omitted — **intentionally omitted**

| | |
|---|---|
| **Original** | `core/retrieval.py` — a persistent SQLite FTS5 index with BM25 ranking, optional jieba Chinese tokenization, time-decay plus confidence weighting (`_CONFIDENCE_WEIGHT = 0.2`), category filters, per-scope isolation, lazy rebuild, and Gateway warm-up (`warm_retrieval`). `retrieval_adapter` defaults to `"fts5"`. `DeerMem.search` falls back to case-insensitive substring over canonical facts sorted by confidence whenever the adapter fails. [deer_mem.py:325-424; core/retrieval.py:1-68] |
| **Port** | No index. Recall is the substring fallback plus the model reading `store-cli.js list`. |
| **Why** | Three reasons, in order of weight. (1) **Scale**: `max_facts` is 100 and the port enforces it; BM25 over ≤100 short documents buys nothing a linear scan does not. (2) **It is already optional upstream** — substring is DeerMem's always-available path, kept precisely so "retrieval errors never make canonical memory unavailable", so omitting the adapter lands the port on a code path upstream itself guarantees. (3) **Cost**: a derived SQLite database, its rebuild lifecycle, warm-up scheduling, corruption recovery and connection teardown are a large amount of infrastructure for a set that fits in one prompt. `notes/skills-and-memory.md` §6 lists this under "What to drop" for exactly these reasons. |
| **Blast radius** | No ranked search API, no time decay, no category-filtered query, no Chinese tokenization. Fact *injection* is unaffected — it never used the index, only confidence ranking within the token budget. The loss becomes real only if `max_facts` is raised far above 100, at which point the index should be reconsidered rather than the scan tuned. |
| **Verified** | Documented absence, not a test. `src/memory/store.test.ts` pins the `listFacts` walk that replaces it. |

### 4. Locks, revisions, journal, v1→v2 migration → single-writer assumption — **intentionally omitted**

| | |
|---|---|
| **Original** | Per-scope cross-process advisory file locks (`file_lock_timeout_seconds`, default 10), a shared manifest revision plus per-fact revisions under optimistic CAS, typed conflict exceptions (`MemoryManifestRevisionConflict` / `MemoryFactRevisionConflict`), a recoverable target-file journal, and a one-way v1→v2 migration that durably writes `{manifest}.v1.bak` before any destructive write. [core/storage.py:42-60, 126-150] |
| **Port** | Never-torn writes are preserved exactly (temp file → fsync → `rename(2)` → parent-dir fsync). The lock, dual-revision CAS, journal and migration are dropped. `memory.json` keeps a monotonic `revision` field because it is part of the documented on-disk shape, but it is not a CAS token — the state library's own `rev` envelope already provides compare-and-set for that file. |
| **Why** | Claude Code sessions are effectively single-writer per project; there is no multi-worker Gateway contending for one user bucket. `notes/skills-and-memory.md` §6 puts this under "What to drop". There is no v1 data to migrate — the port has never written a v1 layout. |
| **Blast radius** | Two concurrent Claude Code sessions writing the same project's memory can lose one side's fact write (last rename wins). No corruption is possible — each file is still all-or-nothing — but a lost update is. Revisit if the port ever grows a shared or remote memory root. |
| **Verified** | `src/memory/store.test.ts` §atomicity (no temp files left behind; a planted half-written temp file never becomes visible; replace-in-place never appends). |

### 5. Fact Markdown omits the `# title` heading — **intentionally omitted**

| | |
|---|---|
| **Original** | `_render_fact_markdown` writes `---\n{front matter}\n---\n\n# {title}\n\n{content}\n`, where `title` is an explicit field or the first content line truncated to 160 characters. [core/storage.py:269-285] |
| **Port** | The heading is omitted: the Markdown body **is** the atomic fact text. |
| **Why** | Upstream derives the heading from the content purely for human browsing and re-derives it on every parse — it carries no information the content does not. Dropping it makes write→read round-trip byte-exact. |
| **Blast radius** | A fact file rendered by the port is not byte-identical to one rendered by DeerFlow, so the two stores are not interchangeable without a trivial transform. Nothing in the port's read path or injection format depends on the heading. |
| **Verified** | `src/memory/store.test.ts` §fact markdown round-trip (every field, multi-line/unicode/CJK bodies). |

### 6. Token counting is always the char estimate, never tiktoken — **degraded**

| | |
|---|---|
| **Original** | `memory.token_counting` defaults to `tiktoken` (accurate, but may block on a BPE download in network-restricted environments — issues #3402/#3429), with failed loads cached for a 600 s cooldown and falling back to the CJK-aware character estimate. `char` is a supported first-class mode. [core/prompt.py:202-309; config.py:87-105] |
| **Port** | Always the CJK-aware character estimate, ported exactly: `floor((codepoints − cjk) / 4) + floor(cjk / 2)`. |
| **Why** | tiktoken is a Python BPE library with no dependency-free TypeScript counterpart, and the port's `package.json` deliberately carries only `typescript` + `vitest`. Upstream already ships this exact mode. |
| **Blast radius** | The budget is slightly conservative for English/code and slightly generous for some scripts, relative to real BPE. One second-order effect: because the budget is enforced against the **sum of per-line** estimates and the estimator floors twice per call, the estimate of the concatenated block can exceed the budget by at most `2 × (lines − 1)` — a couple of tokens on a 2000-token budget. Upstream has the identical property in `char` mode. |
| **Verified** | `src/memory/injection.test.ts` pins the formula against an independent reimplementation, the per-line budget invariant, and the `2 × (lines − 1)` bound. |

---

## M7 — deterministic middleware hooks (loop detection, tool meta, read-before-write, turn context)

### 1. Loop enforcement moves from `after_model` to a PreToolUse deny — **relocated**

| | |
|---|---|
| **Original** | `LoopDetectionMiddleware._apply` runs in `after_model`, i.e. after the model has emitted its tool calls. A hard stop **rewrites that AIMessage**: `tool_calls=[]`, raw `tool_calls`/`function_call` stripped from `additional_kwargs`, `finish_reason` `"tool_calls"→"stop"`, and the `[FORCED STOP]` text appended to the content. Nothing raises; the agent is simply left with no calls to make and must answer from what it has. `_stop_reason[run_id] = "loop_capped"` is exposed through `consume_stop_reason`. [loop_detection_middleware.py:544-609] |
| **Port** | `src/hooks/loop-guard.ts` runs at **PreToolUse** and returns `permissionDecision: "deny"` with the same verbatim `[FORCED STOP]` text. A hook cannot rewrite an assistant message, so the call is refused instead of erased; the model reads the refusal and terminates on its own. `loop_capped` is written to `.deerflow/state/<thread>/loop-detection.json` and, best-effort, to `run-meta.json`. |
| **Blast radius** | The model sees a denial *result* where the original saw its own message silently shortened. It may narrate the denial. Termination is no longer guaranteed by construction — it depends on the model reacting to repeated refusals — but every further matching call is denied, so the loop cannot make progress either way. |
| **Verified** | `src/hooks/loop-guard.test.ts` (allow ×2, warn at 3, allow at 4, deny at 5 and 6, `loop_capped` in both state files); live process smoke: five identical `Grep` payloads piped into the built hook produced exactly that sequence. The detector itself is exact — `src/middleware/loop-detection.test.ts` replays all 99 baseline steps. |

### 2. Detection is stepped per tool call, not per model response — **degraded (more sensitive)**

| | |
|---|---|
| **Original** | `_hash_tool_calls` hashes a whole response's tool-call set as one order-independent multiset, and the window advances once per response. Five identical *responses* trip the hard limit. |
| **Port** | PreToolUse fires once per call and cannot see its siblings, so the machine is stepped once per call. A repeated single call is identical to the original. A repeated **batch** of N identical calls appends N hashes per response and trips at roughly `5/N` responses instead of 5. |
| **Why it is the safe direction** | It fires sooner, never later; the guard cannot miss a loop it would previously have caught. The alternative — buffering calls to reconstruct a response boundary — has no reliable signal in the hook payload and would delay enforcement past the calls it is meant to stop. |
| **Blast radius** | A model that legitimately issues the *same* call several times inside one response reaches the warning faster. Distinct calls are unaffected (different hashes), which is the overwhelmingly common parallel-dispatch shape. |
| **Verified** | `src/middleware/loop-detection.test.ts` pins the per-step semantics against the baseline; `src/hooks/loop-guard.test.ts` pins the per-call walk. |

### 3. Warnings are context, not a queued `HumanMessage`; the hook never emits `allow` — **relocated**

| | |
|---|---|
| **Original** | A warning is queued and injected at the **next** model call as a trailing `HumanMessage(name="loop_warning")` — deferred precisely to keep `assistant tool_calls → tool_messages` pairing valid for OpenAI/Moonshot and to avoid Anthropic's mid-stream `SystemMessage` restriction. Deduped, capped at 4 per (thread, run), dropped at `after_agent`. [module docstring 18-38; 396-406, 672-713] |
| **Port** | The warning is emitted at the call itself as `hookSpecificOutput.additionalContext` **plus** a top-level `systemMessage`. No deferral is needed (a hook does not assemble the request), so the whole pending-warning queue — cap, dedupe, per-run scoping, `before_agent`/`after_agent` clearing — is dropped as machinery with nothing left to solve. Warn-once-per-hash semantics, which are the *behaviour*, are kept in the state file. |
| **Deliberate refusal** | On the warn path the hook emits **no `permissionDecision` at all**. Writing `permissionDecision: "allow"` would not merely permit the call — it bypasses the user's own permission rules for it. Where the original only queued text, the port refuses to escalate: it abstains from the decision and the normal permission flow runs untouched. |
| **Blast radius** | Two carriers instead of one, and one turn earlier. `parity-test-plan.md` S10 already sanctions "hook systemMessage/additionalContext rather than a `loop_warning` HumanMessage". |
| **Verified** | `src/middleware/hook-runtime.test.ts` ("NEVER emits permissionDecision \"allow\""); `src/hooks/loop-guard.test.ts`. |

### 4. Claude Code tool calls are translated into DeerFlow tool calls before hashing — **relocated (required)**

| | |
|---|---|
| **Original** | The key rules are keyed on DeerFlow tool names and argument names: `read_file`/`path`/`start_line`/`end_line`, `write_file`/`content`, `str_replace`/`old_str`/`new_str`, and the salient set `path, url, query, command, pattern, glob, cmd`. |
| **Port** | `src/middleware/tool-adapter.ts` maps `Read→read_file` (`file_path`→`path`, `offset`/`limit`→`start_line`/`end_line = offset+limit-1`), `Write→write_file`, `Edit→str_replace`, `Bash→bash`, `Grep→grep`, `Glob→glob`, `WebFetch→web_fetch`, `WebSearch→web_search`; MCP tools pass through under their own names. |
| **Why it is not optional** | Without it every rule silently disables itself: `Read` is not `read_file` so ranged reads stop bucketing, and `file_path` is not a salient field so the key falls back to full args and two reads of one file look unrelated. The failure would be invisible — no error, just a guard that never fires. |
| **Blast radius** | The `offset+limit-1` conversion is an interpretation: DeerFlow's `read_file` took an inclusive range, Claude Code's `Read` takes a start plus a count. Off-by-one at a 200-line bucket edge is possible and harmless (it changes which bucket a read lands in, never whether the detector works). |
| **Verified** | `src/middleware/tool-adapter.test.ts` asserts the mapping as **hash outcomes** (same-bucket reads collide, far reads do not, same-path different-content writes do not collide, non-salient Grep args are ignored). |

### 5. The `deerflow_tool_meta` taxonomy becomes model-visible — **relocated**

| | |
|---|---|
| **Original** | `normalize_tool_message` stamps the meta into `additional_kwargs["deerflow_tool_meta"]`. It is **invisible to the model**: its consumers are ToolProgressMiddleware's state machine and the subagent status contract. |
| **Port** | `src/hooks/post-tool-meta.ts` emits the same five fields as JSON inside a `<deerflow_tool_meta tool="…">` fence in `additionalContext`, followed by one line of guidance for the `recommended_next_action`. The classification is byte-exact against all 38 + 4 baseline vectors; the **envelope and the guidance sentences are port-authored**, because there is no original wording to be verbatim about. |
| **Why** | The port has no message-metadata channel, and in M7 no ToolProgress state machine either. The only consumer that exists is the model, so an enum it cannot read is worth nothing. |
| **Blast radius** | The model now reads framework classification text after a failed tool call — new input the original never produced. Bounded by emitting **only** on `error`/`partial_success` (success is silent), so a clean session pays nothing. |
| **Verified** | `src/middleware/tool-meta.test.ts` (42/42 baseline vectors exact); `src/hooks/post-tool-meta.test.ts` (envelope, guidance, silence on success). |

### 6. Tool-output externalization is platform-native; only a soft warning survives — **intentionally omitted**

| | |
|---|---|
| **Original** | `ToolOutputBudgetMiddleware` externalizes results ≥12k chars to a file with a typed synopsis, falling back to head/tail truncation at 30k. |
| **Port** | Not re-implemented. Claude Code already truncates and externalizes large tool outputs itself, and a hook that wrote a second copy to `outputs/.tool-results/` would fight the platform for the same job while doubling the bytes on disk. What M7 keeps is the *signal*: `post-tool-meta.ts` appends one line when a result exceeds 20,000 characters, telling the model to narrow the next call instead of re-issuing it. |
| **Blast radius** | The synopsis format and the exact 12k/30k thresholds are not reproduced; the row for `tool_output_budget_middleware.py` stays `planned` for whoever wants byte parity. The behaviour that mattered — an oversized result does not silently consume the context — is native plus this note. |
| **Verified** | `src/hooks/post-tool-meta.test.ts` (warns above the budget, silent exactly at it, combines with a classification). |

### 7. Read marks move from the message list to a state file — **degraded**

| | |
|---|---|
| **Original** | The sha256 mark lives on the `read_file` ToolMessage's `additional_kwargs` and the gate scans `state["messages"]` in reverse. This gives a property the file cannot: "summarization deleting the read result deletes the mark with it — the gate can never pass while the read content is gone from context." [read_before_write_middleware.py:12-16] |
| **Port** | Marks live in `.deerflow/state/<thread>/read-marks.json`, because a hook cannot write to the transcript. A mark therefore **outlives** the Read result in context: after a compaction the gate may pass on a file the model can no longer see. |
| **Why it is acceptable** | The hash still proves the file has not CHANGED since it was read, which is the property #3857 was filed for — the bug was an append loop (five copies of one section written after a single read), not a forgotten read. And Claude Code's own native rule ("you must Read the file in this conversation before editing") independently covers the in-context half, so the two enforcements together are strictly stronger than either. |
| **Additional deltas** | (a) the per-`(scope, path)` `threading.Lock` that serialized gate-check with execution is gone — hooks are separate processes; the residual race resolves toward *denying* (a mark for content the model was not shown fails to match). (b) the mark list needs its own bound, since it is no longer bounded by the message window: 200 paths, oldest-first eviction, which can only ever cause an extra re-read. |
| **Verified** | `src/middleware/read-marks.test.ts` (newest-mark-must-match, writes-never-refresh, creation allows, fail-open, normalization, cap eviction); `src/hooks/write-gate.test.ts` (the full Read→Edit→write→deny→Read→allow handshake). |

### 8. The block message names `Read`, not `read_file` — **relocated**

| | |
|---|---|
| **Original** | `_BLOCK_MESSAGE` ends "Call read_file on it (a ranged read of the relevant section is enough…)". |
| **Port** | The hook passes `"Read"`, producing "Call Read on it (…)". Everything else in the message, including the leading `"Error: "` and the em-dash, is verbatim. |
| **Why** | Instructing a Claude Code model to call `read_file` names a tool that does not exist. This is exactly the DeerFlow-name → native-name substitution the port already whitelists for the lead prompt in M3 (`src/prompts/substitutions.ts`). `blockMessage()` still **defaults** to `read_file`, so the module remains verbatim-capable for any consumer that wants the original string. |
| **Blast radius** | One token in one model-facing sentence. |
| **Verified** | `src/hooks/write-gate.test.ts` ("names the NATIVE read tool in the deny message, not read_file"). |

### 9. The read-before-write hook duplicates a native rule, against the port plan's own judgment — **declared decision**

| | |
|---|---|
| **The conflict** | `docs/claude-code-port/middleware-port-plan.md` §12 concludes: "A PreToolUse hash-check hook could tighten freshness further but would **duplicate native behavior — not planned**." The traceability-matrix row for the same middleware plans the opposite: "pre-tool-guard hook + native Read-before-Write … double enforcement acceptable, fail-open kept." |
| **What M7 did** | Followed the matrix and built the hook, with an escape hatch (`DEERFLOW_DISABLE_READ_GATE=1`) so a deployment that agrees with the port plan can turn it off without a code change. |
| **The deciding argument** | The two rules test different things. Native: *was this file read in this conversation.* Ported: *does the newest read mark equal the file's current sha256.* Only the second detects that the file MOVED between two writes, which is the failure #3857 describes. The hook can only ever refuse a subset of what a blind write would be, so composing them costs nothing but a denied call the native rule would also have wanted to deny. |
| **Blast radius** | An extra denial path on `Write`/`Edit`. Fail-open on every uncertainty (missing file, unreadable file, no thread id, unreadable mark store). |
| **Verified** | `src/hooks/write-gate.test.ts`, including the escape hatch disabling both halves together. |

### 10. Turn context is injected every turn, not once per conversation — **degraded**

| | |
|---|---|
| **Original** | `DynamicContextMiddleware._inject` injects the reminder **once**, into the first genuine `HumanMessage`, via the ID-swap triplet, and then never again — "the first message is then frozen for the whole session, so the prefix cache can hit on every subsequent turn". It re-injects only when `_last_injected_date` differs from today (midnight crossing). |
| **Port** | `src/hooks/turn-context.ts` emits the date reminder (and the durable projection when state exists) on **every** `UserPromptSubmit`. A hook has no way to read what a previous turn injected — `additionalContext` does not persist into a place the next invocation can inspect. |
| **Blast radius** | Repeated tokens each turn, and the prefix-cache argument that motivated the freeze does not apply here (the port does not assemble the request). In exchange, the midnight crossing is handled for free and post-compaction context loss — the entire reason the durable projection exists — is repaired every turn instead of once. |
| **Also different** | The ID-swap triplet is impossible: the date arrives as user-turn context rather than a `SystemMessage`, i.e. without system-role authority (this is the same carrier change M8 recorded for the durable projection, §M8 entry 6, and the untrusted half stays fenced and escaped inside `<durable_context_data>`). The `context:memory` run-journal record is not produced. |
| **Verified** | `src/hooks/turn-context.test.ts` (verbatim reminder format, date-only with no state, projection appended once state exists, date still injected when the state tree is unreadable). |

### 11. The delegation ledger is committed by a CLI, not by the graph write — **relocated**

| | |
|---|---|
| **Original** | `delegation_ledger.py` DERIVES the ledger from message history inside the graph's own state write: a `task` tool call becomes `in_progress`, the paired ToolMessage upgrades it to terminal. |
| **Port** | `workflows/deep-run.js` emits ledger-shaped entries with `created_at: null` and `result_sha256: null` (a workflow script has no clock and no hash function), and `src/deeprun/ledger-cli.ts` — piped the workflow's JSON result — validates them, stamps both fields, and commits them through the same `mergeDelegations` reducer under atomic-write + `rev` CAS. |
| **Blast radius** | **The commit is a separate, skippable step.** A deep run whose result is never piped into the CLI leaves no ledger entry, and the next turn sees a run that appears never to have delegated. Mitigated by an explicit instruction in `skills/run/SKILL.md` ("After a deep-run completes"), by the CLI being idempotent (re-running keeps the first-seen `created_at` and adds no duplicates), and by it exiting 1 without writing on invalid input. |
| **Also different** | The CLI reflects a run-level `stop_reason` onto `run-meta.json` but never changes the run's STATUS: a deep run is one delegation batch inside a lead run, and marking it `completed` would trip the terminal guard on the lead's own finalize. |
| **Verified** | `src/deeprun/ledger-cli.test.ts` (13 tests: digest of the full result rather than the bounded brief, idempotence, run-id mismatch left alone, no run record still persists, validation reports every bad entry at once); live: a deep-run result piped into the built CLI wrote the ledger and printed one summary line, and a malformed one exited 1 having written nothing. |

### 12. ToolProgressMiddleware is deferred, not omitted — **declared absence**

| | |
|---|---|
| **Original** | `ToolProgressMiddleware` (lead slot 13) runs a per-`(thread, tool)` stagnation state machine: 3 consecutive problems → WARNED + `[PROGRESS HINT]`, +2 more → BLOCKED when not model-recoverable, auth/config/internal `stop` classes → BLOCKED immediately, Jaccard ≥0.8 near-duplicates count as problems. `tool_progress.enabled` defaults **False**. |
| **Port** | Not implemented in M7. |
| **Honest status** | This is a **deferral, not an omission.** `middleware-port-plan.md` §13 rates deterministic parity as *possible* ("all classification is rule-based; delivery differs") and merely low priority because the feature ships off. The baseline skipped its vectors (G2) for a different reason — driving it needs a live tool handler and a real `Runtime`. Its one hard dependency, the `deerflow_tool_meta` taxonomy, now exists in `src/middleware/tool-meta.ts`, so a later milestone inherits the classifier and needs only the state machine and the two hook branches. |
| **Blast radius** | None against the original's defaults: a stock DeerFlow deployment does not run this middleware either. A deployment that enabled it loses per-tool stagnation blocking; the loop detector still catches identical-call and per-tool-frequency loops. |
| **Verified** | Declared absence, recorded in the traceability matrix row as `deferred (not in M7)`. |

---

## M13 — artifacts & workspace changes

### 1. Unified diffs are not produced — only the summary and the receipt — **intentionally omitted**

| | |
|---|---|
| **Original** | `compare_snapshots` builds a `difflib.unified_diff` per changed file, counts `additions`/`deletions`, spills text to a cache dir, and drops a diff that exceeds the aggregate budget with reason `truncated`. The payload rides one `workspace_changes` event that the Gateway renders in the UI [diff.py:17-100, 162-197; scanner.py:198-217; recorder.py:126-160]. |
| **Port** | `src/artifacts/snapshot.ts` snapshots **metadata only** and `diffSnapshots` reports `created` / `modified` / `deleted` with before/after size and sha256. No file content is read into memory, no text cache dir is created, no unified diff and no `+A -B` line counters exist. `src/artifacts/workspace-changes.ts` records the summary and the path lists. |
| **Why** | **There is no UI to render a diff.** The original's diffs existed for one consumer — the Gateway's "what changed" panel, fed by `get_workspace_changes_response(include_diff=...)`. The port has no panel and no event store; a hook would be computing, caching and persisting per-turn unified diffs that nothing ever displays, at real cost on the critical path of every turn. The model, meanwhile, already has `Read` and `git diff`. |
| **What is kept** | Every metadata invariant that carries correctness, byte-for-byte: the four limits (200 / 2000 / 256 KiB / 1 MiB, `types.py:18-27`), `_same_file` (sha256 when both sides have one, else size+mtime), the sensitive-path rule (**never hashed** — a sha256 of a secret is a fingerprint of it), the >256 KiB rule (no hash, reason `large`), the never-follow-a-symlink rule (`lstat` + `readlink` only), the binary sample test, the excluded-directory set, and `get_changed_output_paths`'s exact contract (created/modified, regular files, outputs root only). `content_unavailable_reason` survives on every entry, recording *why* content would have been unavailable upstream. |
| **Also different** | (a) `max_total_diff_bytes = 1 MiB` is carried as a declared constant but is **inert** — there is no diff budget to spend. (b) The original's fourth status `symlink_created` is collapsed into `created`/`modified`; it existed to stop a symlink replacing a regular file being reported `deleted` (diff.py:130-136), which the port's two-sided classification cannot produce anyway. The `symlink` flag survives on every change. (c) `mtime_ns` becomes `mtimeMs` (Node's portable stat field), so a sub-millisecond edit to a file too large to hash can read as unchanged; every file ≤ 256 KiB is compared by sha256 instead. |
| **Blast radius** | A user who wants line-level detail runs `git diff`. Nothing in the delivery verdict, the change record, or the receipt depends on diff text. |
| **Verified** | `src/artifacts/snapshot.test.ts` (29 tests: limits pinned against the Python defaults, sensitive/large/binary/symlink metadata-only rules, the size+mtime fallback proven on a same-size sensitive edit, `maxFiles`/`maxScannedFiles` truncation, `changedOutputPaths` exclusions). |

### 2. Snapshots are turn-level, not run-level — **degraded**

| | |
|---|---|
| **Original** | One snapshot per RUN: `capture_workspace_snapshot` is called once in the worker preamble [worker.py:673-681], held in memory for the run's lifetime, and consumed once at the end by `record_workspace_changes` + the delivery verdict [worker.py:1044-1060]. One run produces exactly one `workspace_changes` event. |
| **Port** | One snapshot per TURN: `src/hooks/turn-snapshot.ts` fires on `UserPromptSubmit` and writes `.deerflow/state/<thread>/workspace-pre.json`; `src/hooks/delivery-gate.ts` fires on `Stop` and consumes it. A multi-turn run therefore produces several records instead of one. |
| **Why** | **A Claude Code session has no run boundary a hook can observe.** There is no event that means "the run is starting" (`SessionStart` fires per session, which is coarser than a run and does not repeat) and none that means "the run is ending" (`Stop` fires per turn). Turn granularity is the finest boundary the platform exposes and the only one both hooks can agree on. |
| **Consequences** | (a) The baseline must be durable rather than in-memory, because two hooks are two processes — hence the extra state channel, written atomically. (b) The change history needs its own bound the original did not need: 20 entries, oldest-first eviction, plus 50 paths per bucket per entry. (c) A file created in turn 1 and modified in turn 3 appears in two records rather than being merged into one. (d) The walk is depth-capped (`FAST_WORKSPACE_MAX_DEPTH = 2` on the project tree; `outputs/` always in full) because it now runs on the critical path of every prompt rather than once per run — a file created more than three levels deep outside `outputs/` is not tracked. |
| **Blast radius** | More, smaller records; the delivery verdict is *stricter* if anything, since it is evaluated at every turn boundary instead of once at the end. |
| **Verified** | `src/hooks/turn-snapshot.test.ts` (baseline round-trip, replacement per turn, the state tree never snapshotting itself); `src/artifacts/snapshot.test.ts` (`outputs/` walked to any depth while the project tree stops at the cap). |

### 3. Delivery enforcement blocks the turn instead of failing the run — **relocated**

| | |
|---|---|
| **Original** | The worker computes `produced_output_paths` from the workspace diff, checks them against the paths the journal attributes to `present_files`, and on a miss sets the run's terminal status to `error` with `_DELIVERY_INCOMPLETE_ERROR = "Artifact delivery incomplete: no produced output artifact was presented"` [worker.py:934-986, 163-165]. The receipt is persisted *before* the status, with bounded retries [worker.py:1044-1113]. |
| **Port** | `src/hooks/delivery-gate.ts` computes the same produced set and emits `{"decision":"block", "reason": …}` carrying the verbatim error string plus the unpresented paths. The receipt is written into `run-meta.json`. |
| **Why the lever changed** | A hook cannot fail a run — the port has no run terminalization at turn boundaries, and marking the run `error` would collide with the M11 goal loop, which may legitimately continue the same run. Blocking is strictly more useful anyway: the original told the *operator* the run failed after the fact, whereas the block hands the *model* the missing paths while it can still present them. `recordDeliveryReceipt` deliberately re-asserts the run's CURRENT status so it can never terminalize a live run nor downgrade a terminal one. |
| **Receipt ordering** | The original's receipt-before-status ordering has no counterpart because it has no purpose here: `run-meta.json` holds the receipt and the status in **one atomic rename**, so the crash window the ordering existed to close does not exist (the same argument `src/state/run-meta.ts` already makes for guarantee G6). Put-if-absent semantics are inherited from `transitionRunMeta`. |
| **Also different** | (a) The receipt is written only on the FINAL word — a satisfied verdict, or an unsatisfied one that can no longer be acted on — because put-if-absent would otherwise freeze an unsatisfied verdict that the very next turn fixes. (b) **`stop_hook_active` suppresses the block unconditionally**, so at most one block per stop chain. If `stop-goal-evaluator.js` blocked first, this hook cannot block for the rest of that chain; the verdict is still recorded into `run-meta.json` as evidence, just not enforced. That is the price of never being able to wedge a session, and it is the right trade: a Stop hook that can block twice is a hazard, an unenforced-but-recorded verdict is not. (c) No block is ever issued without a baseline (a missing `workspace-pre.json` stands the hook down), so the gate can never fire on the whole project tree. |
| **Blast radius** | One extra block path at the end of a turn that wrote to `outputs/`. Silent for every turn that did not. |
| **Verified** | `src/hooks/delivery-gate.test.ts` (20 tests: block text and missing-path list, no block outside `outputs/`, no block on deletions, no block without a baseline, double-block prevention, receipt written only on the final word, status never changed); `src/artifacts/delivery.test.ts` (28 tests including the put-if-absent and terminal-status cases). |

### 4. "Presented" is read from the final message, not from a `present_files` call — **relocated**

| | |
|---|---|
| **Original** | `present_files` is a real tool: it validates that each path lies under `/mnt/user-data/outputs`, appends it to the `artifacts` state channel, and the journal attributes those paths to the run. The presented set is therefore an **exact, structured** fact. |
| **Port** | `extractPresentedPaths` scans the final assistant message for path-like tokens (anything containing `/`, plus bare filenames with a plausible 2-8 character extension containing at least one letter), and `coversProducedPath` matches them against the produced set by exact path, by basename, or by absolute-path suffix — both directions of `/`-boundary suffix containment. |
| **Why** | `sandbox-contract.md` §3 consequence 3 already recorded it: the port has no interception point for `present_files`, and the model's own final message is the only place the delivery is observable. This is the same substitution the contract made for the tool itself — "the listing IS the delivery". |
| **Direction of error** | Deliberately permissive. A false positive **credits** a delivery that was sloppily worded; a false negative **blocks a turn that did the right thing**, which is the failure mode that would make the gate intolerable. Prose is still kept out (`e.g.`, `v1.20`, `3.5` do not qualify), and a near-miss basename (`other-report.md` for `outputs/report.md`) does not match. |
| **Also different** | The original's outputs-only path validation has no counterpart (unchanged from M5, `sandbox-contract.md` §3 consequence 3): nothing rejects a `present`-style mention of a path outside `outputs/`, it simply matches nothing. |
| **Blast radius** | A determined model could satisfy the gate by naming the file without really presenting it — the same residual the prompt-policy version had, now with a verification stage in front of it. |
| **Verified** | `src/artifacts/delivery.test.ts` (extraction of relative/absolute/backticked/Windows-separator paths, prose rejection, basename matching, near-miss refusal, the full satisfied/partial/missing verdict matrix). |
