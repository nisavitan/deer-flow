# Context-loss measurements — recorded runs

Environment: Claude Code 2.1.220, plugin loaded via `--plugin-dir`, model haiku, fixture `case-01.json` (12 items: 4 facts, 2 decisions + 2 constraints, 1 style rule, 3 files; 6 probes). Date: 2026-08-01.

## Measurement A — resume recall (live, PASSED)

Procedure (per RUNBOOK case a):
1. Seeded a session with the 12 `seed` sentences (`claude -p`, session `ccc44935…`). Reply: OK.
2. Resumed in a **separate process** (`claude -p --resume`), asked all 6 probes.
3. Scored the answers with the deterministic harness (`dist/summary/context-loss-cli.js --fixture case-01.json`).

Result:
```json
{"items_total":12,"items_recalled":12,"recall_rate":1,"lost_items":[]}
```
**12/12 recall across process boundaries.** Session persistence carries the full seeded knowledge; the port's state files were not needed for this leg (they cover the structured channels, not conversation memory).

## Measurement B — compaction recall (headless attempt: NOT TRIGGERABLE; deferred to interactive session)

Attempted to trigger auto-compaction by context flooding in the seeded session:
- Round 1: 10 large file reads → `READS-DONE`, no PreCompact fire (0 `precompact` lines in hooks.jsonl).
- Round 2: 9 more large reads → **`Prompt is too long`** (`is_error: true`) — the resumed history exceeded the window at prompt assembly, and print-mode did **not** auto-compact before failing.
- Round 3 (calibrated small nudge): same `Prompt is too long` — the session is past the limit; every further `-p --resume` fails.

**Honest finding:** in headless (`-p`) mode, an overflowing session is not rescued by auto-compaction; the PreCompact flush path therefore could not be demonstrated live headlessly. Its correctness evidence remains: unit tests (queue write on digest path) + subprocess smoke (hook exits 0, writes summary.json + queue entry when invoked with a PreCompact payload). The live demonstration moves to the interactive joint session: run `/compact` in a seeded interactive session (PreCompact fires on manual compaction), then resume + probes + scorer (RUNBOOK case b).

**Platform finding recorded for risks:** headless deep work must not rely on auto-compaction; the port's architecture already answers this — heavy context goes to deep-run subagents with fresh contexts, and durable continuity lives in the state files, not the conversation window.
