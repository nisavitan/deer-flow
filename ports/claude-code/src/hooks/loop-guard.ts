// M7 loop guard: PreToolUse hook. Breaks repetitive tool-call loops before they burn the run.
//
// Ports backend/packages/harness/deerflow/agents/middlewares/loop_detection_middleware.py
// (lead slot 29, `loop_detection.enabled` default True) @ 0950924 — the ALGORITHM lives in
// src/middleware/loop-detection.ts and is pinned against parity/baseline/loop_detection.json
// (6 scenarios / 99 steps). This file is only the enforcement point.
//
// RELOCATED ENFORCEMENT (docs/claude-code-port/middleware-port-plan.md §29; parity-test-plan S10).
// The original detects in `after_model`, AFTER the model has emitted its tool calls, and stops the
// loop by rewriting that AIMessage — `tool_calls=[]` plus `[FORCED STOP]` text — so the agent is
// forced to answer from what it already has. A hook cannot rewrite an assistant message. The port
// therefore moves enforcement one step later, to PreToolUse, and denies the call: the model sees a
// refusal carrying the same `[FORCED STOP]` text and terminates on its own. Warnings, which the
// original queued for injection at the next model call to keep provider message-pairing valid, need
// no deferral here and are delivered at the call itself.
//
// PER-CALL, NOT PER-RESPONSE. The original hashes a whole response's tool-call SET as one multiset.
// PreToolUse fires once per call with no view of its siblings, so the port steps the machine once
// per call. A repeated single call behaves identically; a repeated *batch* of N identical calls
// trips the hard limit after ~5/N responses instead of 5. It fires sooner, never later — the safety
// property is preserved and the sensitivity is documented in parity/DISCREPANCIES.md.
//
// FAIL-OPEN, ALWAYS EXIT 0. A guard that crashes must not wedge every tool call in the session.
import { pathToFileURL } from 'node:url'
import {
  LOOP_STOP_REASON,
  parseLoopDetectionState,
  step,
  type LoopStepResult,
} from '../middleware/loop-detection.js'
import { isGuardedToolName, toDeerflowToolCall } from '../middleware/tool-adapter.js'
import {
  appendHookLog,
  emitHookOutput,
  parseHookPayload,
  readStdin,
  resolveThreadId,
  type HookOutput,
  type HookPayload,
} from '../middleware/hook-runtime.js'
import { threadStateFile } from '../state/paths.js'
import { readStateFile, updateStateFile } from '../state/atomic-io.js'
import { applyRunTransition, runMetaPath, type RunMetaPayload } from '../state/run-meta.js'

/** File name of the loop-detector channel inside a thread's state directory. */
export const LOOP_STATE_FILE = 'loop-detection.json'

/** Escape hatch, mirroring `loop_detection.enabled` (default True in the original config). */
export const DISABLE_ENV_VAR = 'DEERFLOW_DISABLE_LOOP_GUARD'

interface LoopStatePayload {
  loop: unknown
  /** Sticky once set, like the original's `_stop_reason` BoundedDict (never cleared by after_agent). */
  stop_reason: string | null
  [key: string]: unknown
}

export interface GuardOptions {
  readonly now: string
  readonly env?: NodeJS.ProcessEnv
}

/**
 * Best-effort: record `stop_reason=loop_capped` on the thread's run record so a loop-capped run is
 * distinguishable from a clean one, exactly as `consume_stop_reason` let the executor do.
 *
 * Silent on every failure. There may be no run record at all (an interactive session that never
 * went through the deep-run wrapper), and a missing run record is not a reason to skip the deny.
 */
function recordStopReason(threadId: string, options: GuardOptions): void {
  try {
    const filePath = runMetaPath(threadId, options.env)
    const existing = readStateFile<RunMetaPayload>(filePath)?.payload.run ?? null
    if (existing === null || existing.stop_reason === LOOP_STOP_REASON) return
    applyRunTransition(filePath, { status: existing.status, stopReason: LOOP_STOP_REASON, now: options.now }, {
      now: options.now,
    })
  } catch {
    // The state write is a diagnostic, not the guard.
  }
}

/**
 * Evaluate one PreToolUse event.
 *
 * @returns the hook output to emit, or `null` for the silent path (unguarded tool, unresolvable
 *          thread, disabled guard, or simply no loop).
 */
export function evaluateLoopGuard(payload: HookPayload, options: GuardOptions): HookOutput | null {
  const env = options.env ?? process.env
  if (env[DISABLE_ENV_VAR] === '1') return null

  const toolName = payload.tool_name
  if (typeof toolName !== 'string' || !isGuardedToolName(toolName)) return null

  const threadId = resolveThreadId(payload, env)
  if (threadId === null) return null

  const call = toDeerflowToolCall(toolName, payload.tool_input)

  let result: LoopStepResult | null = null
  try {
    const filePath = threadStateFile(threadId, LOOP_STATE_FILE, env)
    updateStateFile<LoopStatePayload>(
      filePath,
      (current) => {
        const stepped = step(parseLoopDetectionState(current?.loop), [call])
        result = stepped
        return {
          loop: stepped.state,
          stop_reason: stepped.stopReason ?? (current?.stop_reason ?? null),
        }
      },
      { now: options.now },
    )
  } catch {
    // An unwritable or contended state file means the window did not advance. Standing down is the
    // only safe response: denying on state we could not persist would deny the same call forever.
    return null
  }

  const stepped = result as LoopStepResult | null
  if (stepped === null || stepped.decision === 'none' || stepped.message === null) return null

  if (stepped.decision === 'hard_stop') {
    recordStopReason(threadId, { now: options.now, ...(options.env === undefined ? {} : { env: options.env }) })
    return { deny: stepped.message }
  }

  // Warn: the call proceeds under the platform's normal permission flow (this hook deliberately
  // does not emit an `allow` decision — see renderHookOutput). The DeerFlow text reaches the model
  // as context and the user as a transcript line; the parity plan sanctions both carriers.
  return { additionalContext: stepped.message, systemMessage: stepped.message }
}

async function main(): Promise<void> {
  const payload = parseHookPayload(await readStdin())
  if (payload === null) return
  const output = evaluateLoopGuard(payload, { now: new Date().toISOString() })
  // O3: the deny/warn decision, alongside the counters loop-detection.json already persists.
  appendHookLog({
    hook: 'loop-guard',
    event: 'PreToolUse',
    thread: resolveThreadId(payload, process.env),
    decision: output === null ? 'silent' : output.deny !== undefined ? 'deny' : 'context',
    summary: `tool=${typeof payload.tool_name === 'string' ? payload.tool_name : 'unknown'}`,
  })
  if (output !== null) emitHookOutput('PreToolUse', output)
}

// Only consume stdin when invoked as a program: the unit tests import `evaluateLoopGuard`, and an
// import must never block on a stdin read.
const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  try {
    await main()
  } catch {
    // Fail open: a guard fault must never block the tool call.
  }
  process.stdin.destroy()
  process.exitCode = 0
}
