// Deterministic checkpoint digest — port-authored, no single original equivalent.
//
// WHAT IT REPLACES. The original's compaction produces an LLM summary
// (`DeerFlowSummarizationMiddleware._create_summary`, model-dependent by its own
// classification [notes/middlewares.md §2.18 "Deterministic? Model-dependent"]). The port
// cannot reproduce that at the compaction boundary: the only place the port learns that
// compaction is about to happen is the PreCompact hook, and a hook is a short-lived
// subprocess that must never call a model (it has no credentials, no budget, and blocks the
// turn). So the port writes what it CAN guarantee — a deterministic digest assembled from
// durable state — and leaves the prose summary to Claude Code's own native compaction, which
// the port does not control. Both halves are declared in
// docs/claude-code-port/summarization-delta.md.
//
// The digest is deliberately assembled from the port's own state files (todos.json,
// delegations.json, artifacts.json), which are written by deterministic hooks, plus a
// best-effort read of the conversation tail. State files are the authoritative source; the
// transcript only contributes user objectives and a message count.
import { readFileSync } from 'node:fs'
import { boundText } from './bound-text.js'
import type { CompactionTrigger, DigestDelegations, DigestTodo, SummaryDigest } from './summary-state.js'
import { readStateFile } from '../state/atomic-io.js'
import { ARTIFACTS_FILE, type ArtifactsPayload } from '../state/artifacts.js'
import { DELEGATIONS_FILE, type DelegationsPayload } from '../state/delegations.js'
import { TODOS_FILE, type TodosPayload } from '../state/todos.js'
import { join } from 'node:path'

/** How many recent user objectives the digest carries. */
export const DIGEST_MAX_OBJECTIVES = 5

/** Per-objective character cap — the original's `_DESCRIPTION_CAP` for ledger descriptions. */
export const DIGEST_OBJECTIVE_CAP = 200

/** Bound on listed open todos and artifacts, so one atomic write stays small. */
export const DIGEST_MAX_TODOS = 20
export const DIGEST_MAX_ARTIFACTS = 20

/** Todo statuses that count as still open. */
const OPEN_TODO_STATUSES: ReadonlySet<string> = new Set(['pending', 'in_progress'])

/**
 * Extract user objectives and a message count from a session transcript.
 *
 * TRANSCRIPT PARSING IS BEST-EFFORT AND OPTIONAL. `state-checkpoint-resume.md` §2.1 records
 * the transcript format as "internal/unstable — never parsed by the port". This function is
 * the one deliberate exception, and it is written so the rule is honoured in effect: every
 * shape assumption is defensive, ANY failure yields `{objectives: [], messageCount: 0}`, and
 * the digest is still produced from state files alone. Nothing downstream depends on a
 * successful parse. See the delta doc row "conversation tail".
 */
export function extractTranscriptTail(
  raw: string,
  maxObjectives: number = DIGEST_MAX_OBJECTIVES,
): { objectives: string[]; messageCount: number } {
  const objectives: string[] = []
  let messageCount = 0

  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    let record: unknown
    try {
      record = JSON.parse(trimmed)
    } catch {
      continue // A truncated or non-JSON line is skipped, never fatal.
    }
    if (typeof record !== 'object' || record === null || Array.isArray(record)) continue
    const entry = record as Record<string, unknown>
    messageCount += 1

    const message = entry['message']
    if (typeof message !== 'object' || message === null || Array.isArray(message)) continue
    const role = (message as Record<string, unknown>)['role']
    if (role !== 'user') continue

    const text = extractUserText((message as Record<string, unknown>)['content'])
    if (text.length === 0) continue
    objectives.push(boundText(text, DIGEST_OBJECTIVE_CAP))
  }

  return {
    objectives: maxObjectives >= 0 ? objectives.slice(-maxObjectives) : objectives,
    messageCount,
  }
}

/** Pull plain text out of a message content field: a string, or an array of typed blocks. */
function extractUserText(content: unknown): string {
  if (typeof content === 'string') return collapse(content)
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block)
      continue
    }
    if (typeof block !== 'object' || block === null) continue
    const typed = block as Record<string, unknown>
    // A tool_result block is not a user objective; it is the platform replaying tool output.
    if (typed['type'] !== 'text') continue
    const text = typed['text']
    if (typeof text === 'string') parts.push(text)
  }
  return collapse(parts.join(' '))
}

function collapse(text: string): string {
  return text.split(/\s+/u).filter((part) => part.length > 0).join(' ')
}

