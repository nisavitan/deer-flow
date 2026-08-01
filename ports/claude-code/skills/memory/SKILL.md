---
name: memory
description: Show or update DeerFlow's durable cross-session memory - rolling user/history summaries plus atomic facts under .deerflow/memory. Use when the user invokes /deerflow:memory, asks what you remember about them, or asks you to remember, forget, or refresh something durable.
allowed-tools: Bash, Read, Write
---

<!-- Ported from backend/packages/harness/deerflow/agents/memory/** @ 0950924 (DeerMem backend:
     deer_mem.py, core/storage.py, core/updater.py, core/prompt.py) — structural translation.
     Traceability: docs/claude-code-port/traceability-matrix.md §7 rows for agents/memory/**.
     The extraction prompts in prompts/memory/*.yaml are byte-verbatim upstream assets. -->

# DeerFlow memory

DeerFlow keeps durable, cross-session memory about the **user** — never about the current task.
Storage lives under `.deerflow/memory/` in the DeerMem v2 shape:

```
.deerflow/memory/
├── memory.json                 # six rolling summary slots (never facts, never an index)
├── facts/{2hex}/{fact-id}.md   # one atomic fact per file; {2hex} = sha256(fact_id)[:2]
└── queue.jsonl                 # conversations captured by the Stop hook, awaiting extraction
```

## The one rule that matters

**You may propose memory writes. You may never perform them.**

Every write passes through a deterministic gate implemented in code
(`dist/memory/gate-cli.js`), which is the port of DeerFlow's `_apply_updates` scope gate. The
gate — not you — decides what is eligible. Do not hand-write files under `.deerflow/memory/`,
do not "fix up" a rejection by relabelling a fact and resubmitting it, and do not treat a
rejection as a problem to route around. A high rejection rate is the system working.

## `/deerflow:memory` — show current memory

Run:

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/memory/store-cli.js render
```

Report to the user, in prose: the six summary slots that have content, the total fact count and
the per-category breakdown, and the queue depth (`store-cli.js queue-read`) if it is non-empty.
Mention `unreadableFactFiles` only when it is non-empty — that is real corruption worth naming.
Do not paste the raw JSON.

## `/deerflow:memory update` — process the capture queue

Run these six steps in order. Stop and report if any step fails; never skip to a later step.

### 1. Read the queue

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/memory/store-cli.js queue-read
```

If `entries` is empty, tell the user there is nothing to extract and stop.

### 2. Read current memory

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/memory/store-cli.js render
node ${CLAUDE_PLUGIN_ROOT}/dist/memory/store-cli.js list
```

`list` gives you every stored fact **with its id** — you need those ids to propose a removal or a
consolidation group.

### 3. Apply the extraction prompt

Read `${CLAUDE_PLUGIN_ROOT}/prompts/memory/memory_update.chat.yaml` and follow it as written. It
is DeerFlow's own prompt, copied byte-for-byte, and it is the specification for this step:
the structured reflection (error/retry detection, user-correction detection, project-constraint
discovery), the six section length guidelines, the fact categories, the `expected_valid_days`
lifetime tiers, the confidence tiers, and the exact output JSON.

Substitute its placeholders yourself:

- `{current_memory}` — the summaries and facts from step 2;
- `{conversation}` — the queued `user` / `assistant` pairs from step 1;
- `{staleness_review_section}` — only if you are also reviewing aged facts; render
  `prompts/memory/staleness_review.yaml`;
- `{consolidation_section}` — only if a category has grown fragmented; render
  `prompts/memory/consolidation.yaml`. Consolidation is **off by default upstream** ("consolidation
  is lossy … opt in explicitly"), so propose it only when the user asked for a cleanup.

Note that `{{` / `}}` in those files are escaped literal braces.

Every proposed fact **must** carry `scope`, `durability` and `authority`. A fact without all three
is rejected. When uncertain, the prompt tells you to classify as thread/project or temporary —
follow that. Never guess `user` + `durable`.

### 4. Gate the proposal

Write your extraction output (the JSON the prompt specifies, wrapped as `{"proposal": { ... }}`)
to a temp file with the `Write` tool, then:

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/memory/gate-cli.js < /tmp/deerflow-memory-proposal.json
```

The gate reads the existing fact inventory itself, and returns `acceptedFacts`,
`acceptedSummaries`, `acceptedRemovals`, `trimmedExistingIds`, `rejections` and `rejectionRate`.
It enforces:

| Rule | Value | Source |
|---|---|---|
| accept only `scope=user` + `durability=durable` + `authority=descriptive` | — | `_apply_updates` scope gate |
| summaries: wholly user-scoped + descriptive | — | same |
| confidence threshold | 0.7 | `fact_confidence_threshold` |
| fact cap, lowest-confidence trimmed | 100 | `max_facts` |
| `expected_valid_days` creation clamp | 1800 (90 x 20) | `staleness_age_days` x `staleness_max_lifetime_multiplier` |
| removals need object form with `id` + `scope` + `reason` | — | same |
| thread/project removals | fail closed | same |
| paired removal runs only if its replacement survived | — | same |

If `warnHighRejectionRate` is true (>60% rejected), say so plainly in your summary — upstream
treats that as a signal that the prompt or the classification has drifted.

### 5. Persist what was accepted

Pipe the gate's output straight through — do not edit it in between:

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/memory/gate-cli.js < /tmp/deerflow-memory-proposal.json \
  | node ${CLAUDE_PLUGIN_ROOT}/dist/memory/store-cli.js apply
```

`apply` writes each accepted fact to its sharded path, merges accepted summaries into
`memory.json`, deletes accepted removals, consolidation sources, and trimmed ids, and reports
`writtenFactIds` / `deletedFactIds`.

### 6. Clear the queue

Only after step 5 reported success:

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/memory/store-cli.js queue-clear
```

If step 5 failed, leave the queue alone — the batch is re-processed next turn, which is exactly
how upstream behaves when a queued update is dropped (the watermark does not advance).

Finally, tell the user what changed: facts added, facts removed, summary slots rewritten, and
anything notable the gate rejected.

## How conversations reach the queue

A `Stop` hook (`dist/hooks/memory-extract.js`) appends the turn's last user message and last
assistant response to `queue.jsonl` after every turn. It never blocks and never speaks.

This is the port's **declared approximation** of DeerFlow's 30-second debounce: Claude Code has
no long-lived process to host a timer thread, and a hook must not block a turn on an LLM call.
The queue survives; the timer does not. Batches are therefore extracted **on the next turn**
rather than 30 seconds later. See `parity/DISCREPANCIES.md`.

## What never goes into memory

From the upstream prompt, verbatim in intent:

- current-task objectives, acceptance criteria, workspace state, exact current file/commit/error state;
- project-only constraints (they are `scope=project`, not `scope=user`);
- one-time action permissions and any other **transactional** content — "edit this", "push that",
  "you may delete X". An instruction is never a durable fact about a person;
- **file upload events** — the prompt calls this out explicitly; uploads are session-specific and
  recording them confuses later conversations.

## Injection

`src/memory/injection.ts` renders the `<memory>` block: the six summaries plus facts selected
greedily in confidence order within a 2000-token budget, with `correction` facts guaranteed a
separate 500-token sub-budget and placed first so ordinary facts cannot evict them. Every
user-editable value is HTML-escaped, so a stored fact containing `</memory>` cannot close the
trust zone.

## Retrieval

There is no search index. Upstream ships an SQLite FTS5/BM25 adapter; the port omits it and uses
the substring fallback that DeerMem itself keeps as its always-available path, plus your own
reading of `store-cli.js list`. At the ~100-fact `max_facts` ceiling this is adequate. See
`parity/DISCREPANCIES.md`.
