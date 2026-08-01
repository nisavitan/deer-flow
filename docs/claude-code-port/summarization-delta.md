# Summarization delta — DeerFlow `SummarizationMiddleware` vs the Claude Code port

Source base: commit `0950924`, branch `port/claude-code-architecture`. Date: 2026-08-01. Milestone: **M8**.

User decision in force: *v1 summarization = Claude Code native compaction + structured checkpoint summaries + atomic state; the delta vs the original `SummarizationMiddleware` must be documented explicitly, and parity tests must MEASURE context loss after compaction/resume* (PROGRESS.md, "User decisions in force").

Inputs: `notes/middlewares.md` §2.17 (`DurableContextMiddleware`) and §2.18 (`DeerFlowSummarizationMiddleware`); `backend/packages/harness/deerflow/agents/middlewares/summarization_middleware.py`; `backend/packages/harness/deerflow/runtime/context_compaction.py`; `state-checkpoint-resume.md` §2.3 (`summary.json`); `claude-code-capabilities.md` §10 (compaction); `experiment-results.md` E4 (hook payloads).

Classification legend (same vocabulary as the traceability matrix): **exact** · **approximate** · **omitted** · **blocked**.

---

## 1. The one-paragraph version

DeerFlow owns *when* to compact, *what* to keep, *what the summary says*, and *where it is stored*. The port owns exactly one of those four: where it is stored. Claude Code decides when compaction happens (~85% of the context window, not tunable), what survives it, and what its summary says — and it exposes one control point, the `PreCompact` hook, which fires before compaction with `transcript_path` and `session_id` but cannot alter the outcome and must not call a model. The port therefore stops trying to reproduce the middleware and instead makes the *durable* half survive: a deterministic digest of structured state (`summary.json`), written atomically at every compaction boundary and re-injected on the next turn through the durable-context projection. What is genuinely lost is prose recall of the compacted conversation itself; §4 is the measurement that quantifies it rather than asserting it away.

---

## 2. Delta table

