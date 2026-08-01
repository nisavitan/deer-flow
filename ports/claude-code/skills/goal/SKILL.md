---
name: goal
description: Set, inspect, or clear a DeerFlow thread goal - an objective the assistant keeps working toward across turns, bounded by a continuation cap of 8 and a no-progress breaker of 2. Use when the user invokes /deerflow:goal, asks to "keep going until X", or asks what the current goal is.
allowed-tools: Bash, Read
---

<!-- Ported from backend/packages/harness/deerflow/runtime/goal.py:parse_goal_command@0950924
     (the three-way /goal semantics: empty -> status, clear|reset|off -> clear, anything else ->
     set) plus the /goal surfaces in app/channels/manager.py and the TUI slash palette.
     The loop itself lives in src/goal-loop/ and src/hooks/stop-goal-evaluator.ts. -->

# DeerFlow goal

Argument: $ARGUMENTS

## The three-way command

DeerFlow's `/goal` has exactly three meanings, and this skill keeps them:

| Argument | Meaning | Command |
|---|---|---|
| _(empty)_ | show the active goal | `node dist/goal-loop/goal-cli.js status` |
| `clear`, `reset`, `off` | clear the active goal | `node dist/goal-loop/goal-cli.js clear` |
| anything else | set that text as the objective | `node dist/goal-loop/goal-cli.js set "<objective>"` |

An optional second positional argument to `set` caps the continuations:
`node dist/goal-loop/goal-cli.js set "finish the audit" 3`. It is clamped to `0..8` — 8 is a hard
engine maximum, not a default you can raise.

The goal lives in `.deerflow/state/<thread>/goal.json`. Every write is atomic (temp file + fsync +
rename) under a `rev` compare-and-set, so a losing write stands down instead of clobbering a newer
one.

## What an active goal does

While a goal is active, the `Stop` hook (`dist/hooks/stop-goal-evaluator.js`) intercepts the end of
each turn and re-checks it. This is DeerFlow's goal-continuation loop, split across the platform:

1. **Deterministic gates run in the hook** — the model cannot influence them:
   - **continuation cap 8**: at most 8 continuations per goal, ever;
   - **no-progress breaker 2**: two consecutive turns that add no new visible assistant output stop
     the loop (keyed on a SHA-256 of the latest visible assistant text, not on reworded prose);
   - **evidence gate**: with no visible assistant reply at all, the loop stands down with
     `missing_evidence` rather than continuing on nothing.
2. **The verdict is yours.** When the gates pass, the hook blocks the stop and hands back the
   verbatim DeerFlow evaluator rubric plus the goal and the visible conversation evidence. You then
   judge your own work under that rubric and act:
   - satisfied → `node dist/goal-loop/goal-cli.js clear`, then stop;
   - `goal_not_met_yet` → keep working; do not ask the user to continue unless genuinely blocked;
   - `needs_user_input` / `run_failed` / `external_wait` / `missing_evidence` →
     `node dist/goal-loop/goal-cli.js record-evaluation '{"satisfied":false,"blocker":"<blocker>","reason":"<why>","evidence_summary":"<what is visible>"}'`,
     then stop. That records the stand-down instead of burning continuations.

Apply the rubric strictly. In DeerFlow the evaluator is a separate model that has no stake in the
answer; here you are judging your own work, so the honest failure mode is declaring victory early.
Judge only on evidence visible in this conversation — never assume a file, command, or test changed
unless the conversation shows it.

## Blocker vocabulary (all six, exactly)

`none` (satisfied only) · `goal_not_met_yet` (useful autonomous work can continue — the only
blocker that continues the loop) · `missing_evidence` (evidence too weak to prove progress; the
fail-closed default) · `needs_user_input` · `run_failed` · `external_wait`.

## Inspecting the loop

`status` prints the whole goal record, including `continuation_count`, `no_progress_count`, and
`last_evaluation` (blocker, reason, evidence summary, and `stand_down_reason` when the loop
stopped). Read it before re-setting a goal that already stood down — re-setting resets the counters.

## Divergence from DeerFlow

The evaluator is not independent here: a Claude Code hook cannot call a model, so the rubric is
handed back to this session instead of to a separate evaluator. The cap, the breaker and the
evidence gate are unchanged and remain outside model control. See `parity/DISCREPANCIES.md` (M11).
