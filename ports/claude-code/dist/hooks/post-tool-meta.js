// M7 tool-result classifier: PostToolUse hook. Turns a failed or empty tool result into an explicit
// instruction about what to do next.
//
// Ports backend/packages/harness/deerflow/agents/middlewares/tool_result_meta.py @ 0950924 (the
// `deerflow_tool_meta` taxonomy, lead slot 14) — the CLASSIFIER lives in src/middleware/tool-meta.ts
// and is pinned against parity/baseline/tool_meta.json (38 + 4 cases). This file is the delivery.
//
// WHAT CHANGES, AND WHY IT HAS TO. In the original the taxonomy is INVISIBLE to the model: it is
// stamped into `additional_kwargs["deerflow_tool_meta"]` for downstream middleware to read —
// ToolProgress's state machine and the subagent status contract. The port has no message metadata
// channel and, in M7, no ToolProgress state machine either. So the classification is delivered to
// the only consumer that exists here, the model, as `additionalContext`.
//
// That means the ENVELOPE below is port-authored: there is no original wording to be verbatim about.
// What IS carried verbatim is everything inside it — the five taxonomy fields and their values, the
// keyword rules that produce them, and the `recommended_next_action` vocabulary. The one-line
// gloss per action is port-authored too, and labelled as such here and in parity/DISCREPANCIES.md.
//
// SUCCESS IS SILENT. A hook that narrates every successful tool call would spend the context budget
// it is meant to protect. Output is emitted only for an error/partial_success classification, or for
// an oversized result.
import { pathToFileURL } from 'node:url';
import { TOOL_META_KEY, isProblemMeta, normalizeToolResult, } from '../middleware/tool-meta.js';
import { isGuardedToolName, toDeerflowMetaToolName } from '../middleware/tool-adapter.js';
import { appendHookLog, emitHookOutput, flattenToolResponse, inferResultStatus, parseHookPayload, readStdin, resolveThreadId, } from '../middleware/hook-runtime.js';
/**
 * Soft warning threshold for an oversized tool result.
 *
 * The original's ToolOutputBudgetMiddleware externalized results at 12k chars to a file and replaced
 * them with a typed synopsis. That whole mechanism is PLATFORM-NATIVE here: Claude Code truncates
 * and externalizes large tool outputs itself (this session's own transcript shows results persisted
 * to a tool-results file with a preview). The port therefore does not re-implement externalization —
 * it would fight the platform for the same job. What it keeps is the *signal*: a one-line note that
 * the model is looking at a result big enough to have been trimmed, so it narrows the next call
 * instead of re-issuing the same one. Recorded in parity/DISCREPANCIES.md.
 */
export const OVERSIZED_RESULT_CHARS = 20000;
/**
 * PORT-AUTHORED. One line of guidance per `recommended_next_action` value.
 *
 * The original never rendered these — the action was an enum read by other middleware. The vocabulary
 * and which action each error class maps to are the original's; the sentences are not.
 */
export const NEXT_ACTION_GUIDANCE = {
    continue: 'Continue with the plan.',
    rewrite_query: 'Rewrite the query or arguments before retrying — the current form returned nothing usable.',
    try_alternative: 'Try a different tool or source; re-issuing this call unchanged is unlikely to succeed.',
    summarize: 'Stop calling this tool and summarize what you have collected so far.',
    stop: 'Stop calling this tool. This failure class cannot be cleared by retrying.',
};
/** Escape hatch for a session that wants raw tool results with no classifier commentary. */
export const DISABLE_ENV_VAR = 'DEERFLOW_DISABLE_TOOL_META';
/**
 * Run the taxonomy over one PostToolUse event.
 *
 * @returns the classification, or `null` when the hook does not apply at all (disabled, or a tool
 *          outside the guarded set).
 */
export function classifyToolResult(payload, options = {}) {
    const env = options.env ?? process.env;
    if (env[DISABLE_ENV_VAR] === '1')
        return null;
    const toolName = payload.tool_name;
    if (typeof toolName !== 'string' || !isGuardedToolName(toolName))
        return null;
    const content = flattenToolResponse(payload.tool_response);
    const meta = normalizeToolResult({
        toolName: toDeerflowMetaToolName(toolName),
        content,
        status: inferResultStatus(payload.tool_response),
    });
    return { toolName, meta, contentLength: content.length, oversized: content.length > OVERSIZED_RESULT_CHARS };
}
/**
 * Classify one PostToolUse event.
 *
 * @returns the hook output to emit, or `null` on the silent path (unguarded tool, disabled, or a
 *          clean success of normal size).
 */
export function evaluateToolResult(payload, options = {}) {
    return renderToolMetaOutput(classifyToolResult(payload, options));
}
/** Turn a classification into the model-facing block, or `null` when there is nothing worth saying. */
export function renderToolMetaOutput(classification) {
    if (classification === null)
        return null;
    const { toolName, meta, contentLength, oversized } = classification;
    if (!isProblemMeta(meta) && !oversized)
        return null;
    const lines = [];
    if (isProblemMeta(meta)) {
        lines.push(`<${TOOL_META_KEY} tool="${toolName}">`, JSON.stringify(meta), `</${TOOL_META_KEY}>`, `Recommended next action: ${meta.recommended_next_action} — ${NEXT_ACTION_GUIDANCE[meta.recommended_next_action]}`);
        if (!meta.recoverable_by_model) {
            lines.push('This error class is not recoverable by the model: do not retry the same call.');
        }
    }
    if (oversized) {
        lines.push(`This ${toolName} result is ${contentLength} characters, past the ${OVERSIZED_RESULT_CHARS}-character budget; ` +
            'narrow the next call (a range, a filter, a more specific query) instead of re-reading the whole thing.');
    }
    return { additionalContext: lines.join('\n') };
}
async function main() {
    const payload = parseHookPayload(await readStdin());
    if (payload === null)
        return;
    const classification = classifyToolResult(payload);
    const output = renderToolMetaOutput(classification);
    // O3: the taxonomy leaves no durable artefact, and a classification the model ignores is
    // otherwise unobservable — this line is the whole evidence base for S9/S11/S16.
    if (classification !== null) {
        appendHookLog({
            hook: 'post-tool-meta',
            event: 'PostToolUse',
            thread: resolveThreadId(payload, process.env),
            decision: output === null ? 'silent' : 'context',
            summary: `tool=${classification.toolName} status=${classification.meta.status} ` +
                `error_type=${classification.meta.error_type ?? 'none'} oversized=${classification.oversized}`,
        });
    }
    if (output !== null)
        emitHookOutput('PostToolUse', output);
}
// Only consume stdin when invoked as a program (tests import `evaluateToolResult`).
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
    try {
        await main();
    }
    catch {
        // A classifier fault must never disturb a tool result that already succeeded.
    }
    process.stdin.destroy();
    process.exitCode = 0;
}
