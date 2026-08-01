# Open questions

Source basis: commit `095092418ccf072aa866c0a663c4056c206091e5` · 2026-08-01.

Questions that implementation (not planning) must answer, plus genuine user decisions. None blocks the go decision; each is bound to a milestone.

## Needs a user decision

1. **Distribution channel**: publish a marketplace for `claude plugin install deerflow@…`, or document git-URL install only? (M15) — cost/benefit is publishing overhead vs one-command install.
2. **Skill hold-backs**: for skills whose bodies call external providers (GEMINI/MINIMAX-keyed), prefer hold-back (drop from v1) or adapt-to-native (rewrite those calls to native capabilities, a documented behavior change)? (M4)
3. **Lead-session vs deep-run summarization**: is approximate (native) summarization acceptable for the lead thread in v1, with exact DeerFlow summarization only inside deep-run? Recommendation: yes; revisit after parity data. (M8)
4. **Port language**: hooks/state lib in TypeScript (recommended — types for contracts, single toolchain with workflows) vs plain JS/bash. (M1)

## Needs implementation-time investigation

5. Hook payload guarantees for PostToolUse `updatedToolOutput` on every tool type (verified for docs; test per-tool in M7).
6. Whether `Stop`-hook continuation can carry the goal-evaluator verdict verbatim as hidden context, or must phrase it as a user-style message (M11); affects transcript cleanliness only.
7. Best mechanism for deep-run cancellation mid-fan-out mapping to `task_cancelled` semantics (TaskStop granularity) (M6).
8. Auto-memory index-size discipline vs DeerMem 2000-token injection budget — measure real sizes with 23 skills + memory (M9).
9. Workflow journal retention lifetime across CLI versions (affects cross-session resume window; state files are the fallback authority) (M10).
10. Whether plugin `settings.json` can pre-seed the Workflow permission to remove the one-time prompt (M15).

## Deferred by scope (recorded, not planned)

- IM-channel equivalents (Slack/Feishu bridges) — delivery layer, out of scope; native "channels" plugins could revisit later.
- Scheduler service → could map to native scheduled agents (cron) in a follow-up.
- Multi-user isolation — meaningless in single-user CLI context.
- Browser-automation toolset — native Chrome integration exists; separate evaluation.
