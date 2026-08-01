// Ported from backend/packages/harness/deerflow/agents/thread_state.py:ThreadState["summary_text"] @ 0950924
//   (LastValue channel, notes/lead-agent-and-state.md §4) and
//   agents/middlewares/summarization_middleware.py:_nonempty_summary (lines 235-245) @ 0950924
//   — structural translation.
//
// The original keeps the compressed history in a LangGraph `summary_text` LastValue channel,
// written only by `DeerFlowSummarizationMiddleware.before_model` and projected into the next
// model request by `DurableContextMiddleware` — never stored as a message
// [notes/middlewares.md §2.18 "summary_text projection"]. The port has no channel table, so
// the same value lives in `summary.json` under the thread state dir and inherits the
// atomic-write + `rev`-CAS discipline of every other channel file
// (docs/claude-code-port/state-checkpoint-resume.md §2.3 `summary.json`).
//
// Two rules are ported, not invented:
//   1. LastValue — a write replaces `summary_text` wholesale.
//   2. A blank / whitespace-only summary is NOT a value. The original treats it as a
//      generation failure and leaves the channel unchanged rather than committing "",
//      because committing an empty replacement would drop history for nothing
//      [summarization_middleware.py:235-245]. The port therefore preserves the previous
//      text on a blank write instead of clearing it.
//
// Port additions over the original channel (a bare string) are declared in
// docs/claude-code-port/summarization-delta.md: `updated_by`, `source_message_count`,
// `commit_sha`, the structured `digest`, and the bounded `compactions` history.
import { threadStateFile } from '../state/paths.js'
import {
  readStateFile,
  updateStateFile,
  type ReadOptions,
  type StateEnvelope,
  type UpdateOptions,
} from '../state/atomic-io.js'

/** File name of the summary channel inside a thread's state directory. */
export const SUMMARY_FILE = 'summary.json'

/** Who produced the current `summary_text`. */
export const SUMMARY_UPDATED_BY_VALUES = ['precompact', 'manual', 'deep-run'] as const

export type SummaryUpdatedBy = (typeof SUMMARY_UPDATED_BY_VALUES)[number]

/** What caused a compaction event, as reported by the PreCompact hook payload. */
export const COMPACTION_TRIGGERS = ['auto', 'manual', 'unknown'] as const

export type CompactionTrigger = (typeof COMPACTION_TRIGGERS)[number]

/**
 * Bound on the retained compaction history.
 *
 * The original keeps no such history (a LastValue channel has no log). The port keeps a short
 * one so a reader can tell that native compaction happened and how often; it is capped so the
 * file stays small and rewritable in one atomic write.
 */
export const COMPACTION_HISTORY_MAX_ENTRIES = 20

export interface CompactionRecord {
  at: string
  trigger: CompactionTrigger
  updated_by: SummaryUpdatedBy
}

/** One open todo carried into the digest. Shape mirrors the native todo item, loosely. */
export interface DigestTodo {
  content: string
  status: string
}

/** Delegation ledger roll-up: counts only, never the full ledger (that file is authoritative). */
export interface DigestDelegations {
  total: number
  by_status: Record<string, number>
}

/**
 * Deterministic checkpoint digest.
 *
 * NOT an LLM summary — every field is copied or counted from durable state, exactly like the
 * original's `result_brief` bounding is "a deterministic head/tail truncation, not an LLM
 * summary" [delegation_ledger.py:33]. A hook must never call a model, so this is what the
 * port can guarantee at compaction time.
 */
export interface SummaryDigest {
  generated_at: string
  trigger: CompactionTrigger
  /** Most recent user objectives, newest last, each bounded. */
  objectives: string[]
  open_todos: DigestTodo[]
  delegations: DigestDelegations
  artifacts: string[]
  /** Messages observed in the source transcript, or 0 when it could not be read. */
  source_message_count: number
}

