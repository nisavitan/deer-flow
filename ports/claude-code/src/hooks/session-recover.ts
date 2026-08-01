// M10 SessionStart hook: orphan recovery + a one-line "state present" notice.
//
// WHAT IT PORTS. `RunManager` runs reconciliation at STARTUP (and every 3rd heartbeat cycle):
// it claims active runs whose lease expired or was never taken, stamps
// `stop_reason="orphan_recovered"`, and backfills a zero delivery receipt
// [manager.py:1700-1784, 1845-2069, via notes/runtime-and-persistence.md §"Crash / orphan
// recovery"]. SessionStart is the port's startup. The scan/apply logic itself lives in
// src/resume/recovery.ts (pure, timestamp-injected); this file is only the hook shell:
// payload in, recovery run, `additionalContext` out.
//
// WHY IT ALSO INJECTS CONTEXT. Non-interactively the original just marks the row and moves
// on. The port has a second obligation the original never had: a resumed Claude Code session
// starts with NO knowledge of the port's Layer-2 state (native sessions do not carry the
// structured channels — claude-code-capabilities.md §6). SessionStart's `additionalContext`
// is the only place to say "there is durable state here", so the hook emits ONE compact line
// per thread and points at `/deerflow:status` for the full report. It deliberately does not
// dump the state: an unbounded SessionStart block would tax every session start.
//
// HARD RULES FOR THIS FILE (same shape as precompact-summary.ts):
//   1. EXIT 0 ALWAYS. Bad payload, unreadable state dir, failed write, missing git — every
//      path is swallowed. A hook that wedges session start is worse than a missed recovery.
//   2. NO MODEL CALL, NO NETWORK. Deterministic file work only.
//   3. WRITES ONLY run-meta.json, and only to terminalize a run the scan proved abandoned.
//
// Registration is NOT applied here: hooks/hooks.json is owned by another lane. The request is
// appended to hooks/REGISTRATION-REQUESTS.md.
import { pathToFileURL } from 'node:url'
import { stateRoot as resolveStateRoot, resolveProjectRoot } from '../state/paths.js'
import { readGitHead } from '../resume/git-head.js'
import { ORPHAN_EXPIRY_MS, listStateThreads, recoverOrphanRuns, type RecoveryOutcome } from '../resume/recovery.js'
import { buildResumePlans, renderResumeLine, type ResumeReport } from '../resume/resume-plan.js'
import { appendHookLog } from '../middleware/hook-runtime.js'

/** Milliseconds to wait for the hook payload before giving up. Mirrors env-guard.ts. */
const STDIN_TIMEOUT_MS = 2000

/**
 * How many threads the injected notice may mention. The block is a pointer, not a report:
 * beyond this the line says "and N more" and `/deerflow:status` carries the rest.
 */
export const MAX_CONTEXT_THREADS = 3

export interface SessionStartPayload {
  session_id?: unknown
  cwd?: unknown
  source?: unknown
  hook_event_name?: unknown
}

export interface SessionRecoveryOptions {
  readonly stateRoot: string
  /** ISO-8601 "now", injected so the whole path is testable. */
  readonly now: string
  readonly currentSessionId: string | null
  readonly currentCommitSha: string | null
  readonly currentBranch: string | null
  /** Defaults to {@link ORPHAN_EXPIRY_MS} (2 h — see recovery.ts for why that number). */
  readonly expiryMs?: number
}

export interface SessionRecoveryResult {
  readonly outcome: RecoveryOutcome
  readonly reports: ResumeReport[]
  /** The block to inject, or `null` when there is nothing worth saying. */
  readonly additionalContext: string | null
}

/**
 * A thread is worth mentioning when it still holds a live run or has a goal set — the two
 * facts a resumed session cannot rediscover on its own. Open todos alone are not enough:
 * the native todo list already survives in the session.
 */
function isNoteworthy(report: ResumeReport): boolean {
  return report.run_active || report.goal !== null
}

