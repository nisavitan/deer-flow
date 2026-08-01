// M7 turn context: UserPromptSubmit hook. Injects the two things the original put in front of the
// model on every request and Claude Code otherwise forgets across a compaction — the current date,
// and the durable-context projection (summary, delegation ledger, skill context).
//
// Ports two middlewares at one carrier:
//   - backend/.../middlewares/dynamic_context_middleware.py (lead slot 15) @ 0950924 —
//     `_build_full_reminder` / `_build_date_update_reminder` (lines 189-211). The reminder FORMAT is
//     verbatim: `<system-reminder>\n<current_date>YYYY-MM-DD, Weekday</current_date>\n</system-reminder>`.
//   - backend/.../middlewares/durable_context_middleware.py (lead slot 18), through
//     src/summary/durable-context.ts, which is the verbatim renderer (M8 built it and states
//     "M7 owns the wiring"). This file is that wiring.
//
// THREE CARRIER CHANGES, ALL DECLARED IN parity/DISCREPANCIES.md:
//   1. The original replaces the first HumanMessage with an ID-SWAP TRIPLET (SystemMessage with the
//      date, optional HumanMessage with memory, the user's own text) so the date carries system-role
//      authority and the prefix cache still hits. A hook cannot rewrite the message list; it gets one
//      `additionalContext` string per turn.
//   2. Because of that, injection is PER TURN, not once-per-conversation-then-frozen. The original
//      injected once and re-injected only on a midnight crossing (`_last_injected_date`). Nothing in
//      a hook can read what a previous turn injected, so this hook re-emits every turn. Cost: tokens.
//      Benefit: the midnight case is covered for free, and so is post-compaction loss — which is the
//      whole reason the durable projection exists.
//   3. Memory injection is NOT here. It is the M9 memory lane's (`src/memory/injection.ts`), and this
//      lane must not touch it. The date and the durable projection are what M7 owns.
//
// A DATE IS ALLOWED HERE. Workflow scripts in this port may not read the clock (it breaks resume);
// hooks are ordinary Node processes and the original called `datetime.now()` at exactly this point.
import { pathToFileURL } from 'node:url'
import { appendHookLog, emitHookOutput, formatCurrentDate, parseHookPayload, readStdin, resolveThreadId, type HookOutput, type HookPayload } from '../middleware/hook-runtime.js'
import { createHash } from 'node:crypto'
import { buildDurableContextBlock } from '../summary/durable-context.js'
import { readStateFile } from '../state/atomic-io.js'
import { threadStateDir } from '../state/paths.js'
import { DELEGATIONS_FILE, type DelegationsPayload } from '../state/delegations.js'
import { GOAL_FILE, type GoalPayload } from '../state/goal.js'
import { SKILL_CONTEXT_FILE, type SkillContextPayload } from '../state/skill-context.js'
import { SUMMARY_FILE, type SummaryPayload } from '../summary/summary-state.js'
import { join } from 'node:path'

/** Escape hatch for a session that wants no per-turn injection at all. */
export const DISABLE_ENV_VAR = 'DEERFLOW_DISABLE_TURN_CONTEXT'

/**
 * Verbatim `_build_date_update_reminder` / the date half of `_build_full_reminder`.
 *
 * Same three lines, same tag names, same `%Y-%m-%d, %A` date. Model-facing text — do not reword.
 */
export function renderDateReminder(now: Date): string {
  return ['<system-reminder>', `<current_date>${formatCurrentDate(now)}</current_date>`, '</system-reminder>'].join(
    '\n',
  )
}

/** Read one state channel, treating an absent, corrupt or future-schema file as empty. */
function readChannel<T extends Record<string, unknown>>(stateDir: string, fileName: string): T | null {
  try {
    return readStateFile<T>(join(stateDir, fileName))?.payload ?? null
  } catch {
    return null
  }
}

export interface TurnContextOptions {
  readonly now: Date
  readonly env?: NodeJS.ProcessEnv
}

/**
 * Build the block a UserPromptSubmit event should inject.
 *
 * The date reminder is unconditional (the original always injected it). The durable projection is
 * appended only when there is something to project — `buildDurableContextBlock` returns empty
 * strings for an empty state, mirroring the original's "return the request unchanged" branch.
 *
 * @returns the context string, or `null` when nothing should be injected.
 */
export function buildTurnContext(payload: HookPayload, options: TurnContextOptions): string | null {
  const env = options.env ?? process.env
  if (env[DISABLE_ENV_VAR] === '1') return null

  const sections: string[] = [renderDateReminder(options.now)]

  const threadId = resolveThreadId(payload, env)
  if (threadId !== null) {
    try {
      const stateDir = threadStateDir(threadId, env)
      const summary = readChannel<SummaryPayload>(stateDir, SUMMARY_FILE)
      const delegations = readChannel<DelegationsPayload>(stateDir, DELEGATIONS_FILE)
      const skillContext = readChannel<SkillContextPayload>(stateDir, SKILL_CONTEXT_FILE)
      const goal = readChannel<GoalPayload>(stateDir, GOAL_FILE)

      const projection = buildDurableContextBlock({
        summaryText: summary?.summary_text ?? null,
        delegations: Array.isArray(delegations?.entries) ? delegations.entries : null,
        skillContext: Array.isArray(skillContext?.entries) ? skillContext.entries : null,
        goal: goal?.goal ?? null,
      })
      if (projection.text !== '') sections.push(projection.text)
    } catch {
      // The date reminder is still worth injecting when the state tree is unreadable.
    }
  }

  return sections.join('\n\n')
}

/** The hook output for one UserPromptSubmit event. */
export function evaluateTurnContext(payload: HookPayload, options: TurnContextOptions): HookOutput | null {
  const context = buildTurnContext(payload, options)
  return context === null ? null : { additionalContext: context }
}

async function main(): Promise<void> {
  const payload = parseHookPayload(await readStdin())
  if (payload === null) return
  const output = evaluateTurnContext(payload, { now: new Date() })
  // O3: the injection rides `additionalContext` and leaves nothing on disk. The sha256 of the block
  // is what parity-test-plan S14 asserts ("injection logged with content sha256") — the digest, not
  // the text, so the log never duplicates the durable state it projects.
  const injected = output?.additionalContext ?? ''
  appendHookLog({
    hook: 'turn-context',
    event: 'UserPromptSubmit',
    thread: resolveThreadId(payload, process.env),
    decision: output === null ? 'silent' : 'context',
    summary: `chars=${injected.length} sha256=${createHash('sha256').update(injected).digest('hex')}`,
  })
  if (output !== null) emitHookOutput('UserPromptSubmit', output)
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  try {
    await main()
  } catch {
    // A failed injection costs context, not the turn. UserPromptSubmit must never block the prompt.
  }
  process.stdin.destroy()
  process.exitCode = 0
}
