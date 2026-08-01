// M13 pre-turn workspace snapshot: UserPromptSubmit hook.
//
// WHAT IT PORTS. `runtime/runs/worker.py:673-681` captures `capture_workspace_snapshot(thread_id,
// user_id)` before the graph runs and keeps it in memory for the whole run; the post-run recorder
// and the delivery verdict both read it. Two hooks are two processes, so the port writes the
// baseline to `.deerflow/state/<thread>/workspace-pre.json` and `src/hooks/delivery-gate.ts` reads
// it back.
//
// GRANULARITY CHANGE, DECLARED IN parity/DISCREPANCIES.md §M13 entry 2. Upstream this is captured
// once per RUN. A Claude Code session has no run boundary a hook can observe, so the port captures
// once per TURN. The delta reported is therefore per-turn, and a multi-turn run reports several
// records instead of one.
//
// HARD RULES FOR THIS FILE:
//   1. FAST. It runs on the critical path of every prompt. `outputs/` is walked in full; the
//      project tree is capped at FAST_WORKSPACE_MAX_DEPTH levels and the whole scan at the
//      original's 2000-file ceiling.
//   2. SILENT. It emits nothing on stdout — it has no decision to make and tells the model nothing.
//   3. EXIT 0 ALWAYS. A missing baseline costs one turn's change record; it must never cost a turn.
//   4. IT SHARES NO STATE WITH `turn-context.js`, which is registered on the same event. Different
//      file, no ordering constraint either way.
//
// Registration is NOT applied here: hooks/hooks.json has a single owner. The request is appended to
// hooks/REGISTRATION-REQUESTS.md.
import { pathToFileURL } from 'node:url'
import { parseHookPayload, readStdin, resolveThreadId, type HookPayload } from '../middleware/hook-runtime.js'
import { defaultScanRoots, scanWorkspace, workspacePrePath, writePreSnapshot } from '../artifacts/snapshot.js'
import { DISABLE_DELIVERY_GATE_ENV_VAR } from '../artifacts/delivery.js'
import { resolveProjectRoot } from '../state/paths.js'

/** Escape hatch for a session that wants no workspace tracking at all. Shared with delivery-gate. */
export const DISABLE_ENV_VAR = DISABLE_DELIVERY_GATE_ENV_VAR

export interface TurnSnapshotOptions {
  readonly now: string
  readonly env?: NodeJS.ProcessEnv
}

/** What one UserPromptSubmit event did. `null` file path means nothing was written. */
export interface TurnSnapshotOutcome {
  readonly threadId: string | null
  readonly filePath: string | null
  readonly scanned: number
  readonly truncated: boolean
}

const SILENT: TurnSnapshotOutcome = { threadId: null, filePath: null, scanned: 0, truncated: false }

/**
 * Capture the pre-turn baseline. Never throws (rule 3).
 *
 * The project root is `CLAUDE_PROJECT_DIR` (else the process cwd) — the same resolution the state
 * tree uses, deliberately, so a snapshot path and a state path can never disagree about which
 * project this is. The payload's `cwd` is not consulted for that reason.
 */
export function captureTurnSnapshot(payload: HookPayload, options: TurnSnapshotOptions): TurnSnapshotOutcome {
  const env = options.env ?? process.env
  if (env[DISABLE_ENV_VAR] === '1') return SILENT

  const threadId = resolveThreadId(payload, env)
  if (threadId === null) return SILENT

  try {
    const projectRoot = resolveProjectRoot(env)
    const snapshot = scanWorkspace(defaultScanRoots(projectRoot), projectRoot)
    const filePath = workspacePrePath(threadId, env)
    writePreSnapshot(filePath, snapshot, options.now)
    return { threadId, filePath, scanned: snapshot.scanned, truncated: snapshot.truncated }
  } catch (error) {
    process.stderr.write(
      `deerflow turn-snapshot: standing down (${error instanceof Error ? error.message : String(error)})\n`,
    )
    return { threadId, filePath: null, scanned: 0, truncated: false }
  }
}

async function main(): Promise<void> {
  const payload = parseHookPayload(await readStdin())
  if (payload === null) return
  captureTurnSnapshot(payload, { now: new Date().toISOString() })
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  try {
    await main()
  } catch {
    // Rule 3: a failed baseline must never block or delay a prompt.
  }
  process.stdin.destroy()
  process.exitCode = 0
}
