# Port implementation progress

Central status doc. Updated at every milestone. Upstream basis: `0950924`. Branch: `port/claude-code-architecture`.

User decisions in force (2026-08-01): TypeScript · install from fork/local only (no marketplace before parity + clean-env install) · provider-dependent skills = optional modules, disabled by default, capability detection · v1 summarization = native compaction + structured checkpoint summaries, delta documented, context-loss parity tests required.

| Milestone | Status | Commit | Tests (exit code) | Known gaps | Next |
|---|---|---|---|---|---|
| Baseline | in progress | — | Original anchor suite: 532 passed (247+285, exit 0). Vector extraction running. | Live-model baseline of original blocked by no-API-key constraint (documented in baseline/README.md) | Commit vectors |
| M1 foundation | implemented, pending commit | — | Smoke: `/deerflow:run ping` → `DEERFLOW-M1-PONG` (exit 0); compiled hook fired (`.deerflow/m1-smoke.log`: `PRE Bash`); plugin deep-run stub → `DEEP-RUN-M1-OK` | run skill + deep-run are declared stubs (replaced M3/M6) | Commit after baseline |
| M2 state library | pending | — | — | — | — |
| M3 lead prompt | pending | — | — | — | — |
| M4 skills | pending | — | — | — | — |
| M5 tools/sandbox | pending | — | — | — | — |
| M6 subagents/deep-run | pending | — | — | — | — |
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
