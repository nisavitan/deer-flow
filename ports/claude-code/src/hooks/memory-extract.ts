// M9 memory capture: Stop hook. Appends the turn's last user message and last assistant
// response to `.deerflow/memory/queue.jsonl`.
//
// Ports backend/packages/harness/deerflow/agents/middlewares/memory_middleware.py:MemoryMiddleware
// (lead slot 23) @ 0950924 — structural translation. Upstream's `aafter_agent` filters the
// conversation to user inputs plus the final AI response and enqueues it for a debounced
// background extraction pass; this hook is the port's equivalent capture point.
//
// DECLARED APPROXIMATION — batch-on-next-turn. Claude Code has no long-lived server process to
// host a timer thread, and a hook must not block the turn on an LLM call, so the 30-second
// debounce becomes "extract on the next turn". Recorded in parity/DISCREPANCIES.md
// §M9 entry 1; the queue mechanics live in src/memory/queue.ts.
//
// This file is EXECUTABLE: its top level runs on import. Keep it a thin wrapper — every piece of
// reusable logic belongs in src/memory/queue.ts, so a library consumer never accidentally runs
// the hook (and never has its stdin consumed by it).
//
// Never blocks. Every path exits 0 with no stdout: a Stop hook that emits output or a non-zero
// status can interrupt the session, and memory capture is strictly best-effort — upstream drops a
// `QueueFull` update and re-feeds it next turn because the watermark does not advance.
import { readFileSync } from 'node:fs'
import { appendQueueEntry, extractTurn } from '../memory/queue.js'
import { appendHookLog, resolveThreadId } from '../middleware/hook-runtime.js'

/** Milliseconds to wait for the hook payload before giving up. */
const STDIN_TIMEOUT_MS = 2000

interface StopHookPayload {
  transcript_path?: unknown
  session_id?: unknown
  stop_hook_active?: unknown
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
  let payload: StopHookPayload
  try {
    payload = JSON.parse(raw) as StopHookPayload
  } catch {
    return
  }
  // O3: one line per Stop, whatever happened. `queued` is the fact a memory scenario asserts on;
  // the queue file itself only shows the successes.
  let queued = 0
  try {
    const transcriptPath = payload.transcript_path
    if (typeof transcriptPath !== 'string' || transcriptPath === '') return

    let transcript: string
    try {
      transcript = readFileSync(transcriptPath, 'utf8')
    } catch {
      return
    }

    const turn = extractTurn(transcript)
    if (turn === null) return

    appendQueueEntry({
      capturedAt: new Date().toISOString(),
      sessionId: typeof payload.session_id === 'string' ? payload.session_id : null,
      user: turn.user,
      assistant: turn.assistant,
    })
    queued = 1
  } finally {
    appendHookLog({
      hook: 'memory-extract',
      event: 'Stop',
      thread: resolveThreadId(payload, process.env),
      decision: 'silent',
      summary: `queued=${queued}`,
    })
  }
}

try {
  await main()
} catch {
  // Best effort: memory capture must never interrupt the session.
}
process.stdin.destroy()
process.exitCode = 0
