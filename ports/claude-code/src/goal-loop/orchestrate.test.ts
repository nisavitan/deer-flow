// Vector-driven integration tests for the goal-loop decision core.
//
// Source of truth: parity/baseline/goal_counters.json — the same file M2 used to pin the raw
// gate functions. Here the vectors are driven END TO END through `decideGoalAction`, so the port
// is pinned on the *composition* (which gate runs first, what gets written to `last_evaluation`,
// when the continuation count moves) and not only on the individual predicates.
//
// Timestamp handling matches src/state/goal.test.ts: the extractor injects
// created_at = 1970-01-01T00:00:00+00:00 and replaces every now_iso() result with '<PINNED>',
// and the port injects both, so the comparison is byte-for-byte with no masking.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildGoalState, computeGoalProgressKey, type GoalEvaluation, type GoalState } from '../state/goal.js'
import { decideGoalAction, makeGoalContinuationMessage } from './orchestrate.js'

const PINNED_TIMESTAMP = '1970-01-01T00:00:00+00:00'
const PINNED_SENTINEL = '<PINNED>'
const OBJECTIVE = 'finish the audit'

interface GateVector {
  name: string
  continuation_count: number
  max_continuations: number
  no_progress_count: number
  max_no_progress_continuations: number
  evaluation: GoalEvaluation
  should_continue_goal: boolean
  stand_down_reason: string | null
}

interface WalkVector {
  turn: number
  continuation_count_before: number
  should_continue_goal: boolean
  stand_down_reason: string | null
}

interface SequenceStep {
  turn: number
  evidence_signature: string
  progress_key: string
  no_progress_count: number
  continuation_count_after: number
  decision: 'continue' | 'stand_down'
  stand_down_reason: string | null
  goal_after: Record<string, unknown>
}

const vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../parity/baseline/goal_counters.json', import.meta.url)), 'utf8'),
) as {
  gate_matrix: GateVector[]
  continuation_cap_walk: WalkVector[]
  no_progress_sequences: { name: string; description: string; steps: SequenceStep[] }[]
}

/** Replace the port's injected timestamps with the extractor's sentinel for comparison. */
function pin(goal: GoalState | null): Record<string, unknown> | null {
  if (goal === null) return null
  const copy = JSON.parse(JSON.stringify(goal)) as Record<string, unknown>
  copy['updated_at'] = PINNED_SENTINEL
  const last = copy['last_evaluation']
  if (typeof last === 'object' && last !== null) {
    ;(last as Record<string, unknown>)['evaluated_at'] = PINNED_SENTINEL
  }
  return copy
}

/**
 * Build a goal whose *computed* no-progress count equals `noProgressCount`.
 *
 * `decideGoalAction` recomputes the breaker from `last_evaluation.progress_key` rather than
 * trusting a caller-supplied number (that is the original's semantics), so a vector asking for
 * `no_progress_count: N` is reproduced by seeding `N - 1` plus a matching previous progress key.
 */
function goalForGate(vector: GateVector, evidenceSignature: string): GoalState {
  const base: GoalState = {
    objective: OBJECTIVE,
    status: 'active',
    created_at: PINNED_TIMESTAMP,
    updated_at: PINNED_TIMESTAMP,
    continuation_count: vector.continuation_count,
    max_continuations: vector.max_continuations,
    no_progress_count: vector.no_progress_count,
    max_no_progress_continuations: vector.max_no_progress_continuations,
  }
  if (vector.no_progress_count === 0) return base
  return {
    ...base,
    no_progress_count: vector.no_progress_count - 1,
    last_evaluation: {
      satisfied: vector.evaluation.satisfied,
      blocker: vector.evaluation.blocker,
      reason: 'previous turn',
      evidence_summary: '',
      run_id: 'run-prev',
      evaluated_at: PINNED_TIMESTAMP,
      progress_key: computeGoalProgressKey(vector.evaluation, evidenceSignature),
    },
  }
}

describe('gate_matrix driven through decideGoalAction', () => {
  for (const vector of vectors.gate_matrix) {
    it(`${vector.name}: continue=${String(vector.should_continue_goal)} stand_down=${String(vector.stand_down_reason)}`, () => {
      const evidenceSignature = 'sig-A'
      const goal = goalForGate(vector, evidenceSignature)
      const action = decideGoalAction({
        goal,
        evaluation: vector.evaluation,
        runId: 'run-1',
        now: PINNED_TIMESTAMP,
        evidenceSignature,
      })

      if (vector.should_continue_goal) {
        expect(action.kind).toBe('continue_with_hidden_prompt')
        expect(action.standDownReason).toBeNull()
        expect(action.hiddenPrompt).toBe(makeGoalContinuationMessage(goal, vector.evaluation))
        expect(action.continuationCount).toBe(vector.continuation_count + 1)
        expect(action.nextGoal?.continuation_count).toBe(vector.continuation_count + 1)
      } else if (vector.evaluation.satisfied) {
        expect(action.kind).toBe('clear_goal')
        expect(action.nextGoal).toBeNull()
        expect(action.standDownReason).toBeNull()
      } else {
        expect(action.kind).toBe('stand_down')
        expect(action.standDownReason).toBe(vector.stand_down_reason)
        // A stand-down does not consume a continuation.
        expect(action.nextGoal?.continuation_count).toBe(vector.continuation_count)
        expect(action.nextGoal?.last_evaluation?.stand_down_reason).toBe(vector.stand_down_reason)
      }
      expect(action.noProgressCount).toBe(vector.no_progress_count)
    })
  }
})

