// Ported from backend/packages/harness/deerflow/runtime/runs/worker.py:_prepare_goal_continuation_input,
// _persist_goal_evaluation, _stand_down_reason and
// backend/packages/harness/deerflow/runtime/goal.py:should_continue_goal, compute_no_progress_count,
// attach_goal_evaluation, make_goal_continuation_message @ 0950924 — structural translation.
//
// This module is the port's goal-loop decision core. It is pure: no clock, no filesystem, no model.
// Every gate it applies is imported from `src/state/goal.ts` (the M2 caps/breaker translation) so
// the two can never disagree — this file only sequences them and produces the next goal state.
//
// Two entry points, one shared gate set:
//   decideGoalAction()  — the full original flow: a *verdict* exists, so satisfied ⇒ clear,
//                         continuable ⇒ hidden continuation prompt, otherwise ⇒ stand down.
//   decideStopHook()    — the Claude Code Stop-hook flow: no verdict exists yet (a hook cannot
//                         call a model), so the deterministic gates run against a pending
//                         `goal_not_met_yet` evaluation and, when they pass, the hook blocks the
//                         stop and hands the frozen evaluator rubric back to the session model.
import {
  attachGoalEvaluation,
  computeNoProgressCount,
  shouldContinueGoal,
  standDownReason,
  type GoalEvaluation,
  type GoalState,
} from '../state/goal.js'
import {
  GOAL_EVALUATOR_SYSTEM_INSTRUCTION,
  NO_VISIBLE_EVIDENCE_EVALUATION,
  evidenceSignatureOf,
  renderGoalEvaluatorUserContent,
} from './evaluator-prompt.js'

/** Command used by the session model to close a satisfied goal from inside a blocked stop. */
export const GOAL_CLI_COMMAND = 'node dist/goal-loop/goal-cli.js'

/**
 * goal.py:391-408 — the hidden `<goal_continuation>` user message, verbatim.
 *
 * The original attaches it as a `HumanMessage` with `hide_from_ui`; the port has no hidden-message
 * channel, so the same text rides inside the Stop hook's block reason instead (DISCREPANCIES).
 */
export function makeGoalContinuationMessage(goal: GoalState, evaluation: GoalEvaluation): string {
  const reason = evaluation.reason.length > 0 ? evaluation.reason : 'No reason provided.'
  const evidence =
    evaluation.evidence_summary !== undefined && evaluation.evidence_summary.length > 0
      ? evaluation.evidence_summary
      : 'No evidence summary provided.'
  return (
    '<goal_continuation>\n' +
    `Active goal: ${goal.objective}\n` +
    `Evaluator result: not satisfied. Blocker: ${evaluation.blocker}. Reason: ${reason}\n` +
    `Visible evidence: ${evidence}\n` +
    'Continue working toward the active goal. Use the available tools and conversation context. ' +
    'Do not ask the user to continue unless you are genuinely blocked.\n' +
    '</goal_continuation>'
  )
}

export interface GoalDecisionInput {
  readonly goal: GoalState
  /** The parsed verdict — see `evaluator-prompt.ts:parseGoalVerdict`. */
  readonly evaluation: GoalEvaluation
  readonly runId: string
  /** ISO-8601 timestamp; the original calls `now_iso()` inside `attach_goal_evaluation`. */
  readonly now: string
  /** Raw latest visible assistant text; hashed into the breaker signature when supplied. */
  readonly evidenceText?: string
  /** Pre-computed breaker signature; wins over `evidenceText` (parity vectors supply this). */
  readonly evidenceSignature?: string
  /** Overrides the derived stand-down reason — used for `evaluation_failed`. */
  readonly standDownReason?: string
}

export type GoalActionKind = 'continue_with_hidden_prompt' | 'clear_goal' | 'stand_down'

export interface GoalAction {
  readonly kind: GoalActionKind
  /** Goal state to persist. `null` means "clear the channel" (satisfied goals are removed). */
  readonly nextGoal: GoalState | null
  /** The `<goal_continuation>` text, only on `continue_with_hidden_prompt`. */
  readonly hiddenPrompt: string | null
  /** Recorded stand-down reason, only on `stand_down`. */
  readonly standDownReason: string | null
  readonly noProgressCount: number
  readonly continuationCount: number
  readonly evidenceSignature: string
}

function resolveSignature(input: { readonly evidenceSignature?: string; readonly evidenceText?: string }): string {
  if (input.evidenceSignature !== undefined) return input.evidenceSignature
  return input.evidenceText === undefined ? '' : evidenceSignatureOf(input.evidenceText)
}

/**
 * The original loop, one turn: verdict in, next goal state + action out.
 *
 * Ordering matches `worker.py`: satisfied clears the goal (never marks it), otherwise the
 * no-progress count is recomputed from the *current* goal's `last_evaluation.progress_key` and the
 * continuation gate decides. On stand-down the continuation count is deliberately NOT bumped — the
 * turn that stood down did not consume a continuation.
 */
