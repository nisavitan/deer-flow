# Hook registration requests

`hooks/hooks.json` has a single owner. Lanes that build a hook do **not** edit it — they append
a request here, and the owning lane applies it. Each request states the event, matcher, command,
ordering constraint, and failure mode, so applying it is mechanical.

Format: one `## <milestone> — <hook name>` section per request, newest last. Mark a request
`applied` (with the commit) once it lands in `hooks.json`.

---

## M8 — PreCompact durable summary digest

**Status:** requested (not applied)

**Requested entry** (add alongside the existing `PreToolUse` block, do not replace it):

```json
"PreCompact": [
  {
    "matcher": "*",
    "hooks": [
      {
        "type": "command",
        "command": "node ${CLAUDE_PLUGIN_ROOT}/dist/hooks/precompact-summary.js"
      }
    ]
  }
]
```

- **Event:** `PreCompact` — fires before both automatic and manual compaction, carrying
  `session_id`, `transcript_path`, and `trigger` on stdin.
- **Matcher:** `*` — the digest must be written for `auto` and `manual` alike; the payload's
  `trigger` value is recorded in `summary.json`, it does not gate the hook.
- **Ordering:** none required. The hook only reads `.deerflow/state/<thread>/` and writes
  `summary.json`; it shares no file with any other registered hook and can run in any position.
- **Failure mode:** exits 0 unconditionally, emits no stdout protocol, and writes diagnostics to
  stderr only. A malformed payload, an unresolvable thread id, or an unwritable state directory
  results in no digest, never a blocked or delayed compaction.
- **Model calls:** none. Pinned by `src/hooks/precompact-summary.test.ts`
  ("contains no model, network, or process-spawn call").
- **Build dependency:** `npm run build` must emit `dist/hooks/precompact-summary.js` before this
  entry is registered.
