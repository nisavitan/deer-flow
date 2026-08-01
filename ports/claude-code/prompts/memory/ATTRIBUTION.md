# Memory extraction prompts — attribution

The four `.yaml` files in this directory are **byte-verbatim copies** of DeerFlow's
bundled DeerMem extraction prompts. They are assets, not translations: the port method
recorded in `docs/claude-code-port/traceability-matrix.md` for
`deermem core/prompts/*.yaml` is **reuse unchanged**, because the prompt text *is* the
extraction behavior (scope/durability/authority classification, lifetime tiers,
confidence tiers, the output-JSON contract that `src/memory/write-gate.ts` gates).

| File | Upstream path (commit `0950924`) | sha256 (first 16) |
|---|---|---|
| `memory_update.chat.yaml` | `backend/packages/harness/deerflow/agents/memory/backends/deermem/deermem/core/prompts/memory_update.chat.yaml` | `4a89062414e79366` |
| `staleness_review.yaml` | `.../core/prompts/staleness_review.yaml` | `f5c7bfb78b801342` |
| `consolidation.yaml` | `.../core/prompts/consolidation.yaml` | `57fdb1315bca30ff` |
| `fact_extraction.yaml` | `.../core/prompts/fact_extraction.yaml` | `5cf5a84939043a06` |

Verify at any time from the repo root:

```bash
diff -r ports/claude-code/prompts/memory \
        backend/packages/harness/deerflow/agents/memory/backends/deermem/deermem/core/prompts \
        --exclude=ATTRIBUTION.md
```

## Placeholder contract

The upstream files are consumed by Python `str.format`, so `{{` / `}}` are *escaped
literal braces* and single-brace tokens are substitution points. `src/memory/extraction-prompt.ts`
reproduces both rules exactly:

- `memory_update.chat.yaml` (`format: chat`) — `{current_memory}`, `{conversation}`,
  `{correction_hint}`, `{staleness_review_section}`, `{consolidation_section}`.
- `staleness_review.yaml` (`format: text`) — `{stale_facts}`.
- `consolidation.yaml` (`format: text`) — `{consolidation_groups}`, `{max_groups}`.
- `fact_extraction.yaml` (`format: text`) — `{message}`. **Dormant upstream** (no runtime
  caller, excluded from construction-time validation, per `deer_mem.py:146-147`); copied
  here for completeness and likewise not wired to a caller in this port.

## Licence

These files ship under the DeerFlow repository licence (see the repo-root `LICENSE`).
Do not edit them in place — an edited template makes the deterministic write gate in
`src/memory/write-gate.ts` reject every proposed write (the upstream fail-closed
behavior for un-migrated custom prompts, `notes/skills-and-memory.md` §4).
