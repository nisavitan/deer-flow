"""Parity BASELINE extractor for the DeerFlow -> Claude Code port.

Executes the ORIGINAL Python engine (``deerflow.*``) and freezes its observable,
deterministic behavior as machine-readable golden vectors. Nothing here is a
transcribed constant: every recorded value is produced by calling the real
function/class from the installed harness.

Run from ``backend/``::

    PYTHONPATH=. uv run python ../ports/claude-code/parity/baseline/extract_vectors.py

Outputs (written next to this file):
    loop_detection.json          G1  LoopDetectionMiddleware detection layers
    tool_meta.json               G3  normalize_tool_result / deerflow_tool_meta
    delegations_ledger.json      G4  merge_delegations reducer
    caps_clamping.json           G5  subagent concurrency/total clamps + truncation
    goal_counters.json           G6  goal continuation cap + no-progress breaker
    state_reducers.json          G7  ThreadState custom reducers
    subagent_status_contract.json G4 contract copy + result-message formats
    prompt_renders/*.txt              apply_prompt_template + subagent prompts

Determinism rules applied:
  * JSON is dumped with ``sort_keys=True`` and a stable indent.
  * No wall-clock timestamps are emitted. Where the real API stamps a timestamp
    (``build_goal_state``/``attach_goal_evaluation``), a fixed value is injected
    or the field is replaced with the sentinel ``"<PINNED>"`` (recorded in
    ``_pinned_fields``).
  * Ordering of every recorded collection follows the engine's own ordering.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

BASELINE_DIR = Path(__file__).resolve().parent
REPO_ROOT = BASELINE_DIR.parents[3]
CONTRACT_SRC = REPO_ROOT / "contracts" / "subagent_status_contract.json"

PINNED_TIMESTAMP = "1970-01-01T00:00:00+00:00"
PINNED_SENTINEL = "<PINNED>"

COMMIT = "0950924"

# --------------------------------------------------------------------------
# Imports of the REAL engine
# --------------------------------------------------------------------------
from langchain_core.messages import AIMessage, ToolMessage  # noqa: E402

from deerflow.agents.lead_agent.agent import _NON_INTERACTIVE_DISABLED_TOOL_NAMES  # noqa: E402
from deerflow.agents.lead_agent.prompt import apply_prompt_template  # noqa: E402
from deerflow.agents.middlewares.loop_detection_middleware import (  # noqa: E402
    LoopDetectionMiddleware,
    _hash_tool_calls,
)
from deerflow.agents.middlewares.subagent_limit_middleware import (  # noqa: E402
    SubagentLimitMiddleware,
)
from deerflow.agents.middlewares.tool_result_meta import (  # noqa: E402
    TOOL_META_KEY,
    normalize_tool_result,
    stamp_exception_meta,
)
from deerflow.agents.thread_state import (  # noqa: E402
    merge_artifacts,
    merge_delegations,
    merge_goal,
    merge_promoted,
    merge_skill_context,
)
from deerflow.config.app_config import AppConfig  # noqa: E402
from deerflow.config.loop_detection_config import LoopDetectionConfig  # noqa: E402
from deerflow.config.sandbox_config import SandboxConfig  # noqa: E402
from deerflow.config.subagents_config import (  # noqa: E402
    clamp_subagent_concurrency,
    clamp_total_subagents_per_run,
)
from deerflow.runtime.goal import (  # noqa: E402
    attach_goal_evaluation,
    build_goal_state,
    compute_goal_progress_key,
    compute_no_progress_count,
    should_continue_goal,
)
from deerflow.runtime.runs.worker import _stand_down_reason  # noqa: E402
from deerflow.subagents.builtins.bash_agent import BASH_AGENT_CONFIG  # noqa: E402
from deerflow.subagents.builtins.general_purpose import GENERAL_PURPOSE_CONFIG  # noqa: E402
from deerflow.subagents.status_contract import (  # noqa: E402
    SUBAGENT_STATUS_VALUES,
    SUBAGENT_STOP_REASON_VALUES,
    format_subagent_result_message,
    make_subagent_additional_kwargs,
)
from deerflow.tools.builtins.task_tool import task_tool  # noqa: E402


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------
class FakeRuntime:
    """Minimal stand-in for ``langgraph.runtime.Runtime``.

    The middlewares under test read exactly two things off the runtime:
    ``runtime.context`` (a dict) for ``thread_id`` / ``run_id``, and they write
    ``context["stop_reason"]``. No graph is required.
    """

    def __init__(self, thread_id: str, run_id: str) -> None:
        self.context: dict[str, Any] = {"thread_id": thread_id, "run_id": run_id}


def ai_message(tool_calls: list[dict[str, Any]], content: str = "") -> AIMessage:
    calls = [{"name": tc["name"], "args": tc["args"], "id": tc["id"], "type": "tool_call"} for tc in tool_calls]
    return AIMessage(content=content, tool_calls=calls)


def write_json(name: str, payload: Any) -> Path:
    path = BASELINE_DIR / name
    path.write_text(json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")
    return path


def write_text(relative: str, text: str) -> Path:
    path = BASELINE_DIR / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def provenance(group: str, source: str, note: str = "") -> dict[str, Any]:
    return {
        "group": group,
        "commit": COMMIT,
        "extracted_by": "ports/claude-code/parity/baseline/extract_vectors.py",
        "method": "executed the original engine functions/classes listed in source_symbols",
        "source_symbols": source.split(","),
        "note": note,
    }


def fixed_app_config() -> AppConfig:
    """A pinned AppConfig so prompt renders never read the developer's config.yaml."""
    return AppConfig(sandbox=SandboxConfig(use="deerflow.sandbox.local:LocalSandboxProvider"))


