// Ported from backend/packages/harness/deerflow/agents/thread_state.py:merge_artifacts @ 0950924 — mechanical TypeScript translation
// Parity vectors: parity/baseline/state_reducers.json -> merge_artifacts.
import { threadStateFile } from './paths.js';
import { updateStateFile } from './atomic-io.js';
/** File name of the presented-artifacts channel. */
export const ARTIFACTS_FILE = 'artifacts.json';
/**
 * Reducer for the artifacts list: merge and deduplicate preserving first-seen order.
 *
 * A `null` update preserves the existing list; an empty list is a no-op merge (not a clear).
 */
export function mergeArtifacts(existing, incoming) {
    if (existing === null || existing === undefined)
        return incoming ? [...incoming] : [];
    if (incoming === null || incoming === undefined)
        return [...existing];
    return [...new Set([...existing, ...incoming])];
}
/** Absolute path of a thread's `artifacts.json`. */
export function artifactsPath(threadId, env) {
    return threadStateFile(threadId, ARTIFACTS_FILE, env);
}
/** Apply an artifacts write under atomic-write + `rev` CAS. */
export function applyArtifacts(filePath, incoming, options) {
    return updateStateFile(filePath, (current) => ({ artifacts: mergeArtifacts(current?.artifacts ?? null, incoming) }), options);
}
