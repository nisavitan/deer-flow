// Ported from backend/packages/harness/deerflow/runtime/goal.py:parse_goal_command,build_goal_state,
// write_thread_goal and the `/goal` command surface in app/channels/manager.py +
// packages/harness/deerflow/tui (status / clear / set three-way semantics) @ 0950924 —
// structural translation.
//
// The original's `/goal` is a chat slash command handled server-side against the checkpoint `goal`
// channel. The port has no server: the command surface becomes this CLI over
// `.deerflow/state/<thread>/goal.json`, driven by `skills/goal/SKILL.md` and by the Stop hook's
// block reason. Every write goes through {@link writeGoal}, i.e. atomic temp+fsync+rename with
// `rev` compare-and-set — the port's `GoalWriteConflict`.
import { pathToFileURL } from 'node:url'
import { readStateFile, updateStateFile } from '../state/atomic-io.js'
import {
  DEFAULT_MAX_GOAL_CONTINUATIONS,
  InvalidGoalObjectiveError,
  buildGoalState,
  goalPath,
  type GoalPayload,
  type GoalState,
} from '../state/goal.js'
import { THREAD_ID_PATTERN } from '../state/paths.js'
import { parseGoalVerdict } from './evaluator-prompt.js'
import { decideGoalAction } from './orchestrate.js'

export const GOAL_CLI_COMMANDS = ['set', 'clear', 'status', 'record-continuation', 'record-evaluation'] as const
export type GoalCliCommand = (typeof GOAL_CLI_COMMANDS)[number]

export interface GoalCliResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export interface GoalCliOptions {
  readonly env?: NodeJS.ProcessEnv
  /** ISO-8601 timestamp; injected so the CLI never reads the clock in tests. */
  readonly now: string
  /** Run id recorded on `last_evaluation`; defaults to the resolved thread id. */
  readonly runId?: string
}

/**
 * Thread identity, in the port's documented precedence:
 * `--thread` > `DEERFLOW_THREAD_ID` > `CLAUDE_SESSION_ID` (state-checkpoint-resume.md §2.1:
 * "the port mints thread_id = the first session id of a thread").
 */
export function resolveCliThreadId(explicit: string | null, env: NodeJS.ProcessEnv): string | null {
  for (const candidate of [explicit, env['DEERFLOW_THREAD_ID'], env['CLAUDE_SESSION_ID']]) {
    if (typeof candidate === 'string' && THREAD_ID_PATTERN.test(candidate)) return candidate
  }
  return null
}

/** Read the current goal, or `null` when the channel is empty / unreadable. */
export function readGoal(threadId: string, env?: NodeJS.ProcessEnv): GoalState | null {
  const envelope = readStateFile<GoalPayload>(goalPath(threadId, env))
  const goal = envelope?.payload.goal
  return goal === undefined || goal === null ? null : goal
}

/**
 * Authoritative goal write, under the same atomic + `rev` CAS path as every other channel.
 *
 * Deliberately NOT `state/goal.ts:applyGoal`: that one runs the write through `mergeGoal`, whose
 * contract is the LangGraph reducer's ("a node that does not touch the channel leaves it alone"),
 * so a `null` there means *no change*, not *clear*. This writer is the port's
 * `write_thread_goal(..., goal | None)` — the goal writer node itself, the one caller that is
 * allowed to replace the channel with nothing (`goal.py:506-509`).
 */
export function writeGoal(filePath: string, goal: GoalState | null, now: string): void {
  updateStateFile<GoalPayload>(filePath, () => ({ goal }), { now })
}

interface ParsedArgs {
  readonly command: string | null
  readonly positional: readonly string[]
  readonly thread: string | null
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = []
  let thread: string | null = null
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    if (token === undefined) continue
    if (token === '--thread' || token === '-t') {
      thread = argv[index + 1] ?? null
      index += 1
      continue
    }
    if (token.startsWith('--thread=')) {
      thread = token.slice('--thread='.length)
      continue
    }
    positional.push(token)
  }
  return { command: positional[0] ?? null, positional: positional.slice(1), thread }
}

function ok(payload: Record<string, unknown>): GoalCliResult {
  return { exitCode: 0, stdout: `${JSON.stringify({ ok: true, ...payload }, null, 2)}\n`, stderr: '' }
}

function fail(message: string): GoalCliResult {
  return { exitCode: 1, stdout: '', stderr: `deerflow goal: ${message}\n` }
}

