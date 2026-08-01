// Ported from backend/packages/harness/deerflow/agents/thread_state.py:merge_delegations @ 0950924 — mechanical TypeScript translation
// Terminal-status vocabulary from backend/packages/harness/deerflow/subagents/status_contract.py:SUBAGENT_STATUS_VALUES @ 0950924.
// Parity vectors: parity/baseline/delegations_ledger.json (operations + sequence).
import { threadStateFile } from './paths.js'
import { updateStateFile, type StateEnvelope, type UpdateOptions } from './atomic-io.js'

/** File name of the delegation-ledger channel inside a thread's state directory. */
export const DELEGATIONS_FILE = 'delegations.json'

/** Ledger cap — `_DELEGATION_LEDGER_MAX_ENTRIES` in the original. */
export const DELEGATION_LEDGER_MAX_ENTRIES = 50

/**
 * Every value `subagent_status` may take. A status in this set is terminal and can never be
 * downgraded by a later out-of-order progress write. `in_progress` is deliberately absent.
 */
export const TERMINAL_DELEGATION_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'cancelled',
  'timed_out',
  'polling_timed_out',
])

export interface DelegationEntry {
  id: string
  run_id?: string
  description: string
  subagent_type: string
  status: string
  result_brief?: string
  result_sha256?: string
  result_ref?: string
  /** Why a guardrail cap ended the run early (token_capped / turn_capped / loop_capped). */
  stop_reason?: string
  created_at: string
  /** Port addition: HEAD when this delegation ran, used by the stale-state predicate. */
  commit_sha?: string
}

export interface DelegationsPayload {
  entries: DelegationEntry[]
  [key: string]: unknown
}

function isTerminal(status: unknown): boolean {
  return typeof status === 'string' && TERMINAL_DELEGATION_STATUSES.has(status)
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
export function mergeDelegations(
  existing: readonly DelegationEntry[] | null | undefined,
  incoming: readonly DelegationEntry[] | null | undefined,
): DelegationEntry[] {
  if (incoming === null || incoming === undefined || incoming.length === 0) {
    return existing ? [...existing] : []
  }

  // A Map preserves insertion order and keeps an entry's position when its key is re-set,
  // which is exactly the original's `by_id` dict + `order` list pairing.
  const byId = new Map<string, DelegationEntry>()
  for (const raw of [...(existing ?? []), ...incoming]) {
    const entryId = raw.id
    const previous = byId.get(entryId)
    if (previous !== undefined && isTerminal(previous.status) && !isTerminal(raw.status)) {
      continue
    }
    let entry = raw
    if (previous !== undefined && previous.created_at) {
      entry = { ...raw, created_at: previous.created_at }
      if (previous.run_id && !entry.run_id) {
        entry = { ...entry, run_id: previous.run_id }
      }
    }
    byId.set(entryId, entry)
  }

  const merged = [...byId.values()]
  return merged.length > DELEGATION_LEDGER_MAX_ENTRIES ? merged.slice(-DELEGATION_LEDGER_MAX_ENTRIES) : merged
}

/** Count distinct delegations attributable to `runId` — the per-run delegation budget input. */
export function countRunDelegations(entries: readonly DelegationEntry[], runId: string | null): number {
  const ids = new Set<string>()
  for (const entry of entries) {
    if (runId !== null && (entry.run_id ?? null) !== runId) continue
    if (entry.id) ids.add(entry.id)
  }
  return ids.size
}

/** Absolute path of a thread's `delegations.json`. */
export function delegationsPath(threadId: string, env?: NodeJS.ProcessEnv): string {
  return threadStateFile(threadId, DELEGATIONS_FILE, env)
}

/** Apply a delegation write to the durable ledger under atomic-write + `rev` CAS. */
export function applyDelegations(
  filePath: string,
  incoming: readonly DelegationEntry[] | null,
  options: UpdateOptions,
): StateEnvelope<DelegationsPayload> {
  return updateStateFile<DelegationsPayload>(
    filePath,
    (current) => ({ entries: mergeDelegations(current?.entries ?? null, incoming) }),
    options,
  )
}
