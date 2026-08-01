// M10 stale-state detection — port-authored, no single original equivalent.
//
// WHAT IT PORTS. DeerFlow never needs this: its cached work lives in LangGraph checkpoint
// rows that are only ever read back inside the same tree, and `runtime/checkpoint_mode.py`
// covers the one staleness class it does have (a channel representation written under a
// different mode) with a fail-closed gate. The port's caches are different — a delegation
// ledger and a workflow journal that survive across sessions and therefore across `git
// checkout` — and the platform provides NO changed-commit detection for either sessions or
// workflow caches (experiment-results.md E3 item 3). So commit binding is a port-side
// obligation, specified in docs/claude-code-port/state-checkpoint-resume.md §4.
//
// This module is PURE (except {@link checkSchemaGate}, which only delegates to atomic-io's
// reader): every input is supplied by the caller so the verdict matrix is testable without a
// git repository. Reading `git rev-parse` lives in git-head.ts.
import {
  StateFileCorruptError,
  StateSchemaVersionError,
  discardStateFile,
  readStateFile,
  type ReadOptions,
  type StateEnvelope,
  type StatePayload,
} from '../state/atomic-io.js'

/** Every verdict {@link evaluateStaleness} can return. */
export const STALENESS_VERDICTS = ['fresh', 'stale_commit', 'stale_branch'] as const

export type StalenessVerdict = (typeof STALENESS_VERDICTS)[number]

export interface CommitBinding {
  /** `commit_sha` recorded in `run-meta.json` at run start. */
  readonly stateCommitSha: string | null | undefined
  /** `git rev-parse HEAD` now; `null` when HEAD could not be read. */
  readonly currentCommitSha: string | null | undefined
  readonly stateBranch?: string | null | undefined
  readonly currentBranch?: string | null | undefined
}

export interface StalenessReport {
  readonly verdict: StalenessVerdict
  /** Human-readable justification, rendered by `/deerflow:status`. */
  readonly reason: string
  readonly stateCommitSha: string | null
  readonly currentCommitSha: string | null
  readonly stateBranch: string | null
  readonly currentBranch: string | null
  readonly commitMatches: boolean
  /** `false` only when both branches are known and differ. An unknown branch is not evidence. */
  readonly branchMatches: boolean
  /**
   * `true` when commit-bound cached results (delegation entries, workflow journal prefixes)
   * must be re-verified rather than reused. Only a commit move sets this: a branch move that
   * lands on the same commit leaves the tree — and therefore every cached result — valid.
   */
  readonly invalidatesCachedResults: boolean
}

