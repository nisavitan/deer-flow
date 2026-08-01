// Shared plumbing for the five M7 middleware hooks. Port-authored — there is no original to
// translate; this is the boilerplate every hook script needs and none of them should re-derive.
//
// It lives under src/middleware/ rather than src/hooks/ on purpose: src/hooks/*.ts are ENTRY POINTS
// (one file per registered command), and an entry point that other entry points import is a
// confusing shape. Everything here is pure or trivially I/O-bound and unit-testable on its own.
//
// THE ONE RULE ALL FIVE HOOKS FOLLOW: a hook fault must never be visible to the user as anything
// worse than the guard not firing. Every function here either returns a fallback or is documented
// as throwing, and every hook wraps its main in try/catch and exits 0.
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveProjectRoot, THREAD_ID_PATTERN } from '../state/paths.js'

/** Milliseconds to wait for the hook payload before giving up. Matches src/hooks/env-guard.ts. */
export const STDIN_TIMEOUT_MS = 2000

/** Fields every hook payload the port reads may carry. Nothing is trusted to be present. */
export interface HookPayload {
  readonly session_id?: unknown
  readonly hook_event_name?: unknown
  readonly tool_name?: unknown
  readonly tool_input?: unknown
  readonly tool_response?: unknown
  readonly prompt?: unknown
  readonly cwd?: unknown
}

/**
 * Read the whole hook payload from stdin, giving up after {@link STDIN_TIMEOUT_MS}.
 *
 * Resolves with whatever arrived rather than rejecting: a truncated payload parses to nothing and
 * the caller stands down, which is the same outcome as a timeout.
 */
export function readStdin(timeoutMs: number = STDIN_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks).toString('utf8'))
    }
    const timer = setTimeout(finish, timeoutMs)
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

/** Parse a hook payload, or `null` when it is not a JSON object. Never throws. */
export function parseHookPayload(raw: string): HookPayload | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    return parsed as HookPayload
  } catch {
    return null
  }
}

/**
 * Resolve the thread id whose state directory this event belongs to.
 *
 * Identical rule to src/hooks/precompact-summary.ts, and for the same reason: `DEERFLOW_THREAD_ID`
 * wins when the port launched the run, otherwise the port's thread identity IS the session id
 * (state-checkpoint-resume.md §2.1). A session id that does not satisfy the thread-id contract
 * yields `null` and the caller stands down rather than inventing a directory name.
 */
export function resolveThreadId(payload: HookPayload, env: NodeJS.ProcessEnv): string | null {
  const configured = env['DEERFLOW_THREAD_ID']
  if (typeof configured === 'string' && THREAD_ID_PATTERN.test(configured)) return configured
  const sessionId = payload.session_id
  if (typeof sessionId === 'string' && THREAD_ID_PATTERN.test(sessionId)) return sessionId
  return null
}

export type HookEventName = 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit'

export interface HookOutput {
  /** Injected into the model's context for the current turn. */
  readonly additionalContext?: string
  /** Shown to the user in the transcript. The parity plan sanctions it for loop warnings. */
  readonly systemMessage?: string
  /** PreToolUse only: refuse the call and hand the model this reason. */
  readonly deny?: string
}

/**
 * Serialize one hook decision.
 *
 * **`permissionDecision` is emitted ONLY to deny.** A hook that allows by writing
 * `permissionDecision: "allow"` also *bypasses the user's own permission rules* for that call — it
 * is an escalation, not a no-op. Where the original merely queued a warning, this port therefore
 * abstains from the permission decision entirely and carries the warning as context: the platform's
 * normal permission flow runs untouched and the model still reads the DeerFlow text.
 */
export function renderHookOutput(event: HookEventName, output: HookOutput): string | null {
  const specific: Record<string, unknown> = { hookEventName: event }
  let hasSpecific = false
  if (output.deny !== undefined && event === 'PreToolUse') {
    specific['permissionDecision'] = 'deny'
    specific['permissionDecisionReason'] = output.deny
    hasSpecific = true
  }
  if (output.additionalContext !== undefined && output.additionalContext !== '') {
    specific['additionalContext'] = output.additionalContext
    hasSpecific = true
  }

  const envelope: Record<string, unknown> = {}
  if (hasSpecific) envelope['hookSpecificOutput'] = specific
  if (output.systemMessage !== undefined && output.systemMessage !== '') {
    envelope['systemMessage'] = output.systemMessage
  }
  return Object.keys(envelope).length === 0 ? null : JSON.stringify(envelope)
}

/** Write a hook decision to stdout. A `null` decision writes nothing at all (the silent path). */
export function emitHookOutput(event: HookEventName, output: HookOutput): void {
  const rendered = renderHookOutput(event, output)
  if (rendered !== null) process.stdout.write(`${rendered}\n`)
}

