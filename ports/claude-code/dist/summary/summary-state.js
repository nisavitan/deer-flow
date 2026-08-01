// Ported from backend/packages/harness/deerflow/agents/thread_state.py:ThreadState["summary_text"] @ 0950924
//   (LastValue channel, notes/lead-agent-and-state.md §4) and
//   agents/middlewares/summarization_middleware.py:_nonempty_summary (lines 235-245) @ 0950924
//   — structural translation.
//
// The original keeps the compressed history in a LangGraph `summary_text` LastValue channel,
// written only by `DeerFlowSummarizationMiddleware.before_model` and projected into the next
// model request by `DurableContextMiddleware` — never stored as a message
// [notes/middlewares.md §2.18 "summary_text projection"]. The port has no channel table, so
// the same value lives in `summary.json` under the thread state dir and inherits the
// atomic-write + `rev`-CAS discipline of every other channel file
// (docs/claude-code-port/state-checkpoint-resume.md §2.3 `summary.json`).
//
// Two rules are ported, not invented:
//   1. LastValue — a write replaces `summary_text` wholesale.
//   2. A blank / whitespace-only summary is NOT a value. The original treats it as a
//      generation failure and leaves the channel unchanged rather than committing "",
//      because committing an empty replacement would drop history for nothing
//      [summarization_middleware.py:235-245]. The port therefore preserves the previous
//      text on a blank write instead of clearing it.
//
// Port additions over the original channel (a bare string) are declared in
// docs/claude-code-port/summarization-delta.md: `updated_by`, `source_message_count`,
// `commit_sha`, the structured `digest`, and the bounded `compactions` history.
import { threadStateFile } from '../state/paths.js';
import { readStateFile, updateStateFile, } from '../state/atomic-io.js';
/** File name of the summary channel inside a thread's state directory. */
export const SUMMARY_FILE = 'summary.json';
/** Who produced the current `summary_text`. */
export const SUMMARY_UPDATED_BY_VALUES = ['precompact', 'manual', 'deep-run'];
/** What caused a compaction event, as reported by the PreCompact hook payload. */
export const COMPACTION_TRIGGERS = ['auto', 'manual', 'unknown'];
/**
 * Bound on the retained compaction history.
 *
 * The original keeps no such history (a LastValue channel has no log). The port keeps a short
 * one so a reader can tell that native compaction happened and how often; it is capped so the
 * file stays small and rewritable in one atomic write.
 */
export const COMPACTION_HISTORY_MAX_ENTRIES = 20;
/** Raised when a caller supplies an `updated_by` outside the declared vocabulary. */
export class InvalidSummaryUpdatedByError extends Error {
    value;
    name = 'InvalidSummaryUpdatedByError';
    constructor(value) {
        super(`Invalid summary updated_by: ${JSON.stringify(value)}`);
        this.value = value;
    }
}
export function isSummaryUpdatedBy(value) {
    return typeof value === 'string' && SUMMARY_UPDATED_BY_VALUES.includes(value);
}
export function assertSummaryUpdatedBy(value) {
    if (!isSummaryUpdatedBy(value))
        throw new InvalidSummaryUpdatedByError(value);
    return value;
}
/**
 * LastValue merge for `summary_text`.
 *
 * A blank or whitespace-only incoming value is a generation failure, not a value: the previous
 * text is preserved [summarization_middleware.py:_nonempty_summary]. `null`/`undefined` means
 * "this writer produced no summary" and likewise preserves.
 */
export function mergeSummaryText(existing, incoming) {
    if (incoming === null || incoming === undefined || incoming.trim().length === 0) {
        return existing ?? '';
    }
    return incoming;
}
/** Absolute path of a thread's `summary.json`. */
export function summaryPath(threadId, env) {
    return threadStateFile(threadId, SUMMARY_FILE, env);
}
/** Read a thread's summary channel; `null` when it has never been written. */
export function readSummary(filePath, options = {}) {
    return readStateFile(filePath, options);
}
function nextCompactions(current, incoming) {
    const existing = Array.isArray(current) ? [...current] : [];
    if (incoming === null || incoming === undefined)
        return existing;
    existing.push(incoming);
    return existing.length > COMPACTION_HISTORY_MAX_ENTRIES
        ? existing.slice(-COMPACTION_HISTORY_MAX_ENTRIES)
        : existing;
}
/**
 * Apply a summary write under atomic-write + `rev` CAS.
 *
 * `summary_text` follows the LastValue rule above; the provenance fields always record the
 * latest writer, so a blank-summary write still tells a reader who last ran and when.
 */
export function applySummary(filePath, write, options) {
    const updatedBy = assertSummaryUpdatedBy(write.updatedBy);
    const digest = write.digest ?? null;
    return updateStateFile(filePath, (current) => ({
        summary_text: mergeSummaryText(current?.summary_text, write.summaryText),
        updated_by: updatedBy,
        source_message_count: write.sourceMessageCount ?? digest?.source_message_count ?? current?.source_message_count ?? 0,
        commit_sha: write.commitSha ?? current?.commit_sha ?? null,
        digest: digest ?? current?.digest ?? null,
        compactions: nextCompactions(current?.compactions, write.compaction),
    }), options);
}