describe('continuation_cap_walk driven as a real 10-turn walk', () => {
  it('continues eight times, then stands down with max_continuations_reached', () => {
    let goal: GoalState = buildGoalState(OBJECTIVE, { now: PINNED_TIMESTAMP })
    for (const step of vectors.continuation_cap_walk) {
      expect(goal.continuation_count).toBe(step.continuation_count_before)
      const evaluation: GoalEvaluation = {
        satisfied: false,
        blocker: 'goal_not_met_yet',
        reason: `turn ${step.turn}`,
        evidence_summary: 'e',
      }
      const action = decideGoalAction({
        goal,
        evaluation,
        runId: `run-${step.turn}`,
        now: PINNED_TIMESTAMP,
        // New evidence every turn so the walk exercises the cap, never the breaker.
        evidenceSignature: `sig-${step.turn}`,
      })
      expect(action.kind).toBe(step.should_continue_goal ? 'continue_with_hidden_prompt' : 'stand_down')
      expect(action.standDownReason).toBe(step.stand_down_reason)
      expect(action.noProgressCount).toBe(0)
      expect(action.nextGoal).not.toBeNull()
      goal = action.nextGoal as GoalState
    }
    expect(goal.continuation_count).toBe(8)
    expect(goal.last_evaluation?.stand_down_reason).toBe('max_continuations_reached')
  })
})

describe('no_progress_sequences driven end to end', () => {
  for (const sequence of vectors.no_progress_sequences) {
    it(`${sequence.name}: ${sequence.description}`, () => {
      let goal: GoalState | null = buildGoalState(OBJECTIVE, { now: PINNED_TIMESTAMP })
      for (const step of sequence.steps) {
        expect(goal).not.toBeNull()
        const evaluation: GoalEvaluation = {
          satisfied: false,
          blocker: 'goal_not_met_yet',
          reason: `turn ${step.turn} reworded reason`,
          evidence_summary: 'e',
        }
        const action = decideGoalAction({
          goal: goal as GoalState,
          evaluation,
          runId: `run-${step.turn}`,
          now: PINNED_TIMESTAMP,
          evidenceSignature: step.evidence_signature,
        })

        expect(action.kind).toBe(step.decision === 'continue' ? 'continue_with_hidden_prompt' : 'stand_down')
        expect(action.standDownReason).toBe(step.stand_down_reason)
        expect(action.noProgressCount).toBe(step.no_progress_count)
        expect(action.continuationCount).toBe(step.continuation_count_after)
        expect(action.nextGoal?.last_evaluation?.progress_key).toBe(step.progress_key)
        expect(pin(action.nextGoal)).toEqual(step.goal_after)
        goal = action.nextGoal
      }
    })
  }
})

describe('satisfied verdicts clear the goal', () => {
  it('never marks a satisfied goal, it removes it', () => {
    const goal = buildGoalState(OBJECTIVE, { now: PINNED_TIMESTAMP })
    const action = decideGoalAction({
      goal,
      evaluation: { satisfied: true, blocker: 'none', reason: 'done', evidence_summary: 'tests pass' },
      runId: 'run-1',
      now: PINNED_TIMESTAMP,
      evidenceText: 'all done',
    })
    expect(action.kind).toBe('clear_goal')
    expect(action.nextGoal).toBeNull()
    expect(action.hiddenPrompt).toBeNull()
  })
})

describe('hidden continuation prompt', () => {
  it('renders goal.py:391-408 verbatim, including both fallback strings', () => {
    const goal = buildGoalState(OBJECTIVE, { now: PINNED_TIMESTAMP })
    expect(
      makeGoalContinuationMessage(goal, {
        satisfied: false,
        blocker: 'goal_not_met_yet',
        reason: 'two files left',
        evidence_summary: 'edited one file',
      }),
    ).toBe(
      '<goal_continuation>\n' +
        'Active goal: finish the audit\n' +
        'Evaluator result: not satisfied. Blocker: goal_not_met_yet. Reason: two files left\n' +
        'Visible evidence: edited one file\n' +
        'Continue working toward the active goal. Use the available tools and conversation context. ' +
        'Do not ask the user to continue unless you are genuinely blocked.\n' +
        '</goal_continuation>',
    )
    expect(
      makeGoalContinuationMessage(goal, { satisfied: false, blocker: 'goal_not_met_yet', reason: '', evidence_summary: '' }),
    ).toContain('Reason: No reason provided.\nVisible evidence: No evidence summary provided.\n')
  })
})

describe('evidence text is hashed when no signature is supplied', () => {
  it('same text keeps the same progress key, different text resets the breaker', () => {
    const first = decideGoalAction({
      goal: buildGoalState(OBJECTIVE, { now: PINNED_TIMESTAMP }),
      evaluation: { satisfied: false, blocker: 'goal_not_met_yet', reason: 'r', evidence_summary: 'e' },
      runId: 'run-1',
      now: PINNED_TIMESTAMP,
      evidenceText: 'assistant said this',
    })
    const repeat = decideGoalAction({
      goal: first.nextGoal as GoalState,
      evaluation: { satisfied: false, blocker: 'goal_not_met_yet', reason: 'reworded entirely', evidence_summary: 'e' },
      runId: 'run-2',
      now: PINNED_TIMESTAMP,
      evidenceText: '  assistant said this  ',
    })
    expect(repeat.noProgressCount).toBe(1)

    const moved = decideGoalAction({
      goal: repeat.nextGoal as GoalState,
      evaluation: { satisfied: false, blocker: 'goal_not_met_yet', reason: 'r', evidence_summary: 'e' },
      runId: 'run-3',
      now: PINNED_TIMESTAMP,
      evidenceText: 'assistant said something new',
    })
    expect(moved.noProgressCount).toBe(0)
  })
})