// ---------------------------------------------------------------------------------------------
// O3 — the hook observability log.
//
// `docs/claude-code-port/parity-test-plan.md` §"Observable channels" defines O3 as
// `.deerflow/logs/hooks.jsonl`, "one structured line per hook", and states that the port MUST
// implement it for the Tier-2 live suite to be executable. Three of the twelve hooks — env-guard,
// post-tool-meta, turn-context — leave NO durable artefact by design (a deny and two
// `additionalContext` injections), so O3 is the only channel that can observe them at all.
//
// It is an OBSERVABILITY channel, never a control path: `appendHookLog` swallows every failure,
// performs one `appendFileSync` (atomic enough for line-sized writes on every platform the port
// targets), and is called after the hook's decision is already made. A hook whose log write fails
// still emits exactly the same decision.
// ---------------------------------------------------------------------------------------------

/** Directory (relative to the project root) that holds the port's log tree. */
export const LOG_DIR_SEGMENTS = ['.deerflow', 'logs'] as const

/** O3's file name below the log root. */
export const HOOK_LOG_FILE_NAME = 'hooks.jsonl'

/**
 * What one hook did, in the vocabulary a scenario asserts on.
 *
 * `silent` — stood down or had nothing to say; `context` — injected `additionalContext`;
 * `deny` — refused a PreToolUse call; `block` — refused a Stop; `error` — the hook's own work
 * failed and it degraded (never a tool error, which rides `summary`).
 */
export type HookLogDecision = 'silent' | 'context' | 'deny' | 'block' | 'error'

/** One O3 record, before the timestamp is stamped. */
export interface HookLogEntry {
  /** The hook script's name, e.g. `write-gate`. */
  readonly hook: string
  /** The Claude Code event it is registered on, e.g. `PreToolUse`. */
  readonly event: string
  /** The thread whose state the hook acted on, or `null` when it could not resolve one. */
  readonly thread: string | null
  readonly decision: HookLogDecision
  /** Free-form, hook-specific detail: a path, a count, a classification. */
  readonly summary?: string
}

/** `<CLAUDE_PROJECT_DIR || cwd>/.deerflow/logs/hooks.jsonl`. */
export function hookLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveProjectRoot(env), ...LOG_DIR_SEGMENTS, HOOK_LOG_FILE_NAME)
}

/**
 * Append one JSON line to O3. **Never throws and never blocks a hook decision.**
 *
 * The timestamp is stamped here rather than by the caller so every line carries the same clock and
 * no hook can forget it; `entry` follows it, so a caller cannot overwrite `ts` either.
 */
export function appendHookLog(entry: HookLogEntry, env: NodeJS.ProcessEnv = process.env): void {
  try {
    const filePath = hookLogPath(env)
    mkdirSync(dirname(filePath), { recursive: true })
    appendFileSync(filePath, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, 'utf8')
  } catch {
    // An unwritable log directory costs observability, never a decision.
  }
}

/**
 * `datetime.now().strftime("%Y-%m-%d, %A")` — the exact date string DynamicContextMiddleware built.
 *
 * The weekday table is hard-coded rather than taken from `Intl`: Python's `%A` under the C locale is
 * always the English name, and a hook must not depend on the host's ICU data or `LANG`.
 */
export const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const

/** Format a local-time date exactly as the original's `%Y-%m-%d, %A`. */
export function formatCurrentDate(now: Date): string {
  const year = String(now.getFullYear()).padStart(4, '0')
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}, ${WEEKDAY_NAMES[now.getDay()] ?? ''}`
}

/**
 * Flatten a tool response into the text the taxonomy classifies.
 *
 * Claude Code's `tool_response` is not one shape: a bare string, `{stdout, stderr}` for Bash, a
 * content-block array, or a tool-specific object. Everything unrecognized contributes nothing
 * rather than throwing — the same defensive stance src/hooks/memory-extract.ts takes on transcript
 * content.
 */
export function flattenToolResponse(response: unknown): string {
  if (typeof response === 'string') return response
  if (Array.isArray(response)) {
    return response
      .map((block) => {
        if (typeof block === 'string') return block
        if (typeof block === 'object' && block !== null) {
          const text = (block as Record<string, unknown>)['text']
          return typeof text === 'string' ? text : ''
        }
        return ''
      })
      .filter((part) => part !== '')
      .join('\n')
  }
  if (typeof response === 'object' && response !== null) {
    const record = response as Record<string, unknown>
    const parts: string[] = []
    for (const key of ['content', 'output', 'stdout', 'stderr', 'error', 'result', 'text']) {
      const value = record[key]
      if (typeof value === 'string' && value !== '') parts.push(value)
      else if (Array.isArray(value) || (typeof value === 'object' && value !== null)) {
        const nested = flattenToolResponse(value)
        if (nested !== '') parts.push(nested)
      }
    }
    return parts.join('\n')
  }
  return ''
}

/**
 * Whether Claude Code reported this result as a failure.
 *
 * The platform does not stamp a DeerFlow-shaped `status`, so the port infers one from the flags a
 * tool result can carry. Inference errs toward `success`: a false `error` would tell the model to
 * abandon a tool that worked.
 */
export function inferResultStatus(response: unknown): 'success' | 'error' {
  if (typeof response !== 'object' || response === null || Array.isArray(response)) return 'success'
  const record = response as Record<string, unknown>
  if (record['is_error'] === true || record['isError'] === true || record['success'] === false) return 'error'
  if (typeof record['interrupted'] === 'boolean' && record['interrupted']) return 'error'
  return 'success'
}
