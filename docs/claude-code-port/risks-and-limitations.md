# Risks and limitations

Commit basis `0950924`, 2026-08-01. Severity: High / Medium / Low. Each entry: risk → evidence class → mitigation.

## Unavoidable behavioral differences (accepted, documented)

1. **Summarization parity is approximate** (High visibility, Low harm). Native auto-compaction has no configurable trigger/keep policy; DeerFlow's `("messages", 20)` keep and token triggers cannot be reproduced in the lead session. [Verified from official documentation + source]. Mitigation: durable `summary.json` digest; exact summarization implementable inside deep-run workflow layer; parity test allows the difference explicitly.
2. **Model-request rewriting has no hook point** (Medium). DynamicContext/DurableContext/ViewImage/InputSanitization classes relocate to turn-boundary injection (UserPromptSubmit `additionalContext`) or become platform-native. Same information, different position; prompt-cache behavior differs. [Verified experimentally + docs].
3. **Checkpoint granularity** (Medium). LangGraph per-superstep multi-channel snapshots → session-turn + workflow-stage + atomic state files. No cross-file transaction. Guarantee table in `state-checkpoint-resume.md`; accepted because port is single-writer/single-process. [Design].
4. **Model diversity is gone by design** (Low, constraint-mandated). All original multi-provider machinery (models/*, thinking toggles for Qwen/DeepSeek, vision flags) is replaced by Claude-family models on the subscription. This is the assignment's constraint, not a regression.
5. **Multi-user/multi-worker semantics collapse** (Low). user_id isolation, leases, cross-worker cancel → single-user CLI reality. Observable invariants (turn identity, receipt-before-done ordering) preserved at file level.
6. **Delegation concurrency ceiling differs upward** (Low). Workflow runtime allows up to 16 concurrent agents; port enforces DeerFlow's 3/6 caps in code to preserve behavior — configurable like the original (1-4 / 1-50 clamps).

## Platform risks

7. **Workflow cross-session resume is same-session only** (High → mitigated to Medium). [Verified from official documentation + E3-b]. Mitigation: port-owned state files + journal re-read; M10 designs cross-session recovery; parity scenario "interrupted run/resume" gates it.
8. **Workflow tool requires permission grant** (Low). One-time install note; headless usage needs `--allowedTools "Workflow"`. [Verified experimentally E1-c].
9. **Platform API surface evolution** (Medium). Hooks/workflow contracts are young; a CLI update could shift JSON schemas. Mitigation: pin minimum CLI version (≥2.1.154; verified on 2.1.220), keep hook payload parsing tolerant, CI smoke on CLI updates.
10. **Auto-compaction may fire mid-deep-run in the lead session** (Medium). Could evict delegation context the lead needs; mitigated by durable-context state files re-injected each turn (mirrors DeerFlow's own design intent: survive compaction via `summary_text`/ledger — the original solved the same problem). [Verified from source — DurableContextMiddleware exists precisely for this].

## Port-fidelity risks

11. **Prompt drift during translation** (High). The lead prompt is the single most behavior-defining asset. Mitigation: snapshot tests against original renders with whitelisted substitutions only (M3); attribution headers with symbol@SHA.
12. **Loop-detection/tool-progress translation bugs** (Medium). Mitigation: Tier-1 vectors extracted from the original ~80 loop tests + 47 summarization tests etc. (parity-test-plan Tier 1).
13. **required-secrets has no native equivalent** (Low today). Zero public skills declare it [Verified from source — grep], so nothing breaks now; documented gap for custom skills; candidate future mechanism: env passthrough via hook-managed allowlist, never persisted.
14. **Skills calling external providers** (Medium). Some skill bodies reference GEMINI/MINIMAX env keys — violates the no-external-provider constraint. Mitigation: hold-back or adapt-to-native dispositions per prompts-and-skills-map.md; the mechanism (skill body) stays faithful, the external call is the excluded part.
15. **`claude_provider.py` pattern must never leak into the port** (High, compliance). The original repo contains OAuth-credential reuse code — explicitly excluded; CI grep in the port repo for credential paths (`.credentials.json`, `sk-ant-oat`) as a guard. [Verified from source].
16. **Upstream velocity** (Medium). DeerFlow moves fast (4589 PRs). Mitigation: M16 sync playbook keyed on the traceability matrix; prompts/skills merge mechanically.

## Honest coverage gaps in this planning phase

- LangChain's inherited `SummarizationMiddleware` internals (`_should_summarize` cutoff logic) were cited as inherited, not source-read (package not vendored). Affects one middleware's Tier-1 vectors; flagged in notes/middlewares.md §coverage.
- Live failure-propagation inside `parallel()` and PostToolUse `updatedToolOutput` rewrite: contract-verified, not force-tested (experiment-results.md).
- `claude plugin install` from a published marketplace not exercised (nothing published yet); `--plugin-dir` + CLI surface verified.
- Frontend/e2e tests were categorized, not deep-read (delivery-layer, excluded from port).
