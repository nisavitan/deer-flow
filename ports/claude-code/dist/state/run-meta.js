// Ported from backend/packages/harness/deerflow/runtime/runs/store/base.py:RunStore @ 0950924 — structural translation
// Ported from backend/packages/harness/deerflow/runtime/runs/worker.py:_persist_delivery_receipt @ 0950924 — structural translation
// The original keeps run identity in a SQL `runs` row and persists the delivery receipt
// *before* the terminal status (two stores, ordered). The port collapses both into a single
// atomic rename of run-meta.json, so the ordering window does not exist at all (guarantee G6,
// docs/claude-code-port/state-checkpoint-resume.md §7). Multi-worker columns (lease, owner,
// cancel handoff) are dropped under the single-process collapse.
// No baseline vector file covers run identity; the invariants are pinned by unit tests.
import { threadStateFile } from './paths.js';
import { STATE_SCHEMA_VERSION, updateStateFile } from './atomic-io.js';
/** File name of the run-identity record. */
export const RUN_META_FILE = 'run-meta.json';
/** Statuses a run can never leave. */
export const TERMINAL_RUN_STATUSES = new Set([
    'completed',
    'error',
    'interrupted',
]);
/** Non-terminal statuses hold the thread's single active-run slot. */
export const ACTIVE_RUN_STATUSES = new Set(['pending', 'running']);
/** Raised when a write would downgrade a terminal run record. */
export class TerminalRunStatusError extends Error {
    current;
    next;
    name = 'TerminalRunStatusError';
    constructor(current, next) {
        super(`Terminal run status ${current} cannot be overwritten by ${next}`);
        this.current = current;
        this.next = next;
    }
}
/** Raised when a new run is admitted while the thread still holds a non-terminal run. */
export class ActiveRunExistsError extends Error {
    runId;
    name = 'ActiveRunExistsError';
    constructor(runId) {
        super(`Thread already has a non-terminal run: ${runId}`);
        this.runId = runId;
    }
}
export function isTerminalRunStatus(status) {
    return TERMINAL_RUN_STATUSES.has(status);
}
/** Build a fresh run-identity record. */
export function buildRunMeta(options) {
    return {
        schema_version: STATE_SCHEMA_VERSION,
        run_id: options.runId,
        thread_id: options.threadId,
        ...(options.sessionId === undefined ? {} : { session_id: options.sessionId }),
        commit_sha: options.commitSha,
        ...(options.branch === undefined ? {} : { branch: options.branch }),
        ...(options.worktreePath === undefined ? {} : { worktree_path: options.worktreePath }),
        status: options.status ?? 'running',
        stop_reason: null,
        error: null,
        started_at: options.now,
        updated_at: options.now,
        ended_at: null,
    };
}
/**
 * Return the next run record.
 *
 * Guard: a terminal record is never overwritten by a non-terminal status. Terminal-to-terminal
 * is allowed (recovery may stamp `interrupted`/`orphan_recovered` over a failed finalize), and
 * an already-recorded delivery receipt always survives.
 */
export function transitionRunMeta(current, options) {
    if (isTerminalRunStatus(current.status) && !isTerminalRunStatus(options.status)) {
        throw new TerminalRunStatusError(current.status, options.status);
    }
    const terminal = isTerminalRunStatus(options.status);
    const delivery = current.delivery ?? options.delivery;
    return {
        ...current,
        status: options.status,
        stop_reason: options.stopReason === undefined ? (current.stop_reason ?? null) : options.stopReason,
        error: options.error === undefined ? (current.error ?? null) : options.error,
        ...(delivery === undefined ? {} : { delivery }),
        updated_at: options.now,
        ended_at: terminal ? options.now : (current.ended_at ?? null),
    };
}
/**
 * Recovery backfill: an orphaned non-terminal record gets a terminal status plus a zero
 * receipt when it has none — the port's `put_if_absent` receipt backfill.
 */
export function recoverOrphanedRun(current, now) {
    return transitionRunMeta(current, {
        status: 'interrupted',
        stopReason: 'orphan_recovered',
        now,
        delivery: { presented_paths: [], receipt_at: now },
    });
}
/** Absolute path of a thread's `run-meta.json`. */
export function runMetaPath(threadId, env) {
    return threadStateFile(threadId, RUN_META_FILE, env);
}
/** Admit a new run, refusing while the thread still holds a non-terminal one. */
export function startRun(filePath, run, options) {
    return updateStateFile(filePath, (current) => {
        const existing = current?.run ?? null;
        if (existing !== null && !isTerminalRunStatus(existing.status)) {
            throw new ActiveRunExistsError(existing.run_id);
        }
        return { run: buildRunMeta(run) };
    }, options);
}
/** Write a status transition (and, on terminal, its receipt) in one atomic rename. */
export function applyRunTransition(filePath, transition, options) {
    return updateStateFile(filePath, (current) => {
        const existing = current?.run ?? null;
        if (existing === null)
            throw new Error(`No run record to transition in ${filePath}`);
        return { run: transitionRunMeta(existing, transition) };
    }, options);
}
