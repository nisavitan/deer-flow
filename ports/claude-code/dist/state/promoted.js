// Ported from backend/packages/harness/deerflow/agents/thread_state.py:merge_promoted @ 0950924 — mechanical TypeScript translation
// Parity vectors: parity/baseline/state_reducers.json -> merge_promoted.
import { threadStateFile } from './paths.js';
import { updateStateFile } from './atomic-io.js';
/** File name of the deferred-tool promotion channel. */
export const PROMOTED_FILE = 'promoted.json';
/** `list(dict.fromkeys(...))` — dedupe preserving first-seen order. */
function dedupe(names) {
    return [...new Set(names)];
}
/**
 * Reducer for deferred-tool promotions, scoped by catalog hash.
 *
 * - incoming None/empty -> preserve existing (the node did not touch promotions);
 * - `catalog_hash` changed -> replace wholesale, dropping stale names, so a persisted bare
 *   name cannot expose a different tool after catalog drift;
 * - same `catalog_hash` -> union names, dedupe, preserve order.
 */
export function mergePromoted(existing, incoming) {
    // Python's `if not new` is true for None and for an empty dict alike.
    if (incoming === null || incoming === undefined || Object.keys(incoming).length === 0) {
        return existing ?? null;
    }
    const incomingHash = String(incoming.catalog_hash);
    const incomingNames = incoming.names ?? [];
    if (existing === null || existing === undefined || existing.catalog_hash !== incomingHash) {
        return { catalog_hash: incomingHash, names: dedupe(incomingNames) };
    }
    return { catalog_hash: existing.catalog_hash, names: dedupe([...existing.names, ...incomingNames]) };
}
/** Absolute path of a thread's `promoted.json`. */
export function promotedPath(threadId, env) {
    return threadStateFile(threadId, PROMOTED_FILE, env);
}
/** Apply a promotion write under atomic-write + `rev` CAS. */
export function applyPromoted(filePath, incoming, options) {
    return updateStateFile(filePath, (current) => ({ promoted: mergePromoted(current?.promoted ?? null, incoming) }), options);
}
