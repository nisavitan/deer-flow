# Implementation roadmap (planning only — not executed)

Source basis: commit `095092418ccf072aa866c0a663c4056c206091e5` · 2026-08-01.

Architecture: `recommended-architecture.md`. Complexity scale: Small / Medium / Large / Research-heavy. No calendar estimates. Every milestone ends with the mandatory deep-review phase gate (implement in verifiable steps → run parity/tests → fix → re-verify → commit).

## M1 — Plugin & workflow foundation — **Medium**
- Objective: installable `deerflow` plugin skeleton; `/deerflow:run` reaches a stub deep-run workflow; Workflow-tool permission documented.
- Original files: none ported yet (structure per `recommended-architecture.md` §1).
- Target: `ports/claude-code/{.claude-plugin,skills/run,workflows/deep-run.js,hooks/hooks.json}`.
- Parity tests: install + invoke smoke (headless `claude -p "/deerflow:run ping"`).
- Acceptance: plugin loads via `--plugin-dir` and `claude plugin install` from git; commands namespaced; no servers/keys.
- Risks: plugin/workflow permission UX. Rollback: delete plugin dir.
- Depends: —.

## M2 — State schema & atomic state library — **Medium**
- Objective: `.deerflow/state/<thread>/` channels with reducer semantics + commit-SHA binding + schema_version.
- Original: `agents/thread_state.py` (reducers), `runtime/runs/schemas.py` (run identity).
- Target: `src/state/*.ts` + tests.
- Parity tests: Tier-1 reducer vectors (delegations ledger: same-id-latest-wins, terminal-never-downgraded, cap; skill-context dedup 8; goal merge).
- Acceptance: vectors extracted from original tests pass; atomic write proven (kill mid-write leaves old state).
- Risks: single-writer assumption. Rollback: state dir is disposable.
- Depends: M1.

## M3 — Lead-agent port (prompt + run skill) — **Large**
- Objective: `/deerflow:run` session behaves per lead policy: benefit-based delegation, artifact rules, terminal-response discipline, plan mode.
- Original: `agents/lead_agent/prompt.py` (all section builders), `factory.py` todo prompts.
- Target: `src/prompts/lead.ts`, `skills/run/SKILL.md`, `skills/plan/SKILL.md`.
- Parity tests: prompt-section snapshot tests against original renders (same inputs → same text modulo platform substitutions, each substitution whitelisted); black-box scenarios: simple research, decomposition.
- Acceptance: every original prompt section accounted (reused/adapted/whitelisted-dropped) in prompts-and-skills-map.md terms.
- Risks: prompt-cache/format drift. Rollback: skill disable.
- Depends: M1.

## M4 — Skill loading & public skills port — **Medium**
- Objective: 23 public skills carried over; slash + auto invocation; allowed-tools mapped.
- Original: `skills/public/**`, `skills/{parser,slash,catalog}.py` semantics.
- Target: `ports/claude-code/skills/**`.
- Parity tests: skill selection scenario (auto + `/deerflow:<skill>`); per-skill smoke for adapted bodies.
- Acceptance: dispositions from prompts-and-skills-map.md implemented; held-back skills documented.
- Risks: external-API-dependent skills (hold-back list). Rollback: per-skill disable.
- Depends: M1.

## M5 — Tool registry mapping & sandbox contract — **Medium**
- Objective: native tool mapping (bash/read/write/edit/glob/grep), `outputs/` artifact convention, env-scrub hook, permission preset.
- Original: `sandbox/tools.py`, `sandbox/env_policy.py`, `tools/builtins/present_file_tool.py` contract.
- Target: hooks/bin/pre-tool-guard (scrub), config permission preset, docs.
- Parity tests: secret-file protection, artifact output scenarios.
- Acceptance: env scrub list identical to source patterns; outputs contract observable.
- Depends: M1.

## M6 — Subagent port (agents + deep-run caps) — **Large**
- Objective: general-purpose/bash agents (verbatim prompts), deep-run.js enforcing 3-concurrent/6-total/1800 s, stop_reason taxonomy, ledger capture, result contract from `contracts/subagent_status_contract.json` (reused unchanged).
- Original: `subagents/{executor,registry,builtins/*,status_contract}.py`, `tools/builtins/task_tool.py`.
- Target: `agents/*.md`, `workflows/deep-run.js`, `src/policy/caps.ts`.
- Parity tests: fan-out, fan-in, subagent failure, timeout, cancellation scenarios; Tier-1 cap-clamping vectors.
- Acceptance: caps enforced in code regardless of model behavior; contract JSON round-trips.
- Risks: timeout enforcement needs wall-clock logic in script. Rollback: workflow versioned.
- Depends: M2, M3.

