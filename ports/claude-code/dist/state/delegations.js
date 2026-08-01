// Ported from backend/packages/harness/deerflow/agents/thread_state.py:merge_delegations @ 0950924 — mechanical TypeScript translation
// Terminal-status vocabulary from backend/packages/harness/deerflow/subagents/status_contract.py:SUBAGENT_STATUS_VALUES @ 0950924.
// Parity vectors: parity/baseline/delegations_ledger.json (operations + sequence).
import { threadStateFile } from './paths.js';
import { updateStateFile } from './atomic-io.js';
/** File name of the delegation-ledger channel inside a thread's state directory. */
export const DELEGATIONS_FILE = 'delegations.json';
/** Ledger cap — `_DELEGATION_LEDGER_MAX_ENTRIES` in the original. */
export const DELEGATION_LEDGER_MAX_ENTRIES = 50;
/**
 * Every value `subagent_status` may take. A status in this set is terminal and can never be
 * downgraded by a later out-of-order progress write. `in_progress` is deliberately absent.
 */
export const TERMINAL_DELEGATION_STATUSES = new Set([
    'completed',
    'failed',
    'cancelled',
    'timed_out',
    'polling_timed_out',
]);
function isTerminal(status) {
    return typeof status === 'string' && TERMINAL_DELEGATION_STATUSES.has(status);
}
/**
 * Reducer for the delegation ledger.
 *
 * - incoming None/empty -> preserve existing;
 * - append entries, replacing the same id with the latest version while preserving first-seen
 *   order and inheriting the first-seen `created_at` plus the previously tagged `run_id`;
 * - a terminal status is never overwritten by a non-terminal status;
 * - truncated to the most recent {@link DELEGATION_LEDGER_MAX_ENTRIES} entries.
 */
export function mergeDelegations(existing, incoming) {
    if (incoming === null || incoming === undefined || incoming.length === 0) {
        return existing ? [...existing] : [];
    }
    // A Map preserves insertion order and keeps an entry's position when its key is re-set,
    // which is exactly the original's `by_id` dict + `order` list pairing.
    const byId = new Map();
    for (const raw of [...(existing ?? []), ...incoming]) {
        const entryId = raw.id;
        const previous = byId.get(entryId);
        if (previous !== undefined && isTerminal(previous.status) && !isTerminal(raw.status)) {
            continue;
        }
        let entry = raw;
        if (previous !== undefined && previous.created_at) {
            entry = { ...raw, created_at: previous.created_at };
            if (previous.run_id && !entry.run_id) {
                entry = { ...entry, run_id: previous.run_id };
            }
        }
        byId.set(entryId, entry);
    }
    const merged = [...byId.values()];
    return merged.length > DELEGATION_LEDGER_MAX_ENTRIES ? merged.slice(-DELEGATION_LEDGER_MAX_ENTRIES) : merged;
}
/** Count distinct delegations attributable to `runId` — the per-run delegation budget input. */
export function countRunDelegations(entries, runId) {
    const ids = new Set();
    for (const entry of entries) {
        if (runId !== null && (entry.run_id ?? null) !== runId)
            continue;
        if (entry.id)
            ids.add(entry.id);
    }
    return ids.size;
}
/** Absolute path of a thread's `delegations.json`. */
export function delegationsPath(threadId, env) {
    return threadStateFile(threadId, DELEGATIONS_FILE, env);
}
/** Apply a delegation write to the durable ledger under atomic-write + `rev` CAS. */
export function applyDelegations(filePath, incoming, options) {
    return updateStateFile(filePath, (current) => ({ entries: mergeDelegations(current?.entries ?? null, incoming) }), options);
}
