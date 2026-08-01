# Port implementation progress

Central status doc. Updated at every milestone. Upstream basis: `0950924`. Branch: `port/claude-code-architecture`.

User decisions in force (2026-08-01): TypeScript · install from fork/local only (no marketplace before parity + clean-env install) · provider-dependent skills = optional modules, disabled by default, capability detection · v1 summarization = native compaction + structured checkpoint summaries, delta documented, context-loss parity tests required.

| Milestone | Status | Commit | Tests (exit code) | Known gaps | Next |
|---|---|---|---|---|---|
| Baseline | **done** | `dc7c7ab9` | Original anchor suite 532 passed (exit 0); extractor deterministic (byte-identical reruns) | Live-model baseline of original blocked by no-API-key constraint (baseline/README.md, 5 recorded skips) | — |
| M1 foundation | **done** | `e2be20c2` | Headless smokes pass (PONG, hook log, deep-run stub) | stubs replaced in M3/M6 | — |
| M2 state library | **done** | `98c4f34e` | 164 vitest tests, 115 baseline vectors consumed, 0 discrepancies (exit 0) | sessions.json/summary.json channels land in M8/M10 | — |
| M3 lead prompt | **done** | `b909c403` | 0 unexplained diffs vs 3 golden renders; drift detection proven; 197 tests total (exit 0) | memory turn-context injection deferred to M9; clamps consolidated onto policy/caps.ts | — |
| M4 skills | **done** | `cf8bec25` | 23/23 skills carried (16 regular + 7 optional gated); headless body-load smoke passed | root tests/skills still target original tree (parity test in M14) | — |
| M5 tools/sandbox | in progress | — | — | — | — |
| M6 subagents/deep-run | in progress | — | — | — | — |
| M7 middleware hooks | pending | — | — | — | — |
| M8 context/summarization | pending | — | — | — | — |
| M9 memory | pending | — | — | — | — |
| M10 checkpoints/resume | pending | — | — | — | — |
| M11 errors/goal loop | pending | — | — | — | — |
| M12 permissions | pending | — | — | — | — |
| M13 artifacts | pending | — | — | — | — |
| M14 parity suite | pending | — | — | — | — |
| M15 packaging | pending | — | — | — | — |
| M16 upstream sync | pending | — | — | — | — |

Rules in force: separate commit per milestone; traceability-matrix.md updated with every replaced component; nothing marked "ported" without code + passing parity test; parity outcomes labeled exact / approximate / intentionally omitted / blocked; independent verifier after every significant milestone.
