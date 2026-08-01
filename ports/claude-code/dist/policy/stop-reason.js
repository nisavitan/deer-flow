// Ported from backend/packages/harness/deerflow/subagents/status_contract.py @ 0950924 — mechanical TypeScript translation
//   SUBAGENT_STATUS_VALUES, SUBAGENT_STOP_REASON_VALUES, _STOP_REASON_LABELS,
//   _RESULT_BEARING_STATUSES, _LEGACY_STATUS_NORMALIZATION.
// Ported from backend/packages/harness/deerflow/agents/middlewares/delegation_ledger.py:_status_guidance @ 0950924 — mechanical TypeScript translation
// Contract fixture: contracts/subagent_status_contract.json (v2).
// Parity vectors: parity/baseline/subagent_status_contract.json
//   (`status_values`, `stop_reason_values`, and the 60 `result_message_formats` rows).
//
// This module owns the *vocabulary*; src/deeprun/result-format.ts owns the rendering that
// consumes it. They are split so the workflow-side inline copy of the formatter has exactly
// one place to stay in sync with.
/** Every value `subagent_status` may take. Mirrors `valid_status_values` in the contract. */
export const SUBAGENT_STATUS_VALUES = [
    'completed',
    'failed',
    'cancelled',
    'timed_out',
    'polling_timed_out',
];
/**
 * Why a guardrail cap ended a run early. Carried on the additive `subagent_stop_reason`
 * field, never as a status enum value (#3875 Phase 2). Mirrors `valid_stop_reason_values`.
 */
export const SUBAGENT_STOP_REASON_VALUES = ['token_capped', 'turn_capped', 'loop_capped'];
/**
 * Human-readable label folded into the model-visible result text when a cap fired, e.g.
 * `Task Succeeded (capped: token budget). Result: ...`. Verbatim from `_STOP_REASON_LABELS`.
 */
export const STOP_REASON_LABELS = {
    token_capped: 'token budget',
    turn_capped: 'turn budget',
    loop_capped: 'repeated tool-call loop',
};
/**
 * Statuses that carry a recoverable result in `result_brief` / `result_sha256`.
 * Only `completed` — a capped run whose partial work survived also surfaces as `completed`.
 */
export const RESULT_BEARING_STATUSES = new Set(['completed']);
/**
 * Read-side normalization for a status that no longer exists on the producer but survives in
 * checkpointed history (#3949 Phase 1 → #3980). `max_turns_reached` resolves to its Phase 2
 * cap equivalent so historical data lands terminally instead of stranding as `in_progress`.
 */
export const LEGACY_STATUS_NORMALIZATION = {
    max_turns_reached: 'turn_capped',
};
/**
 * Non-terminal ledger status. Deliberately NOT a contract status value: the original's
 * `DelegationEntry` uses it for a dispatched-but-unfinished delegation and
 * `TERMINAL_DELEGATION_STATUSES` (src/state/delegations.ts) excludes it so it can never
 * overwrite a terminal write.
 */
export const IN_PROGRESS_STATUS = 'in_progress';
export function isSubagentStatus(value) {
    return typeof value === 'string' && SUBAGENT_STATUS_VALUES.includes(value);
}
export function isSubagentStopReason(value) {
    return typeof value === 'string' && SUBAGENT_STOP_REASON_VALUES.includes(value);
}
/**
 * Producer-boundary validation. The original raises `ValueError` rather than accepting an
 * arbitrary string, "a typo would silently leak through to consumers as missing metadata
 * rather than failing loudly at the producer boundary".
 */
export class SubagentContractValueError extends Error {
    name = 'SubagentContractValueError';
    constructor(message) {
        super(message);
    }
}
export function assertSubagentStatus(value) {
    if (!isSubagentStatus(value)) {
        throw new SubagentContractValueError(`invalid subagent status ${JSON.stringify(value)}; expected one of ${SUBAGENT_STATUS_VALUES.join(', ')}`);
    }
    return value;
}
export function assertSubagentStopReason(value) {
    if (value === null || value === undefined)
        return null;
    if (!isSubagentStopReason(value)) {
        throw new SubagentContractValueError(`invalid subagent stop_reason ${JSON.stringify(value)}; expected one of ${SUBAGENT_STOP_REASON_VALUES.join(', ')}`);
    }
    return value;
}
/** The `(capped: ...)` label for a stop reason, or `null` when no cap fired. */
export function stopReasonLabel(stopReason) {
    if (stopReason === null || stopReason === undefined)
        return null;
    return STOP_REASON_LABELS[stopReason] ?? null;
}
/**
 * Ledger guidance line — `_status_guidance`, verbatim strings.
 *
 * Rendered by the original into `## Work already delegated` as
 * `- [status] description (via type; guidance) -> brief`. A cap always wins over the plain
 * status branch: a capped run tells the lead what to do about the cap, not about the status.
 */
export function statusGuidance(status, stopReason) {
    if (stopReason !== null && stopReason !== undefined && stopReason !== '') {
        if (status === 'completed') {
            return 'hit a guardrail cap with a partial result; reuse the partial result, retry with a tighter scope, or raise the per-agent budget (max_turns / token_budget)';
        }
        return 'hit a guardrail cap with no usable result; retry with a tighter scope or raise the per-agent budget (max_turns / token_budget)';
    }
    if (status === IN_PROGRESS_STATUS)
        return 'already delegated; do NOT delegate again; wait for or build on the result';
    if (status === 'completed')
        return 'completed result; do NOT delegate again; reuse this result';
    if (status === 'failed')
        return 'failed attempt; may retry with a changed plan';
    if (status === 'cancelled')
        return 'cancelled attempt; may retry with a changed plan';
    if (status === 'timed_out')
        return 'timed-out attempt; may retry with a changed plan';
    if (status === 'polling_timed_out')
        return 'polling timed-out attempt; may retry with a changed plan';
    return 'prior attempt; inspect status before retrying';
}
