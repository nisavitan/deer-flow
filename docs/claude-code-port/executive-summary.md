# Executive summary — DeerFlow → Claude Code faithful source port (planning phase)

Date: 2026-08-01 · Upstream commit: `095092418ccf072aa866c0a663c4056c206091e5` (bytedance/deer-flow, main) · Fork: `https://github.com/nisavitan/deer-flow` · Planning branch: `port/claude-code-architecture` · Claude Code CLI: `2.1.220` (Max subscription, claude.ai OAuth, no API key).

## Recommendation: **PROCEED WITH FULL PORT** (Option B), with documented limitations

All seven decision gates passed with executed evidence (`experiment-results.md`). No fundamental blocker was found. The recommended architecture is a single **`deerflow` Claude Code plugin**: interactive session as the lead thread (ported lead prompt), **Dynamic Workflows** as the deterministic orchestration core (delegation caps 3/6, timeouts, stop_reason taxonomy, goal loop), **hooks** as deterministic middleware (tool-boundary guards, tool-meta taxonomy, loop detection), **native sessions** + port-owned atomic state files for state/checkpoint/resume, and DeerFlow's prompts/skills/contracts **reused verbatim** wherever the platform permits.

## What was established

1. **Source truth**: 2,115 tracked files classified (`repository-inventory.md`); the 443-file harness engine mapped from source with symbol/line citations across 7 analysis notes (~500 KB) synthesized into `original-runtime-map.md` (11 lifecycles, 3 diagrams).
2. **Engine vs delivery**: the TUI + `DeerFlowClient` prove the engine runs without any HTTP layer; gateway/frontend/channels/DB/Redis are delivery infrastructure, each exclusion justified (`engine-boundary.md`).
3. **Platform truth**: capabilities verified against official docs *and* the installed CLI *and* seven executed experiments — including the two load-bearing ones: a **plugin-packaged workflow** invoked as `/deerflow-poc:wf-hello` running subagents on the Max plan, and **resume replaying 3 completed agents from cache in 14 ms with 0 tokens**.
4. **Constraint compliance**: no API key, no servers, no OAuth handling, no DeerFlow Python runtime. The Agent SDK path is disqualified by Anthropic's own auth policy (API-key-only); notably, DeerFlow's `models/claude_provider.py` implements exactly the forbidden OAuth-reuse pattern and is excluded with a CI guard planned.

## Headline numbers (derived from the 195-row traceability matrix)

- **Engine behavior preserved (exact + approximate): ≈88%** of in-scope engine behaviors (28.8% exact, 59.0% approximate; 12.2% consciously dropped, each with a stated reason).
- **Original source reused or translated: ≈47%** of matrix rows (9 reuse rows cover the largest assets — 104 public-skill files, memory prompt YAMLs, the subagent status contract JSON, subagent role prompts; 82 rows are mechanical/structural translations). The remainder is *deleted*, not rewritten — replaced by native platform primitives or excluded as delivery.

## Major unavoidable differences (full list: `risks-and-limitations.md`)

1. Lead-session summarization is approximate (native auto-compaction is not threshold-tunable); exact DeerFlow semantics available inside deep-run.
2. Model-request-rewriting middlewares relocate to turn-boundary injection (no hook point exists); several provider-compat middlewares are obsolete on a Claude-only platform.
3. Checkpoint granularity: per-superstep LangGraph snapshots → session-turn + workflow-stage + atomic state files (guarantee deltas tabulated in `state-checkpoint-resume.md`).
4. Multi-provider model support is replaced by Claude models — mandated by the assignment's constraints.

## Deliverables index

`repository-inventory.md` · `original-runtime-map.md` · `engine-boundary.md` · `claude-code-capabilities.md` · `experiment-results.md` · `traceability-matrix.md` · `middleware-port-plan.md` · `state-checkpoint-resume.md` · `prompts-and-skills-map.md` · `parity-test-plan.md` (7 vector groups + 24 scenarios) · `architecture-options.md` · `recommended-architecture.md` · `implementation-roadmap.md` (16 milestones, no calendar dates) · `risks-and-limitations.md` · `open-questions.md` · `notes/` (7 source-analysis files) · `experiments/claude-code-port/` (PoC plugin + raw evidence log).

## Next step

Milestone M1 (plugin & workflow foundation) per `implementation-roadmap.md`, after the four user decisions in `open-questions.md` §1 are taken (distribution channel, skill hold-backs, v1 summarization stance, port language — recommendations provided for each).