# --------------------------------------------------------------------------
# G1 - loop detection
# --------------------------------------------------------------------------
def _drive_loop_steps(
    middleware: LoopDetectionMiddleware,
    runtime: FakeRuntime,
    steps: list[list[dict[str, Any]]],
) -> list[dict[str, Any]]:
    """Feed AI responses through the REAL ``LoopDetectionMiddleware._apply``.

    ``_apply`` is the middleware's own after_model body: it calls the real
    ``_track_and_check`` (both detection layers), performs the hard stop, and
    queues warnings for later injection. The decision is read back out of the
    real return value / the real pending-warning queue.
    """
    thread_id = runtime.context["thread_id"]
    key = (thread_id, runtime.context["run_id"])
    records: list[dict[str, Any]] = []
    for index, tool_calls in enumerate(steps, start=1):
        pending_before = list(middleware._pending_warnings.get(key, []))
        message = ai_message(tool_calls)
        state = {"messages": [message]}
        result = middleware._apply(state, runtime)
        pending_after = list(middleware._pending_warnings.get(key, []))

        call_hash = _hash_tool_calls([{"name": tc["name"], "args": tc["args"]} for tc in tool_calls])
        history = middleware._history.get(thread_id, [])
        record: dict[str, Any] = {
            "step": index,
            "tool_calls": [{"name": tc["name"], "args": tc["args"]} for tc in tool_calls],
            "call_hash": call_hash,
            "hash_window_length": len(history),
            "hash_count_in_window": history.count(call_hash),
            "tool_frequency_counts": dict(sorted(middleware._tool_name_counter.get(thread_id, {}).items())),
            "decision": "none",
            "injected_message": None,
            "stop_reason": None,
        }
        if result is not None:
            stripped = result["messages"][0]
            record["decision"] = "hard_stop"
            record["injected_message"] = stripped.content
            record["stripped_tool_calls"] = list(stripped.tool_calls)
            record["finish_reason"] = stripped.response_metadata.get("finish_reason")
            record["stop_reason"] = runtime.context.get("stop_reason")
            record["consumable_stop_reason"] = middleware._stop_reason.get(runtime.context["run_id"])
        elif len(pending_after) > len(pending_before):
            record["decision"] = "warn"
            record["injected_message"] = pending_after[-1]
        records.append(record)
    return records


def extract_loop_detection() -> dict[str, Any]:
    config = LoopDetectionConfig()
    defaults = config.model_dump()

    def fresh() -> tuple[LoopDetectionMiddleware, FakeRuntime]:
        return LoopDetectionMiddleware.from_config(config), FakeRuntime("t-loop", "r-loop")

    scenarios: dict[str, Any] = {}

    # 1. Identical tool-call sets: warn at 3, hard stop at 5.
    mw, rt = fresh()
    identical = [{"name": "grep", "args": {"pattern": "TODO", "path": "/src"}, "id": "c"}]
    scenarios["identical_calls_warn3_hard5"] = {
        "description": "Byte-identical tool_calls repeated 6 times under default thresholds (warn 3 / hard 5).",
        "steps": _drive_loop_steps(mw, rt, [identical] * 6),
    }

    # 2. Sliding window: an old hash decays out of the 20-entry window.
    mw, rt = fresh()
    steps: list[list[dict[str, Any]]] = [identical] * 4
    steps += [[{"name": "grep", "args": {"pattern": f"P{i}", "path": "/src"}, "id": "c"}] for i in range(19)]
    steps += [identical] * 4
    scenarios["window_sliding_20"] = {
        "description": (
            "Four identical calls (warn fires at 3, count reaches 4 without a hard stop), then 19 distinct calls so the "
            "20-entry window decays all but one occurrence, then the identical call again: the count restarts from the "
            "surviving occurrence and the hard stop is deferred instead of firing on the next repeat."
        ),
        "steps": _drive_loop_steps(mw, rt, steps),
    }

    # 3. Order independence of the call-set hash (multiset semantics).
    mw, rt = fresh()
    pair_ab = [
        {"name": "grep", "args": {"pattern": "a"}, "id": "c1"},
        {"name": "read_file", "args": {"path": "/x.py"}, "id": "c2"},
    ]
    pair_ba = [
        {"name": "read_file", "args": {"path": "/x.py"}, "id": "c3"},
        {"name": "grep", "args": {"pattern": "a"}, "id": "c4"},
    ]
    scenarios["order_independent_pair"] = {
        "description": "Same multiset of tool calls in reversed order must hash identically and therefore accumulate on one counter.",
        "steps": _drive_loop_steps(mw, rt, [pair_ab, pair_ba, pair_ab, pair_ba, pair_ab]),
    }

    # 4. read_file 200-line range bucketing collapses nearby ranged reads.
    mw, rt = fresh()
    ranged = [
        [{"name": "read_file", "args": {"path": "/a.py", "start_line": 1, "end_line": 100}, "id": "c"}],
        [{"name": "read_file", "args": {"path": "/a.py", "start_line": 50, "end_line": 150}, "id": "c"}],
        [{"name": "read_file", "args": {"path": "/a.py", "start_line": 100, "end_line": 200}, "id": "c"}],
        [{"name": "read_file", "args": {"path": "/a.py", "start_line": 2, "end_line": 90}, "id": "c"}],
        [{"name": "read_file", "args": {"path": "/a.py", "start_line": 10, "end_line": 20}, "id": "c"}],
        [{"name": "read_file", "args": {"path": "/a.py", "start_line": 401, "end_line": 500}, "id": "c"}],
    ]
    scenarios["read_file_range_bucketing"] = {
        "description": "read_file ranges inside the same 200-line bucket collapse to one hash (hard stop at the 5th); a different bucket does not.",
        "steps": _drive_loop_steps(mw, rt, ranged),
    }

    # 5. Frequency layer boundaries: warn 30, hard 50 (each call has distinct args
    #    so the hash layer never fires).
    mw, rt = fresh()
    freq_steps = [[{"name": "read_file", "args": {"path": f"/file_{i}.py"}, "id": "c"}] for i in range(50)]
    freq_records = _drive_loop_steps(mw, rt, freq_steps)
    scenarios["tool_frequency_warn30_hard50"] = {
        "description": "Single tool type with varying args, 50 calls. Frequency layer warns at 30 and hard stops at 50; the hash layer never fires.",
        "boundary_steps": {
            "29": freq_records[28],
            "30": freq_records[29],
            "31": freq_records[30],
            "49": freq_records[48],
            "50": freq_records[49],
        },
        "steps": freq_records,
    }

    # 6. Hash layer takes priority over the frequency layer.
    mw, rt = fresh()
    scenarios["hash_layer_priority"] = {
        "description": "Identical calls hard stop at 5 even though the frequency counter is far below its own thresholds.",
        "steps": _drive_loop_steps(mw, rt, [identical] * 5),
    }

    # Hash relations (equal / not-equal), the portable form for a TS canonicalizer.
    def rel(a: list[dict[str, Any]], b: list[dict[str, Any]]) -> str:
        return "equal" if _hash_tool_calls(a) == _hash_tool_calls(b) else "not_equal"

    hash_relations = [
        {
            "name": "same_calls_same_hash",
            "left": [{"name": "grep", "args": {"pattern": "x", "path": "/s"}}],
            "right": [{"name": "grep", "args": {"pattern": "x", "path": "/s"}}],
        },
        {
            "name": "order_independent",
            "left": [{"name": "a", "args": {"path": "/1"}}, {"name": "b", "args": {"path": "/2"}}],
            "right": [{"name": "b", "args": {"path": "/2"}}, {"name": "a", "args": {"path": "/1"}}],
        },
        {
            "name": "stringified_dict_args_match_dict_args",
            "left": [{"name": "grep", "args": {"pattern": "x"}}],
            "right": [{"name": "grep", "args": '{"pattern": "x"}'}],
        },
        {
            "name": "reversed_read_file_range_matches_forward_range",
            "left": [{"name": "read_file", "args": {"path": "/a", "start_line": 1, "end_line": 100}}],
            "right": [{"name": "read_file", "args": {"path": "/a", "start_line": 100, "end_line": 1}}],
        },
        {
            "name": "grep_pattern_affects_hash",
            "left": [{"name": "grep", "args": {"pattern": "x"}}],
            "right": [{"name": "grep", "args": {"pattern": "y"}}],
        },
        {
            "name": "write_file_content_affects_hash",
            "left": [{"name": "write_file", "args": {"path": "/a", "content": "one"}}],
            "right": [{"name": "write_file", "args": {"path": "/a", "content": "two"}}],
        },
        {
            "name": "str_replace_content_affects_hash",
            "left": [{"name": "str_replace", "args": {"path": "/a", "old_str": "x", "new_str": "y"}}],
            "right": [{"name": "str_replace", "args": {"path": "/a", "old_str": "x", "new_str": "z"}}],
        },
        {
            "name": "non_salient_field_ignored",
            "left": [{"name": "search", "args": {"query": "q", "limit": 5}}],
            "right": [{"name": "search", "args": {"query": "q", "limit": 50}}],
        },
        {
            "name": "read_file_far_ranges_differ",
            "left": [{"name": "read_file", "args": {"path": "/a", "start_line": 1, "end_line": 100}}],
            "right": [{"name": "read_file", "args": {"path": "/a", "start_line": 401, "end_line": 500}}],
        },
    ]
    for entry in hash_relations:
        entry["relation"] = rel(entry["left"], entry["right"])
        entry["left_hash"] = _hash_tool_calls(entry["left"])
        entry["right_hash"] = _hash_tool_calls(entry["right"])

    return {
        "_provenance": provenance(
            "G1",
            "deerflow.agents.middlewares.loop_detection_middleware:LoopDetectionMiddleware._apply,"
            "deerflow.agents.middlewares.loop_detection_middleware:LoopDetectionMiddleware._track_and_check,"
            "deerflow.agents.middlewares.loop_detection_middleware:_hash_tool_calls,"
            "deerflow.config.loop_detection_config:LoopDetectionConfig",
            "Warnings are queued by _apply and injected at the next model call; `injected_message` for a warn step is the queued text verbatim. "
            "For a hard stop it is the rewritten AIMessage content (original content was empty, so it starts with two newlines).",
        ),
        "config_defaults": defaults,
        "hash_relations": hash_relations,
        "scenarios": scenarios,
    }


