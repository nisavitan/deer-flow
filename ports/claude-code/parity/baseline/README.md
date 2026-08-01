# Parity BASELINE — original DeerFlow engine

Machine-readable golden vectors describing the **original Python engine's** behavior, frozen so the
TypeScript/Claude Code port can be diffed against them later. Every value here was produced by
**executing** the real `deerflow.*` modules — no constant was copied out of source or docs.

- Source basis commit: **`0950924`** (`095092418ccf072aa866c0a663c4056c206091e5`), the commit the
  port design docs (`docs/claude-code-port/*`) were written against.
- Reference plan: `docs/claude-code-port/parity-test-plan.md` (Tier 1, groups G1–G7).
- Behavioral spec cross-check: `docs/claude-code-port/notes/middlewares.md`.

## How to reproduce

```bash
cd backend
PYTHONPATH=. uv run python ../ports/claude-code/parity/baseline/extract_vectors.py
```

Exit code `0`. The script rewrites every JSON/TXT artifact in this directory and validates that each
JSON file re-parses before exiting.

The anchor-test transcript is reproduced with:

```bash
cd backend
PYTHONPATH=. uv run pytest \
  tests/test_loop_detection_middleware.py tests/test_tool_error_handling_middleware.py \
  tests/test_dangling_tool_call_middleware.py tests/test_clarification_middleware.py \
  tests/test_lead_agent_prompt.py tests/test_subagent_executor.py \
  tests/test_summarization_middleware.py tests/test_subagent_limit_middleware.py \
  tests/test_tool_progress_middleware.py tests/test_thread_state_reducers.py \
  tests/test_goal_runtime.py tests/test_subagent_status_contract.py -q
```

Full output and exit code are stored verbatim in `anchor_tests_run.txt` (**532 passed**, exit `0`).

## Artifacts

| File | Plan group | What it freezes | Engine symbols executed |
| --- | --- | --- | --- |
| `loop_detection.json` | G1 | Config defaults, call-set hash relations, and per-step decisions (`none` / `warn` / `hard_stop`) with the exact injected message text, sliding-window counts and per-tool frequency counters. | `LoopDetectionMiddleware._apply` / `._track_and_check`, `_hash_tool_calls`, `LoopDetectionConfig` |
| `tool_meta.json` | G3 | Full `deerflow_tool_meta` for a 38-case input matrix plus 4 exception-stamp cases. | `normalize_tool_result`, `normalize_tool_message`, `stamp_exception_meta` |
| `delegations_ledger.json` | G4 | Ledger merge results for append / same-id update / terminal-not-downgraded / created_at+run_id inheritance / 50-entry cap eviction, plus a folded 5-step run sequence. | `merge_delegations` |
| `caps_clamping.json` | G5 | Clamped values for `max_concurrent_subagents` (1–4) and `max_total_subagents` (1–50), the middleware constructor's effective values, the `allowed_this_response` matrix (with the `[SUBAGENT LIMIT REACHED]` note and `subagent_limit_capped` stop reason), and the missing-`run_id` fail-restrictive path. | `clamp_subagent_concurrency`, `clamp_total_subagents_per_run`, `SubagentLimitMiddleware.__init__` / `._truncate_task_calls` |
| `goal_counters.json` | G6 | Continuation-cap and no-progress-cap clamping, the continue/stand-down gate matrix with `stand_down_reason`, three no-progress evaluation sequences, and a 10-turn continuation-cap walk. | `build_goal_state`, `should_continue_goal`, `compute_goal_progress_key`, `compute_no_progress_count`, `attach_goal_evaluation`, `worker._stand_down_reason` |
| `state_reducers.json` | G7 | `merge_skill_context` (path dedup, recency, cap 8, legacy-key drop, 500-char description cap), `merge_goal`, `merge_promoted` (catalog-hash scoping), `merge_artifacts` (dedup). | the four reducers in `deerflow.agents.thread_state` |
| `subagent_status_contract.json` | G4 | Verbatim parse of `contracts/subagent_status_contract.json` **plus** the model-visible result text, metadata error, and `additional_kwargs` for every `status × stop_reason × payload-shape` combination (60 rows). | `format_subagent_result_message`, `make_subagent_additional_kwargs` |
| `prompt_renders/*.txt` | G5 / prompts | Golden renders of the real lead system prompt for three pinned configurations, both built-in subagent system prompts + role descriptions, and the `task` tool description. | `apply_prompt_template`, `GENERAL_PURPOSE_CONFIG`, `BASH_AGENT_CONFIG`, `task_tool.description` |
| `anchor_tests_run.txt` | — | The original offline anchor suite's raw output and exit code. | pytest |