- **Thread resolution:** `DEERFLOW_THREAD_ID` when exported, else the `session_id` from the
  payload (the port's thread id *is* the first session id — `state-checkpoint-resume.md` §2.1).

**Rationale:** this is the port's only control point at the compaction boundary and the
replacement for `DeerFlowSummarizationMiddleware.before_model`'s durable write. See
`docs/claude-code-port/summarization-delta.md` rows 1 and 4.

---

## M9 — Stop memory capture

**Status:** requested (not applied)

**Requested entry** (add alongside the existing blocks, do not replace them):

```json
"Stop": [
  {
    "matcher": "",
    "hooks": [
      {
        "type": "command",
        "command": "node ${CLAUDE_PLUGIN_ROOT}/dist/hooks/memory-extract.js"
      }
    ]
  }
]
```

- **Event:** `Stop` — fires at the end of a turn, carrying `session_id`, `transcript_path`, and
  `stop_hook_active` on stdin. This is the port's analog of `MemoryMiddleware.aafter_agent`.
- **Matcher:** `""` — a `Stop` hook has no tool to match on; the empty string means every Stop.
- **Ordering:** none required. The hook only reads the transcript path given to it and appends to
  `.deerflow/memory/queue.jsonl`; it shares no file with any other registered hook.
- **Failure mode:** exits 0 unconditionally and writes nothing to stdout — a `Stop` hook that
  emits output or a non-zero status can interrupt the session. A malformed payload, a missing or
  unreadable transcript, a turn with no user/assistant pair, or any internal fault results in no
  queue entry, never a blocked turn. Captured messages are capped at 20,000 characters each.
- **Model calls:** none. The hook only appends; extraction happens on the next `/deerflow:run`
  turn or on an explicit `/deerflow:memory update`.
- **Build dependency:** `npm run build` must emit `dist/hooks/memory-extract.js` before this
  entry is registered.

**Not requested — `SubagentStop`:** upstream deliberately omits `MemoryMiddleware` from the
subagent chain and passes `skip_memory_flush=True`, because subagents share the parent's
`thread_id` and their internal turns would otherwise pollute the parent's durable memory
(`summarization_middleware.py:695-701`). Registering this hook on `SubagentStop` would reintroduce
exactly that bug.

**Rationale:** replaces DeerFlow's debounced background extraction queue, which has no home in
Claude Code (no long-lived server process to host a timer thread, and a hook must not block a turn
on an LLM call). The queue survives; the 30-second debounce becomes batch-on-next-turn. See
`parity/DISCREPANCIES.md` §M9.

---

## M10 — SessionStart orphan recovery

**Status:** requested (not applied)

**Requested entry** (add alongside the existing blocks, do not replace them):

```json
"SessionStart": [
  {
    "matcher": "startup|resume|clear",
    "hooks": [
      {
        "type": "command",
        "command": "node ${CLAUDE_PLUGIN_ROOT}/dist/hooks/session-recover.js"
      }
    ]
  }
]
```

- **Event:** `SessionStart` — fires when a session begins, carrying `session_id`, `cwd`, and
  `source` on stdin. This is the port's *startup*, and therefore the analog of `RunManager`
  reconciliation running at startup (`manager.py:1700-1784`).
- **Matcher:** `startup|resume|clear` — every way a session begins. `resume` matters most: a
  resumed session is exactly the case where an abandoned run from the previous process is still
  recorded non-terminal.
- **Ordering:** none required against other hooks. It is the only writer of `run-meta.json` at
  session start, and it writes through the atomic-write + `rev`-CAS state library, so a
  concurrent writer loses the race rather than tearing a file.
- **Failure mode:** exits 0 unconditionally. A malformed payload, an absent or unreadable state
  root, a failed recovery write, or a missing `git` binary all result in no context block and no
  recovery, never a blocked session start. Diagnostics go to stderr only.
- **Writes:** `run-meta.json` only, and only to terminalize a run the scan proved abandoned
  (`status: interrupted`, `stop_reason: orphan_recovered`, zero delivery receipt backfilled
  put-if-absent). It never touches goal, todos, delegations, artifacts, or summary.
- **Stdout protocol:** `hookSpecificOutput.additionalContext`, emitted **only** when a thread
  holds a live run or a set goal — at most 3 threads, one compact line each, plus a pointer to
  `/deerflow:status`. Silent otherwise, so a session with no DeerFlow state pays nothing.
- **Model calls:** none. Deterministic file work plus two `git rev-parse` calls with a 2 s
  timeout each.
- **Build dependency:** `npm run build` must emit `dist/hooks/session-recover.js` before this
  entry is registered.

**Abandonment rule:** a non-terminal run recorded by a session other than the current one, whose
`updated_at` is more than **2 hours** old (`ORPHAN_EXPIRY_MS` in `src/resume/recovery.ts`), is
terminalized. Fresher ones are reported as resume candidates and left untouched. This constant
replaces the original's heartbeat lease deadline — see `parity/DISCREPANCIES.md` §M10 entry 1.

**Rationale:** without this hook, a crashed run holds the thread's single active-run slot forever
(`ActiveRunExistsError` on every subsequent run) and a resumed session has no way to learn that
durable Layer-2 state exists at all, since native sessions do not carry the structured channels.
See `docs/claude-code-port/state-checkpoint-resume.md` §5.

---

## M11 — Stop goal-continuation evaluator

**Status:** requested (not applied)

**Requested entry** — this is a **second** `Stop` hook. Append it to the `hooks` array of the
`Stop` block requested by M9 (do not create a second `Stop` block, and do not replace
`memory-extract.js`):

```json
"Stop": [
  {
    "matcher": "",
    "hooks": [
      {
        "type": "command",
        "command": "node ${CLAUDE_PLUGIN_ROOT}/dist/hooks/memory-extract.js"
      },
      {
        "type": "command",
        "command": "node ${CLAUDE_PLUGIN_ROOT}/dist/hooks/stop-goal-evaluator.js"
      }
    ]
  }
]
```

- **Event:** `Stop` — fires at the end of a turn, carrying `session_id`, `transcript_path`, and
  `stop_hook_active` on stdin. This is the port's analog of the worker's post-turn goal
  continuation check (`worker.py:908-932`).
- **Matcher:** `""` — a `Stop` hook has no tool to match on; the empty string means every Stop.
- **Ordering:** **must be listed after `memory-extract.js`.** This hook is the only registered hook
  that can emit `{"decision":"block"}`; memory capture must be given its chance to append to the
  queue for the turn that is ending, before the turn is potentially extended. The two share no
  file (`goal.json` vs `memory/queue.jsonl`).
- **Failure mode:** exits 0 unconditionally. A malformed payload, an unresolvable thread id, an
  unreadable transcript, an absent `goal.json`, or any internal fault results in **no decision at
  all** — the turn ends normally. Diagnostics go to stderr only. It never emits a non-zero status.
- **Stdout protocol:** `{"decision":"block","reason":"<rubric + self-evaluation instruction>"}`,
  emitted **only** when the thread has an active goal AND every deterministic gate passes
  (continuation cap 8 not reached, no-progress breaker 2 not tripped, visible assistant evidence
  present). Silent in every other case, so a session with no goal pays nothing.
- **Writes:** `goal.json` only, through the atomic-write + `rev`-CAS state library. The updated
  goal (`continuation_count + 1`, or the recorded `stand_down_reason`) is persisted **before** the
  block is emitted — that write, not the model, is what bounds the loop at 8 continuations.
- **Model calls:** none. The evaluator model call has no counterpart in a hook; the verbatim
  rubric is handed to the session model in the block reason instead (see
  `parity/DISCREPANCIES.md` §M11 entry 1).
- **Build dependency:** `npm run build` must emit `dist/hooks/stop-goal-evaluator.js` before this
  entry is registered. The block reason also instructs the model to run
  `node dist/goal-loop/goal-cli.js`, so `dist/goal-loop/goal-cli.js` must be built too.
- **Thread resolution:** `DEERFLOW_THREAD_ID` when exported, else the `session_id` from the
  payload — identical to `precompact-summary.js`.

**Infinite-loop safety:** a Stop hook that blocks unconditionally wedges a session. Three
independent guards prevent that: (a) the durable continuation counter, written before the block and
hard-capped at `max_continuations` (≤ 8); (b) the no-progress breaker, which stands the loop down
after 2 consecutive turns whose latest visible assistant text is unchanged; (c)
`continuation_not_recorded` — if `stop_hook_active` is true while `continuation_count` is still 0,
the counter is not advancing (a failing write), so the hook stands down instead of blocking again.
Pinned by `src/goal-loop/stop-hook.test.ts` ("the loop terminates at the cap…", 50 iterations,
exactly 8 blocks).

---

## M7 — deterministic middleware hooks (five entries)

**Status:** requested (not applied)

Appended after M8-M11 because this file is ordered by *request time*, not by milestone number.
All five hooks below are independent of the requests above: they share no state file with
`precompact-summary.js`, `memory-extract.js`, `session-recover.js`, or `stop-goal-evaluator.js`,
and none of them can emit `{"decision":"block"}`.

**Requested entries** (add alongside the existing blocks; the `PreToolUse` array already holds the
M5 `Bash` env-guard block, which must be preserved):

```json
"PreToolUse": [
  {
    "matcher": "Bash|Edit|Write|Read|Glob|Grep|WebFetch|WebSearch|mcp__.*",
    "hooks": [
      {
        "type": "command",
        "command": "node ${CLAUDE_PLUGIN_ROOT}/dist/hooks/loop-guard.js"
      }
    ]
  },
  {
    "matcher": "Write|Edit",
    "hooks": [
      {
        "type": "command",
        "command": "node ${CLAUDE_PLUGIN_ROOT}/dist/hooks/write-gate.js"
      }
    ]
  }
],
"PostToolUse": [
  {
    "matcher": "Bash|Edit|Write|Read|Glob|Grep|WebFetch|WebSearch|mcp__.*",
    "hooks": [
      {
        "type": "command",
        "command": "node ${CLAUDE_PLUGIN_ROOT}/dist/hooks/post-tool-meta.js"
      }
    ]
  },
  {
    "matcher": "Read",
    "hooks": [
      {
        "type": "command",
        "command": "node ${CLAUDE_PLUGIN_ROOT}/dist/hooks/read-mark.js"
      }
    ]
  }
],
"UserPromptSubmit": [
  {
    "matcher": "*",
    "hooks": [
      {
        "type": "command",
        "command": "node ${CLAUDE_PLUGIN_ROOT}/dist/hooks/turn-context.js"
      }
    ]
  }
]
```

### 1. `PreToolUse` / `Bash|Edit|Write|Read|Glob|Grep|WebFetch|WebSearch|mcp__.*` → `loop-guard.js`

- **Ports:** `LoopDetectionMiddleware` (lead slot 29, `loop_detection.enabled` default True).
- **Matcher rationale:** the tools that perform *work*. The harness control surface
  (`Agent`/`Task`, `TaskCreate`, `AskUserQuestion`, `Skill`, `Workflow`) is deliberately excluded —
  denying one would break the port's own delegation machinery, and orchestration calls are not the
  repetitive work loops the detector exists to break. The hook re-applies the same filter internally
  (`isGuardedToolName`), so a looser matcher in `hooks.json` cannot widen its scope.
- **Ordering:** none required. Sole writer of `.deerflow/state/<thread>/loop-detection.json`.
- **Stdout protocol:** `permissionDecision: "deny"` carrying the verbatim `[FORCED STOP]` text at
  the hard limit; `additionalContext` + `systemMessage` carrying the verbatim `[LOOP DETECTED]`
  text at the warn threshold. **It never emits `permissionDecision: "allow"`** — allowing would
  bypass the user's own permission rules, so on the warn path the hook abstains from the decision
  entirely and the normal permission flow runs.
- **Writes:** `loop-detection.json` (always), and best-effort `run-meta.json`
  `stop_reason: loop_capped` on a hard stop. Both through the atomic-write + `rev`-CAS library.
- **Failure mode:** exits 0 unconditionally and fails **open** — an unwritable or contended state
  file, an unresolvable thread id, or any internal fault means no decision, never a blocked call.
- **Escape hatch:** `DEERFLOW_DISABLE_LOOP_GUARD=1`.
- **Build dependency:** `dist/hooks/loop-guard.js`.

### 2. `PreToolUse` / `Write|Edit` → `write-gate.js`

- **Ports:** the gate half of `ReadBeforeWriteMiddleware` (lead slot 12,
  `read_before_write.enabled` default True).
- **Matcher rationale:** exactly the two file-modifying tools, matching the original's
  `_GATED_WRITE_TOOLS = {write_file, str_replace}`.
- **Ordering:** none required against `loop-guard.js` — different state files, and either may deny
  first without changing the outcome (both refusals are correct on their own grounds).
- **Stdout protocol:** `permissionDecision: "deny"` with the ported `_BLOCK_MESSAGE`, or silence.
- **Writes:** none. Read-only over `read-marks.json`.
- **Failure mode:** exits 0 and fails **open** — a file that does not exist (creation), one that
  cannot be read, an unreadable mark store, or a payload with no `file_path` all allow the write.
- **Escape hatch:** `DEERFLOW_DISABLE_READ_GATE=1` (disables entry 4 as well; one flag governs both
  halves, as the single config toggle did).
- **Interaction with the platform:** Claude Code natively refuses to Edit/Write a file not Read in
  the conversation. This hook enforces the same invariant on different evidence (content hash vs
  conversation membership) and only ever refuses a subset of what a blind write would be, so the
  two compose without conflict.
- **Build dependency:** `dist/hooks/write-gate.js`.

### 3. `PostToolUse` / `Bash|Edit|Write|Read|Glob|Grep|WebFetch|WebSearch|mcp__.*` → `post-tool-meta.js`

- **Ports:** the `deerflow_tool_meta` taxonomy from `tool_result_meta.py` (lead slot 14).
- **Matcher rationale:** identical to entry 1, for the same reason.
- **Ordering:** none required. Writes nothing.
- **Stdout protocol:** `additionalContext` carrying the `deerflow_tool_meta` JSON plus the
  `recommended_next_action` guidance — emitted **only** for an `error`/`partial_success`
  classification or a result above the 20,000-character budget. Silent on the happy path, so a
  clean session pays nothing.
- **Failure mode:** exits 0 unconditionally; a classifier fault never disturbs a result that
  already succeeded.
- **Escape hatch:** `DEERFLOW_DISABLE_TOOL_META=1`.
- **Build dependency:** `dist/hooks/post-tool-meta.js`.

### 4. `PostToolUse` / `Read` → `read-mark.js`

- **Ports:** the mark-stamping half of `ReadBeforeWriteMiddleware` (`_attach_read_mark`).
- **Matcher rationale:** `Read` only, matching `_READ_TOOLS = {read_file}`.
- **Ordering:** must be a `PostToolUse` hook, not `PreToolUse` — the mark has to hash the file at
  the instant the model was shown it, exactly as the original stamped *after* the read handler
  returned. No ordering constraint against entry 3 (different files, and entry 3 writes nothing).
- **Stdout protocol:** none. This hook has no decision to make and tells the model nothing.
- **Writes:** `.deerflow/state/<thread>/read-marks.json` (one mark per path, cap 200, oldest-first
  eviction) through the atomic-write + `rev`-CAS library.
- **Failure mode:** exits 0 unconditionally. A missing mark costs one extra Read; it never blocks.
- **Escape hatch:** `DEERFLOW_DISABLE_READ_GATE=1` (same flag as entry 2, on purpose).
- **Build dependency:** `dist/hooks/read-mark.js`.

### 5. `UserPromptSubmit` / `*` → `turn-context.js`

- **Ports:** `DynamicContextMiddleware`'s date reminder (lead slot 15) and
  `DurableContextMiddleware`'s projection (lead slot 18, rendered by `src/summary/durable-context.ts`).
- **Matcher rationale:** `UserPromptSubmit` has no tool to match on; every prompt gets the current
  date and, when the thread has durable state, the ledger/summary/skill projection.
- **Ordering:** none required. Read-only over `summary.json`, `delegations.json`,
  `skill-context.json`, and `goal.json`.
- **Stdout protocol:** `hookSpecificOutput.additionalContext` only. **It never blocks a prompt.**
- **Writes:** none.
- **Failure mode:** exits 0 unconditionally. An unreadable state tree still yields the date
  reminder; a total fault yields no injection and the turn proceeds.
- **Escape hatch:** `DEERFLOW_DISABLE_TURN_CONTEXT=1`.
- **Not included — memory injection.** The `<memory>` block belongs to the M9 memory lane
  (`src/memory/injection.ts`) and is deliberately absent from this hook. If that lane adds its own
  `UserPromptSubmit` entry, both may be registered: they emit independent `additionalContext`
  strings and share no file.
- **Build dependency:** `dist/hooks/turn-context.js`.

**Cost note for the owning lane:** entries 1-4 run once per matched tool call and entry 5 once per
turn. All five are short-lived Node processes that read at most a handful of small JSON files; none
calls a model, spawns a process, or touches the network.

---

## M13 — workspace snapshot + delivery gate (two entries)

**Status:** requested (not applied)

Two hooks, one feature. The `UserPromptSubmit` entry writes the pre-turn baseline; the `Stop`
entry diffs against it, records what changed, and enforces the `outputs/` delivery contract.
Registering only one of them is a no-op: without the baseline the gate stands down by design.

**Requested entries** (add alongside the existing blocks; both arrays already exist and must be
preserved, not replaced):

```json
"UserPromptSubmit": [
  {
    "matcher": "*",
    "hooks": [
      {
        "type": "command",
        "command": "node ${CLAUDE_PLUGIN_ROOT}/dist/hooks/turn-context.js"
      },
      {
        "type": "command",
        "command": "node ${CLAUDE_PLUGIN_ROOT}/dist/hooks/turn-snapshot.js"
      }
    ]
  }
],
"Stop": [
  {
    "matcher": "",
    "hooks": [
      {
        "type": "command",
        "command": "node ${CLAUDE_PLUGIN_ROOT}/dist/hooks/memory-extract.js"
      },
      {
        "type": "command",
        "command": "node ${CLAUDE_PLUGIN_ROOT}/dist/hooks/stop-goal-evaluator.js"
      },
      {
        "type": "command",
        "command": "node ${CLAUDE_PLUGIN_ROOT}/dist/hooks/delivery-gate.js"
      }
    ]
  }
]
```

### 1. `UserPromptSubmit` / `*` → `turn-snapshot.js`

- **Ports:** the pre-run workspace capture, `runtime/runs/worker.py:673-681`
  (`capture_workspace_snapshot`), through `src/artifacts/snapshot.ts`.
- **Matcher rationale:** `UserPromptSubmit` has no tool to match on; every prompt needs a
  baseline, because any turn may write to `outputs/`.
- **Ordering:** **none required against `turn-context.js`.** They share no file — this hook writes
  only `workspace-pre.json`, that one reads `summary/delegations/skill-context/goal` and writes
  nothing. Either order is correct.
- **Stdout protocol:** none. It has no decision to make and tells the model nothing.
- **Writes:** `.deerflow/state/<thread>/workspace-pre.json` only, through the atomic-write state
  library. Unconditional overwrite (single writer, each turn supersedes the last).
- **Failure mode:** exits 0 unconditionally. A malformed payload, an unresolvable thread id, or an
  unwritable state directory results in no baseline — and the Stop gate then stands down rather
  than blocking. Diagnostics go to stderr only.
- **Cost:** one bounded filesystem walk per turn. `outputs/` in full; the project tree capped at
  `FAST_WORKSPACE_MAX_DEPTH = 2` directory levels; the whole scan capped at the original's
  `max_scanned_files = 2000`. `.git`, `node_modules`, `dist`, `build`, `.venv`, `__pycache__` and
  `.deerflow` are never descended into. Files ≤ 256 KiB are sha256'd; larger, sensitive-looking and
  symlinked entries are metadata-only.
- **Model calls:** none.
- **Escape hatch:** `DEERFLOW_DISABLE_DELIVERY_GATE=1` (disables entry 2 as well; one flag governs
  both halves, as `DEERFLOW_DISABLE_READ_GATE` does for the read gate).
- **Build dependency:** `dist/hooks/turn-snapshot.js`.

### 2. `Stop` / `""` → `delivery-gate.js`

- **Ports:** `workspace_changes/recorder.py:record_workspace_changes` (the post-run record) and the
  delivery verdict of `runtime/runs/worker.py:934-986` + `_persist_delivery_receipt`
  (1044-1113). This entry is what **restores the enforcement `docs/sandbox-contract.md` §3
  recorded as weakened at M5.**
- **Matcher:** `""` — a `Stop` hook has no tool to match on; the empty string means every Stop.
- **Ordering:** **must be listed LAST, after `stop-goal-evaluator.js`** (which is itself after
  `memory-extract.js`). Rationale: the goal evaluator decides whether the turn is really over, so
  it must get its continuation first; the delivery check belongs on the turn that actually ends.
  Running it earlier would block on a turn the goal loop was about to extend anyway. The three
  hooks share no file (`memory/queue.jsonl` vs `goal.json` vs `workspace-changes.json` +
  `run-meta.json`).
- **Stdout protocol:** `{"decision":"block","reason":"<ported delivery-contract text + the
  unpresented paths>"}`, emitted **only** when a baseline exists, files were created or modified
  under `outputs/`, none of them is named in the final assistant message, and `stop_hook_active` is
  false. Silent in every other case.
- **Writes:** `workspace-changes.json` (one entry per turn with changes, history capped at 20,
  identical consecutive deltas deduplicated) and the `delivery` field of `run-meta.json`
  (put-if-absent, via `applyRunTransition` re-asserting the run's CURRENT status — it never
  terminalizes a live run). Both through the atomic-write + `rev`-CAS library.
- **Failure mode:** exits 0 unconditionally. A malformed payload, an unresolvable thread id, a
  missing or corrupt baseline, an unreadable transcript, or any internal fault results in **no
  decision at all** — the turn ends normally. Diagnostics go to stderr only.
- **Model calls:** none. The verdict is a set comparison between the changed-outputs list and the
  path-like tokens in the final message.
- **Escape hatch:** `DEERFLOW_DISABLE_DELIVERY_GATE=1` (same flag as entry 1, on purpose).
- **Build dependency:** `dist/hooks/delivery-gate.js`.

**Infinite-loop safety:** a Stop hook that blocks unconditionally wedges a session. Four
independent guards prevent that: (a) it never blocks unless files were created or modified under
`outputs/`; (b) `stop_hook_active` true suppresses the block unconditionally — at most one block
per stop chain, no counter required; (c) a missing baseline stands the hook down, so a fresh or
broken state tree can never trigger it; (d) presenting the paths satisfies the verdict on the very
next evaluation. Pinned by `src/hooks/delivery-gate.test.ts` ("never double-blocks…",
"terminates: one block, then the continuation turn cannot block again").

**Interaction with `stop-goal-evaluator.js`:** both can emit a block. When the goal evaluator
blocks first, the continuation turn carries `stop_hook_active: true`, which permanently suppresses
this hook's block for the rest of that chain — the delivery verdict is then still recorded into
`run-meta.json` as evidence, just not enforced. That is the accepted cost of guard (b) and is
declared in `parity/DISCREPANCIES.md` §M13 entry 3.
