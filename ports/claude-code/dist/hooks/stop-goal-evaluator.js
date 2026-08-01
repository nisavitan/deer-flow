// M11 Stop hook: the deterministic half of DeerFlow's goal-continuation loop.
//
// WHAT IT PORTS. `runtime/runs/worker.py` re-enters the graph after a visible turn while an active
// goal is unsatisfied: it asks a separate non-thinking evaluator model for a typed verdict
// (`runtime/goal.py:evaluate_goal_completion`), then continues with a hidden
// `<goal_continuation>` HumanMessage — bounded by continuation cap 8, the no-progress breaker 2,
// a durable end-of-turn receipt and a thread-unchanged check [worker.py:908-932, 1229-1260].
//
// THE ADAPTATION (recorded in parity/DISCREPANCIES.md). A hook is a short-lived subprocess with no
// model credentials, so the evaluator model call has no counterpart here. The port splits the loop:
//   - deterministic gates (cap, breaker, evidence presence) run HERE, in `decideStopHook`, where
//     the model cannot influence them;
//   - the semantic verdict is delegated back to the session model by BLOCKING the stop with the
//     verbatim evaluator rubric as the block reason.
// Evaluator independence is lost. Termination is not: this hook persists `continuation_count + 1`
// BEFORE it emits the block, so at most `max_continuations` blocks can ever be issued for one goal
// regardless of what the model does with the rubric.
//
// HARD RULES FOR THIS FILE:
//   1. NO MODEL CALL. See above.
//   2. EXIT 0 ALWAYS, and on any failure emit NO decision — an unreadable transcript or an
//      unwritable state dir must let the turn end, never wedge it.
//   3. THIN SHELL. Every decision lives in src/goal-loop/orchestrate.ts so it is unit-testable
//      without a subprocess; this file only does IO.
//
// Registration is NOT applied here: hooks/hooks.json is owned by another lane. The request is
// appended to hooks/REGISTRATION-REQUESTS.md.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { formatVisibleConversation, latestVisibleAssistantSignature, } from '../goal-loop/evaluator-prompt.js';
import { decideStopHook } from '../goal-loop/orchestrate.js';
import { readGoal, writeGoal } from '../goal-loop/goal-cli.js';
import { goalPath } from '../state/goal.js';
import { THREAD_ID_PATTERN } from '../state/paths.js';
/** Milliseconds to wait for the hook payload before giving up. Mirrors precompact-summary.ts. */
const STDIN_TIMEOUT_MS = 2000;
/**
 * Resolve the thread id whose `goal.json` this stop belongs to. Same contract as
 * `precompact-summary.ts`: `DEERFLOW_THREAD_ID` wins, else the session id when it satisfies the
 * thread-id pattern, else stand down rather than invent a directory name.
 */
export function resolveThreadId(payload, env) {
    const configured = env['DEERFLOW_THREAD_ID'];
    if (typeof configured === 'string' && THREAD_ID_PATTERN.test(configured))
        return configured;
    const sessionId = payload.session_id;
    if (typeof sessionId === 'string' && THREAD_ID_PATTERN.test(sessionId))
        return sessionId;
    return null;
}
function textOfContent(content) {
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return '';
    const parts = [];
    for (const block of content) {
        if (typeof block === 'string') {
            parts.push(block);
            continue;
        }
        if (typeof block !== 'object' || block === null)
            continue;
        const record = block;
        if (record['type'] !== 'text')
            continue;
        const text = record['text'];
        if (typeof text === 'string')
            parts.push(text);
    }
    return parts.join('\n');
}
/**
 * Defensive JSONL transcript reader: every line that is not a well-formed user/assistant entry is
 * skipped rather than aborting the read. Mirrors `goal.py:_is_visible_message` in what counts as
 * evidence — only `user` and `assistant` roles, only non-empty text.
 */
export function parseTranscriptMessages(raw) {
    const messages = [];
    for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length === 0)
            continue;
        let entry;
        try {
            entry = JSON.parse(trimmed);
        }
        catch {
            continue;
        }
        if (typeof entry !== 'object' || entry === null)
            continue;
        const record = entry;
        const type = record['type'];
        if (type !== 'user' && type !== 'assistant')
            continue;
        const message = record['message'];
        const content = typeof message === 'object' && message !== null ? message['content'] : record['content'];
        const text = textOfContent(content).trim();
        if (text.length === 0)
            continue;
        messages.push({ role: type, text });
    }
    return messages;
}
/** Read + parse a transcript file; an unreadable path yields no evidence, never an exception. */
export function readTranscript(transcriptPath) {
    if (transcriptPath === null || transcriptPath.length === 0)
        return [];
    try {
        return parseTranscriptMessages(readFileSync(transcriptPath, 'utf8'));
    }
    catch {
        return [];
    }
}
/**
 * One Stop event, end to end: resolve thread → read goal → read transcript evidence → decide →
 * persist → report. Never throws (rule 2).
 */
export function evaluateStop(payload, options) {
    const env = options.env ?? process.env;
    const threadId = resolveThreadId(payload, env);
    if (threadId === null)
        return { decision: null, threadId: null, persisted: false };
    try {
        const goal = readGoal(threadId, env);
        const messages = readTranscript(typeof payload.transcript_path === 'string' ? payload.transcript_path : null);
        const decision = decideStopHook({
            goal,
            evidenceText: formatVisibleConversation(messages),
            evidenceSignature: latestVisibleAssistantSignature(messages),
            stopHookActive: payload.stop_hook_active === true,
            runId: threadId,
            now: options.now,
        });
        let persisted = false;
        if (decision.nextGoal !== null) {
            // Persist BEFORE the block is emitted: the counter, not the model, bounds this loop.
            writeGoal(goalPath(threadId, env), decision.nextGoal, options.now);
            persisted = true;
        }
        return { decision, threadId, persisted };
    }
    catch (error) {
        process.stderr.write(`deerflow stop-goal-evaluator: standing down (${error instanceof Error ? error.message : String(error)})\n`);
        return { decision: null, threadId, persisted: false };
    }
}
/** The Stop hook's stdout protocol: a block decision, or nothing at all. */
export function renderHookOutput(outcome) {
    const decision = outcome.decision;
    if (decision === null || !decision.block || decision.blockReason === null)
        return '';
    return `${JSON.stringify({ decision: 'block', reason: decision.blockReason })}\n`;
}
function readStdin() {
    return new Promise((resolve) => {
        const chunks = [];
        let settled = false;
        const finish = () => {
            if (settled)
                return;
            settled = true;
            resolve(Buffer.concat(chunks).toString('utf8'));
        };
        const timer = setTimeout(finish, STDIN_TIMEOUT_MS);
        timer.unref();
        process.stdin.on('data', (chunk) => chunks.push(chunk));
        process.stdin.on('end', () => {
            clearTimeout(timer);
            finish();
        });
        process.stdin.on('error', () => {
            clearTimeout(timer);
            finish();
        });
    });
}
async function main() {
    const raw = await readStdin();
    let payload;
    try {
        payload = JSON.parse(raw);
    }
    catch {
        return; // Malformed payload: stand down.
    }
    if (typeof payload !== 'object' || payload === null)
        return;
    const output = renderHookOutput(evaluateStop(payload, { now: new Date().toISOString() }));
    if (output.length > 0)
        process.stdout.write(output);
}
// Only consume stdin when invoked as a program: the unit tests import the pure helpers above.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
    try {
        await main();
    }
    catch {
        // Rule 2: a hook fault must never wedge the turn.
    }
    process.stdin.destroy();
    process.exitCode = 0;
}
