// M7 read-before-write gate: PreToolUse hook on Write|Edit. Refuses a modification to a file whose
// CURRENT content the model has not read.
//
// Ports the gate half of
// backend/packages/harness/deerflow/agents/middlewares/read_before_write_middleware.py
// (`_check_write_gate`, lines 186-214; `_BLOCK_MESSAGE`, 57-62) @ 0950924, lead slot 12,
// `read_before_write.enabled` default True. The store and the decision live in
// src/middleware/read-marks.ts; src/hooks/read-mark.ts stamps the marks.
//
// WHY THIS EXISTS WHEN THE PLATFORM ALREADY HAS A RULE. Claude Code's own Edit/Write tools require a
// prior Read in the conversation. That is the same INVARIANT, enforced on different evidence:
// natively, "was this file read in this conversation"; here, "does the newest read mark equal the
// file's current sha256". docs/claude-code-port/middleware-port-plan.md §12 judged the native rule
// sufficient and did not plan this hook; the traceability matrix row plans it as "pre-tool-guard
// hook + native Read-before-Write … double enforcement acceptable, fail-open kept". M7 follows the
// matrix, and the deciding argument is #3857 itself: the bug was an APPEND LOOP, five copies of the
// same section written after one read. A conversation-membership rule cannot see that the file moved
// between writes; a content hash can. The two enforcements compose — whichever refuses first wins,
// and this one only ever refuses a strict subset of what a blind write would be.
//
// FAIL-OPEN. A file that does not exist (creation), or that cannot be read (binary, permissions,
// a sandbox error-string channel), is allowed through and the tool produces its own error. The
// original is explicit about this and so is this hook: `hashFileIfReadable` returns `null` for all
// of those and `checkWriteGate` allows on `null`.
import { pathToFileURL } from 'node:url'
import {
  DISABLE_READ_GATE_ENV_VAR,
  checkWriteGate,
  hashFileIfReadable,
  loadReadMarks,
  readMarksPath,
} from '../middleware/read-marks.js'
import { GATED_WRITE_TOOL_NAMES, NATIVE_READ_TOOL_NAME } from '../middleware/tool-adapter.js'
import {
  appendHookLog,
  emitHookOutput,
  parseHookPayload,
  readStdin,
  resolveThreadId,
  type HookOutput,
  type HookPayload,
} from '../middleware/hook-runtime.js'

export { DISABLE_READ_GATE_ENV_VAR }

export interface GateOptions {
  readonly env?: NodeJS.ProcessEnv
}

/**
 * Evaluate one PreToolUse Write/Edit event.
 *
 * @returns the deny output, or `null` when the write is allowed or the gate does not apply.
 */
export function evaluateWriteGate(payload: HookPayload, options: GateOptions = {}): HookOutput | null {
  const env = options.env ?? process.env
  if (env[DISABLE_READ_GATE_ENV_VAR] === '1') return null

  const toolName = payload.tool_name
  if (typeof toolName !== 'string' || !GATED_WRITE_TOOL_NAMES.has(toolName)) return null

  const toolInput = payload.tool_input
  if (typeof toolInput !== 'object' || toolInput === null) return null
  const filePath = (toolInput as Record<string, unknown>)['file_path']
  // `_requested_path` returns None for a missing/blank path and the original then runs the handler
  // unchanged: a call with no path is the tool's error to report, not the gate's.
  if (typeof filePath !== 'string' || filePath === '') return null

  const threadId = resolveThreadId(payload, env)
  if (threadId === null) return null

  const currentHash = hashFileIfReadable(filePath)
  if (currentHash === null) return null // Creation or uninspectable: fail open.

  let marks
  try {
    marks = loadReadMarks(readMarksPath(threadId, env))
  } catch {
    // An unreadable mark store is not evidence that the file WAS read, but denying on a state
    // failure would block every write in the session. Fail open, consistent with the original.
    return null
  }

  const decision = checkWriteGate({
    toolName,
    path: filePath,
    currentHash,
    marks,
    readToolName: NATIVE_READ_TOOL_NAME,
  })
  return decision.allowed ? null : { deny: decision.reason }
}

async function main(): Promise<void> {
  const payload = parseHookPayload(await readStdin())
  if (payload === null) return
  const output = evaluateWriteGate(payload)
  // O3: read-marks.json shows what was read; this line shows what the gate DECIDED about a write.
  const toolInput = payload.tool_input
  const filePath =
    typeof toolInput === 'object' && toolInput !== null ? (toolInput as Record<string, unknown>)['file_path'] : undefined
  appendHookLog({
    hook: 'write-gate',
    event: 'PreToolUse',
    thread: resolveThreadId(payload, process.env),
    decision: output === null ? 'silent' : 'deny',
    summary: `path=${typeof filePath === 'string' ? filePath : 'unknown'}`,
  })
  if (output !== null) emitHookOutput('PreToolUse', output)
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  try {
    await main()
  } catch {
    // Fail open: a gate fault must never block a write.
  }
  process.stdin.destroy()
  process.exitCode = 0
}