# --------------------------------------------------------------------------
# G3 - deerflow_tool_meta taxonomy
# --------------------------------------------------------------------------
def extract_tool_meta() -> dict[str, Any]:
    cases: list[dict[str, Any]] = []

    def add(name: str, content: str, *, tool: str = "generic_tool", status: str = "success", additional_kwargs: dict | None = None) -> None:
        msg = ToolMessage(
            content=content,
            tool_call_id="tc-1",
            name=tool,
            status=status,
            additional_kwargs=dict(additional_kwargs or {}),
        )
        result = normalize_tool_result(msg)
        cases.append(
            {
                "name": name,
                "input": {"tool_name": tool, "status": status, "content": content, "pre_existing_meta": (additional_kwargs or {}).get(TOOL_META_KEY)},
                "deerflow_tool_meta": result.additional_kwargs[TOOL_META_KEY],
            }
        )

    # success / empty
    add("success_plain_text", "Found 3 matches in src/app.py")
    add("empty_result", "")

    # "Error:"-prefixed content, one per taxonomy class
    add("error_prefix_auth_401", "Error: 401 unauthorized")
    add("error_prefix_auth_invalid_api_key", "Error: invalid api key provided")
    add("error_prefix_rate_limited", "Error: rate limit exceeded, retry later")
    add("error_prefix_transient_timeout", "Error: connection timeout while contacting host")
    add("error_prefix_config", "Error: no api key configured for this provider")
    add("error_prefix_permission", "Error: permission denied: /etc/shadow")
    add("error_prefix_no_results", "Error: no results found for that query")
    add("error_prefix_not_found", "Error: no such file or directory: /tmp/missing.txt")
    add("error_prefix_not_found_404", "Error: 404 while resolving the resource")
    add("error_prefix_internal", "Error: internal error 500 from upstream")
    add("error_prefix_unknown", "Error: something unclassifiable happened")
    add(
        "error_prefix_exception_shape",
        "Error: Tool 'grep' failed with ValueError: bad pattern. Continue with available context, or choose an alternative tool.",
    )

    # ordering traps: numeric codes are word-boundary anchored
    add("numeric_code_not_word_boundary", "Error: request took 500ms to complete")

    # status="error" without the "Error:" prefix
    add("status_error_plain_text", "the requested file does not exist", status="error")
    add("status_error_json_error_field", '{"error": "rate limit exceeded", "query": "unauthorized"}', status="error")
    add("status_error_json_without_error_key", '{"user_id": 401, "results": []}', status="error")
    add("status_error_json_semantic_zero", '{"error": "none", "results": [1, 2]}', status="error")
    add("status_error_json_non_string_error", '{"error": 404}', status="error")

    # success status carrying a JSON error payload
    add("success_json_error_field", '{"error": "boom"}')
    add("success_json_error_none_is_success", '{"error": "none", "results": [1, 2]}')
    add("success_json_error_empty_string_is_success", '{"error": "", "results": []}')

    # web_fetch error shells (name-gated, equality-after-normalization)
    add("web_fetch_shell_404", "404 Not Found\nnginx/1.24.0", tool="web_fetch")
    add("web_fetch_shell_iis_404", "404 - File or directory not found.\nIIS", tool="web_fetch")
    add("web_fetch_shell_http_error_404", "HTTP Error 404 - Not Found", tool="web_fetch")
    add("web_fetch_shell_503", "503 Service Unavailable\nvarnish", tool="web_fetch")
    add("web_fetch_shell_401", "401 Unauthorized", tool="web_fetch")
    add("web_fetch_document_about_404_is_success", "404 Ways to Cook Rice\nA long article about rice.", tool="web_fetch")
    add("web_fetch_document_titled_not_found_is_success", "Not Found: a short history of the 404\nBody text.", tool="web_fetch")
    add("error_shell_gate_is_name_based", "404 Not Found\nnginx/1.24.0", tool="read_file")

    # partial-success markers
    add("partial_truncated", "Output truncated after 100 lines")
    add("partial_results", "partial results returned for this query")
    add("partial_no_results_found", "no results found for the given query")
    add("partial_no_content_found", "no content found at that location")
    add("partial_no_images_found", "no images found")
    add("partial_results_may_be_incomplete", "results may be incomplete")

    # pre-existing stamp is preserved verbatim
    add(
        "pre_existing_stamp_preserved",
        "Error: 401 unauthorized",
        additional_kwargs={
            TOOL_META_KEY: {
                "status": "success",
                "error_type": None,
                "recoverable_by_model": True,
                "recommended_next_action": "continue",
                "source": "tool_return",
            }
        },
    )

    # stamp_exception_meta always overwrites, source="exception"
    exception_cases: list[dict[str, Any]] = []
    for name, exc_info in [
        ("exception_not_found", "Tool 'read_file' failed with FileNotFoundError: no such file or directory: /tmp/x"),
        ("exception_permission", "Tool 'bash' failed with PermissionError: permission denied"),
        ("exception_timeout", "Tool 'web_fetch' failed with TimeoutError: connection timeout"),
        ("exception_unknown", "Tool 'task' failed with RuntimeError: kaboom"),
    ]:
        msg = ToolMessage(content=f"Error: {exc_info}", tool_call_id="tc-1", name="x", status="error")
        stamped = stamp_exception_meta(msg, exc_info)
        exception_cases.append(
            {
                "name": name,
                "input": {"exc_info": exc_info},
                "deerflow_tool_meta": stamped.additional_kwargs[TOOL_META_KEY],
            }
        )

    return {
        "_provenance": provenance(
            "G3",
            "deerflow.agents.middlewares.tool_result_meta:normalize_tool_result,deerflow.agents.middlewares.tool_result_meta:normalize_tool_message,deerflow.agents.middlewares.tool_result_meta:stamp_exception_meta",
            "Each case builds a real langchain ToolMessage and records the full deerflow_tool_meta the engine stamped.",
        ),
        "normalize_tool_result_cases": cases,
        "stamp_exception_meta_cases": exception_cases,
    }