## M7 — Middleware port (hooks) — **Large**
- Objective: per `middleware-port-plan.md`: pre-tool-guard, post-tool-meta (8-type taxonomy), loop-progress-guard (window 20, 3/5; freq 30/50; progress state machine), read-before-write, turn-context injection.
- Original: `agents/middlewares/*` (the deterministic subset).
- Target: `hooks/bin/*`, `src/policy/*`.
- Parity tests: Tier-1 vectors per middleware (from original test names); loop detection, tool error, malformed-result black-box scenarios.
- Acceptance: deterministic middlewares bit-parity on vectors; relocated ones behavior-verified.
- Depends: M2.

## M8 — Context & summarization — **Medium / Research-heavy edge**
- Objective: native auto-compaction integration + durable `summary.json` digest + `/deerflow:compact`; deep-run-layer exact summarization if needed.
- Original: `agents/middlewares/summarization_middleware.py`, `runtime/context_compaction.py`.
- Parity tests: context-overflow scenario (documented allowed differences).
- Depends: M2, M7.

## M9 — Memory — **Medium**
- Objective: DeerMem-shaped auto-memory layout (single-fact files + index), extraction prompts reused (4 YAMLs), write-gate policy, injection budget discipline.
- Original: `agents/memory/**` (deermem core), prompts YAMLs verbatim.
- Parity tests: memory-injection scenario; extraction-gate vectors.
- Depends: M2.

## M10 — Checkpoints & resume — **Large**
- Objective: run-meta lifecycle, cross-session deep-run resume from state files + journal, stale-commit invalidation, orphan-recovery behavior.
- Original: `runtime/runs/worker.py` (behavioral subset), `runtime/checkpoint_*` semantics per `state-checkpoint-resume.md`.
- Parity tests: interrupted run, resume, changed-repo-after-checkpoint scenarios.
- Depends: M2, M6.

## M11 — Error & retry behavior — **Medium**
- Objective: terminal-response discipline, tool-error taxonomy surfaced to model, retry policy, goal-loop stop-goal-evaluator hook (cap 8, breaker 2, evaluator prompt reused).
- Original: `tool_error_handling_middleware.py`, `terminal_response_middleware.py`, `runtime/goal.py`.
- Parity tests: retry, dangling-tool-call, evidence-validation scenarios; goal-loop counter vectors.
- Depends: M7.

## M12 — Permissions & sandboxing preset — **Small**
- Objective: shipped allow/deny preset + sandbox settings guidance mirroring DeerFlow authz defaults.
- Parity tests: permission-denial scenario.
- Depends: M5.

## M13 — Artifacts & workspace changes — **Medium**
- Objective: outputs delivery contract + pre/post workspace diff summary (behavioral essence of workspace_changes) surfaced in final message.
- Original: `workspace_changes/*` (limits preserved), delivery-receipt invariant (present-before-done).
- Parity tests: artifact output, final synthesis scenarios.
- Depends: M5, M6.

## M14 — Full parity suite — **Large**
- Objective: complete Tier-1 vector suite + all 24 Tier-2 black-box scenarios green per thresholds in `parity-test-plan.md`.
- Acceptance: pass thresholds met; every allowed-difference documented; no silent gaps.
- Depends: M1–M13.

## M15 — Packaging & installation — **Small**
- Objective: marketplace/git install path, version pinning to upstream release, ATTRIBUTION, install docs (`claude plugin install` → `/deerflow:run`).
- Depends: M14.

## M16 — Upstream synchronization — **Medium**
- Objective: sync playbook: fetch upstream → diff engine paths → map to port units via traceability matrix → re-run parity suite.
- Acceptance: one dry-run sync against a newer upstream commit executed.
- Depends: M14, M15.

Dependency spine: M1 → M2 → {M3,M4,M5,M7,M9} → M6 → {M8,M10,M11,M12,M13} → M14 → M15 → M16.
