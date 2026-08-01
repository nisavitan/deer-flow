// M10 crash / orphan recovery.
//
// WHAT IT PORTS. `RunManager` reconciliation (startup + every 3rd heartbeat cycle,
// single-flight) claims expired- or NULL-lease `runs` rows via `claim_for_takeover`, marks
// them with `stop_reason="orphan_recovered"` and backfills a zero delivery receipt through
// the same `put_if_absent` singleton, so a receipt written by a worker that crashed *after*
// delivering is preserved [manager.py:1700-1784, 1845-2069, 987-1006, via
// notes/runtime-and-persistence.md §"Crash / orphan recovery"]. `shutdown(timeout)` marks
// only non-settled runs `interrupted` [manager.py:2136-2234].
//
// WHAT CHANGES. The original's abandonment test is a *lease*: a row is orphaned when its
// heartbeat lease expired or was never taken. The port is single-process (the deployment
// collapse blessed by notes/runtime-and-persistence.md §9.9, "startup reclaims NULL-lease
// active rows"), so there is no lease to expire and no peer to take over. Abandonment is
// decided by two facts the port can actually observe:
//   1. the recording session is not the current session (state-checkpoint-resume.md §5 step 1:
//      "a non-terminal record from another/dead session is by definition abandoned"), and
//   2. the record has not been updated for longer than {@link ORPHAN_EXPIRY_MS}.
// (1) alone identifies the orphan; (2) decides whether it is still worth offering as a resume
// or should be terminalized now. Recorded in parity/DISCREPANCIES.md (M10 §1).
//
// PURITY. Every timestamp is caller-injected: the scan takes `now`, the apply takes `now`.
// Nothing here calls `Date.now()`, so the whole decision matrix is testable against fixtures.
import { readdirSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { THREAD_ID_PATTERN } from '../state/paths.js'
import {
  RUN_META_FILE,
  applyRunTransition,
  isTerminalRunStatus,
  type RunMeta,
  type RunMetaPayload,
} from '../state/run-meta.js'
import { checkSchemaGate } from './staleness.js'

/**
 * How long a non-terminal run may go without an update before recovery terminalizes it
 * instead of offering it as a resume candidate: 2 hours.
 *
 * This is the port's analog of DeerFlow's heartbeat lease deadline. It is deliberately far
 * longer than any lease (the original renews every `lease_seconds/3`), because the port has no
 * peer that could steal the run — the constant only separates "the session that owns this is
 * probably still around" from "nothing has touched this since; it is dead". Too short would
 * terminalize a run the user is still working on; too long would leave the thread's single
 * active-run slot blocked (`ActiveRunExistsError`) for the rest of the day.
 */
export const ORPHAN_EXPIRY_MS = 2 * 60 * 60 * 1000

/** What recovery proposes to do with one orphaned run. */
export type RecoveryAction = 'resume_candidate' | 'mark_interrupted'

export interface OrphanRun {
  readonly threadId: string
  /** Absolute path of the thread's `run-meta.json`. */
  readonly filePath: string
  readonly run: RunMeta
  readonly action: RecoveryAction
  /** Milliseconds since `updated_at`, or `null` when that timestamp is unparseable. */
  readonly ageMs: number | null
  readonly reason: string
}

export interface OrphanScanOptions {
  /** `<project-root>/.deerflow/state` — the directory holding one subdirectory per thread. */
  readonly stateRoot: string
  /** ISO-8601 "now", injected by the caller. */
  readonly now: string
  /** Defaults to {@link ORPHAN_EXPIRY_MS}. */
  readonly expiryMs?: number
  /**
   * The session running the scan. A non-terminal record written by THIS session is live work,
   * not an orphan, and is skipped entirely.
   */
  readonly currentSessionId?: string | null
}

/**
 * Thread ids present under `stateRoot`, sorted.
 *
 * Only directories whose name satisfies the thread-id contract are returned: a stray file or a
 * quarantined `<name>.invalid-…` directory is not a thread. A missing state root yields `[]`.
 */
export function listStateThreads(stateRoot: string): string[] {
  let entries: Dirent[]
  try {
    entries = readdirSync(stateRoot, { withFileTypes: true })
  } catch {
    return [] // No state root yet: nothing to recover, never an error.
  }
  return entries
    .filter((entry) => entry.isDirectory() && THREAD_ID_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort()
}

/** Read one thread's run record, tolerating an absent or uninterpretable file. */
export function readRunMeta(filePath: string): RunMeta | null {
  const gate = checkSchemaGate<RunMetaPayload>(filePath)
  if (gate.status !== 'ok') return null
  const run = gate.envelope?.payload.run ?? null
  return run !== null && typeof run === 'object' ? run : null
}

/** Milliseconds between two ISO-8601 timestamps, or `null` when either is unparseable. */
function elapsedMs(from: string | undefined, to: string): number | null {
  if (typeof from !== 'string') return null
  const start = Date.parse(from)
  const end = Date.parse(to)
  if (Number.isNaN(start) || Number.isNaN(end)) return null
  return end - start
}

/**
 * Decide what to do with one non-terminal run record.
 *
 * An unparseable `updated_at` yields `mark_interrupted`: a record whose own clock cannot be
 * read gives no evidence that anything is still working on it, and the fail-closed direction
 * here is to terminalize (which is recoverable — the state files are untouched) rather than
 * to leave the thread's active-run slot blocked forever.
 */
export function classifyOrphan(run: RunMeta, now: string, expiryMs: number): { action: RecoveryAction; ageMs: number | null; reason: string } {
  const ageMs = elapsedMs(run.updated_at, now)
  if (ageMs === null) {
    return { action: 'mark_interrupted', ageMs: null, reason: `unparseable updated_at (${String(run.updated_at)})` }
  }
  if (ageMs > expiryMs) {
    return {
      action: 'mark_interrupted',
      ageMs,
      reason: `no update for ${Math.round(ageMs / 60000)} min (expiry ${Math.round(expiryMs / 60000)} min)`,
    }
  }
  return {
    action: 'resume_candidate',
    ageMs,
    reason: `last updated ${Math.round(ageMs / 60000)} min ago, within the ${Math.round(expiryMs / 60000)} min expiry`,
  }
}

/**
 * Scan every thread's `run-meta.json` for non-terminal runs left behind by a dead session.
 *
 * Returns candidates only — nothing is written. Terminal runs, absent records, records this
 * session owns, and records under an unreadable schema are all skipped.
 */
export function scanOrphanRuns(options: OrphanScanOptions): OrphanRun[] {
  const expiryMs = options.expiryMs ?? ORPHAN_EXPIRY_MS
  const currentSessionId = options.currentSessionId ?? null
  const orphans: OrphanRun[] = []

  for (const threadId of listStateThreads(options.stateRoot)) {
    const filePath = join(options.stateRoot, threadId, RUN_META_FILE)
    let run: RunMeta | null
    try {
      run = readRunMeta(filePath)
    } catch {
      continue // An I/O fault on one thread must not abort the whole scan.
    }
    if (run === null) continue
    if (typeof run.status !== 'string' || isTerminalRunStatus(run.status)) continue
    if (currentSessionId !== null && run.session_id === currentSessionId) continue

    const { action, ageMs, reason } = classifyOrphan(run, options.now, expiryMs)
    orphans.push({ threadId, filePath, run, action, ageMs, reason })
  }
  return orphans
}

export interface ApplyRecoveryOptions {
  readonly now: string
}

/**
 * Terminalize one orphan.
 *
 * Writes `status: "interrupted"` + `stop_reason: "orphan_recovered"` and, when the record has
 * no receipt, a zero receipt `{presented_paths: [], receipt_at: now}` — all in ONE atomic
 * rename, which is where the port is locally stronger than the original's two-store ordering
 * (guarantee G6). An existing receipt is preserved by `transitionRunMeta`'s put-if-absent
 * rule, exactly mirroring the original's `put_if_absent` backfill.
 *
 * A `resume_candidate` is never written: recovery only terminalizes what it decided is dead.
 *
 * @returns the written record, or `null` when the orphan was left alone.
 */
export function applyRecovery(orphan: OrphanRun, options: ApplyRecoveryOptions): RunMeta | null {
  if (orphan.action !== 'mark_interrupted') return null
  const envelope = applyRunTransition(
    orphan.filePath,
    {
      status: 'interrupted',
      stopReason: 'orphan_recovered',
      now: options.now,
      delivery: { presented_paths: [], receipt_at: options.now },
    },
    { now: options.now },
  )
  return envelope.payload.run
}

export interface RecoveryOutcome {
  /** Every non-terminal run found, whatever the verdict. */
  readonly orphans: OrphanRun[]
  /** The subset that was terminalized by this call. */
  readonly interrupted: OrphanRun[]
  /** The subset still offered for resume. */
  readonly resumable: OrphanRun[]
  /** Threads whose recovery write failed, with the reason. Recovery never throws. */
  readonly failures: Array<{ threadId: string; error: string }>
}

/**
 * Scan and apply in one pass — the entry point used by the SessionStart hook and by any
 * deep-run launch.
 *
 * Never throws: a thread whose write fails is reported in `failures` and the scan continues,
 * because a recovery fault must not block the session that triggered it.
 */
export function recoverOrphanRuns(options: OrphanScanOptions): RecoveryOutcome {
  const orphans = scanOrphanRuns(options)
  const interrupted: OrphanRun[] = []
  const resumable: OrphanRun[] = []
  const failures: Array<{ threadId: string; error: string }> = []

  for (const orphan of orphans) {
    if (orphan.action !== 'mark_interrupted') {
      resumable.push(orphan)
      continue
    }
    try {
      applyRecovery(orphan, { now: options.now })
      interrupted.push(orphan)
    } catch (error) {
      failures.push({ threadId: orphan.threadId, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { orphans, interrupted, resumable, failures }
}