# --------------------------------------------------------------------------
# G4a - delegation ledger reducer
# --------------------------------------------------------------------------
def entry(entry_id: str, status: str, **extra: Any) -> dict[str, Any]:
    base = {
        "id": entry_id,
        "description": f"task {entry_id}",
        "subagent_type": "general-purpose",
        "status": status,
        "created_at": PINNED_TIMESTAMP,
    }
    base.update(extra)
    return base


def extract_delegations_ledger() -> dict[str, Any]:
    operations: list[dict[str, Any]] = []

    def add(name: str, existing: Any, new: Any, description: str) -> None:
        operations.append(
            {
                "name": name,
                "description": description,
                "existing": existing,
                "new": new,
                "merged": merge_delegations(existing, new),
            }
        )

    add("append_to_empty", None, [entry("d1", "in_progress")], "None ledger + one entry.")
    add("append_two", [entry("d1", "in_progress")], [entry("d2", "in_progress")], "Append preserves first-seen order.")
    add("empty_new_preserves_existing", [entry("d1", "completed")], [], "Falsy new update preserves the existing ledger.")
    add("none_new_preserves_existing", [entry("d1", "completed")], None, "None update preserves the existing ledger.")
    add(
        "same_id_update_advances_status",
        [entry("d1", "in_progress")],
        [entry("d1", "completed", result_brief="done", result_sha256="a" * 64)],
        "Same id: latest wins, position preserved.",
    )
    add(
        "terminal_never_downgraded",
        [entry("d1", "completed", result_brief="done")],
        [entry("d1", "in_progress")],
        "completed -> in_progress is rejected; the terminal entry survives untouched.",
    )
    add(
        "terminal_to_terminal_allowed",
        [entry("d1", "failed")],
        [entry("d1", "completed", result_brief="recovered")],
        "Terminal -> terminal is a normal update (both statuses are in TERMINAL_STATUSES).",
    )
    add(
        "created_at_and_run_id_preserved_on_update",
        [entry("d1", "in_progress", run_id="run-A", created_at="2020-01-01T00:00:00+00:00")],
        [entry("d1", "completed", created_at="2099-01-01T00:00:00+00:00")],
        "An update inherits the first-seen created_at and the previously tagged run_id.",
    )
    add(
        "stop_reason_captured",
        [entry("d1", "in_progress")],
        [entry("d1", "completed", stop_reason="loop_capped", result_brief="partial")],
        "Additive stop_reason rides on the terminal entry.",
    )

    cap_existing = [entry(f"d{i:03d}", "completed") for i in range(50)]
    cap_new = [entry(f"n{i:03d}", "in_progress") for i in range(5)]
    cap_merged = merge_delegations(cap_existing, cap_new)
    operations.append(
        {
            "name": "cap_eviction_50",
            "description": "50 existing + 5 new -> capped to the most recent 50 entries (oldest 5 evicted).",
            "existing_ids": [e["id"] for e in cap_existing],
            "new_ids": [e["id"] for e in cap_new],
            "merged_ids": [e["id"] for e in cap_merged],
            "merged_length": len(cap_merged),
        }
    )

    # Sequential application (the reducer folded over a run's writes).
    ledger: Any = None
    sequence: list[dict[str, Any]] = []
    for label, update in [
        ("dispatch_two", [entry("s1", "in_progress"), entry("s2", "in_progress")]),
        ("s1_completes", [entry("s1", "completed", result_brief="alpha", result_sha256="b" * 64)]),
        ("s2_fails", [entry("s2", "failed")]),
        ("stale_s1_running_rejected", [entry("s1", "in_progress")]),
        ("dispatch_third", [entry("s3", "in_progress")]),
    ]:
        ledger = merge_delegations(ledger, update)
        sequence.append({"step": label, "update": update, "ledger": ledger})

    return {
        "_provenance": provenance(
            "G4",
            "deerflow.agents.thread_state:merge_delegations",
            "Terminal statuses come from deerflow.subagents.status_contract:SUBAGENT_STATUS_VALUES; 'in_progress' is deliberately non-terminal.",
        ),
        "ledger_max_entries": len(cap_merged),
        "operations": operations,
        "sequence": sequence,
    }


