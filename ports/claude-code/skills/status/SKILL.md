---
name: status
description: Report DeerFlow's durable state for every thread - the recorded run, goal, open todos, delegation ledger, artifacts and whether that state is still bound to the current commit - and offer to resume or clear it. Use when the user invokes /deerflow:status, asks what DeerFlow was doing, asks whether earlier work can be resumed, or after a crashed or interrupted session.
---

<!-- Ported from the original's thread/run inspection surface @ 0950924:
     GET /api/threads/{id} + the runs table (runtime/runs/store) + the LangGraph state
     snapshot, all of which the DeerFlow web UI consumed. The port has no server and no UI,
     so the same facts are printed by a CLI.
     Implementation: src/resume/status-cli.ts (renderer), src/resume/resume-plan.ts (report),
     src/resume/staleness.ts (commit binding), src/resume/recovery.ts + 
     src/hooks/session-recover.ts (the automatic recovery counterpart).
     Design: docs/claude-code-port/state-checkpoint-resume.md §3-§5. -->

# DeerFlow status

Claude Code sessions carry the conversation; they do **not** carry DeerFlow's
structured state (goal, todos, delegation ledger, run identity, artifacts).
That state lives in `.deerflow/state/<thread>/` and survives crashes, reboots
and new sessions. This skill reads it and tells the user what is resumable.

## Steps

1. **Render the report.** Run:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/resume/status-cli.js"
   ```

   Add `--thread <id>` to limit the report to one thread, or `--json` when you
   need the raw structure rather than the markdown. The command is **read-only**:
   it never writes a state file, never terminalizes a run and never resumes
   anything.

2. **Present the output as-is.** Show the user the rendered markdown. Do not
   summarize away the two fields that carry the decision:

   - **Staleness** — `fresh` (state is bound to the current commit),
     `stale_branch` (branch moved, same commit, nothing invalidated), or
     `stale_commit` (HEAD moved, or HEAD could not be read).
   - **Recommended action** — `continue`, `restart_stale`, or
     `nothing_to_resume`.

   If a thread lists **unreadable channels**, say so plainly: that file was
   written under a schema this build cannot interpret, and it was read as empty
   rather than guessed at.

3. **Offer the next action** matching the recommendation:

   | Recommendation | What to offer |
   |---|---|
   | `continue` | Resume the objective: `/deerflow:run <the goal objective from the report>`. Tell the user which delegation results are reusable, so they know what will not be re-run. |
   | `restart_stale` | Explain that HEAD moved since the state was written, so **no cached delegation result will be reused** and those stages re-run. Offer `/deerflow:run <objective>` anyway, or clearing the stale state (step 4). |
   | `nothing_to_resume` | Say there is nothing pending and offer to start fresh with `/deerflow:run <objective>`. |

4. **Clearing state is the user's call, never yours.** If the user wants stale
   state gone, tell them what to delete and let them run it:

   ```bash
   rm -rf .deerflow/state/<thread-id>
   ```

   Never delete a state directory on your own initiative, and never delete one
   whose run is still non-terminal without pointing out that a live run is
   recorded there.

## What resuming actually does

The port's cross-session resume is **state-file keyed**, not checkpoint keyed:
Claude Code's own `resumeFromRunId` is same-session only. A resumed run reads
the thread's state files and skips a stage only when all of these hold:

- the delegation entry is terminal, **and**
- its recorded `commit_sha` equals current HEAD, **and**
- any referenced output file still exists (and matches `result_sha256` when one
  was recorded).

Anything failing that predicate re-runs. An entry with no recorded `commit_sha`
can never match and always re-runs. Stale entries stay in the ledger — history
stays truthful — they are only excluded from the skip.

## What this is not

- **Not a checkpoint browser.** There is no per-superstep snapshot to inspect
  and no "restore state at step N". The addressable anchors are the head state
  files and the per-run `runs/<run_id>.pre/` snapshots.
- **Not a recovery command.** Abandoned runs are terminalized automatically at
  session start by the `SessionStart` hook
  (`dist/hooks/session-recover.js`), which marks a run left non-terminal for
  more than 2 hours as `interrupted` with `stop_reason: orphan_recovered` and
  backfills a zero delivery receipt. This skill only reports what happened.
- **Not the conversation.** Rewinding messages or files is native
  (`/rewind`, `--resume`, `--fork-session`) and is not what this skill reads.
