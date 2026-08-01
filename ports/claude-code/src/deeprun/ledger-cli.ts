// `node dist/deeprun/ledger-cli.js` — persist a finished deep run's delegation ledger.
//
// THE MISSING HALF OF THE LEDGER. `agents/middlewares/delegation_ledger.py` @ 0950924 DERIVED the
// ledger by scanning message history: a `task` tool call became an `in_progress` entry and the
// paired ToolMessage upgraded it to terminal, all inside the graph's own state write. The port has
// neither the message history nor the graph write. `workflows/deep-run.js` therefore emits
// ledger-SHAPED entries in its result (src/deeprun/ledger-io.ts documents why), but a workflow
// script cannot finish the job: it has no clock (`created_at`) and no hash function
// (`result_sha256`), and it cannot touch `.deerflow/state/`. This CLI is where those three things
// exist. Piping the workflow's JSON result into it is what actually commits the ledger — see the
// "After a deep-run completes" section of skills/run/SKILL.md.
//
// Unlike a hook, a CLI may fail loudly: bad input exits 1 with a message on stderr. Nothing is
// half-written — the ledger goes down in one atomic `rev` compare-and-set write.
//
// Usage:
//   node dist/deeprun/ledger-cli.js [--thread <id>] [--json] < deep-run-result.json
// Defaults: --thread from $DEERFLOW_THREAD_ID.
// Exit codes: 0 on success, 1 on a usage/validation/state error.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { readStateFile } from '../state/atomic-io.js'
import { delegationsPath, type DelegationEntry } from '../state/delegations.js'
import { applyRunTransition, runMetaPath, type RunMetaPayload, type RunStopReason } from '../state/run-meta.js'
import { writeDelegations } from './ledger-io.js'
import { boundMetadataText } from './result-format.js'

/** Run-level stop reasons a deep run may report. Anything else is ignored rather than invented. */
const RUN_STOP_REASONS: ReadonlySet<string> = new Set<RunStopReason>([
  'loop_capped',
  'token_capped',
  'safety_capped',
  'subagent_limit_capped',
  'model_length_capped',
  'orphan_recovered',
])

/** Raised when the piped result cannot be trusted to describe a real run. */
export class LedgerValidationError extends Error {
  override readonly name = 'LedgerValidationError'
  constructor(readonly problems: readonly string[]) {
    super(`Invalid deep-run result: ${problems.join('; ')}`)
  }
}

export interface DeepRunResultShape {
  readonly run_id?: unknown
  readonly stop_reason?: unknown
  readonly ledger_entries?: unknown
  readonly results?: unknown
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * Validate and complete the workflow's ledger entries.
 *
 * Two fields are stamped here because only this process can produce them:
 *   - `created_at`: the workflow has no clock. The reducer inherits a first-seen `created_at` for an
 *     id it has already recorded, so re-running this CLI over the same result is idempotent.
 *   - `result_sha256`: the digest of the FULL result text, taken from the matching entry in
 *     `results` (the ledger's own `result_brief` is bounded at 2000 chars and hashing it would give
 *     a digest of a truncation). Computed exactly as `makeSubagentAdditionalKwargs` does — sha256 of
 *     the untruncated string — and only for a completed task with a non-blank result.
 *
 * @throws LedgerValidationError when `ledger_entries` is absent or any entry is unusable.
 */
export function buildLedgerEntries(result: DeepRunResultShape, now: string): DelegationEntry[] {
  const problems: string[] = []
  const raw = result.ledger_entries
  if (!Array.isArray(raw)) {
    throw new LedgerValidationError(['`ledger_entries` is missing or not an array'])
  }

  // Index the full results by their ledger id so the digest hashes what the subagent really returned.
  const fullResults = new Map<string, { status: unknown; result: unknown }>()
  const runId = asString(result.run_id)
  if (Array.isArray(result.results)) {
    for (const item of result.results) {
      if (typeof item !== 'object' || item === null) continue
      const record = item as Record<string, unknown>
      const index = record['index']
      if (runId !== null && typeof index === 'number') {
        fullResults.set(`${runId}:${index}`, { status: record['status'], result: record['result'] })
      }
    }
  }

  const entries: DelegationEntry[] = []
  raw.forEach((item, position) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      problems.push(`entry ${position} is not an object`)
      return
    }
    const record = item as Record<string, unknown>
    const id = asString(record['id'])
    const description = record['description']
    const subagentType = asString(record['subagent_type'])
    const status = asString(record['status'])
    if (id === null) problems.push(`entry ${position} has no \`id\``)
    if (typeof description !== 'string') problems.push(`entry ${position} has no \`description\``)
    if (subagentType === null) problems.push(`entry ${position} has no \`subagent_type\``)
    if (status === null) problems.push(`entry ${position} has no \`status\``)
    if (id === null || typeof description !== 'string' || subagentType === null || status === null) return

    const entry: DelegationEntry = {
      id,
      description,
      subagent_type: subagentType,
      status,
      created_at: asString(record['created_at']) ?? now,
    }
    const entryRunId = asString(record['run_id']) ?? runId
    if (entryRunId !== null) entry.run_id = entryRunId
    const stopReason = asString(record['stop_reason'])
    if (stopReason !== null) entry.stop_reason = stopReason
    const commitSha = asString(record['commit_sha'])
    if (commitSha !== null) entry.commit_sha = commitSha

    const brief = asString(record['result_brief'])
    if (brief !== null) entry.result_brief = boundMetadataText(brief)

    const stored = asString(record['result_sha256'])
    if (stored !== null) {
      entry.result_sha256 = stored
    } else {
      const full = fullResults.get(id)
      const text = full?.result
      if (full?.status === 'completed' && typeof text === 'string' && text.trim() !== '') {
        entry.result_sha256 = createHash('sha256').update(text, 'utf8').digest('hex')
      }
    }

    entries.push(entry)
  })

  if (problems.length > 0) throw new LedgerValidationError(problems)
  return entries
}