# --------------------------------------------------------------------------
# G5 - caps clamping
# --------------------------------------------------------------------------
def extract_caps_clamping() -> dict[str, Any]:
    inputs = [-1, 0, 1, 3, 4, 5, 10, 50, 51, None]

    def clamp_row(fn: Any, value: Any) -> dict[str, Any]:
        try:
            return {"input": value, "effective": fn(value), "error": None}
        except Exception as exc:  # noqa: BLE001 - recording the real failure mode
            return {"input": value, "effective": None, "error": type(exc).__name__}

    concurrency = [clamp_row(clamp_subagent_concurrency, v) for v in inputs]
    total = [clamp_row(clamp_total_subagents_per_run, v) for v in inputs]

    constructor: list[dict[str, Any]] = []
    for value in inputs:
        row: dict[str, Any] = {"input": value}
        try:
            mw = SubagentLimitMiddleware(max_concurrent=value, max_total=value)
            row["effective_max_concurrent"] = mw.max_concurrent
            row["effective_max_total"] = mw.max_total
            row["error"] = None
        except Exception as exc:  # noqa: BLE001
            row["effective_max_concurrent"] = None
            row["effective_max_total"] = None
            row["error"] = type(exc).__name__
        constructor.append(row)

    # allowed_this_response = min(max_concurrent, max(0, max_total - prior_run_delegations))
    truncation: list[dict[str, Any]] = []
    for max_concurrent, max_total, prior, requested in [
        (3, 6, 0, 1),
        (3, 6, 0, 3),
        (3, 6, 0, 8),
        (3, 6, 4, 3),
        (3, 6, 5, 3),
        (3, 6, 6, 2),
        (3, 6, 9, 1),
        (1, 6, 0, 4),
        (4, 50, 0, 8),
    ]:
        mw = SubagentLimitMiddleware(max_concurrent=max_concurrent, max_total=max_total)
        rt = FakeRuntime("t-caps", "run-1")
        delegations = [entry(f"p{i}", "completed", run_id="run-1") for i in range(prior)]
        calls = [{"name": "task", "args": {"description": f"d{i}", "prompt": "p", "subagent_type": "general-purpose"}, "id": f"tc{i}"} for i in range(requested)]
        state = {"messages": [ai_message(calls, content="dispatching")], "delegations": delegations}
        result = mw._truncate_task_calls(state, rt)
        if result is None:
            kept = requested
            note_appended = False
            content = None
        else:
            new_msg = result["messages"][0]
            kept = len([tc for tc in new_msg.tool_calls if tc.get("name") == "task"])
            content = new_msg.content
            note_appended = "[SUBAGENT LIMIT REACHED]" in str(content)
        truncation.append(
            {
                "configured_max_concurrent": max_concurrent,
                "configured_max_total": max_total,
                "prior_current_run_delegations": prior,
                "requested_task_calls": requested,
                "allowed_task_calls": kept,
                "middleware_returned_update": result is not None,
                "limit_note_appended": note_appended,
                "message_content": content,
                "stop_reason": rt.context.get("stop_reason"),
            }
        )

    # Missing run_id -> fail-restrictive full-ledger count.
    mw = SubagentLimitMiddleware(max_concurrent=3, max_total=6)
    rt_no_run = FakeRuntime("t-caps", "run-1")
    del rt_no_run.context["run_id"]
    delegations = [entry(f"old{i}", "completed", run_id="run-OLD") for i in range(6)]
    calls = [{"name": "task", "args": {"description": "d", "prompt": "p", "subagent_type": "general-purpose"}, "id": "tc0"}]
    result = mw._truncate_task_calls({"messages": [ai_message(calls, content="go")], "delegations": delegations}, rt_no_run)
    missing_run_id = {
        "description": "No run_id in runtime context: every ledger entry counts as prior usage (fail-restrictive).",
        "prior_ledger_entries": len(delegations),
        "requested_task_calls": 1,
        "allowed_task_calls": 0 if result is not None else 1,
        "limit_note_appended": bool(result is not None and "[SUBAGENT LIMIT REACHED]" in str(result["messages"][0].content)),
        "stop_reason": rt_no_run.context.get("stop_reason"),
    }

    return {
        "_provenance": provenance(
            "G5",
            "deerflow.config.subagents_config:clamp_subagent_concurrency,"
            "deerflow.config.subagents_config:clamp_total_subagents_per_run,"
            "deerflow.agents.middlewares.subagent_limit_middleware:SubagentLimitMiddleware.__init__,"
            "deerflow.agents.middlewares.subagent_limit_middleware:SubagentLimitMiddleware._truncate_task_calls",
            "`None` inputs are recorded with the real exception class name rather than a fabricated clamped value.",
        ),
        "max_concurrent_subagents_clamp": concurrency,
        "max_total_subagents_clamp": total,
        "middleware_constructor": constructor,
        "allowed_this_response": truncation,
        "missing_run_id": missing_run_id,
    }


# --------------------------------------------------------------------------
# G6 - goal counters
# --------------------------------------------------------------------------
def _pin_goal(goal: dict[str, Any]) -> dict[str, Any]:
    pinned = dict(goal)
    pinned["created_at"] = PINNED_TIMESTAMP
    pinned["updated_at"] = PINNED_SENTINEL
    last = pinned.get("last_evaluation")
    if isinstance(last, dict):
        last = dict(last)
        if "evaluated_at" in last:
            last["evaluated_at"] = PINNED_SENTINEL
        pinned["last_evaluation"] = last
    return pinned


