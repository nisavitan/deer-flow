// Ported from backend/packages/harness/deerflow/subagents/status_contract.py @ 0950924 — mechanical TypeScript translation
//   format_subagent_result_message, make_subagent_additional_kwargs,
//   normalize_token_usage, _bound_metadata_text.
// Parity vectors: parity/baseline/subagent_status_contract.json -> `result_message_formats`
//   (all 60 status x stop_reason x input-shape rows; the test asserts byte equality of both
//   `model_visible_content` and `metadata_error`, plus the full `additional_kwargs` object).
//
// IMPORTANT: workflows/deep-run.js carries an inline copy of `formatSubagentResultMessage`
// because workflow scripts cannot import modules. Any change here must be mirrored there;
// deep-run.js names this file as its source of truth.
import { createHash } from 'node:crypto';
import { RESULT_BEARING_STATUSES, assertSubagentStatus, assertSubagentStopReason, stopReasonLabel, } from '../policy/stop-reason.js';
export const SUBAGENT_STATUS_KEY = 'subagent_status';
export const SUBAGENT_STOP_REASON_KEY = 'subagent_stop_reason';
export const SUBAGENT_ERROR_KEY = 'subagent_error';
export const SUBAGENT_RESULT_BRIEF_KEY = 'subagent_result_brief';
export const SUBAGENT_RESULT_SHA256_KEY = 'subagent_result_sha256';
export const SUBAGENT_MODEL_NAME_KEY = 'subagent_model_name';
export const SUBAGENT_TOKEN_USAGE_KEY = 'subagent_token_usage';
export const SUBAGENT_METADATA_TEXT_MAX_CHARS = 2000;
/** The sentinel `_extract_final_result` returns when a subagent produced nothing usable. */
export const NO_RESPONSE_SENTINEL = 'No response generated';
/**
 * `_bound_metadata_text` — deterministic middle truncation, head 2/3 and tail 1/3 around a
 * `\n...\n` marker. Not an LLM summary.
 *
 * Slicing runs over CODE POINTS, not UTF-16 code units, because the original slices a Python
 * `str`: for astral-plane text a naive JS slice would cut a surrogate pair in half and change
 * the rendered length.
 */
export function boundMetadataText(text, cap = SUBAGENT_METADATA_TEXT_MAX_CHARS) {
    const cleaned = text.trim();
    const points = [...cleaned];
    if (points.length <= cap)
        return cleaned;
    const marker = '\n...\n';
    if (cap <= marker.length)
        return points.slice(0, cap).join('');
    const head = Math.floor((cap * 2) / 3);
    const tail = cap - head - marker.length;
    if (tail <= 0)
        return points.slice(0, cap).join('');
    return `${points.slice(0, head).join('')}${marker}${points.slice(points.length - tail).join('')}`;
}
/** Python `str(error).strip() if isinstance(error, str) else ""`. */
function errorText(error) {
    return typeof error === 'string' ? error.trim() : '';
}
/**
 * `format_subagent_result_message` — model-visible task content plus normalized metadata error.
 *
 * When `stopReason` is set a short `(capped: ...)` note is folded into the text so the lead
 * agent sees — without parsing metadata — that a guardrail cap ended the run. Note that
 * `cancelled` / `timed_out` / `polling_timed_out` deliberately IGNORE the cap label: the cap
 * is not why they ended.
 *
 * The `detail === base` comparisons are the original's, not an "is the error empty" test: an
 * error whose text is literally `Task failed.` renders without the ` Error: ` suffix too.
 */