Every JSON file carries a `_provenance` block (`group`, `commit`, `source_symbols`, `method`).

## Determinism

- JSON is written with `sort_keys=True` and a fixed indent; no file contains a wall-clock timestamp.
- `build_goal_state` is called with a pinned `now=`; the timestamps that the engine stamps internally
  (`goal.updated_at`, `goal.last_evaluation.evaluated_at`) are replaced with the sentinel `"<PINNED>"`
  and listed in that file's `_pinned_fields`.
- Prompt renders use an explicitly constructed `AppConfig` (only `sandbox.use` is set; everything else
  is a schema default), so they never read a developer's `config.yaml`. The repo has no root
  `config.yaml`, so this is also what an unconfigured checkout produces.
- The lead system prompt is deliberately date-free: `DynamicContextMiddleware` injects the current date
  and memory per turn into the first `HumanMessage`, not into the system prompt (that is what makes the
  prompt prefix-cacheable upstream). No date pinning was necessary.
- Prompt renders use the deferred-discovery path (`skill_names=frozenset({...})`) with two **fake**
  skill names, so the render depends on no on-disk skill catalog.

## Honest limitation statement (read this before trusting the baseline)

**A live-model, black-box baseline of the original engine is blocked by the no-API-key constraint of
this environment.** Nothing here observed the original agent actually running against a model.

Consequently this baseline is:

1. **Deterministic-component level** — the middleware/reducer/clamp/taxonomy logic that runs with no
   model in the loop. These vectors are exact and are the strongest parity evidence available offline.
2. **Prompt-render level** — the exact bytes of the policy text the original engine puts in front of
   the model. Per the plan's global framing rule, model-shaped behavior (delegation choice, summary
   wording, synthesis quality) is *not* claimed as parity; what is frozen is that the same policy is
   visible and the same deterministic enforcement wraps whatever the model chose.

**What is NOT baselined here:** anything that requires a model call — `evaluate_goal_completion`'s
judgment, `DeerFlowSummarizationMiddleware` summary text, `TitleMiddleware`'s LLM path, memory
extraction, and every Tier 2 scenario (S1–S24) in `parity-test-plan.md`. Those remain open and must be
run once credentials exist.

**The behavioral authority for model-independent logic is the original offline test suite**, not this
directory: the 532 anchor tests recorded in `anchor_tests_run.txt` are the upstream-maintained
statement of correct behavior. These vectors are a *projection* of that behavior into a
language-neutral form for the port; where a vector and an anchor test ever disagree, the anchor test
wins and the vector is the bug.

## Skipped extractions

| Item | Reason |
| --- | --- |
| G1 `tool_freq_overrides` per-tool threshold vectors | The default config ships `tool_freq_overrides={}`; driving overrides means inventing a config the original never uses by default. The plan's Tier 1 note pins only the default 30/50 thresholds, which are covered. Not faked, just out of the frozen-defaults scope. |
| G2 tool-progress state machine | `ToolProgressMiddleware` is **disabled by default** (`tool_progress.enabled=False`) and its `wrap_tool_call` path requires a live tool handler plus a real `Runtime`, i.e. exactly the "heavy graph mocks" the task said to avoid. It is also not in the requested group list (1–8). `tests/test_tool_progress_middleware.py` is included in the anchor run instead. |
| `non_interactive=true` as a distinct prompt render | `non_interactive` is not an input to `apply_prompt_template` — the rendered system prompt is byte-identical with and without it. Its only effect is removing tools from the bound toolset. Rather than emit a duplicate file, the real value of `_NON_INTERACTIVE_DISABLED_TOOL_NAMES` is recorded in `prompt_renders/non_interactive_tool_filter.txt`. |
| Clamp behavior for `None` caps | The real `clamp_*` functions raise `TypeError` on `None`; that is recorded as `{"effective": null, "error": "TypeError"}` rather than inventing a default. (Listed here because the requested input set included `None`.) |
| Two *real* skills in the n=3 prompt render | Using real on-disk skills would bind the golden render to the developer's `skills/` tree. Two fixed fake names are used through the real deferred-discovery renderer instead, which is what makes the render reproducible. |

## Consuming these vectors from the port

The port's Tier 1 suite should load these files directly (they are the `(input, expected)` tables the
plan calls for) and replay them against the TS translation. Hash values are recorded alongside an
`equal` / `not_equal` **relation** field in `loop_detection.json#hash_relations`; assert on the
relation, not on the Python `md5` literal, unless the TS canonicalizer is proven byte-identical to
`json.dumps(..., sort_keys=True)`.