def extract_goal_counters() -> dict[str, Any]:
    continuation_cap = []
    for requested in [-1, 0, 5, 8, 9, 20]:
        goal = build_goal_state("finish the audit", max_continuations=requested, now=PINNED_TIMESTAMP)
        continuation_cap.append(
            {
                "requested_max_continuations": requested,
                "effective_max_continuations": goal["max_continuations"],
                "effective_max_no_progress_continuations": goal["max_no_progress_continuations"],
                "continuation_count": goal["continuation_count"],
                "no_progress_count": goal["no_progress_count"],
            }
        )

    no_progress_cap = []
    for requested in [-1, 0, 2, 5]:
        goal = build_goal_state("finish the audit", max_no_progress_continuations=requested, now=PINNED_TIMESTAMP)
        no_progress_cap.append(
            {
                "requested_max_no_progress_continuations": requested,
                "effective_max_no_progress_continuations": goal["max_no_progress_continuations"],
            }
        )

    def evaluation(satisfied: bool, blocker: str, reason: str = "r", evidence: str = "e") -> dict[str, Any]:
        return {"satisfied": satisfied, "blocker": blocker, "reason": reason, "evidence_summary": evidence}

    gate_matrix = []
    for name, continuation_count, no_progress, evl in [
        ("not_satisfied_continuable_fresh", 0, 0, evaluation(False, "goal_not_met_yet")),
        ("satisfied_stops", 0, 0, evaluation(True, "none")),
        ("blocked_needs_user_input", 0, 0, evaluation(False, "needs_user_input")),
        ("blocked_missing_evidence", 0, 0, evaluation(False, "missing_evidence")),
        ("blocked_run_failed", 0, 0, evaluation(False, "run_failed")),
        ("blocked_external_wait", 0, 0, evaluation(False, "external_wait")),
        ("cap_not_reached_7_of_8", 7, 0, evaluation(False, "goal_not_met_yet")),
        ("cap_reached_8_of_8", 8, 0, evaluation(False, "goal_not_met_yet")),
        ("cap_exceeded_9_of_8", 9, 0, evaluation(False, "goal_not_met_yet")),
        ("no_progress_1_of_2", 3, 1, evaluation(False, "goal_not_met_yet")),
        ("no_progress_2_of_2", 3, 2, evaluation(False, "goal_not_met_yet")),
    ]:
        goal = build_goal_state("finish the audit", now=PINNED_TIMESTAMP)
        goal["continuation_count"] = continuation_count
        goal["no_progress_count"] = no_progress
        gate_matrix.append(
            {
                "name": name,
                "continuation_count": continuation_count,
                "max_continuations": goal["max_continuations"],
                "no_progress_count": no_progress,
                "max_no_progress_continuations": goal["max_no_progress_continuations"],
                "evaluation": evl,
                "should_continue_goal": should_continue_goal(goal, evl, no_progress_count=no_progress),
                "stand_down_reason": _stand_down_reason(goal, evl, no_progress),
            }
        )

    # No-progress breaker driven as an evaluation sequence.
    def run_sequence(name: str, description: str, evidence_signatures: list[str]) -> dict[str, Any]:
        goal = build_goal_state("finish the audit", now=PINNED_TIMESTAMP)
        steps = []
        for turn, signature in enumerate(evidence_signatures, start=1):
            evl = evaluation(False, "goal_not_met_yet", reason=f"turn {turn} reworded reason")
            no_progress = compute_no_progress_count(goal, evl, evidence_signature=signature)
            stand_down = _stand_down_reason(goal, evl, no_progress)
            decision = "stand_down" if (stand_down is not None or not should_continue_goal(goal, evl, no_progress_count=no_progress)) else "continue"
            next_continuation = goal["continuation_count"] + (1 if decision == "continue" else 0)
            goal = attach_goal_evaluation(
                goal,
                evl,
                run_id=f"run-{turn}",
                continuation_count=next_continuation,
                no_progress_count=no_progress,
                stand_down_reason=stand_down,
                evidence_signature=signature,
            )
            steps.append(
                {
                    "turn": turn,
                    "evidence_signature": signature,
                    "progress_key": compute_goal_progress_key(evl, evidence_signature=signature),
                    "no_progress_count": no_progress,
                    "continuation_count_after": goal["continuation_count"],
                    "decision": decision,
                    "stand_down_reason": stand_down,
                    "goal_after": _pin_goal(goal),
                }
            )
        return {"name": name, "description": description, "steps": steps}

    sequences = [
        run_sequence(
            "same_evidence_three_turns",
            "Identical visible assistant evidence on every turn: the breaker trips on the third evaluation (no_progress_count reaches max 2).",
            ["sig-A", "sig-A", "sig-A"],
        ),
        run_sequence(
            "changing_evidence",
            "Evidence changes on every turn: the no-progress counter resets and the loop keeps continuing until the continuation cap.",
            ["sig-A", "sig-B", "sig-C", "sig-D"],
        ),
        run_sequence(
            "stall_then_recover",
            "One repeat, then new evidence: the counter goes 0 -> 1 -> 0.",
            ["sig-A", "sig-A", "sig-B", "sig-B"],
        ),
    ]

    # Continuation cap reached by running the loop with fresh evidence each turn.
    goal = build_goal_state("finish the audit", now=PINNED_TIMESTAMP)
    cap_walk = []
    for turn in range(1, 11):
        evl = evaluation(False, "goal_not_met_yet")
        signature = f"sig-{turn}"
        no_progress = compute_no_progress_count(goal, evl, evidence_signature=signature)
        stand_down = _stand_down_reason(goal, evl, no_progress)
        cont = should_continue_goal(goal, evl, no_progress_count=no_progress)
        cap_walk.append(
            {
                "turn": turn,
                "continuation_count_before": goal["continuation_count"],
                "should_continue_goal": cont,
                "stand_down_reason": stand_down,
            }
        )
        goal = attach_goal_evaluation(
            goal,
            evl,
            run_id=f"run-{turn}",
            continuation_count=goal["continuation_count"] + (1 if cont and stand_down is None else 0),
            no_progress_count=no_progress,
            stand_down_reason=stand_down,
            evidence_signature=signature,
        )

    return {
        "_provenance": provenance(
            "G6",
            "deerflow.runtime.goal:build_goal_state,"
            "deerflow.runtime.goal:should_continue_goal,"
            "deerflow.runtime.goal:compute_goal_progress_key,"
            "deerflow.runtime.goal:compute_no_progress_count,"
            "deerflow.runtime.goal:attach_goal_evaluation,"
            "deerflow.runtime.runs.worker:_stand_down_reason",
            "Timestamps produced by now_iso() are replaced with the sentinel '<PINNED>'; created_at is injected as a fixed value.",
        ),
        "_pinned_fields": ["goal.created_at", "goal.updated_at", "goal.last_evaluation.evaluated_at"],
        "continuation_cap_clamping": continuation_cap,
        "no_progress_cap_clamping": no_progress_cap,
        "gate_matrix": gate_matrix,
        "no_progress_sequences": sequences,
        "continuation_cap_walk": cap_walk,
    }


# --------------------------------------------------------------------------
# G7 - ThreadState reducers
# --------------------------------------------------------------------------
def skill(path: str, name: str = "", description: str = "d", loaded_at: int = 0) -> dict[str, Any]:
    return {"name": name or path.rsplit("/", 2)[-2], "path": path, "description": description, "loaded_at": loaded_at}


