# State, Checkpointing, and Resume — Claude Code-Native Design

Source base: commit `0950924`, branch `port/claude-code-architecture`. Date: 2026-08-01.

Inputs: `notes/runtime-and-persistence.md`, `notes/lead-agent-and-state.md`, `claude-code-capabilities.md`, `experiment-results.md` (Experiment 3). Claim markers: **[Verified from source: …]** (DeerFlow source, via the cited note), **[Verified experimentally: …]** (proof experiments), **[Inference/design]** (this document's design decision).

---

## 1. Original semantics recap

What DeerFlow's LangGraph runtime actually provides, condensed from the source notes.

### 1.1 ThreadState channels + reducers

`ThreadState(AgentState)` extends `messages` with structured channels; `THREAD_STATE_REDUCER_FIELDS = {messages, sandbox, artifacts, todos, goal, viewed_images, promoted, delegations, skill_context}` plus LastValue fields (`thread_data`, `title`, `uploaded_files`, `summary_text`) [Verified from source: notes/lead-agent-and-state.md §4]. Reducer policies that carry correctness:

- `delegations` — ledger of `task` delegations `{id, run_id?, description, subagent_type, status, result_brief?, result_sha256?, result_ref?, stop_reason?, created_at}`; same-id latest wins keeping first-seen order and original `created_at`/`run_id`; terminal status never downgraded by a non-terminal write; capped to last 50 entries [Verified from source: notes/lead-agent-and-state.md §4, thread_state.py:156-204].
- `skill_context` — references only (never SKILL.md bodies), `{name, path, description, loaded_at}`; dedup by `path`, re-read refreshes recency, description whitespace-collapsed and capped at 500 chars, most-recent-8 cap [Verified from source: notes/lead-agent-and-state.md §4, thread_state.py:207-261].
- `goal` — preserve on None write, replace on non-None; satisfied goals are *removed*, not marked [Verified from source: notes/lead-agent-and-state.md §4-5].
- `todos` — last-non-None wins; an explicit empty list is a real update and replaces [Verified from source: notes/lead-agent-and-state.md §4].
- `artifacts` — merge + dedupe preserving order [Verified from source: notes/lead-agent-and-state.md §4].
- `summary_text` — LastValue, out-of-band compressed history [Verified from source: notes/lead-agent-and-state.md §4].

### 1.2 Checkpoint identity, run identity, modes

- Checkpoint coordinates: `thread_id` / `checkpoint_ns` / `checkpoint_id`, with `parent_config` parentage links forming the lineage; forks are created by writing against a `checkpoint_id` selector. A parentless or version-less manual write is treated as corruption (severed delta ancestry, dropped blobs) [Verified from source: notes/runtime-and-persistence.md §2].
- One checkpoint per superstep; breaking the stream leaves the last completed superstep durable [Verified from source: notes/runtime-and-persistence.md §2].
- Run identity: `run_id` minted per run, durable `runs` row, one active run per thread (partial unique index), `run_id` also stamped on the input HumanMessage as the current-run boundary [Verified from source: notes/runtime-and-persistence.md §1, §8; notes/lead-agent-and-state.md §7].
- Full vs delta channel modes: `full` stores whole-snapshot channel values; `delta` stores sentinel blobs + per-step message writes with a snapshot cadence. Mode is process-frozen, marker-stamped, fail-closed on mismatch [Verified from source: notes/runtime-and-persistence.md §2].
- Rollback points: eager pre-run capture of *materialized* state (messages + non-message channels + raw pending writes) under the checkpoint thread lock; capture failure disables rollback (fail-closed) [Verified from source: notes/runtime-and-persistence.md §1 step 10, §2].
- Resume inputs: a run may carry `configurable.checkpoint_id`/`checkpoint_map`; delta mode linearizes the fork onto the head; `pre_existing_message_ids` is recomputed to re-establish the current-run boundary [Verified from source: notes/runtime-and-persistence.md §6].
- Interrupts: clarification "interrupt" ends the graph cleanly; the reply arrives as a *new run* carrying a `human_input_response` HumanMessage. Cancel = `interrupt` (keep checkpoint, status interrupted) or `rollback` (restore pre-run capture, status error) [Verified from source: notes/runtime-and-persistence.md §6].
- Out-of-band writes (goal, title, run durations) use optimistic CAS on the head `checkpoint_id` and stand down or retry on movement; there is **no cross-write transaction** [Verified from source: notes/runtime-and-persistence.md §2].

---

## 2. Design decision — two-layer state model

The port splits DeerFlow's single LangGraph checkpoint store into two layers with different owners.

### Layer 1 — conversation state: native Claude Code sessions

Native sessions own everything message-shaped: history, turn durability, resume, branching, and conversation/file rewind.

| DeerFlow concept | Native mechanism | Evidence |
|---|---|---|
| `thread_id` | Session id (`--session-id`, stable across `--resume`) | [Verified experimentally: experiment-results.md E3-a — headless resume recalled state cross-process with the same session id] |
| Resume from head | `--continue` / `--resume <id>` | [Verified experimentally: E3-a] |
| Branch / fork from checkpoint | `--fork-session`; interactive `/rewind` (conversation & file checkpoints) | [Verified from source: claude-code-capabilities.md §6 — DOC/CLI verified] |
| Per-superstep message durability | Session transcript `~/.claude/projects/<proj>/<id>.jsonl` (format internal/unstable — never parsed by the port) | [Verified from source: claude-code-capabilities.md §6] |

**Mapping rule** [Inference/design]: the port mints `thread_id` = the first session id of a thread and keeps it stable. Later sessions of the same thread (resumes, forks) are recorded in the thread's `sessions.json` (§2.3). A DeerFlow "branch from checkpoint X" becomes `--fork-session` from the session containing X; the fork's new session id is appended to `sessions.json` with its parent — this preserves the *lineage identity* requirement (guarantee G1) at session granularity rather than checkpoint granularity.

**Delta-vs-full checkpoint modes: N/A in the port.** The full/delta split (plus snapshot frequency, mode markers, freeze, compatibility gate, linearized delta resume) exists solely to avoid re-serializing the whole `messages` blob into every LangGraph checkpoint row — a storage optimization for LangGraph's per-superstep snapshot representation [Verified from source: notes/runtime-and-persistence.md §2]. The port has no such representation: conversation history is the session transcript (natively incremental), and Layer 2 files are small structured JSON that are rewritten wholesale. There is no blob-duplication problem to optimize, hence no modes, no freeze, no mode-mismatch gate, and no delta-fork-poisoning class (#4458) — that entire hazard is designed out rather than ported [Inference/design; hazard documented in notes/runtime-and-persistence.md §2, §9.5].

### Layer 2 — structured DeerFlow state: port-owned state directory

Everything in `ThreadState` that is *not* messages lives in explicit JSON files. This is required because native sessions do not replace the structured channels [Verified from source: claude-code-capabilities.md §6 mapping note] and cross-session workflow resume is not supported, so durable cross-run state must live in files keyed by run identity [Verified experimentally: experiment-results.md E3 item 4].

**Layout** [Inference/design]:

```
<project-root>/.deerflow/state/<thread_id>/
  run-meta.json        # current/most-recent run record (identity, status, delivery receipt)
  sessions.json        # thread -> session lineage (primary id, forks with parentage)
  goal.json            # goal channel
  todos.json           # todos channel
  delegations.json     # delegation ledger
  skill-context.json   # active-skill references
  artifacts.json       # presented-artifact paths
  summary.json         # durable summary / compaction record
  runs/<run_id>.json   # archive of terminal run records
  runs/<run_id>.pre/   # pre-run rollback snapshot of the state files (copied at run start)
```

`.deerflow/` is gitignored. The directory is per-project-root, so a worktree gets its own state tree — worktree binding is then explicit in `run-meta.json` (§4) rather than accidental.

**Common file envelope** [Inference/design] — every file wraps its payload:

```json
{ "schema_version": 1, "rev": 42, "updated_at": "2026-08-01T12:00:00Z", ... }
```

- `schema_version` — integer, per-file; migrate-or-discard rule in §4.
- `rev` — per-file monotonic counter, incremented on every write. This is the port's analog of DeerFlow's head-`checkpoint_id` CAS: every read-modify-write records the `rev` it read and **stands down (or re-reads and retries, max 3 attempts) if the file's `rev` changed at write time**, mirroring `GoalWriteConflict` semantics [Verified from source: notes/runtime-and-persistence.md §2 "no cross-write transaction", §9.2; port mechanism: Inference/design].

**Atomic-write discipline** [Inference/design]: all writers write `<name>.json.tmp-<pid>` in the *same directory*, fsync, then `rename(2)` over the target. Readers therefore always see a complete, parseable file — never a torn write. Single-writer assumption: one Claude Code session (or one workflow run) is the sole writer for a thread's state dir at a time; this is the single-process collapse the runtime notes explicitly permit ("startup reclaims NULL-lease active rows" — the heartbeat-off behavior) [Verified from source: notes/runtime-and-persistence.md §9.9]. There is deliberately **no cross-file transaction** — see §7 for why this is acceptable and where DeerFlow also lacks one.

### 2.3 Per-file schemas, reducer → read-modify-write rules, and writers

Reducers are functions over channel writes; the port translates each into a read-modify-write (RMW) rule executed under the atomic-write + `rev`-CAS discipline. Writer legend: **hook** = deterministic settings/plugin hook (PreToolUse/PostToolUse/SessionStart/Stop/PreCompact); **workflow** = Dynamic Workflow script code; **skill** = instruction inside a port skill telling the model to invoke a helper script (least deterministic — used only where no hook point exists).

#### `delegations.json`
```json
{ "schema_version": 1, "rev": 7, "updated_at": "...",
  "entries": [ { "id": "d-01", "run_id": "r-...", "description": "...",
                 "subagent_type": "explore", "status": "completed",
                 "result_brief": "...", "result_sha256": "...", "result_ref": "runs/r-.../d-01.json",
                 "stop_reason": null, "created_at": "...", "commit_sha": "0950924..." } ] }
```
RMW rules (translated from `merge_delegations` [Verified from source: notes/lead-agent-and-state.md §4]):
1. Incoming empty/None entry set → no write.
2. Same `id` → replace the entry's payload **in place** (first-seen order kept) but preserve original `created_at` and `run_id`.
3. A terminal `status` (values from `contracts/subagent` status vocabulary) is never overwritten by a non-terminal one — later out-of-order progress events cannot downgrade a finished delegation.
4. After merge, truncate to the **last 50** entries.
5. `commit_sha` per entry is a port addition for staleness (§4) [Inference/design].

Writers: **workflow** code after each `agent()` resolves (deep runs — the workflow already receives the schema-validated result [Verified experimentally: E2-a]); **hook** (PostToolUse on the Agent tool) for interactive-session delegations, since hooks receive structured `tool_name`/`tool_input` JSON deterministically [Verified experimentally: experiment-results.md E4-a].

#### `goal.json`
```json
{ "schema_version": 1, "rev": 3, "updated_at": "...",
  "goal": { "objective": "...", "status": "active",
            "created_at": "...", "updated_at": "...",
            "continuation_count": 2, "max_continuations": 8,
            "no_progress_count": 0, "max_no_progress_continuations": 2,
            "last_evaluation": { "satisfied": false, "blocker": "goal_not_met_yet",
                                  "reason": "...", "evidence_summary": "...",
                                  "progress_key": "...", "stand_down_reason": null } } }
```
RMW rules (from `merge_goal` + `runtime/goal.py` policy [Verified from source: notes/lead-agent-and-state.md §5; notes/runtime-and-persistence.md §5]):
1. None write → preserve existing; non-None → replace wholesale.
2. Satisfied goal → write `"goal": null` (cleared, never marked satisfied).
3. `max_continuations` clamped to `max(0, min(requested, 8))`; `max_no_progress_continuations` = 2; objective capped at 4000 chars; blocker restricted to the six-value enum with only `goal_not_met_yet` continuable — **same constants, ported verbatim**.
4. `continuation_count` is defensively recomputed inside the write (`max(caller_count, current+1)`), and every write is `rev`-CAS-guarded — the port equivalent of `goal_thread_lock` + `GoalWriteConflict`.

Writers: **workflow** code owns the goal loop in deep runs (evaluate → decide → write); a **Stop hook** reads (never writes) `goal.json` to decide forced continuation in interactive sessions [Inference/design; Stop-hook continuation capability Verified from source: claude-code-capabilities.md §5].

#### `todos.json`
```json
{ "schema_version": 1, "rev": 11, "updated_at": "...", "todos": [ { "content": "...", "status": "pending" } ] }
```
RMW rule (from `merge_todos`): last-non-None wins; an explicit `[]` **is** an update and replaces; None → preserve [Verified from source: notes/lead-agent-and-state.md §4]. Writer: **hook** (PostToolUse on TodoWrite) mirrors the native todo tool's input into the file — deterministic, no model cooperation needed [Inference/design].

#### `skill-context.json`
```json
{ "schema_version": 1, "rev": 5, "updated_at": "...",
  "entries": [ { "name": "pdf", "path": "/…/skills/pdf/SKILL.md", "description": "…≤500 chars…", "loaded_at": "..." } ] }
```
RMW rules (from `merge_skill_context` / `_normalize_skill_entry` [Verified from source: notes/lead-agent-and-state.md §4]):
1. Reference only — never the SKILL.md body.
2. Normalize: drop unknown/legacy keys, whitespace-collapse description, cap at 500 chars.
3. Dedup by `path`; a re-read refreshes recency (moves the entry to most-recent).
4. Cap to the **8 most recent** entries. `loaded_at` is observational only.

Writer: **hook** (PostToolUse matching Read/Skill invocations whose path ends in `SKILL.md` or whose tool is Skill) [Inference/design].

#### `artifacts.json`
```json
{ "schema_version": 1, "rev": 2, "updated_at": "...", "artifacts": [ "outputs/report.pdf" ] }
```
RMW rule (from `merge_artifacts`): union incoming with existing, dedupe preserving first-seen order (`dict.fromkeys` semantics) [Verified from source: notes/lead-agent-and-state.md §4]. Writers: **workflow** code when a stage produces deliverables; **hook** (PostToolUse) on the port's present-files skill helper in interactive sessions [Inference/design].

#### `summary.json`
```json
{ "schema_version": 1, "rev": 1, "updated_at": "...",
  "summary_text": "…", "source": "stage_synthesis",
  "compactions": [ { "at": "...", "trigger": "auto" } ] }
```
RMW rule: LastValue — replace `summary_text` wholesale [Verified from source: notes/lead-agent-and-state.md §4]. Writers: **workflow** synthesis code (stage summaries for deep runs); **hook** (PreCompact) appends a compaction record so the port knows native compaction occurred — the port cannot control native compaction content, a documented behavioral delta [Verified from source: experiment-results.md E4; claude-code-capabilities.md §10].

#### `run-meta.json`
```json
{ "schema_version": 1, "rev": 9,
  "run_id": "r-2026-08-01-a1b2", "thread_id": "…", "session_id": "…",
  "workflow_run_id": "wf_7b12b2c7-99d",
  "commit_sha": "0950924…", "branch": "port/claude-code-architecture",
  "worktree_path": "/abs/path/to/checkout",
  "status": "running", "stop_reason": null, "error": null,
  "delivery": { "presented_paths": ["outputs/report.pdf"], "receipt_at": "..." },
  "started_at": "...", "updated_at": "...", "ended_at": null }
```
Rules [Inference/design, mirroring notes/runtime-and-persistence.md §1 steps 16-19]:
1. One non-terminal run per thread: a new run refuses to start (or offers recovery, §5) while `status ∈ {pending, running}` — the port's version of the `uq_runs_thread_active` admission gate.
2. `status` values: `pending | running | success | error | interrupted`; `stop_reason` carries the DeerFlow taxonomy (`loop_capped`, `token_capped`, `safety_capped`, `subagent_limit_capped`, `model_length_capped`, `orphan_recovered`).
3. **Receipt-with-status atomicity**: the terminal write sets `delivery` and terminal `status` in the *same* atomic file write — collapsing DeerFlow's receipt-before-status two-store ordering into one rename (see G6 in §7).
4. On terminal, the record is copied to `runs/<run_id>.json` (archive; failure to archive is non-fatal — `run-meta.json` remains authoritative).

Writer: **workflow** code (deep runs); **hooks** (SessionStart marks `running` for interactive turns bound to a thread; Stop marks turn completion) [Inference/design].

#### `sessions.json`
```json
{ "schema_version": 1, "rev": 4, "updated_at": "...",
  "thread_id": "…", "primary_session_id": "…",
  "sessions": [ { "session_id": "…", "parent_session_id": null, "kind": "primary", "created_at": "..." },
                { "session_id": "…", "parent_session_id": "…", "kind": "fork", "reason": "branch-from-review", "created_at": "..." } ] }
```
Rules: append-only; a session id is never removed; forks always record their parent — this is the Layer-1 lineage record (guarantee G1). Writer: **hook** (SessionStart receives `session_id` on stdin [Verified experimentally: E4-a]) plus **workflow** code when it launches forked sessions [Inference/design].

---

## 3. Checkpoint identity & resume

### 3.1 Run identity

Port run identity = the tuple recorded in `run-meta.json`: port-minted `run_id` + `session_id` + (for deep runs) the workflow runtime's `workflow_run_id` + `commit_sha` + timestamps [Inference/design]. This mirrors DeerFlow's `runs` row (run_id, thread_id, status, stop_reason, timestamps) at the fields that carry behavior [Verified from source: notes/runtime-and-persistence.md §8], dropping the multi-worker columns (lease, owner, cancel handoff) per the single-process collapse [Verified from source: notes/runtime-and-persistence.md §9 "deployment concerns"].

### 3.2 Resume paths

**Within a session (interrupted deep run, same session still alive):** re-invoke the workflow with `resumeFromRunId=<workflow_run_id>` from `run-meta.json`. Completed `agent()` calls replay from the journal cache with no re-execution — measured 14 ms, 0 tokens, 0 tool calls for a 3-agent run; invalidation is prefix-based on the first changed `agent()` call [Verified experimentally: experiment-results.md E3-b].

**Across sessions (process died, machine rebooted, next day):** `resumeFromRunId` is same-session only [Verified from source: claude-code-capabilities.md §4 "Cross-session resume: not supported per docs"]. The port's cross-session resume is therefore **state-file keyed**:
1. Resume the conversation natively: `claude --resume <session_id>` from `sessions.json` (headless resume verified cross-process [Verified experimentally: E3-a]).
2. Re-launch the workflow *fresh* (new workflow run id). The workflow script's first act is to read the thread's state files; stages whose results are already recorded (`delegations.json` entries with terminal status + matching `commit_sha`, `artifacts.json` paths that still exist) are **skipped after re-verification**, not blindly trusted: the stage-skip predicate is "terminal delegation entry exists AND its `commit_sha` matches current HEAD AND any referenced output file exists and (when `result_sha256` is recorded) hashes match". Failing any check re-runs the stage [Inference/design].
3. Resume inputs: like DeerFlow, a resumed run may append no new user message; the current-run boundary is the new `run_id` written to `run-meta.json`, and delegation entries are tagged with the `run_id` that produced them — the port analog of `pre_existing_message_ids` / per-run delegation budgets [Verified from source: notes/runtime-and-persistence.md §9.3 for the original requirement; port mechanism: Inference/design].

### 3.3 Honest delta vs LangGraph checkpoints

LangGraph gives DeerFlow a **per-superstep, multi-channel, transactionally-written snapshot with parentage** — resume can anchor to any historical checkpoint and materialize the full channel state at that point [Verified from source: notes/runtime-and-persistence.md §2]. The port has **no exact equivalent** and does not pretend to. Its guarantee is three coarser, independent layers:

| Granularity | Mechanism | Scope |
|---|---|---|
| Turn-level (messages) | Native session transcript + `/rewind` conversation/file checkpoints | conversation only, native-owned [Verified from source: claude-code-capabilities.md §6] |
| Stage-level (work) | Workflow journal (`journal.jsonl`, one result per agent) + `resumeFromRunId` | same-session deep runs [Verified experimentally: E3-b] |
| Channel-level (structured state) | Explicit state files, each atomically written with `rev` | cross-session, port-owned [Inference/design] |

What is lost: (a) there is no single identifier that names "the complete state of everything at superstep N" — a resume anchors to a session position for conversation and to state-file contents for channels, and those two are only *eventually* aligned (at turn/stage boundaries, when hooks and workflow code have flushed); (b) resume-from-arbitrary-historical-checkpoint of *structured* channels is not supported — only the head state files plus per-run `runs/<run_id>.pre/` snapshots are addressable rollback anchors. Both losses are accepted because every DeerFlow behavior the port must reproduce (§7) is defined at turn/stage/run boundaries, not mid-superstep [Inference/design].

### 3.4 Interrupt semantics

- **Clarification**: DeerFlow's clarification "interrupt" is a clean graph end + a new run carrying the reply [Verified from source: notes/runtime-and-persistence.md §6]. In the port this is simply native turn-taking: the model asks, the turn ends, the user replies — no machinery needed. The structured `human_input_response` v1 envelope is retired for interactive use; deep-run workflows that need a mid-run user decision surface it by ending the stage and recording a `needs_user_input` blocker in `goal.json` [Inference/design].
- **Cancel/interrupt**: Esc / TaskStop stops execution; state files keep whatever was last atomically written; `run-meta.json` is marked `interrupted` (by the Stop path or recovery scan, §5) — DeerFlow's `interrupt` action equivalent.
- **Cancel/rollback**: restore conversation and files via `/rewind` (native checkpoints) and restore the state dir from `runs/<run_id>.pre/` (§5). Fail-closed like DeerFlow: if the pre-run snapshot copy failed at run start, rollback of Layer 2 is disabled for that run rather than partially restored [Verified from source: notes/runtime-and-persistence.md §9.4 for the original rule; port mechanism: Inference/design].

---

## 4. Stale-state detection

The platform has **no built-in changed-commit detection** for either sessions or workflow caches — this is a port-side obligation [Verified experimentally: experiment-results.md E3 item 3].

**Commit binding** [Inference/design]:
- `run-meta.json` carries `commit_sha` (`git rev-parse HEAD`), `branch`, and `worktree_path`, captured at run start.
- `delegations.json` carries `commit_sha` **per entry** (the HEAD when that delegation ran) — these are the cached results whose validity depends on the tree.
- Workflow `agent()` prompts embed the commit SHA in their args so the workflow journal's own prefix cache self-invalidates on a changed tree [Verified experimentally: E3-b conclusion].
- Files that do *not* carry `commit_sha`: `goal.json`, `todos.json`, `sessions.json`, `summary.json` — user intent and conversation lineage are not code-derived and survive a tree change [Inference/design].

**Mismatch rule** [Inference/design]: at run start (workflow preamble or SessionStart hook), compare current `git rev-parse HEAD` + resolved worktree path against the recorded values. On mismatch: dependent cached results are invalidated — delegation entries with a stale `commit_sha` are kept in the ledger (history is truthful) but excluded from the stage-skip predicate of §3.2, so their stages re-run; `artifacts.json` paths are re-verified for existence. Nothing is silently reused across a tree change.

**Schema versioning** [Inference/design]: every file's `schema_version` is checked on read. Rule: **migrate-or-discard** — (a) older version with a registered migration → migrate in memory, write back atomically with the new version; (b) unknown or newer version → do not partially parse; rename the file to `<name>.invalid-<timestamp>` and start that channel empty, logging the discard. This is the port's analog of DeerFlow's fail-closed mode gate: never interpret state under the wrong schema [Verified from source: notes/runtime-and-persistence.md §2 for the fail-closed precedent; rule itself: Inference/design].

---

## 5. Crash recovery & partial-stage recovery

**Consistency baseline**: because every state file is written via temp-file + rename, a crash at any instant leaves each file either at its previous complete version or its new complete version — never torn [Inference/design]. The workflow journal independently preserves one result per completed agent [Verified experimentally: E3-b].

**Recovery procedure** [Inference/design, behaviorally mirroring DeerFlow orphan reconciliation — Verified from source: notes/runtime-and-persistence.md §6 "Crash / orphan recovery"]:

1. **Scan**: on SessionStart (and on any deep-run launch), scan `.deerflow/state/*/run-meta.json` for `status ∈ {pending, running}` where the recording session is not the current one — these are orphans (single-writer means no lease check is needed; a non-terminal record from another/dead session is by definition abandoned).
2. **Offer or mark**: interactively, surface the orphan and offer: *resume* (cross-session resume path of §3.2) or *mark interrupted*. Non-interactively (headless/scheduled), mark it directly: atomically rewrite `run-meta.json` with `status: "interrupted"`, `stop_reason: "orphan_recovered"` — the same stop_reason DeerFlow's reconciler stamps.
3. **Receipt backfill**: if the orphaned record has no `delivery` object, the terminal write includes `delivery: { presented_paths: [], receipt_at: <now> }` — a zero receipt, exactly mirroring DeerFlow's `put_if_absent` backfill; an existing delivery object (crash after receipt) is preserved, never overwritten [Verified from source: notes/runtime-and-persistence.md §6, §9.6 for the original; port mechanism: Inference/design].
4. **Partial-stage recovery**: on resume, completed stages are recovered from `delegations.json` + the re-verification predicate (§3.2); the interrupted stage re-runs from its beginning. Stage is the recovery quantum — there is no sub-stage (per-superstep) replay, consistent with §3.3.
5. **Rollback-snapshot hygiene**: `runs/<run_id>.pre/` snapshots for terminal runs older than the archive retention window are deleted during the scan.

---

## 6. Secret exclusion

State files **never store credentials** — no tokens, API keys, OAuth material, or `required-secrets` values may appear in any Layer 2 file. DeerFlow parallels: `redact_config_secrets` strips `context.secrets`, all reserved `__`-prefixed keys (`REDACTED_CONTEXT_KEYS`), and legacy `metadata.auth_token` before run kwargs are persisted — request-scoped secrets are never written to the runs table [Verified from source: notes/runtime-and-persistence.md §8].

Port rules [Inference/design]:
1. The port never reads or persists Claude Code auth material at all — the CLI owns authentication [Verified from source: claude-code-capabilities.md "Confirmed constraint compliance"].
2. Skill `required-secrets` (the frontmatter field with no native equivalent) are resolved at use-time from the environment/OS keychain and passed transiently; `skill-context.json` records the skill *reference* only, never resolved secret values — inheriting the reference-not-body rule.
3. `result_brief`/`result_ref` payloads written by workflow code pass a redaction filter for known secret env-var names before persistence (defense in depth; the deterministic writers make this enforceable in code, not prompts).
4. Parity check: a test greps every file the port wrote during an end-to-end run for planted sentinel secrets (see §7 test references).

---

## 7. Guarantees table

The 10 port-must-reproduce guarantees from `notes/runtime-and-persistence.md` §9, plus two storage-honesty rows. Levels: **equivalent** (same observable behavior), **weaker-defined** (behavior preserved at a coarser granularity, delta stated), **dropped** (not reproduced, with reason). Parity test references: DeerFlow anchor = existing test pinning the original behavior [Verified from source: notes/delivery-and-tests.md §6]; port test = proposed test under `experiments/claude-code-port/parity/` (to be created in the implementation phase) [Inference/design].

| # | DeerFlow guarantee | Port mechanism | Level | Parity test reference |
|---|---|---|---|---|
| G1 | Checkpoint identity + parentage: every write anchored to a lineage; parentless write = corruption | Layer 1: native session lineage + `sessions.json` fork records (parent always recorded). Layer 2: per-file `rev` chain + `runs/<run_id>.pre/` anchors. No per-write parent pointer inside a file. | **Weaker-defined** — lineage at session/run granularity, not per checkpoint | port `parity/state/test_session_lineage.py`; DeerFlow anchor: checkpoint-parentage assertions in `test_goal_worker` |
| G2 | Staleness via optimistic CAS on head checkpoint id; stand down on movement | Per-file `rev` compare-and-stand-down (max 3 retries) on every RMW; `goal.json` writes recompute counts inside the write | **Equivalent** per file; **weaker-defined** globally (no cross-file head) | port `parity/state/test_rev_cas_stand_down.py`; DeerFlow anchor: `test_goal_runtime` GoalWriteConflict cases |
| G3 | Resume inputs / current-run boundary (`pre_existing_message_ids`, per-run delegation budget) | New `run_id` minted per run in `run-meta.json`; delegation entries tagged with producing `run_id`; per-run subagent budget counted over current-run entries only | **Equivalent** at the behavior that matters (budgets, attribution); message-id masking is native-session-internal | port `parity/state/test_run_boundary_budget.py`; DeerFlow anchor: `test_thread_state_reducers` delegation run-budget cases |
| G4 | Rollback = restore eagerly captured materialized pre-run state, fail-closed on capture failure | `/rewind` (native conversation+file checkpoints) + `runs/<run_id>.pre/` state-dir snapshot copied at run start; snapshot-copy failure disables Layer 2 rollback for that run | **Equivalent** (behavioral): eager capture, materialized copy, fail-closed | port `parity/state/test_rollback_fail_closed.py`; DeerFlow anchor: rollback tests in `test_goal_worker`/runs worker suite |
| G5 | Delta-fork poisoning: forks from non-head snapshots in append-log storage must be linearized | Designed out: no delta/append-log channel representation exists; every state file is rewritten wholesale; forks are whole-session forks | **Equivalent by construction** (hazard class removed) | port `parity/state/test_fork_no_replay.py` (fork a session, assert no stale delegation resurrection) |
| G6 | Receipt-before-status: idempotent delivery receipt persisted before terminal status; crash path backfills zero receipt | Receipt and terminal status written in **one** atomic `run-meta.json` rename (no ordering window at all); recovery backfills zero receipt, preserves existing receipt | **Equivalent** (locally stronger: single-write atomicity replaces cross-store ordering) | port `parity/state/test_terminal_receipt_atomic.py`; DeerFlow anchor: worker delivery-receipt tests |
| G7 | Durable end-of-turn receipt before autonomous continuation (head id + no pending writes + visible AI message) | Continuation predicate: the turn/stage has terminated (Stop hook fired, or workflow `agent()` resolved) AND `run-meta.json`/`goal.json` flushed (their `updated_at` ≥ turn end). No pending-writes notion exists; "tool still in flight" cannot occur because hooks/workflow code run only at completed boundaries | **Weaker-defined** — predicate is boundary-based, not checkpoint-introspective; same fail-closed direction (don't continue without evidence of a settled turn) | port `parity/state/test_continuation_gate.py`; DeerFlow anchor: `test_goal_worker` durable-receipt cases |
| G8 | Goal caps/breaker: max_continuations clamp 0–8, no-progress cap 2, breaker keyed on SHA-256 of latest visible assistant text | Same constants and clamp in `goal.json` write rules; workflow goal loop computes `progress_key` from the SHA-256 of the latest visible assistant output, not evaluator prose | **Equivalent** (pure policy port) | port `parity/state/test_goal_caps_breaker.py`; DeerFlow anchor: `test_goal_runtime` cap/breaker tests |
| G9 | Ownership fencing: unconfirmed ownership → no further durable writes; startup reclaims orphans | Single-writer, single-process: fencing collapses to the recovery scan (§5) reclaiming non-terminal `run-meta.json` records — exactly the heartbeat-off behavior the runtime notes bless | **Equivalent** under the single-process collapse (multi-worker fencing dropped by design — no second worker exists) | port `parity/state/test_orphan_recovery.py`; DeerFlow anchor: manager reconciliation tests |
| G10 | Event feed identity: `run_id` as turn identity for consumers; seq strictly increasing per thread | `run_id` identity preserved in `run-meta.json`/`runs/` archive and delegation tags; workflow journal is per-run ordered. No per-thread strictly-increasing event seq is maintained | **Weaker-defined / partially dropped** — there are no SSE consumers in the port (delivery infra dropped by design); the surviving consumers (recovery scan, resume predicate) key on `run_id` + file `rev`, which the port does maintain | port `parity/state/test_run_identity.py`; DeerFlow anchor: `test_replay_golden` event-order fixtures (adapted) |
| G11 | Per-superstep multi-channel transactional snapshot (LangGraph checkpoint row) | **None.** Turn-level (session) + stage-level (journal) + per-file atomic writes; no cross-file transaction | **Dropped** — acceptable because: single writer per thread dir; every cross-file invariant the original system enforces is established at turn/stage boundaries where all writers have flushed; each file alone is always internally consistent (atomic rename); and DeerFlow itself has no cross-write transaction for out-of-band writes, only CAS (§1.2) | covered jointly by G2/G6/G7 port tests |
| G12 | Secrets never persisted (`REDACTED_CONTEXT_KEYS`, request-scoped secrets) | §6: no credentials in any state file; use-time resolution; redaction filter on persisted briefs | **Equivalent** | port `parity/state/test_no_secrets_in_state.py` (sentinel grep) |

**Explicit non-claim**: a directory of JSON files is *not* a LangGraph checkpointer. What the port guarantees is exactly: atomic single-file writes (never-torn reads), per-file CAS staleness detection, stage-level resume with re-verification, run-identity + receipt atomicity, commit-SHA staleness invalidation, and fail-closed rollback/schema handling. What it does not guarantee is any point-in-time snapshot spanning multiple files or any mid-stage replay — and every reproduced behavior in the table above is defined so that it never needs one.