export function decideGoalAction(input: GoalDecisionInput): GoalAction {
  const { goal, evaluation, runId, now } = input
  const evidenceSignature = resolveSignature(input)

  if (evaluation.satisfied) {
    return {
      kind: 'clear_goal',
      nextGoal: null,
      hiddenPrompt: null,
      standDownReason: null,
      noProgressCount: 0,
      continuationCount: goal.continuation_count,
      evidenceSignature,
    }
  }

  const noProgressCount = computeNoProgressCount(goal, evaluation, evidenceSignature)

  if (shouldContinueGoal(goal, evaluation, noProgressCount)) {
    const continuationCount = goal.continuation_count + 1
    return {
      kind: 'continue_with_hidden_prompt',
      nextGoal: attachGoalEvaluation(goal, evaluation, {
        runId,
        continuationCount,
        noProgressCount,
        evidenceSignature,
        now,
      }),
      hiddenPrompt: makeGoalContinuationMessage(goal, evaluation),
      standDownReason: null,
      noProgressCount,
      continuationCount,
      evidenceSignature,
    }
  }

  const reason = input.standDownReason ?? standDownReason(goal, evaluation, noProgressCount) ?? 'stand_down'
  return {
    kind: 'stand_down',
    nextGoal: attachGoalEvaluation(goal, evaluation, {
      runId,
      noProgressCount,
      standDownReason: reason,
      evidenceSignature,
      now,
    }),
    hiddenPrompt: null,
    standDownReason: reason,
    noProgressCount,
    continuationCount: goal.continuation_count,
    evidenceSignature,
  }
}

// ---------------------------------------------------------------------------------------------
// Stop-hook gate
// ---------------------------------------------------------------------------------------------

/**
 * The evaluation the deterministic gates are run against when no verdict exists yet.
 *
 * `goal_not_met_yet` is the only continuable blocker, so this is the *permissive* input: it lets
 * the cap and the breaker be the only things that can stop the loop, which is exactly the split
 * the port needs (deterministic gates here, semantic judgment delegated to the model).
 */
export const PENDING_SELF_EVALUATION: GoalEvaluation = Object.freeze({
  satisfied: false,
  blocker: 'goal_not_met_yet',
  reason: 'Deterministic pre-check: the goal is still active and no satisfied verdict was recorded for this turn.',
  evidence_summary: '',
})

/** Stand-down reasons this gate can produce beyond the ported `worker.py` vocabulary. */
export const NO_ACTIVE_GOAL = 'no_active_goal'
export const CONTINUATION_NOT_RECORDED = 'continuation_not_recorded'

export interface StopHookInput {
  /** Parsed `goal.json` contents; `null` when the channel is empty. */
  readonly goal: GoalState | null
  /** Latest visible assistant text from the transcript. */
  readonly evidenceText?: string
  /** Pre-computed breaker signature; wins over `evidenceText`. */
  readonly evidenceSignature?: string
  /** Claude Code's `stop_hook_active` — true when this stop follows an earlier hook block. */
  readonly stopHookActive: boolean
  readonly runId: string
  readonly now: string
}

export interface StopHookDecision {
  /** Whether the hook emits `{"decision":"block"}`. */
  readonly block: boolean
  /** The block reason handed to the model, or `null` when standing down. */
  readonly blockReason: string | null
  /** Why the hook stood down, or `null` when it blocked. */
  readonly standDownReason: string | null
  /** Goal state to persist before returning; `null` means "write nothing". */
  readonly nextGoal: GoalState | null
  readonly continuationCount: number
  readonly noProgressCount: number
  readonly evidenceSignature: string
}

/**
 * The deterministic half of the goal loop, as a Stop hook decides it.
 *
 * Gates, in order:
 *   1. no active goal                        → never block;
 *   2. no visible assistant evidence         → `blocked:missing_evidence` (goal.py:291-297);
 *   3. a prior block left no recorded        → `continuation_not_recorded`: the counter is the
 *      continuation (state write lost)          only thing bounding this loop, so a counter that
 *                                               is not advancing must stop it, not extend it;
 *   4. cap / breaker (`shouldContinueGoal`)  → block, or the ported stand-down reason.
 *
 * Termination is guaranteed by the counter, not by the model: the caller persists `nextGoal`
 * (continuation_count + 1) *before* emitting the block, so at most `max_continuations` blocks can
 * ever be issued for one goal even if the model ignores every instruction in the block reason.
 */