def extract_state_reducers() -> dict[str, Any]:
    skill_cases: list[dict[str, Any]] = []

    def add_skill(name: str, existing: Any, new: Any, description: str) -> None:
        skill_cases.append(
            {
                "name": name,
                "description": description,
                "existing": existing,
                "new": new,
                "merged": merge_skill_context(existing, new),
            }
        )

    add_skill("append_to_none", None, [skill("/mnt/skills/public/a/SKILL.md")], "None existing + one entry.")
    add_skill(
        "dedup_by_path_refreshes_recency",
        [skill("/mnt/skills/public/a/SKILL.md", loaded_at=1), skill("/mnt/skills/public/b/SKILL.md", loaded_at=2)],
        [skill("/mnt/skills/public/a/SKILL.md", description="updated", loaded_at=3)],
        "Re-reading a path replaces the entry and moves it to the most-recent slot.",
    )
    add_skill(
        "none_new_normalizes_existing",
        [{"path": "/mnt/skills/public/a/SKILL.md", "name": "a", "description": "  spaced   out  ", "loaded_at": 4, "body": "LEGACY BODY"}],
        None,
        "A None update still normalizes legacy entries (drops the verbatim body, collapses whitespace).",
    )
    add_skill(
        "legacy_keys_dropped",
        None,
        [{"path": "/mnt/skills/public/a/SKILL.md", "name": "a", "description": "d", "loaded_at": "not-an-int", "content": "LEGACY"}],
        "Unknown keys are dropped; a non-int loaded_at becomes 0.",
    )
    add_skill(
        "description_truncated_to_500",
        None,
        [skill("/mnt/skills/public/a/SKILL.md", description="x" * 600)],
        "Descriptions are whitespace-collapsed and truncated to 500 chars.",
    )
    cap_existing = [skill(f"/mnt/skills/public/s{i}/SKILL.md", loaded_at=i) for i in range(6)]
    cap_new = [skill(f"/mnt/skills/public/n{i}/SKILL.md", loaded_at=100 + i) for i in range(4)]
    skill_cases.append(
        {
            "name": "cap_8_keeps_most_recent",
            "description": "6 existing + 4 new = 10 -> capped to the 8 most recently read entries.",
            "existing_paths": [e["path"] for e in cap_existing],
            "new_paths": [e["path"] for e in cap_new],
            "merged_paths": [e["path"] for e in merge_skill_context(cap_existing, cap_new)],
            "merged_length": len(merge_skill_context(cap_existing, cap_new)),
        }
    )

    goal_cases = []
    active_goal = build_goal_state("ship the port", now=PINNED_TIMESTAMP)
    replacement = build_goal_state("ship the port v2", now=PINNED_TIMESTAMP)
    for name, existing, new, description in [
        ("none_update_preserves_active_goal", active_goal, None, "A node that does not touch the goal channel preserves it."),
        ("explicit_replacement_wins", active_goal, replacement, "The goal writer replaces the active goal."),
        ("set_from_empty", None, active_goal, "First write installs the goal."),
    ]:
        goal_cases.append(
            {
                "name": name,
                "description": description,
                "existing": _pin_goal(existing) if existing else None,
                "new": _pin_goal(new) if new else None,
                "merged": _pin_goal(merge_goal(existing, new)) if merge_goal(existing, new) else None,
            }
        )

    promoted_cases = []
    for name, existing, new, description in [
        ("first_write", None, {"catalog_hash": "h1", "names": ["a", "b", "a"]}, "First write dedupes names, preserving order."),
        (
            "same_hash_unions",
            {"catalog_hash": "h1", "names": ["a", "b"]},
            {"catalog_hash": "h1", "names": ["b", "c"]},
            "Same catalog hash: union, dedupe, preserve order.",
        ),
        (
            "hash_change_replaces",
            {"catalog_hash": "h1", "names": ["a", "b"]},
            {"catalog_hash": "h2", "names": ["c"]},
            "Catalog drift wholesale-replaces so a stale bare name cannot expose a different tool.",
        ),
        ("none_update_preserves", {"catalog_hash": "h1", "names": ["a"]}, None, "None update preserves existing promotions."),
        ("empty_update_preserves", {"catalog_hash": "h1", "names": ["a"]}, {}, "Falsy update preserves existing promotions."),
    ]:
        promoted_cases.append(
            {
                "name": name,
                "description": description,
                "existing": existing,
                "new": new,
                "merged": merge_promoted(existing, new),
            }
        )

    artifact_cases = []
    for name, existing, new, description in [
        ("append_from_none", None, ["/mnt/user-data/outputs/a.md"], "None existing."),
        (
            "dedup_preserves_order",
            ["/mnt/user-data/outputs/a.md", "/mnt/user-data/outputs/b.md"],
            ["/mnt/user-data/outputs/b.md", "/mnt/user-data/outputs/c.md"],
            "Duplicates collapse, first-seen order is preserved.",
        ),
        ("none_new_preserves", ["/mnt/user-data/outputs/a.md"], None, "None update preserves existing artifacts."),
        ("empty_new_returns_existing", ["/mnt/user-data/outputs/a.md"], [], "An empty update is a no-op merge."),
    ]:
        artifact_cases.append(
            {
                "name": name,
                "description": description,
                "existing": existing,
                "new": new,
                "merged": merge_artifacts(existing, new),
            }
        )

    return {
        "_provenance": provenance(
            "G7",
            "deerflow.agents.thread_state:merge_skill_context,deerflow.agents.thread_state:merge_goal,deerflow.agents.thread_state:merge_promoted,deerflow.agents.thread_state:merge_artifacts",
            "Goal payloads use build_goal_state with a pinned timestamp; updated_at is replaced with '<PINNED>'.",
        ),
        "merge_skill_context": skill_cases,
        "merge_goal": goal_cases,
        "merge_promoted": promoted_cases,
        "merge_artifacts": artifact_cases,
    }


# --------------------------------------------------------------------------
# G4b - subagent status contract
# --------------------------------------------------------------------------
def extract_subagent_status_contract() -> dict[str, Any]:
    contract = json.loads(CONTRACT_SRC.read_text(encoding="utf-8"))

    formats: list[dict[str, Any]] = []
    stop_reasons: list[Any] = [None, *SUBAGENT_STOP_REASON_VALUES]
    for status in SUBAGENT_STATUS_VALUES:
        for stop_reason in stop_reasons:
            for label, result, error in [
                ("with_result_no_error", "FINDINGS: three defects.", None),
                ("with_error_no_result", None, "boom: the tool exploded"),
                ("empty", None, None),
            ]:
                content, metadata_error = format_subagent_result_message(status, result=result, error=error, stop_reason=stop_reason)
                formats.append(
                    {
                        "status": status,
                        "stop_reason": stop_reason,
                        "input_shape": label,
                        "result": result,
                        "error": error,
                        "model_visible_content": content,
                        "metadata_error": metadata_error,
                        "additional_kwargs": make_subagent_additional_kwargs(status, result=result, error=error, stop_reason=stop_reason),
                    }
                )

    return {
        "_provenance": provenance(
            "G4",
            "contracts/subagent_status_contract.json,deerflow.subagents.status_contract:format_subagent_result_message,deerflow.subagents.status_contract:make_subagent_additional_kwargs",
            "contract_json is a verbatim parse of the repo contract file; the format table is the real formatter's output for every status x stop_reason combination.",
        ),
        "contract_json": contract,
        "contract_source_path": "contracts/subagent_status_contract.json",
        "status_values": list(SUBAGENT_STATUS_VALUES),
        "stop_reason_values": list(SUBAGENT_STOP_REASON_VALUES),
        "result_message_formats": formats,
    }