/** Run the scan, terminalize what expired, and compose the notice. Never throws. */
export function runSessionRecovery(options: SessionRecoveryOptions): SessionRecoveryResult {
  const outcome = recoverOrphanRuns({
    stateRoot: options.stateRoot,
    now: options.now,
    currentSessionId: options.currentSessionId,
    // Stated explicitly rather than left to the scan's default: 2 h without an update is the
    // hook's abandonment rule, and it should be readable at the call site.
    expiryMs: options.expiryMs ?? ORPHAN_EXPIRY_MS,
  })

  const threadIds = listStateThreads(options.stateRoot)
  const reports = buildResumePlans(threadIds, options.stateRoot, {
    currentCommitSha: options.currentCommitSha,
    currentBranch: options.currentBranch,
  })

  const noteworthy = reports.filter(isNoteworthy)
  if (noteworthy.length === 0) return { outcome, reports, additionalContext: null }

  const lines: string[] = []
  for (const report of noteworthy.slice(0, MAX_CONTEXT_THREADS)) {
    lines.push(`DeerFlow state present: ${renderResumeLine(report)}`)
  }
  if (noteworthy.length > MAX_CONTEXT_THREADS) {
    lines.push(`(+${noteworthy.length - MAX_CONTEXT_THREADS} more thread(s) with durable state)`)
  }
  if (outcome.interrupted.length > 0) {
    lines.push(
      `Recovered ${outcome.interrupted.length} abandoned run(s): marked interrupted with stop_reason orphan_recovered.`,
    )
  }
  lines.push('Run /deerflow:status for details.')
  return { outcome, reports, additionalContext: lines.join('\n') }
}

/** SessionStart's stdout protocol for injecting context. */
export function renderHookOutput(additionalContext: string): string {
  return `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext,
    },
  })}\n`
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
  let payload: SessionStartPayload = {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      payload = parsed as SessionStartPayload
    }
  } catch {
    // Malformed payload: recovery still runs, it just cannot exclude the current session.
  }

  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : null
  // ONE project root for both halves. The state tree and the HEAD it is compared against must
  // come from the same checkout, or a worktree would be judged stale against another tree's
  // commit. `CLAUDE_PROJECT_DIR` wins when the platform set it; the payload's `cwd` is the
  // fallback, and `resolveProjectRoot` (process cwd) the last resort.
  const projectRoot =
    process.env['CLAUDE_PROJECT_DIR'] ??
    (typeof payload.cwd === 'string' && payload.cwd.length > 0 ? payload.cwd : resolveProjectRoot())
  const head = readGitHead(projectRoot)

  const result = runSessionRecovery({
    stateRoot: resolveStateRoot({ ...process.env, CLAUDE_PROJECT_DIR: projectRoot }),
    now: new Date().toISOString(),
    currentSessionId: sessionId,
    currentCommitSha: head.commitSha,
    currentBranch: head.branch,
  })

  // O3: run-meta.json records WHICH runs were recovered; this line records that the scan ran at all
  // — the difference between "nothing was orphaned" and "the hook never fired".
  appendHookLog(
    {
      hook: 'session-recover',
      event: 'SessionStart',
      thread: sessionId,
      decision: result.additionalContext === null ? 'silent' : 'context',
      summary: `recovered=${result.outcome.interrupted.length} threads=${result.reports.length}`,
    },
    { ...process.env, CLAUDE_PROJECT_DIR: projectRoot },
  )

  if (result.additionalContext !== null) process.stdout.write(renderHookOutput(result.additionalContext))
}

// Only consume stdin when invoked as a program: the unit tests import `runSessionRecovery`,
// and an import must not block on a stdin read or touch a state file.
const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  try {
    await main()
  } catch (error) {
    // Rule 1: a recovery fault must never block session start.
    process.stderr.write(
      `deerflow session-recover: skipped (${error instanceof Error ? error.message : String(error)})\n`,
    )
  }
  process.stdin.destroy()
  process.exitCode = 0
}