export const GOAL_CLI_USAGE = `usage: goal-cli <command> [--thread <id>]

  set <objective> [max_continuations]   install an active goal (max clamped to 0..${DEFAULT_MAX_GOAL_CONTINUATIONS})
  clear                                 remove the active goal
  status                                print the active goal (or null)
  record-continuation                   bump continuation_count by one
  record-evaluation <json>              apply an evaluator verdict and print the resulting action`

/**
 * Run one CLI invocation. Pure with respect to the clock (`options.now`) and the environment;
 * the only side effect is the atomic goal-file write.
 */
export function runGoalCli(argv: readonly string[], options: GoalCliOptions): GoalCliResult {
  const env = options.env ?? process.env
  const args = parseArgs(argv)
  if (args.command === null || args.command === 'help' || args.command === '--help') {
    return { exitCode: args.command === null ? 1 : 0, stdout: `${GOAL_CLI_USAGE}\n`, stderr: '' }
  }
  if (!(GOAL_CLI_COMMANDS as readonly string[]).includes(args.command)) {
    return fail(`unknown command ${JSON.stringify(args.command)}\n${GOAL_CLI_USAGE}`)
  }
  const command = args.command as GoalCliCommand

  const threadId = resolveCliThreadId(args.thread, env)
  if (threadId === null) {
    return fail('no thread id: pass --thread <id> or set DEERFLOW_THREAD_ID / CLAUDE_SESSION_ID')
  }
  const filePath = goalPath(threadId, env)
  const runId = options.runId ?? threadId

  try {
    switch (command) {
      case 'status': {
        return ok({ command, thread_id: threadId, goal: readGoal(threadId, env) })
      }
      case 'clear': {
        writeGoal(filePath, null, options.now)
        return ok({ command, thread_id: threadId, goal: null })
      }
      case 'set': {
        const objective = args.positional[0]
        if (objective === undefined || objective.trim().length === 0) {
          return fail('set requires an objective')
        }
        const rawMax = args.positional[1]
        let maxContinuations = DEFAULT_MAX_GOAL_CONTINUATIONS
        if (rawMax !== undefined) {
          const parsed = Number(rawMax)
          if (!Number.isFinite(parsed)) return fail(`max_continuations must be a number, got ${JSON.stringify(rawMax)}`)
          maxContinuations = parsed
        }
        const goal = buildGoalState(objective, { maxContinuations, now: options.now })
        writeGoal(filePath, goal, options.now)
        return ok({ command, thread_id: threadId, goal })
      }
      case 'record-continuation': {
        const goal = readGoal(threadId, env)
        if (goal === null) return fail('no active goal to continue')
        const next: GoalState = {
          ...goal,
          continuation_count: goal.continuation_count + 1,
          updated_at: options.now,
        }
        writeGoal(filePath, next, options.now)
        return ok({ command, thread_id: threadId, goal: next })
      }
      case 'record-evaluation': {
        const raw = args.positional[0]
        if (raw === undefined) return fail('record-evaluation requires a JSON verdict argument')
        const goal = readGoal(threadId, env)
        if (goal === null) return fail('no active goal to evaluate')
        const parsed = parseGoalVerdict(raw)
        const action = decideGoalAction({
          goal,
          evaluation: parsed.evaluation,
          runId,
          now: options.now,
          ...(parsed.ok ? {} : { standDownReason: parsed.standDownReason }),
        })
        writeGoal(filePath, action.nextGoal, options.now)
        return ok({
          command,
          thread_id: threadId,
          parsed: parsed.ok,
          ...(parsed.ok ? {} : { parse_error: parsed.error }),
          action: action.kind,
          stand_down_reason: action.standDownReason,
          hidden_prompt: action.hiddenPrompt,
          continuation_count: action.continuationCount,
          no_progress_count: action.noProgressCount,
          goal: action.nextGoal,
        })
      }
    }
  } catch (error) {
    if (error instanceof InvalidGoalObjectiveError) return fail(error.message)
    return fail(error instanceof Error ? error.message : String(error))
  }
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  const result = runGoalCli(process.argv.slice(2), { now: new Date().toISOString() })
  if (result.stdout.length > 0) process.stdout.write(result.stdout)
  if (result.stderr.length > 0) process.stderr.write(result.stderr)
  process.exitCode = result.exitCode
}
