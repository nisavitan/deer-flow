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
