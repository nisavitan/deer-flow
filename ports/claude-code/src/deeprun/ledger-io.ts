// Ported from backend/packages/harness/deerflow/agents/middlewares/delegation_ledger.py:extract_delegations @ 0950924 — structural translation
// Parity vectors: parity/baseline/delegations_ledger.json (the reducer's operations + sequence,
//   already pinned by src/state/delegations.test.ts).
//
// Structural, not mechanical: the original DERIVES the ledger by scanning message history —
// `task` tool calls become `in_progress` entries and the paired ToolMessage's
// `additional_kwargs` upgrades them to terminal. The port has no message history to scan
// (deep-run.js dispatches through the Agent tool, whose calls never land in the lead's
// message list as `task` calls), so the same two-step lifecycle is produced directly by the
// dispatcher: `dispatchEntry` at launch, `terminalEntry` on return. The reducer in
// src/state/delegations.ts is unchanged and still enforces terminal-never-downgraded, so an
// out-of-order write cannot undo a finished delegation.
//
// TIMESTAMPS: workflow scripts cannot call `Date.now()` / `new Date()` (they would break
// resume), so every function here takes `createdAt` as an argument. The deep run stamps them
// after the workflow returns — see the ledger-capture verdict in parity/DISCREPANCIES.md.
import {
  applyDelegations,
  delegationsPath,
  type DelegationEntry,
  type DelegationsPayload,
} from '../state/delegations.js'
import type { StateEnvelope, UpdateOptions } from '../state/atomic-io.js'
import { IN_PROGRESS_STATUS, type SubagentStopReason } from '../policy/stop-reason.js'
import { makeSubagentAdditionalKwargs, SUBAGENT_RESULT_BRIEF_KEY, SUBAGENT_RESULT_SHA256_KEY } from './result-format.js'
import type { DeepRunTaskResult } from './task-schema.js'
import type { PlannedTask } from './batching.js'

/** `_DESCRIPTION_CAP` — descriptions are bounded before they enter the ledger. */
export const DESCRIPTION_CAP = 200

/**
 * Stable delegation id.
 *
 * The original reuses the `task` tool_call_id as the task_id "for traceability". The port has
 * no tool_call_id, and cannot mint a uuid (no `Math.random()` in workflow scripts and the id
 * must survive a workflow resume unchanged), so it derives one from the run identity plus the
 * task's position in the plan. Deterministic, unique within a run, and resume-stable.
 */
export function delegationId(runId: string, index: number): string {
  return `${runId}:${index}`
}

function boundDescription(description: string): string {
  return description.length <= DESCRIPTION_CAP ? description : description.slice(0, DESCRIPTION_CAP)
}

export interface DispatchEntryOptions {
  readonly runId: string
  readonly createdAt: string
  readonly commitSha?: string
}

/**
 * Ledger entry for a dispatched-but-unfinished delegation.
 *
 * Status `in_progress` is deliberately not a contract status value: it is the original's
 * non-terminal ledger marker and is absent from `TERMINAL_DELEGATION_STATUSES`, so the
 * terminal write that follows can always overwrite it — never the other way round.
 */
export function dispatchEntry(task: PlannedTask, options: DispatchEntryOptions): DelegationEntry {
  return {
    id: delegationId(options.runId, task.index),
    run_id: options.runId,
    description: boundDescription(task.description),
    subagent_type: task.agentType,
    status: IN_PROGRESS_STATUS,
    created_at: options.createdAt,
    ...(options.commitSha === undefined ? {} : { commit_sha: options.commitSha }),
  }
}

/**
 * Terminal ledger entry for a returned delegation.
 *
 * `result_brief` / `result_sha256` come from `makeSubagentAdditionalKwargs`, so the bounded
 * brief and the digest-of-the-FULL-result are produced by exactly one implementation.
 * The reducer inherits `created_at` from the dispatch entry with the same id, so the caller
 * does not need the original timestamp here.
 */
export function terminalEntry(dispatch: DelegationEntry, result: DeepRunTaskResult): DelegationEntry {
  const kwargs = makeSubagentAdditionalKwargs(result.status, {
    result: result.result,
    error: result.status === 'completed' ? null : result.result,
    stopReason: (result.stop_reason ?? null) as SubagentStopReason | null,
  })
  const brief = kwargs[SUBAGENT_RESULT_BRIEF_KEY]
  const sha256 = kwargs[SUBAGENT_RESULT_SHA256_KEY]
  return {
    ...dispatch,
    status: result.status,
    ...(result.stop_reason ? { stop_reason: result.stop_reason } : {}),
    ...(typeof brief === 'string' ? { result_brief: brief } : {}),
    ...(typeof sha256 === 'string' ? { result_sha256: sha256 } : {}),
  }
}

/**
 * Map a whole finished deep run onto its ledger entries: one terminal entry per accepted task.
 *
 * Dropped tasks get NO entry — they were never delegated, and inventing an entry for them
 * would consume per-run budget that was never spent. They surface through the plan's
 * `[SUBAGENT LIMIT REACHED]` note instead.
 */
export function runLedgerEntries(
  tasks: readonly PlannedTask[],
  results: readonly DeepRunTaskResult[],
  options: DispatchEntryOptions,
): DelegationEntry[] {
  const entries: DelegationEntry[] = []
  for (let position = 0; position < tasks.length; position += 1) {
    const task = tasks[position]
    const result = results[position]
    if (task === undefined || result === undefined) continue
    entries.push(terminalEntry(dispatchEntry(task, options), result))
  }
  return entries
}

/** Write ledger entries for a thread under the state library's atomic-write + `rev` CAS. */
export function writeDelegations(
  threadId: string,
  entries: readonly DelegationEntry[],
  options: UpdateOptions,
  env?: NodeJS.ProcessEnv,
): StateEnvelope<DelegationsPayload> {
  return applyDelegations(delegationsPath(threadId, env), entries, options)
}
