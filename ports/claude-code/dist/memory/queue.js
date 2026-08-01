// The durable capture queue — the port's stand-in for deermem core/queue.py:MemoryUpdateQueue
// @ 0950924 (structural translation).
//
// Upstream is a process-local list plus a `threading.Timer` debounce (`debounce_seconds` default
// 30, range 1-300) that coalesces contexts per (thread_id, user_id, agent_name) before a worker
// pool runs the extraction LLM call. The port keeps the QUEUE and drops the TIMER: Claude Code
// has no long-lived process to host one, and a hook must not block a turn on an LLM call. Batches
// are drained on the next turn instead. See parity/DISCREPANCIES.md §M9 entry 1.
//
// This module is deliberately import-safe: it contains NO top-level side effects, so both the
// Stop hook (src/hooks/memory-extract.ts) and the store CLI can depend on it. Putting this logic
// in the hook module itself would mean importing the hook *runs* it — which silently consumed
// the CLI's stdin before the split.
import { appendFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { memoryRoot } from './store.js';
/** Queue filename below the memory root. */
export const QUEUE_FILE_NAME = 'queue.jsonl';
/** Hard cap on one captured message, so a single huge turn cannot grow the queue unboundedly. */
export const MAX_CAPTURED_CHARS = 20000;
function clamp(text) {
    return text.length > MAX_CAPTURED_CHARS ? `${text.slice(0, MAX_CAPTURED_CHARS)}\n[truncated]` : text;
}
/**
 * Flatten a transcript `message.content` into plain text.
 *
 * Defensive by construction: content may be a bare string, an array of typed blocks, or a shape
 * this build has never seen. Anything unrecognized contributes nothing rather than throwing —
 * mirroring `prompt.py:format_conversation_for_update`, which tolerates multimodal list content
 * and keeps text parts only.
 */
export function extractText(content) {
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
        const text = block['text'];
        if (typeof text === 'string')
            parts.push(text);
    }
    return parts.join(' ').trim();
}
/**
 * Pull the last user message and last assistant response out of a transcript JSONL body.
 *
 * Returns `null` when either side is missing: upstream requires at least one human AND one AI
 * message before enqueuing anything (`deer_mem.py:202-293`). Unparseable lines are skipped
 * individually so one corrupt record never discards the whole turn.
 */
export function extractTurn(transcript) {
    let user = '';
    let assistant = '';
    for (const line of transcript.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '')
            continue;
        let record;
        try {
            record = JSON.parse(trimmed);
        }
        catch {
            continue;
        }
        if (typeof record !== 'object' || record === null)
            continue;
        const entry = record;
        // Transcript records carry `type` plus a nested `message` envelope; some builds put `role`
        // on the record itself. Accept either.
        const message = typeof entry['message'] === 'object' && entry['message'] !== null ? entry['message'] : entry;
        const role = typeof message['role'] === 'string' ? message['role'] : typeof entry['type'] === 'string' ? entry['type'] : '';
        if (role !== 'user' && role !== 'assistant')
            continue;
        // A `tool_result` block is a user-role record but not a user utterance; it carries no `text`
        // field, so `extractText` returns '' and the empty check below drops it.
        const text = extractText(message['content']);
        if (text.trim() === '')
            continue;
        if (role === 'user')
            user = text;
        else
            assistant = text;
    }
    if (user.trim() === '' || assistant.trim() === '')
        return null;
    return { user: clamp(user.trim()), assistant: clamp(assistant.trim()) };
}
/** Absolute path of the queue file. */
export function queuePath(env) {
    return join(memoryRoot(env), QUEUE_FILE_NAME);
}
/** Append one entry, creating the memory root on demand. */
export function appendQueueEntry(entry, env) {
    mkdirSync(memoryRoot(env), { recursive: true });
    appendFileSync(queuePath(env), `${JSON.stringify(entry)}\n`, 'utf8');
}
/** Read every queued batch. A corrupt line is skipped, never fatal. An absent queue is empty. */
export function readQueue(env) {
    let raw;
    try {
        raw = readFileSync(queuePath(env), 'utf8');
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return [];
        throw error;
    }
    const entries = [];
    for (const line of raw.split('\n')) {
        if (line.trim() === '')
            continue;
        try {
            const parsed = JSON.parse(line);
            if (typeof parsed['user'] !== 'string' || typeof parsed['assistant'] !== 'string')
                continue;
            entries.push({
                capturedAt: typeof parsed['capturedAt'] === 'string' ? parsed['capturedAt'] : '',
                sessionId: typeof parsed['sessionId'] === 'string' ? parsed['sessionId'] : null,
                user: parsed['user'],
                assistant: parsed['assistant'],
            });
        }
        catch {
            // A corrupt line never discards the rest of the batch.
        }
    }
    return entries;
}
/** Truncate the queue. Called only after the batch was durably applied. */
export function clearQueue(env) {
    try {
        rmSync(queuePath(env));
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
}