export function formatSubagentResultMessage(status, input = {}) {
    const resultText = input.result === null || input.result === undefined ? '' : String(input.result);
    const detailText = errorText(input.error);
    const capped = stopReasonLabel(input.stopReason ?? null);
    if (status === 'completed') {
        const head = capped === null ? 'Task Succeeded.' : `Task Succeeded (capped: ${capped}).`;
        return { modelVisibleContent: `${head} Result: ${resultText}`, metadataError: null };
    }
    if (status === 'cancelled') {
        const base = 'Task cancelled by user.';
        const detail = detailText || base;
        if (detail === base)
            return { modelVisibleContent: detail, metadataError: detail };
        return { modelVisibleContent: `Task cancelled by user. Error: ${detail}`, metadataError: detail };
    }
    if (status === 'timed_out') {
        const base = 'Task timed out.';
        const detail = detailText || base;
        if (detail === base)
            return { modelVisibleContent: detail, metadataError: detail };
        return { modelVisibleContent: `Task timed out. Error: ${detail}`, metadataError: detail };
    }
    if (status === 'polling_timed_out') {
        // The detail IS the content here — no "Error:" prefix.
        const detail = detailText || 'Task polling timed out.';
        return { modelVisibleContent: detail, metadataError: detail };
    }
    // `failed` — including a capped run that produced no usable output. The cap note is folded
    // in so the lead can tell a broken subagent from one that ran out of budget. The metadata
    // error deliberately carries the bare `Task failed.`, WITHOUT the cap suffix.
    const base = 'Task failed.';
    const detail = detailText || base;
    if (capped !== null) {
        if (detail === base)
            return { modelVisibleContent: `Task failed (capped: ${capped}).`, metadataError: detail };
        return { modelVisibleContent: `Task failed (capped: ${capped}). Error: ${detail}`, metadataError: detail };
    }
    if (detail === base)
        return { modelVisibleContent: detail, metadataError: detail };
    return { modelVisibleContent: `Task failed. Error: ${detail}`, metadataError: detail };
}
/**
 * `normalize_token_usage` — validate a cumulative usage mapping into the contract shape.
 * Requires non-negative integers for all three keys; anything else yields `null` rather than
 * a partially-filled object. Python rejects `bool`; TypeScript's `typeof true !== 'number'`
 * covers the same case.
 */
export function normalizeTokenUsage(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return null;
    const source = value;
    const normalized = {};
    for (const key of ['input_tokens', 'output_tokens', 'total_tokens']) {
        const amount = source[key];
        if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 0)
            return null;
        normalized[key] = amount;
    }
    return normalized;
}
/**
 * `make_subagent_additional_kwargs` — the structured metadata payload the original stamps on
 * the terminal `ToolMessage`.
 *
 * Key order matches the original's insertion order (status, result brief + digest, error,
 * stop reason, model name, token usage) so a JSON dump compares cleanly against the vectors.
 * Blank errors are dropped so the wire format never carries a misleading `subagent_error: ""`.
 * The digest hashes the FULL result, not the truncated brief.
 */
export function makeSubagentAdditionalKwargs(status, input = {}) {
    assertSubagentStatus(status);
    const stopReason = assertSubagentStopReason(input.stopReason ?? null);
    const payload = { [SUBAGENT_STATUS_KEY]: status };
    const result = input.result;
    if (RESULT_BEARING_STATUSES.has(status) && typeof result === 'string' && result.trim() !== '') {
        payload[SUBAGENT_RESULT_BRIEF_KEY] = boundMetadataText(result);
        payload[SUBAGENT_RESULT_SHA256_KEY] = createHash('sha256').update(result, 'utf8').digest('hex');
    }
    // Only `completed` (a clean success, or a capped run whose partial work survived)
    // suppresses the error blob; every other status carries it.
    const error = input.error;
    if (status !== 'completed' && typeof error === 'string' && error.trim() !== '') {
        payload[SUBAGENT_ERROR_KEY] = boundMetadataText(error);
    }
    if (stopReason !== null)
        payload[SUBAGENT_STOP_REASON_KEY] = stopReason;
    const modelName = input.modelName;
    if (typeof modelName === 'string' && modelName.trim() !== '') {
        payload[SUBAGENT_MODEL_NAME_KEY] = modelName.trim();
    }
    const usage = normalizeTokenUsage(input.tokenUsage);
    if (usage !== null)
        payload[SUBAGENT_TOKEN_USAGE_KEY] = usage;
    return payload;
}
