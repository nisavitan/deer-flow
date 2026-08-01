// M5 env guard: PreToolUse hook on Bash. Refuses a command that would carry a
// secret-like environment value into a child process.
//
// Ports the *intent* of backend/packages/harness/deerflow/sandbox/env_policy.py
// (build_sandbox_env) and sandbox/tools.py (mask_secret_values) @ 0950924 to the one
// enforcement point Claude Code exposes: DeerFlow scrubs the child env it builds and
// masks leaked values on the way out; the port cannot do either (Claude Code owns the
// spawn and the tool result), so it refuses the command on the way in.
//
// Scope: smoke-class guard, deliberately narrow and FAIL-OPEN. Any parse failure,
// missing field, or internal error exits 0 and lets the tool call proceed — a guard
// that crashes must not wedge every Bash call. The M7 full pre-tool guard (sandbox
// audit classifier + guardrail/authorization layers) refines this; see
// docs/claude-code-port/middleware-port-plan.md §11.
//
// Deny shape verified experimentally in E4-b (experiments/claude-code-port/RESULTS-log.md:81-87):
// PreToolUse hookSpecificOutput with permissionDecision "deny" surfaces the reason to
// the model and records it in `permission_denials`.
import { detectSecretExposure, isSecretLikeName } from '../policy/env-scrub.js'

/** Milliseconds to wait for the hook payload before giving up and allowing the call. */
const STDIN_TIMEOUT_MS = 2000

interface PreToolUsePayload {
  tool_name?: string
  tool_input?: { command?: string }
}

/** Matches an `export`/`env` keyword followed by one or more NAME=VALUE assignments. */
const ASSIGNMENT_PREFIX = /(?:^|[\s;&|(])(?:export|env)\s+((?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s;&|]*)\s*)+)/g
/** Matches one NAME=VALUE assignment inside the run captured above. */
const ASSIGNMENT = /([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s;&|]*)/g

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return value.slice(1, -1)
  }
  return value
}

/**
 * Names that the command explicitly re-exports into a child with a non-empty value
 * and whose name is secret-like. `export FOO=` / `env FOO= cmd` (empty value) is not
 * a leak and is ignored, matching the original's "non-empty value" masking rule.
 *
 * @returns matching variable names, sorted and de-duplicated.
 */
export function detectSecretReexport(command: string): string[] {
  const hits = new Set<string>()
  for (const run of command.matchAll(ASSIGNMENT_PREFIX)) {
    const body = run[1]
    if (!body) continue
    for (const assignment of body.matchAll(ASSIGNMENT)) {
      const name = assignment[1]
      const rawValue = assignment[2]
      if (!name || rawValue === undefined) continue
      if (unquote(rawValue).length === 0) continue
      if (isSecretLikeName(name)) hits.add(name)
    }
  }
  return [...hits].sort()
}

/**
 * The guard decision for one Bash command.
 *
 * @returns the deny reason, or `null` when the command is allowed.
 */
export function evaluateCommand(command: string, env: Readonly<Record<string, string | undefined>>): string | null {
  const embedded = detectSecretExposure(command, env)
  if (embedded.length > 0) {
    return `deerflow env-guard: command embeds the value of secret-like variable ${embedded[0]}`
  }
  const reexported = detectSecretReexport(command)
  if (reexported.length > 0) {
    return `deerflow env-guard: command re-exports the secret-like variable ${reexported[0]} into a child process`
  }
  return null
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

function deny(reason: string): void {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    })}\n`,
  )
}

async function main(): Promise<void> {
  const raw = await readStdin()
  let payload: PreToolUsePayload
  try {
    payload = JSON.parse(raw) as PreToolUsePayload
  } catch {
    return // Malformed payload: fail open.
  }
  if (payload.tool_name !== 'Bash') return
  const command = payload.tool_input?.command
  if (typeof command !== 'string' || command.length === 0) return

  const reason = evaluateCommand(command, process.env)
  if (reason !== null) deny(reason)
}

try {
  await main()
} catch {
  // Fail open: never let a guard fault block the tool call.
}
// Release stdin so the process can exit on its own once the deny payload has
// flushed. `process.exit()` here would risk truncating that write on a pipe.
process.stdin.destroy()
process.exitCode = 0