/** Trim and collapse an absent/blank identifier to `null` so `''` never compares equal. */
function normalize(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

/**
 * Compare a run's recorded tree binding against the current one.
 *
 * Precedence is commit-first: a commit move is the only condition that invalidates cached
 * results, so it is reported even when the branch also moved. A branch move at the same
 * commit is surfaced (`stale_branch`) because it changes *where* work would land, but it
 * invalidates nothing.
 *
 * FAIL-CLOSED on unknowns: if either side's commit sha is missing (no git, no recorded sha),
 * the binding cannot be proven and the verdict is `stale_commit` — the port never silently
 * reuses a cached result it cannot tie to a tree (state-checkpoint-resume.md §4).
 */
export function evaluateStaleness(binding: CommitBinding): StalenessReport {
  const stateCommitSha = normalize(binding.stateCommitSha)
  const currentCommitSha = normalize(binding.currentCommitSha)
  const stateBranch = normalize(binding.stateBranch)
  const currentBranch = normalize(binding.currentBranch)

  const commitMatches = stateCommitSha !== null && currentCommitSha !== null && stateCommitSha === currentCommitSha
  const branchKnown = stateBranch !== null && currentBranch !== null
  const branchMatches = !branchKnown || stateBranch === currentBranch

  const base = {
    stateCommitSha,
    currentCommitSha,
    stateBranch,
    currentBranch,
    commitMatches,
    branchMatches,
  } as const

  if (!commitMatches) {
    const reason =
      stateCommitSha === null || currentCommitSha === null
        ? `commit binding unknown (state ${stateCommitSha ?? 'none'}, current ${currentCommitSha ?? 'none'})`
        : `HEAD moved ${short(stateCommitSha)} -> ${short(currentCommitSha)}`
    return { ...base, verdict: 'stale_commit', reason, invalidatesCachedResults: true }
  }
  if (!branchMatches) {
    return {
      ...base,
      verdict: 'stale_branch',
      reason: `branch changed ${stateBranch ?? 'none'} -> ${currentBranch ?? 'none'} at the same commit`,
      invalidatesCachedResults: false,
    }
  }
  return {
    ...base,
    verdict: 'fresh',
    reason: `state matches HEAD ${short(currentCommitSha)}`,
    invalidatesCachedResults: false,
  }
}

/** First 7 characters of a sha, for display only. */
function short(sha: string | null): string {
  return sha === null ? 'unknown' : sha.slice(0, 7)
}

/** Anything carrying the port's per-entry commit binding (a delegation ledger entry). */
export interface CommitBound {
  readonly commit_sha?: string | undefined
}

/**
 * The stage-skip half of the re-verification predicate
 * (state-checkpoint-resume.md §3.2): a cached result is reusable only when its recorded
 * `commit_sha` matches current HEAD. An entry with no recorded sha can never match, so it is
 * always re-run — silence is not evidence.
 *
 * The artifact half (file exists, `result_sha256` matches) is verified by the consumer that
 * owns those files; this module only decides the tree binding.
 */
export function isCommitBindingReusable(
  entryCommitSha: string | null | undefined,
  currentCommitSha: string | null | undefined,
): boolean {
  const entry = normalize(entryCommitSha)
  const current = normalize(currentCommitSha)
  return entry !== null && current !== null && entry === current
}

/**
 * Split commit-bound cached entries into the ones a resume may skip and the ones it must
 * re-run. Invalidated entries are RETURNED, not dropped: the ledger stays truthful, they are
 * merely excluded from the stage-skip predicate (state-checkpoint-resume.md §4).
 */
export function partitionByCommitBinding<T extends CommitBound>(
  entries: readonly T[],
  currentCommitSha: string | null | undefined,
): { reusable: T[]; invalidated: T[] } {
  const reusable: T[] = []
  const invalidated: T[] = []
  for (const entry of entries) {
    if (isCommitBindingReusable(entry.commit_sha, currentCommitSha)) reusable.push(entry)
    else invalidated.push(entry)
  }
  return { reusable, invalidated }
}

export type SchemaGateStatus = 'absent' | 'ok' | 'unreadable'

export interface SchemaGateResult<T extends StatePayload> {
  readonly status: SchemaGateStatus
  /** Non-null only when `status === 'ok'`. Migrations registered in `options` are applied. */
  readonly envelope: StateEnvelope<T> | null
  /** Why the file is unreadable; `null` otherwise. */
  readonly reason: string | null
}

/**
 * The migrate-or-discard gate, delegated to atomic-io.
 *
 * The MIGRATE half is entirely atomic-io's: {@link readStateFile} walks registered
 * migrations in memory and only throws when it cannot reach the reader's version. This
 * wrapper adds nothing to it — it converts that throw into a verdict so a resume/recovery
 * caller can keep going past one uninterpretable channel instead of aborting the scan.
 *
 * Only schema and corruption faults are absorbed; an I/O fault (EACCES, EIO) still throws,
 * because "cannot read the disk" is not the same finding as "this file is from another
 * schema" and must not be silently reported as one.
 */
export function checkSchemaGate<T extends StatePayload = StatePayload>(
  filePath: string,
  options: ReadOptions = {},
): SchemaGateResult<T> {
  try {
    const envelope = readStateFile<T>(filePath, options)
    if (envelope === null) return { status: 'absent', envelope: null, reason: null }
    return { status: 'ok', envelope, reason: null }
  } catch (error) {
    if (error instanceof StateSchemaVersionError || error instanceof StateFileCorruptError) {
      return { status: 'unreadable', envelope: null, reason: error.message }
    }
    throw error
  }
}

export interface DiscardResult<T extends StatePayload> extends SchemaGateResult<T> {
  /** Where an unreadable file was quarantined, or `null` when nothing was discarded. */
  readonly quarantinePath: string | null
}

/**
 * The DISCARD half: quarantine a file this build cannot interpret to
 * `<name>.invalid-<timestamp>` and report the channel as empty, per §4's
 * "never interpret state under the wrong schema".
 */
export function discardIfUnreadable<T extends StatePayload = StatePayload>(
  filePath: string,
  timestamp: string,
  options: ReadOptions = {},
): DiscardResult<T> {
  const gate = checkSchemaGate<T>(filePath, options)
  if (gate.status !== 'unreadable') return { ...gate, quarantinePath: null }
  const quarantinePath = discardStateFile(filePath, timestamp)
  return { ...gate, quarantinePath }
}