export interface SummaryPayload {
  summary_text: string
  updated_by: SummaryUpdatedBy
  source_message_count: number
  commit_sha: string | null
  digest: SummaryDigest | null
  compactions: CompactionRecord[]
  [key: string]: unknown
}

/** Raised when a caller supplies an `updated_by` outside the declared vocabulary. */
export class InvalidSummaryUpdatedByError extends Error {
  override readonly name = 'InvalidSummaryUpdatedByError'
  constructor(readonly value: unknown) {
    super(`Invalid summary updated_by: ${JSON.stringify(value)}`)
  }
}

export function isSummaryUpdatedBy(value: unknown): value is SummaryUpdatedBy {
  return typeof value === 'string' && (SUMMARY_UPDATED_BY_VALUES as readonly string[]).includes(value)
}

export function assertSummaryUpdatedBy(value: unknown): SummaryUpdatedBy {
  if (!isSummaryUpdatedBy(value)) throw new InvalidSummaryUpdatedByError(value)
  return value
}

/**
 * LastValue merge for `summary_text`.
 *
 * A blank or whitespace-only incoming value is a generation failure, not a value: the previous
 * text is preserved [summarization_middleware.py:_nonempty_summary]. `null`/`undefined` means
 * "this writer produced no summary" and likewise preserves.
 */
export function mergeSummaryText(
  existing: string | null | undefined,
  incoming: string | null | undefined,
): string {
  if (incoming === null || incoming === undefined || incoming.trim().length === 0) {
    return existing ?? ''
  }
  return incoming
}

/** Absolute path of a thread's `summary.json`. */
export function summaryPath(threadId: string, env?: NodeJS.ProcessEnv): string {
  return threadStateFile(threadId, SUMMARY_FILE, env)
}

/** Read a thread's summary channel; `null` when it has never been written. */
export function readSummary(
  filePath: string,
  options: ReadOptions = {},
): StateEnvelope<SummaryPayload> | null {
  return readStateFile<SummaryPayload>(filePath, options)
}

export interface SummaryWrite {
  /** New compressed history, or `null` when this writer produced none (see {@link mergeSummaryText}). */
  readonly summaryText: string | null
  readonly updatedBy: SummaryUpdatedBy
  /** Messages the summary was derived from; defaults to the digest's count, else 0. */
  readonly sourceMessageCount?: number
  readonly commitSha?: string | null
  readonly digest?: SummaryDigest | null
  /** Appended to the bounded compaction history when provided. */
  readonly compaction?: CompactionRecord | null
}

function nextCompactions(
  current: readonly CompactionRecord[] | null | undefined,
  incoming: CompactionRecord | null | undefined,
): CompactionRecord[] {
  const existing = Array.isArray(current) ? [...current] : []
  if (incoming === null || incoming === undefined) return existing
  existing.push(incoming)
  return existing.length > COMPACTION_HISTORY_MAX_ENTRIES
    ? existing.slice(-COMPACTION_HISTORY_MAX_ENTRIES)
    : existing
}

/**
 * Apply a summary write under atomic-write + `rev` CAS.
 *
 * `summary_text` follows the LastValue rule above; the provenance fields always record the
 * latest writer, so a blank-summary write still tells a reader who last ran and when.
 */
export function applySummary(
  filePath: string,
  write: SummaryWrite,
  options: UpdateOptions,
): StateEnvelope<SummaryPayload> {
  const updatedBy = assertSummaryUpdatedBy(write.updatedBy)
  const digest = write.digest ?? null
  return updateStateFile<SummaryPayload>(
    filePath,
    (current) => ({
      summary_text: mergeSummaryText(current?.summary_text, write.summaryText),
      updated_by: updatedBy,
      source_message_count:
        write.sourceMessageCount ?? digest?.source_message_count ?? current?.source_message_count ?? 0,
      commit_sha: write.commitSha ?? current?.commit_sha ?? null,
      digest: digest ?? current?.digest ?? null,
      compactions: nextCompactions(current?.compactions, write.compaction),
    }),
    options,
  )
}