# --------------------------------------------------------------------------
# Prompt renders
# --------------------------------------------------------------------------
FAKE_SKILLS = frozenset({"parity-fixture-alpha", "parity-fixture-beta"})


def extract_prompt_renders() -> list[str]:
    app_config = fixed_app_config()
    written: list[str] = []

    header = (
        "# BASELINE PROMPT RENDER (original DeerFlow engine, commit {commit})\n"
        "# produced by: ports/claude-code/parity/baseline/extract_vectors.py\n"
        "# call: {call}\n"
        "# pinned inputs: AppConfig(sandbox.use='deerflow.sandbox.local:LocalSandboxProvider') with all other\n"
        "#   fields at their schema defaults (skills.container_path='{container}'), agent_name=None,\n"
        "#   user_id=None. No date/memory is present: DynamicContextMiddleware injects those per turn into\n"
        "#   the first HumanMessage, NOT into this system prompt.\n"
        "# ---8<--- render begins on the next line ---8<---\n"
    )

    renders = [
        (
            "lead_prompt_subagents_enabled_n3_two_skills.txt",
            f"apply_prompt_template(subagent_enabled=True, max_concurrent_subagents=3, max_total_subagents=6, skill_names=frozenset({sorted(FAKE_SKILLS)}))",
            apply_prompt_template(
                subagent_enabled=True,
                max_concurrent_subagents=3,
                max_total_subagents=6,
                app_config=app_config,
                skill_names=frozenset(FAKE_SKILLS),
            ),
        ),
        (
            "lead_prompt_subagents_enabled_n1.txt",
            "apply_prompt_template(subagent_enabled=True, max_concurrent_subagents=1, max_total_subagents=6, skill_names=frozenset())",
            apply_prompt_template(
                subagent_enabled=True,
                max_concurrent_subagents=1,
                max_total_subagents=6,
                app_config=app_config,
                skill_names=frozenset(),
            ),
        ),
        (
            "lead_prompt_subagents_disabled_non_interactive.txt",
            "apply_prompt_template(subagent_enabled=False, skill_names=frozenset())",
            apply_prompt_template(
                subagent_enabled=False,
                app_config=app_config,
                skill_names=frozenset(),
            ),
        ),
    ]

    for filename, call, body in renders:
        text = header.format(commit=COMMIT, call=call, container=app_config.skills.container_path) + body
        write_text(f"prompt_renders/{filename}", text)
        written.append(f"prompt_renders/{filename}")

    # non_interactive does not change the rendered system prompt; it filters the
    # bound tool list. Record the real constant so the delta is not lost.
    note = (
        f"# BASELINE NOTE (original DeerFlow engine, commit {COMMIT})\n"
        "# produced by: ports/claude-code/parity/baseline/extract_vectors.py\n"
        "#\n"
        "# `non_interactive` (configurable.non_interactive, set only for internally authenticated\n"
        "# scheduler launches) is NOT an input to apply_prompt_template — the rendered lead system\n"
        "# prompt is byte-identical with and without it. Its entire effect is removing tools from the\n"
        "# bound toolset in deerflow.agents.lead_agent.agent:make_lead_agent.\n"
        "#\n"
        "# Real value of deerflow.agents.lead_agent.agent._NON_INTERACTIVE_DISABLED_TOOL_NAMES:\n"
        f"{json.dumps(sorted(_NON_INTERACTIVE_DISABLED_TOOL_NAMES), indent=2)}\n"
    )
    write_text("prompt_renders/non_interactive_tool_filter.txt", note)
    written.append("prompt_renders/non_interactive_tool_filter.txt")

    subagent_header = "# BASELINE SUBAGENT PROMPT (original DeerFlow engine, commit {commit})\n# produced by: ports/claude-code/parity/baseline/extract_vectors.py\n# source: {source}\n# ---8<--- render begins on the next line ---8<---\n"
    for filename, source, body in [
        (
            "subagent_general_purpose_system_prompt.txt",
            "deerflow.subagents.builtins.general_purpose:GENERAL_PURPOSE_CONFIG.system_prompt",
            GENERAL_PURPOSE_CONFIG.system_prompt,
        ),
        (
            "subagent_general_purpose_description.txt",
            "deerflow.subagents.builtins.general_purpose:GENERAL_PURPOSE_CONFIG.description",
            GENERAL_PURPOSE_CONFIG.description,
        ),
        (
            "subagent_bash_system_prompt.txt",
            "deerflow.subagents.builtins.bash_agent:BASH_AGENT_CONFIG.system_prompt",
            BASH_AGENT_CONFIG.system_prompt,
        ),
        (
            "subagent_bash_description.txt",
            "deerflow.subagents.builtins.bash_agent:BASH_AGENT_CONFIG.description",
            BASH_AGENT_CONFIG.description,
        ),
        (
            "task_tool_description.txt",
            "deerflow.tools.builtins.task_tool:task_tool.description (LangChain-parsed docstring)",
            task_tool.description,
        ),
    ]:
        write_text(f"prompt_renders/{filename}", subagent_header.format(commit=COMMIT, source=source) + body)
        written.append(f"prompt_renders/{filename}")

    return written


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------
def main() -> int:
    produced: list[str] = []
    produced.append(write_json("loop_detection.json", extract_loop_detection()).name)
    produced.append(write_json("tool_meta.json", extract_tool_meta()).name)
    produced.append(write_json("delegations_ledger.json", extract_delegations_ledger()).name)
    produced.append(write_json("caps_clamping.json", extract_caps_clamping()).name)
    produced.append(write_json("goal_counters.json", extract_goal_counters()).name)
    produced.append(write_json("state_reducers.json", extract_state_reducers()).name)
    produced.append(write_json("subagent_status_contract.json", extract_subagent_status_contract()).name)
    produced.extend(extract_prompt_renders())

    for name in produced:
        path = BASELINE_DIR / name
        size = path.stat().st_size
        print(f"wrote {name} ({size} bytes)")
        if name.endswith(".json"):
            json.loads(path.read_text(encoding="utf-8"))
    print(f"OK: {len(produced)} artifacts under {BASELINE_DIR}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