/** Read a transcript file if it exists and is readable; `null` on any failure. */
export function readTranscript(path: string | null | undefined): string | null {
  if (typeof path !== 'string' || path.length === 0) return null
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** Read one state file, treating a missing or unreadable file as an empty channel. */
function readChannel<T extends Record<string, unknown>>(dir: string, fileName: string): T | null {
  try {
    return readStateFile<T>(join(dir, fileName))?.payload ?? null
  } catch {
    return null // Corrupt or unknown-schema channel: absent, never fatal inside a hook.
  }
}

function openTodos(payload: TodosPayload | null): DigestTodo[] {
  const todos = payload?.todos
  if (!Array.isArray(todos)) return []
  const open: DigestTodo[] = []
  for (const todo of todos) {
    if (typeof todo !== 'object' || todo === null) continue
    const record = todo as Record<string, unknown>
    const status = typeof record['status'] === 'string' ? (record['status'] as string) : 'pending'
    if (!OPEN_TODO_STATUSES.has(status)) continue
    const content = record['content']
    open.push({ content: boundText(collapse(String(content ?? '')), DIGEST_OBJECTIVE_CAP), status })
    if (open.length >= DIGEST_MAX_TODOS) break
  }
  return open
}

function delegationCounts(payload: DelegationsPayload | null): DigestDelegations {
  const entries = payload?.entries
  if (!Array.isArray(entries)) return { total: 0, by_status: {} }
  const byStatus: Record<string, number> = {}
  let total = 0
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue
    total += 1
    // The file may predate the current shape, so `status` is read defensively.
    const raw: unknown = (entry as unknown as Record<string, unknown>)['status']
    const status = typeof raw === 'string' ? raw : 'unknown'
    byStatus[status] = (byStatus[status] ?? 0) + 1
  }
  // Sorted so two runs over the same ledger produce byte-identical JSON.
  const sorted: Record<string, number> = {}
  for (const key of Object.keys(byStatus).sort()) sorted[key] = byStatus[key] as number
  return { total, by_status: sorted }
}

function artifactPaths(payload: ArtifactsPayload | null): string[] {
  const artifacts = payload?.artifacts
  if (!Array.isArray(artifacts)) return []
  return artifacts.filter((item): item is string => typeof item === 'string').slice(0, DIGEST_MAX_ARTIFACTS)
}

export interface BuildDigestOptions {
  /** Thread state directory holding todos.json / delegations.json / artifacts.json. */
  readonly stateDir: string
  /** ISO-8601 timestamp; injected so the builder never calls `Date.now()`. */
  readonly now: string
  readonly trigger: CompactionTrigger
  /** Session transcript path, when the caller has one (PreCompact supplies it). */
  readonly transcriptPath?: string | null
}

/** Assemble the digest. Pure apart from reading the named files; never throws. */
export function buildSummaryDigest(options: BuildDigestOptions): SummaryDigest {
  const raw = readTranscript(options.transcriptPath ?? null)
  const tail = raw === null ? { objectives: [], messageCount: 0 } : extractTranscriptTail(raw)
  return {
    generated_at: options.now,
    trigger: options.trigger,
    objectives: tail.objectives,
    open_todos: openTodos(readChannel<TodosPayload>(options.stateDir, TODOS_FILE)),
    delegations: delegationCounts(readChannel<DelegationsPayload>(options.stateDir, DELEGATIONS_FILE)),
    artifacts: artifactPaths(readChannel<ArtifactsPayload>(options.stateDir, ARTIFACTS_FILE)),
    source_message_count: tail.messageCount,
  }
}

/**
 * Render the digest as the `summary_text` the durable-context projection will re-inject.
 *
 * Deterministic: same digest in, byte-identical text out. The heading mirrors the section the
 * original's `DurableContextMiddleware` renders (`## Conversation summary so far`) so the
 * projected block reads the same whether the text came from a model or from this digest.
 */
export function renderDigestText(digest: SummaryDigest): string {
  const lines: string[] = [
    `Deterministic checkpoint digest (no model was called). Compaction trigger: ${digest.trigger}. Generated ${digest.generated_at}.`,
  ]

  if (digest.objectives.length > 0) {
    lines.push('', 'Recent user objectives (oldest first):')
    for (const objective of digest.objectives) lines.push(`- ${objective}`)
  }

  if (digest.open_todos.length > 0) {
    lines.push('', 'Open todos:')
    for (const todo of digest.open_todos) lines.push(`- [${todo.status}] ${todo.content}`)
  }

  if (digest.delegations.total > 0) {
    const breakdown = Object.entries(digest.delegations.by_status)
      .map(([status, count]) => `${status}=${count}`)
      .join(', ')
    lines.push('', `Delegations: ${digest.delegations.total} total (${breakdown}). Full ledger: delegations.json.`)
  }

  if (digest.artifacts.length > 0) {
    lines.push('', 'Artifacts presented so far:')
    for (const artifact of digest.artifacts) lines.push(`- ${artifact}`)
  }

  lines.push(
    '',
    'This digest lists durable state only; it does not reproduce the compacted conversation.',
  )
  return lines.join('\n')
}
