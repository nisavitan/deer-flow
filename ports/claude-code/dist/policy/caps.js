// Ported from backend/packages/harness/deerflow/config/subagents_config.py:clamp_subagent_concurrency,clamp_total_subagents_per_run @ 0950924 — mechanical TypeScript translation
// Ported from backend/packages/harness/deerflow/agents/middlewares/subagent_limit_middleware.py:SubagentLimitMiddleware.__init__,_truncate_task_calls @ 0950924 — structural translation
// Parity vectors: parity/baseline/caps_clamping.json.
// Structural, not mechanical, for the truncation half: the original rewrites the AIMessage's
// tool_calls inside an after_model middleware hook. The port has no message-rewrite point, so
// the same arithmetic decides how many delegations the dispatcher may launch, and the same
// note text / stop_reason ride out on the decision instead of on a cloned message.
import { countRunDelegations } from '../state/delegations.js';
export const MIN_CONCURRENT_SUBAGENT_CALLS = 1;
export const MAX_CONCURRENT_SUBAGENT_CALLS = 4;
export const MIN_TOTAL_SUBAGENTS_PER_RUN = 1;
export const MAX_TOTAL_SUBAGENTS_PER_RUN = 50;
export const DEFAULT_MAX_TOTAL_SUBAGENTS_PER_RUN = 6;
/** `MAX_CONCURRENT_SUBAGENTS` — the middleware's default per-response concurrency. */
export const DEFAULT_MAX_CONCURRENT_SUBAGENT_CALLS = 3;
/** Model-visible note appended when the per-run delegation budget is exhausted. Verbatim. */
export const SUBAGENT_LIMIT_NOTE = '[SUBAGENT LIMIT REACHED] The subagent delegation limit for this run has been reached. ' +
    'Continue using the subagent results already collected, execute remaining simple work ' +
    'directly, or summarize the remaining work instead of launching more subagents.';
/** Stop reason stamped on the run when the per-run cap is exhausted (#4176). */
export const SUBAGENT_LIMIT_STOP_REASON = 'subagent_limit_capped';
/**
 * Raised for a non-integer limit. The original's `max(1, min(4, None))` raises `TypeError`;
 * the recorded vectors pin that as an error rather than a fabricated clamped value, so the
 * port refuses the input instead of coercing it.
 */
export class SubagentLimitTypeError extends TypeError {
    value;
    name = 'SubagentLimitTypeError';
    constructor(value) {
        super(`Subagent limit must be an integer, received ${value === null ? 'null' : typeof value}`);
        this.value = value;
    }
}
function requireInteger(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
        throw new SubagentLimitTypeError(value);
    }
    return value;
}
/** Clamp per-response task-call concurrency to the enforced middleware range [1, 4]. */
export function clampSubagentConcurrency(value) {
    return Math.max(MIN_CONCURRENT_SUBAGENT_CALLS, Math.min(MAX_CONCURRENT_SUBAGENT_CALLS, requireInteger(value)));
}
/** Clamp per-run task delegation totals to the enforced range [1, 50]. */
export function clampTotalSubagentsPerRun(value) {
    return Math.max(MIN_TOTAL_SUBAGENTS_PER_RUN, Math.min(MAX_TOTAL_SUBAGENTS_PER_RUN, requireInteger(value)));
}
/** Clamped limit pair — the port's `SubagentLimitMiddleware.__init__`. */
export function createSubagentLimits(maxConcurrent = DEFAULT_MAX_CONCURRENT_SUBAGENT_CALLS, maxTotal = DEFAULT_MAX_TOTAL_SUBAGENTS_PER_RUN) {
    return {
        maxConcurrent: clampSubagentConcurrency(maxConcurrent),
        maxTotal: clampTotalSubagentsPerRun(maxTotal),
    };
}
/** `_append_text`: join with a blank line, or replace when there is nothing to append to. */
function appendText(content, text) {
    if (content === null || content === undefined || content === '')
        return text;
    return `${content}\n\n${text}`;
}
/**
 * Count prior delegations of the current run.
 *
 * Fail-restrictive, exactly like the original: with no `run_id` in scope every ledger entry
 * counts as prior usage rather than none.
 */
export function priorDelegationsForRun(delegations, runId) {
    if (!Array.isArray(delegations))
        return 0;
    return countRunDelegations(delegations, runId);
}
/**
 * How many `task` delegations may be launched in this response.
 *
 * `allowed = min(max_concurrent, max(0, max_total - prior))`. When the request exceeds it the
 * excess calls are dropped; when the per-run budget is fully exhausted the model-visible
 * limit note is appended and the run is stamped `subagent_limit_capped`.
 */
export function allowedThisResponse(request) {
    const { maxConcurrent, maxTotal } = request.limits;
    const remainingTotal = Math.max(0, maxTotal - request.priorDelegations);
    const allowed = Math.min(maxConcurrent, remainingTotal);
    if (request.requestedTaskCalls <= allowed) {
        // The original returns None: no message update, nothing truncated, no stop reason.
        return {
            allowedTaskCalls: request.requestedTaskCalls,
            remainingTotal,
            truncated: false,
            limitNoteAppended: false,
            messageContent: null,
            stopReason: null,
        };
    }
    const exhausted = remainingTotal === 0;
    const content = exhausted ? appendText(request.messageContent, SUBAGENT_LIMIT_NOTE) : (request.messageContent ?? null);
    return {
        allowedTaskCalls: allowed,
        remainingTotal,
        truncated: true,
        limitNoteAppended: exhausted,
        messageContent: content,
        stopReason: exhausted ? SUBAGENT_LIMIT_STOP_REASON : null,
    };
}
