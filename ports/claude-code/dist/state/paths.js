// Ported from backend/packages/harness/deerflow/utils/thread_id.py:validate_thread_id @ 0950924 — mechanical TypeScript translation
// State-root resolution is the port's own layout (docs/claude-code-port/state-checkpoint-resume.md §2
// "Layer 2 — structured DeerFlow state"); the thread-id contract is the original's, verbatim.
import { join } from 'node:path';
/** Canonical thread identifier contract shared across DeerFlow backends. */
export const THREAD_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** Directory (relative to the project root) that holds every port-owned state file. */
export const STATE_DIR_SEGMENTS = ['.deerflow', 'state'];
/** Raised when a caller supplies a thread id the persistence layer cannot key on. */
export class InvalidThreadIdError extends Error {
    name = 'InvalidThreadIdError';
    threadId;
    constructor(threadId) {
        super('Invalid thread_id: expected 1-64 ASCII letters, digits, hyphens, or underscores');
        this.threadId = threadId;
    }
}
/**
 * Return a valid thread id or throw.
 *
 * Thread IDs are caller-defined opaque identifiers, not necessarily UUIDs, but
 * they must be safe for every persistence and filesystem backend.
 */
export function validateThreadId(threadId) {
    if (typeof threadId !== 'string' || !THREAD_ID_PATTERN.test(threadId)) {
        throw new InvalidThreadIdError(threadId);
    }
    return threadId;
}
/** Project root the state tree hangs off: CLAUDE_PROJECT_DIR when set, else cwd. */
export function resolveProjectRoot(env = process.env) {
    const configured = env['CLAUDE_PROJECT_DIR'];
    return configured && configured.length > 0 ? configured : process.cwd();
}
/** `<project-root>/.deerflow/state`. */
export function stateRoot(env) {
    return join(resolveProjectRoot(env), ...STATE_DIR_SEGMENTS);
}
/** `<project-root>/.deerflow/state/<thread_id>` — validated, never built from raw input. */
export function threadStateDir(threadId, env) {
    return join(stateRoot(env), validateThreadId(threadId));
}
/** Absolute path of one channel file inside a thread's state directory. */
export function threadStateFile(threadId, fileName, env) {
    if (fileName.length === 0 || fileName.includes('/') || fileName.includes('\\') || fileName.includes('..')) {
        throw new Error(`Invalid state file name: ${JSON.stringify(fileName)}`);
    }
    return join(threadStateDir(threadId, env), fileName);
}
/** `<thread dir>/runs` — archived terminal run records and pre-run snapshots. */
export function threadRunsDir(threadId, env) {
    return join(threadStateDir(threadId, env), 'runs');
}