| # | Dimension | Original (`0950924`) | Port (M8) | Class | Consequence | Mitigation |
|---|---|---|---|---|---|---|
| 1 | **Trigger** | `_prepare_compaction` counts tokens over `messages` **plus** a synthetic `HumanMessage(name="summary")` carrying the previous `summary_text`, then defers to `_should_summarize(trigger_messages, total_tokens)`; `trigger` is config (tokens / messages / fraction-of-max, OR-combined list) [summarization_middleware.py:458-481; notes/middlewares.md §2.18] | Claude Code auto-compaction at ~85% of the context window. No threshold, no OR-list, no fraction; the existing summary does not weigh into the trigger because the port never sees the token count | **omitted** | Compaction can fire earlier or later than a DeerFlow deployment would choose; a tuned low threshold (keep context small, summarize often) is not expressible | `PreCompact` fires whenever the platform decides, so the durable digest is refreshed at *every* boundary regardless of where it lands; `/deerflow:compact` lets a user force a digest refresh at a moment of their choosing |
| 2 | **Keep policy** | `keep` tuple, default `("messages", 20)`; parent `_determine_cutoff_index` partitions at the cutoff [config/summarization_config.py:36-53] | Platform-owned. The port cannot name a cutoff, cannot count preserved messages, and cannot read the partition | **omitted** | "The last 20 messages are always intact" is no longer a guarantee the port can make | Nothing message-shaped is relied on: everything the port needs after compaction lives in state files, not in the retained tail |
| 3 | **Reminder rescue** | `_preserve_dynamic_context_reminders` pulls tagged dynamic-context reminders **and** their untagged ID-swap peers (`{base}__user`, `{base}__memory`) out of the to-summarize window, preserving chronological order [summarization_middleware.py:571-623] | No equivalent. The ID-swap triplet is an artifact of `DynamicContextMiddleware`'s message rewriting, which the port replaces with per-turn `UserPromptSubmit` injection (M7) | **omitted** (obsolete) | None expected: with per-turn injection there is no long-lived reminder message that compaction could strand | The date/memory reminder is re-injected on the *next* turn by construction, so losing the old copy is the intended behavior |
| 4 | **Summary storage** | `summary_text` LangGraph **LastValue** channel, written by `before_model` alongside `RemoveMessage(REMOVE_ALL_MESSAGES)`; never stored as a message [summarization_middleware.py:547-569] | `.deerflow/state/<thread>/summary.json`, `{schema_version, rev, updated_at, summary_text, updated_by, source_message_count, commit_sha, digest, compactions}`, atomic temp+fsync+rename with `rev` CAS (`src/summary/summary-state.ts`) | **exact** (merge rule) / **approximate** (mechanism) | The LastValue rule is preserved verbatim, including `_nonempty_summary`: a blank summary is a generation failure and preserves the previous value rather than clearing it | Durability is stronger than the original here (never-torn reads, explicit CAS stand-down) — the LangGraph channel had transactionality the port replaced with the file discipline pinned in `state-checkpoint-resume.md` §2 |
| 5 | **Summary content** | LLM-generated prose from the compacted window (`_create_summary` → model invoke); **model-dependent** by the original's own classification | Two independent halves: (a) Claude Code's native compaction summary — outside the port's control and outside its inspection; (b) the port's **deterministic digest**: recent user objectives, open todos, delegation status counts, artifacts, message count (`src/summary/digest.ts`) | **approximate** | The digest cannot summarize reasoning, intermediate findings, or anything not written to durable state. Prose recall depends entirely on the platform's summary | The digest is *lossless for the things it covers* and reproducible byte-for-byte; §4 measures what the pair actually recalls |
| 6 | **Summary prompt wrapper** | `<existing_summary>` / `<new_messages>` blocks, HTML-escaped (`quote=False`) against block breakout (#4162/#4097), trim-then-escape ordering, `_CANNED_SUMMARIES` short-circuits [summarization_middleware.py:405-435, 27-32, 222-233] | Ported verbatim in `src/summary/wrapper.ts` (`buildSummaryRequest`), drift-tested against a frozen copy of lines 415-435 | **exact** | Available for any port path that does generate a summary (deep runs); unused by the hook, which never calls a model | Frozen-source drift test in `src/summary/wrapper.test.ts` fails if either side is edited |
| 7 | **Summary base instruction** | `SummarizationMiddleware.summary_prompt`, **inherited from LangChain**, merely `.format()`-ed by DeerFlow [summarization_middleware.py:450] | Not vendored. `PORT_SUMMARY_BASE_INSTRUCTION` is port-authored replacement text, labeled as such in the file header | **approximate** (deliberate) | Generated summaries would differ in wording from a DeerFlow deployment | The text is not DeerFlow's to port; the wrapper *around* it — the part DeerFlow owns — is exact |
| 8 | **Trim budget** | `trim_tokens_to_summarize` (default 4000 **tokens**), split half/half, `strategy="last"` for the existing summary and `"first"` for new messages, with `_bound_text` as the deterministic fallback [summarization_middleware.py:357-403] | Char budget with the same half/half split and the same `_bound_text` fallback; no token counter, so the port is permanently on the fallback path and the first/last strategy distinction is lost | **approximate** | Trim boundaries differ from the original's token-accurate ones | `boundText` is verbatim; the budget is an explicit caller option, not a hidden default. Side effect: the canned `"Previous conversation was too long to summarize."` branch is preserved but **unreachable** in the port (a char cap clamped to ≥1 never empties a non-empty input) — asserted in the wrapper test rather than deleted |
| 9 | **Model selection / fallback** | Ordered candidates (configured summary model → run model), lazy guarded construction, per-candidate failure cached as `None`, `TAG_NOSTREAM` so summary tokens never reach the frontend [summarization_middleware.py:127-212] | None. Claude Code owns the model; the port never invokes one for summarization | **omitted** | A deployment cannot summarize with a cheaper model than the run model | No mitigation needed at the hook boundary (no model call at all). Deep runs, if they ever generate a summary, use the platform's model |
| 10 | **Stream tagging** | `TAG_NOSTREAM` on a dedicated model copy so the summary call's tokens are not broadcast as a phantom AI message | N/A | **omitted** (obsolete) | None: no port-side summary call exists to leak tokens | — |
| 11 | **Memory flush hook** | `before_summarization` hooks fire once a summary exists; the lead chain attaches `memory_flush_hook` (when `memory.enabled`) so pre-compaction messages reach durable memory; subagents pass `skip_memory_flush=True` [summarization_middleware.py:625-647, 743-747] | Not implemented in M8. The port's memory queue is **M9**; the `PreCompact` hook is the intended fire point | **blocked (M9)** | Until M9, information that only existed in the compacted window is not flushed to durable memory — a real loss window | Declared, not hidden: `parity/DISCREPANCIES.md` → M8 §4. The hook already runs at the right instant, so M9 adds the enqueue call and nothing else |
| 12 | **Failure policy** | Automatic path swallows generation failure (state unchanged, retried next triggered turn); manual `/compact` raises `SummaryGenerationError` [summarization_middleware.py:35-42, 496-507] | Hook exits 0 on every failure path (bad payload, unresolvable thread, unwritable dir, corrupt channel); the CLI exits 1 loudly | **exact** (in spirit) | A missing digest is silent in the automatic path, exactly as the original's swallowed failure is | Same split as the original: automatic = fail-open, manual = fail-loud |
| 13 | **Manual compaction** | `POST /threads/{id}/compact` → `compact_thread_context`: forces compaction, generates a summary, rewrites `messages` + `summary_text` in one mutation-graph checkpoint write under a `checkpoint_write` reservation [runtime/context_compaction.py] | `/deerflow:compact` skill → `node dist/summary/digest-cli.js`: rebuilds the digest only, then instructs the **user** to run native `/compact` (slash commands are not model-invocable) | **approximate** | Manual compaction is now two actions by two actors, and the port half does not shrink the context | The skill states this explicitly and is forbidden from claiming the context was compacted; the durable half is atomic exactly as the original's write was |
| 14 | **Projection of the summary** | `DurableContextMiddleware` injects `SystemMessage(_AUTHORITY_CONTRACT)` + one hidden `HumanMessage(<durable_context_data>)` containing summary / ledger / skills, per model request [notes/middlewares.md §2.17] | `src/summary/durable-context.ts` builds the same texts in the same order; the two-message split becomes two labeled sections of one `additionalContext` string (M7 wires the injection) | **exact** (format) / **approximate** (carrier) | The authority rules no longer arrive with system-role weight; they are the first section of injected user-turn context | Both halves are exported separately (`authorityContract`, `dataBlock`) so a future two-message carrier needs no re-derivation; escaping and budgets are verbatim, and tests assert an untrusted value cannot close the data block |
| 15 | **Goal in durable context** | Not projected — the goal drives the runtime continuation loop only | Optional port-authored `## Active goal` section, **off by default** | **approximate** (port addition) | Enabling it changes the model-visible block vs the original | Default-off, explicitly labeled in the rendered text as a port addition |
| 16 | **Conversation tail read** | Reads `state["messages"]` directly | Best-effort defensive JSONL parse of `transcript_path`, used only for user objectives and a message count | **approximate** | Deviates from `state-checkpoint-resume.md` §2.1 ("transcript format internal/unstable — never parsed by the port") | Every failure mode yields an empty tail and the digest is still produced from state files; nothing downstream depends on a successful parse. Recorded in `parity/DISCREPANCIES.md` → M8 §5 |

---

## 3. What the port guarantees after a compaction

Stated positively, so the guarantee can be tested rather than argued:

1. `summary.json` exists and is complete or absent — never torn (atomic rename).
2. It names the thread's recent user objectives, every open todo, every delegation with its status, and every presented artifact, as of the instant before compaction.
3. Its provenance is explicit: `updated_by` ∈ {`precompact`, `manual`, `deep-run`}, plus a bounded `compactions` history.
4. Nothing in it was produced by a model, so it is reproducible: same state in, byte-identical text out.
5. The durable-context projection re-injects it, fenced as data under the verbatim authority contract, so a value inside it can never act as an instruction.

Everything else about the compacted conversation is the platform's summary, which the port neither controls nor inspects.

---

## 4. Measuring the loss (the part that is not a claim)

`src/summary/context-loss.ts` is the measurement harness M14 runs. It is deliberately not a smoke test:

- **Input A — pre-compaction snapshot** (`parity/fixtures/context-loss/<case>.json`; the fixture *format* is defined and tested here, the cases themselves are authored by M14): enumerated `facts`, `decisions`, `files`, each with an id, canonical text, and optional aliases.
- **Input B — post-compaction probe transcript**: the answers given to recall questions after compaction/resume.
- **Output**: `{case_id, items_total, items_recalled, recall_rate, lost_items[], by_kind}` — a number and a named list of what was lost, per kind.

Deliberate properties: matching is literal-with-aliases (plus basename matching for file paths), never semantic, so the score is deterministic and reproducible; it can under-report recall but never over-report it, which is the safe direction for a loss metric. An LLM judge would be more generous and less reproducible, so it is not used.

Scoring vectors: `src/summary/context-loss.test.ts` (16 tests). Running the probe end-to-end against real compaction is M14's job; M8 owns the scorer so that number cannot drift.

---

## 5. Files

| Path | Role |
|---|---|
| `ports/claude-code/src/summary/summary-state.ts` | `summary.json` channel: schema, LastValue merge, atomic + CAS writes |
| `ports/claude-code/src/summary/wrapper.ts` | Verbatim `<existing_summary>`/`<new_messages>` wrapper + `buildSummaryRequest` |
| `ports/claude-code/src/summary/bound-text.ts` | Single copy of the original's thrice-duplicated `_bound_text` |
| `ports/claude-code/src/summary/durable-context.ts` | Durable-context re-injection block (authority contract + fenced data) |
| `ports/claude-code/src/summary/digest.ts` | Deterministic digest builder + renderer |
| `ports/claude-code/src/summary/digest-cli.ts` | `node dist/summary/digest-cli.js` — manual digest rebuild |
| `ports/claude-code/src/summary/context-loss.ts` | Context-loss scoring harness |
| `ports/claude-code/src/hooks/precompact-summary.ts` | `PreCompact` hook: deterministic snapshot, no model, exit 0 |
| `ports/claude-code/skills/compact/SKILL.md` | `/deerflow:compact` |
