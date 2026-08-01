# Attribution

This directory is a source port of **DeerFlow** — https://github.com/bytedance/deer-flow — at commit `095092418ccf072aa866c0a663c4056c206091e5` (2026-08-01), under the upstream project's license (see the repository root `LICENSE`).

- Prompts, skill bodies, memory extraction YAMLs, and the subagent status contract are reused **verbatim** from upstream (sha256-attributed where copied; see `prompts/memory/ATTRIBUTION.md`).
- TypeScript modules under `src/` are **structural or mechanical translations** of the upstream Python; every file carries a provenance header naming its source file, symbol, and commit.
- Every deliberate behavioral deviation is recorded in `parity/DISCREPANCIES.md`.
- The port-to-original mapping is maintained in `docs/claude-code-port/traceability-matrix.md`.