export function decideStopHook(input: StopHookInput): StopHookDecision {
  const { goal, stopHookActive, runId, now } = input
  const evidenceSignature = resolveSignature(input)

  if (goal === null) {
    return {
      block: false,
      blockReason: null,
      standDownReason: NO_ACTIVE_GOAL,
      nextGoal: null,
      continuationCount: 0,
      noProgressCount: 0,
      evidenceSignature,
    }
  }

  if (evidenceSignature.length === 0) {
    const evaluation = NO_VISIBLE_EVIDENCE_EVALUATION
    const noProgressCount = computeNoProgressCount(goal, evaluation, evidenceSignature)
    const reason = standDownReason(goal, evaluation, noProgressCount) ?? `blocked:${evaluation.blocker}`
    return {
      block: false,
      blockReason: null,
      standDownReason: reason,
      nextGoal: attachGoalEvaluation(goal, evaluation, {
        runId,
        noProgressCount,
        standDownReason: reason,
        evidenceSignature,
        now,
      }),
      continuationCount: goal.continuation_count,
      noProgressCount,
      evidenceSignature,
    }
  }

  const noProgressCount = computeNoProgressCount(goal, PENDING_SELF_EVALUATION, evidenceSignature)

  if (stopHookActive && goal.continuation_count === 0) {
    return {
      block: false,
      blockReason: null,
      standDownReason: CONTINUATION_NOT_RECORDED,
      nextGoal: attachGoalEvaluation(goal, PENDING_SELF_EVALUATION, {
        runId,
        noProgressCount,
        standDownReason: CONTINUATION_NOT_RECORDED,
        evidenceSignature,
        now,
      }),
      continuationCount: goal.continuation_count,
      noProgressCount,
      evidenceSignature,
    }
  }

  if (!shouldContinueGoal(goal, PENDING_SELF_EVALUATION, noProgressCount)) {
    const reason = standDownReason(goal, PENDING_SELF_EVALUATION, noProgressCount) ?? 'stand_down'
    return {
      block: false,
      blockReason: null,
      standDownReason: reason,
      nextGoal: attachGoalEvaluation(goal, PENDING_SELF_EVALUATION, {
        runId,
        noProgressCount,
        standDownReason: reason,
        evidenceSignature,
        now,
      }),
      continuationCount: goal.continuation_count,
      noProgressCount,
      evidenceSignature,
    }
  }

  const continuationCount = goal.continuation_count + 1
  return {
    block: true,
    blockReason: renderStopHookBlockReason({
      goal,
      conversation: input.evidenceText ?? '',
      continuationCount,
      noProgressCount,
    }),
    standDownReason: null,
    nextGoal: attachGoalEvaluation(goal, PENDING_SELF_EVALUATION, {
      runId,
      continuationCount,
      noProgressCount,
      evidenceSignature,
      now,
    }),
    continuationCount,
    noProgressCount,
    evidenceSignature,
  }
}

export interface StopHookBlockReasonInput {
  readonly goal: GoalState
  /** Rendered visible conversation evidence (`formatVisibleConversation`). */
  readonly conversation: string
  readonly continuationCount: number
  readonly noProgressCount: number
}

/**
 * The block reason: the frozen evaluator rubric plus the self-evaluation instruction.
 *
 * This IS the adaptation. The original sends {@link GOAL_EVALUATOR_SYSTEM_INSTRUCTION} to a
 * separate non-thinking model and acts on its JSON; the port hands the same rubric and the same
 * user content to the session model and asks it to act on its own verdict. The judging standard is
 * byte-identical, the judge is not independent — mitigated by the cap/breaker gates above, which
 * the model cannot influence. See parity/DISCREPANCIES.md.
 */
export function renderStopHookBlockReason(input: StopHookBlockReasonInput): string {
  const { goal, continuationCount, noProgressCount } = input
  return [
    '[deerflow goal loop] An active goal is still open, so this turn is not finished.',
    '',
    'Evaluate the goal against the rubric below. This is the same rubric DeerFlow gives its',
    'independent evaluator model; here you are evaluating your own work, so apply it strictly.',
    '',
    '<goal_evaluator_rubric>',
    GOAL_EVALUATOR_SYSTEM_INSTRUCTION,
    '</goal_evaluator_rubric>',
    '',
    renderGoalEvaluatorUserContent({ objective: goal.objective, conversation: input.conversation }),
    '',
    'Then act on your own verdict:',
    `- satisfied ⇒ run \`${GOAL_CLI_COMMAND} clear\` and stop.`,
    '- goal_not_met_yet ⇒ keep working toward the goal with the available tools. Do not ask the',
    '  user to continue unless you are genuinely blocked.',
    '- needs_user_input / run_failed / external_wait / missing_evidence ⇒ record the verdict with',
    `  \`${GOAL_CLI_COMMAND} record-evaluation '{"satisfied":false,"blocker":"<blocker>","reason":"<why>","evidence_summary":"<evidence>"}'\``,
    '  and stop. That stands the loop down instead of burning continuations.',
    '',
    `Continuation ${continuationCount} of ${goal.max_continuations}. ` +
      `No-progress breaker ${noProgressCount} of ${goal.max_no_progress_continuations} ` +
      '(it trips when a turn adds no new visible assistant output).',
  ].join('\n')
}
