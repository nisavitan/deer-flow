// M8 PreCompact hook: snapshot durable state into summary.json before Claude Code compacts.
//
// WHAT IT PORTS. `DeerFlowSummarizationMiddleware.before_model` fires when its own trigger
// fires, generates a summary, writes the `summary_text` channel, and fires
// `before_summarization` hooks with the messages that are about to disappear
// [summarization_middleware.py:452-569, 625-647]. The port owns none of that: Claude Code
// decides when to compact (~85% of the context window, untunable) and produces its own
// summary. The single control point the platform exposes is PreCompact — "before compaction
// happens", carrying `transcript_path` and `session_id`. So this hook takes the ONE action
// that is both possible and deterministic there: it writes the durable digest, which the
// turn-context projection (src/summary/durable-context.ts, wired in M7) re-injects after the
// compaction has thrown the history away.
//
// HARD RULES FOR THIS FILE:
//   1. NO MODEL CALL. A hook is a short-lived subprocess with no credentials and a blocking
//      budget; the original's LLM summary has no counterpart here. Deterministic digest only.
//   2. EXIT 0 ALWAYS. Every failure path — bad payload, unwritable state dir, corrupt
//      channel file — is swallowed. A guard that wedges compaction is worse than a missing
//      digest, and this mirrors the original's own fail-open stance on the automatic path
//      ("swallows the failure, leaving compaction state unchanged for the turn"
//      [summarization_middleware.py:35-42, 496-507]).
//   3. NO STDOUT PROTOCOL. PreCompact has no decision to make; the hook writes a file and is
//      silent. Diagnostics go to stderr only.
//
// Registration is NOT applied here: hooks/hooks.json is owned by another lane. The request is
// appended to hooks/REGISTRATION-REQUESTS.md.
import { pathToFileURL } from 'node:url'
import { buildSummaryDigest, renderDigestText } from '../summary/digest.js'
import { applySummary, summaryPath, type CompactionTrigger } from '../summary/summary-state.js'
import { THREAD_ID_PATTERN, threadStateDir } from '../state/paths.js'

/** Milliseconds to wait for the hook payload before giving up. Mirrors env-guard.ts. */
const STDIN_TIMEOUT_MS = 2000

export interface PreCompactPayload {
  session_id?: unknown
  transcript_path?: unknown
  trigger?: unknown
  hook_event_name?: unknown
}

/**
 * Resolve the thread id whose state dir this compaction belongs to.
 *
 * `DEERFLOW_THREAD_ID` wins when the run was launched by the port (deep runs export it).
 * Otherwise the port's thread identity IS the session id
 * (state-checkpoint-resume.md §2.1: "the port mints thread_id = the first session id of a
 * thread"), so the session id is used when it satisfies the thread-id contract. A session id
 * that does not (an unexpected format) yields `null` and the hook stands down rather than
 * inventing a directory name.
 */
export function resolveThreadId(payload: PreCompactPayload, env: NodeJS.ProcessEnv): string | null {
  const configured = env['DEERFLOW_THREAD_ID']
  if (typeof configured === 'string' && THREAD_ID_PATTERN.test(configured)) return configured
  const sessionId = payload.session_id
  if (typeof sessionId === 'string' && THREAD_ID_PATTERN.test(sessionId)) return sessionId
  return null
}

/** Normalize the payload's `trigger` field; anything unrecognized is recorded as `unknown`. */
export function resolveTrigger(payload: PreCompactPayload): CompactionTrigger {
  return payload.trigger === 'auto' || payload.trigger === 'manual' ? payload.trigger : 'unknown'
}

export interface SnapshotOptions {
  readonly now: string
  readonly env?: NodeJS.ProcessEnv
}

/**
 * Build and persist the digest for one PreCompact event.
 *
 * @returns the written file path, or `null` when the hook stood down (no resolvable thread).
 *          Never throws — see rule 2 in the file header.
 */
export function snapshotSummary(payload: PreCompactPayload, options: SnapshotOptions): string | null {
  const env = options.env ?? process.env
  const threadId = resolveThreadId(payload, env)
  if (threadId === null) return null

  const transcriptPath = typeof payload.transcript_path === 'string' ? payload.transcript_path : null
  const trigger = resolveTrigger(payload)

  try {
    const stateDir = threadStateDir(threadId, env)
    const filePath = summaryPath(threadId, env)
    const digest = buildSummaryDigest({ stateDir, now: options.now, trigger, transcriptPath })
    applySummary(
      filePath,
      {
        summaryText: renderDigestText(digest),
        updatedBy: 'precompact',
        digest,
        compaction: { at: options.now, trigger, updated_by: 'precompact' },
      },
      { now: options.now },
    )
    return filePath
  } catch (error) {
    process.stderr.write(
      `deerflow precompact-summary: digest not written (${error instanceof Error ? error.message : String(error)})\n`,
    )
    return null
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks).toString('utf8'))
    }
    const timer = setTimeout(finish, STDIN_TIMEOUT_MS)
    timer.unref()
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk))
    process.stdin.on('end', () => {
      clearTimeout(timer)
      finish()
    })
    process.stdin.on('error', () => {
      clearTimeout(timer)
      finish()
    })
  })
}

async function main(): Promise<void> {
  const raw = await readStdin()
  let payload: PreCompactPayload
  try {
    payload = JSON.parse(raw) as PreCompactPayload
  } catch {
    return // Malformed payload: stand down.
  }
  if (typeof payload !== 'object' || payload === null) return
  snapshotSummary(payload, { now: new Date().toISOString() })
}

// Only consume stdin when invoked as a program: the unit tests import `snapshotSummary`
// from this module, and an import must not block on a stdin read.
const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  try {
    await main()
  } catch {
    // Rule 2: a hook fault must never block compaction.
  }
  process.stdin.destroy()
  process.exitCode = 0
}