export interface PersistOptions {
  readonly threadId: string
  readonly now: string
  readonly env?: NodeJS.ProcessEnv
}

export interface PersistOutcome {
  readonly path: string
  readonly rev: number
  readonly entries: number
  readonly totalEntries: number
  /** The stop reason written onto the run record, or `null` when nothing was written. */
  readonly runStopReason: RunStopReason | null
}

/**
 * Persist one deep run's ledger, then reflect its run-level stop reason onto the run record.
 *
 * The run's STATUS is deliberately untouched. A deep run is one delegation batch inside a lead run,
 * not the run itself — marking it `completed` here would terminate a run the lead is still working
 * on, and `transitionRunMeta`'s terminal guard would then refuse the lead's own finalize.
 */
export function persistDeepRunLedger(result: DeepRunResultShape, options: PersistOptions): PersistOutcome {
  const entries = buildLedgerEntries(result, options.now)
  const envelope = writeDelegations(options.threadId, entries, { now: options.now }, options.env)

  let runStopReason: RunStopReason | null = null
  const stopReason = asString(result.stop_reason)
  if (stopReason !== null && RUN_STOP_REASONS.has(stopReason)) {
    try {
      const filePath = runMetaPath(options.threadId, options.env)
      const existing = readStateFile<RunMetaPayload>(filePath)?.payload.run ?? null
      const runId = asString(result.run_id)
      if (existing !== null && (runId === null || existing.run_id === runId)) {
        applyRunTransition(
          filePath,
          { status: existing.status, stopReason: stopReason as RunStopReason, now: options.now },
          { now: options.now },
        )
        runStopReason = stopReason as RunStopReason
      }
    } catch {
      // The ledger is the deliverable; a missing or contended run record does not undo it.
    }
  }

  const stored = envelope.payload.entries
  return {
    path: delegationsPath(options.threadId, options.env),
    rev: envelope.rev,
    entries: entries.length,
    totalEntries: Array.isArray(stored) ? stored.length : 0,
    runStopReason,
  }
}

interface CliOptions {
  threadId: string | null
  json: boolean
}

/** Parse argv (without `node` and the script path). Throws on an unknown flag. */
export function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
  const options: CliOptions = { threadId: env['DEERFLOW_THREAD_ID'] ?? null, json: false }
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    switch (flag) {
      case '--thread': {
        const value = argv[++index]
        if (value === undefined) throw new Error('Missing value for --thread')
        options.threadId = value
        break
      }
      case '--json':
        options.json = true
        break
      default:
        throw new Error(`Unknown argument: ${String(flag)}`)
    }
  }
  return options
}

function readStdinSync(): string {
  // A CLI reading a piped payload blocks on purpose: unlike a hook it has no turn to hold up.
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

function main(): number {
  let options: CliOptions
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
  if (options.threadId === null) {
    process.stderr.write('No thread id: pass --thread <id> or set DEERFLOW_THREAD_ID.\n')
    return 1
  }

  let result: DeepRunResultShape
  try {
    const parsed: unknown = JSON.parse(readStdinSync())
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('expected a deep-run result object on stdin')
    }
    result = parsed as DeepRunResultShape
  } catch (error) {
    process.stderr.write(`Could not read the deep-run result: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }

  try {
    const outcome = persistDeepRunLedger(result, { threadId: options.threadId, now: new Date().toISOString() })
    if (options.json) {
      process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`)
    } else {
      const capped = outcome.runStopReason === null ? '' : `; run stop_reason=${outcome.runStopReason}`
      process.stdout.write(
        `deerflow ledger: ${outcome.entries} delegation(s) persisted to ${outcome.path} ` +
          `(rev ${outcome.rev}, ${outcome.totalEntries} total)${capped}.\n`,
      )
    }
  } catch (error) {
    process.stderr.write(`Failed to persist the ledger: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
  return 0
}

// Only run when invoked as a program; importing the module (tests do) must never read stdin.
const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = main()
}
