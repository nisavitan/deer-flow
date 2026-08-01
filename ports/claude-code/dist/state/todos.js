// Ported from backend/packages/harness/deerflow/agents/thread_state.py:merge_todos @ 0950924 — mechanical TypeScript translation
// No baseline vector file covers merge_todos; the semantics are pinned by
// docs/claude-code-port/notes/lead-agent-and-state.md §4 (thread_state.py:110-120) and unit-tested.
import { threadStateFile } from './paths.js';
import { updateStateFile } from './atomic-io.js';
/** File name of the todos channel. */
export const TODOS_FILE = 'todos.json';
/**
 * Reducer for the todos list: keep the last non-None value.
 *
 * - `null`/`undefined` (the node did not touch todos) -> preserve existing;
 * - any provided list, **including an empty one**, is an explicit update and replaces.
 */
export function mergeTodos(existing, incoming) {
    if (incoming === null || incoming === undefined) {
        return existing === null || existing === undefined ? null : [...existing];
    }
    return [...incoming];
}
/** Absolute path of a thread's `todos.json`. */
export function todosPath(threadId, env) {
    return threadStateFile(threadId, TODOS_FILE, env);
}
/** Apply a todos write under atomic-write + `rev` CAS. */
export function applyTodos(filePath, incoming, options) {
    return updateStateFile(filePath, (current) => ({ todos: mergeTodos(current?.todos ?? null, incoming) }), options);
}
