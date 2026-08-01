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
`docs/claude-code-port/DISCREPANCIES.md` §M9.
