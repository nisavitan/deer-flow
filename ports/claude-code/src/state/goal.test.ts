// Vector-driven parity tests for the goal channel: caps, gate matrix, no-progress breaker.
// Sources of truth:
//   parity/baseline/goal_counters.json      (deerflow.runtime.goal + runs.worker:_stand_down_reason)
//   parity/baseline/state_reducers.json     (deerflow.agents.thread_state:merge_goal)
// The extractor pins timestamps: created_at is injected as 1970-01-01T00:00:00+00:00 and every
// now_iso() result is replaced with '<PINNED>'. The port injects both, so the vectors compare
// byte-for-byte instead of needing timestamp masking.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MAX_GOAL_CONTINUATIONS,
  DEFAULT_MAX_NO_PROGRESS_CONTINUATIONS,
  InvalidGoalObjectiveError,
  MAX_GOAL_OBJECTIVE_CHARS,
  attachGoalEvaluation,
  buildGoalState,
  computeGoalProgressKey,
  computeNoProgressCount,
  mergeGoal,
  normalizeGoalObjective,
  shouldContinueGoal,
  standDownReason,
  type GoalEvaluation,
  type GoalState,
} from './goal.js'

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

const goalVectors = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../parity/baseline/goal_counters.json', import.meta.url)), 'utf8'),
) as {
  continuation_cap_clamping: {
    requested_max_continuations: number
    effective_max_continuations: number
    effective_max_no_progress_continuations: number
    continuation_count: number
    no_progress_count: number
  }[]
  no_progress_cap_clamping: {
    requested_max_no_progress_continuations: number
    effective_max_no_progress_continuations: number
  }[]
  gate_matrix: GateVector[]
  no_progress_sequences: { name: string; description: string; steps: SequenceStep[] }[]
  continuation_cap_walk: {
    turn: number
    continuation_count_before: number
    should_continue_goal: boolean
    stand_down_reason: string | null
  }[]
}

const reducerVectors = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../parity/baseline/state_reducers.json', import.meta.url)), 'utf8'),
) as { merge_goal: { name: string; existing: GoalState | null; new: GoalState | null; merged: GoalState | null }[] }

function evaluation(satisfied: boolean, blocker: GoalEvaluation['blocker'], reason = 'r', evidence = 'e'): GoalEvaluation {
  return { satisfied, blocker, reason, evidence_summary: evidence }
}

describe('merge_goal parity vectors', () => {
  it.each(reducerVectors.merge_goal.map((vector) => [vector.name, vector] as const))('vector %s', (_name, vector) => {
    expect(mergeGoal(vector.existing, vector.new)).toEqual(vector.merged)
  })

  it('consumed every recorded merge_goal vector', () => {
    expect(reducerVectors.merge_goal).toHaveLength(3)
  })
})

describe('goal cap clamping parity vectors', () => {
  it.each(goalVectors.continuation_cap_clamping.map((v) => [v.requested_max_continuations, v] as const))(
    'max_continuations requested %s',
    (_requested, vector) => {
      const goal = buildGoalState(OBJECTIVE, {
        maxContinuations: vector.requested_max_continuations,
        now: PINNED_TIMESTAMP,
      })
      expect(goal.max_continuations).toBe(vector.effective_max_continuations)
      expect(goal.max_no_progress_continuations).toBe(vector.effective_max_no_progress_continuations)
      expect(goal.continuation_count).toBe(vector.continuation_count)
      expect(goal.no_progress_count).toBe(vector.no_progress_count)
    },
  )

  it.each(goalVectors.no_progress_cap_clamping.map((v) => [v.requested_max_no_progress_continuations, v] as const))(
    'max_no_progress_continuations requested %s',
    (_requested, vector) => {
      const goal = buildGoalState(OBJECTIVE, {
        maxNoProgressContinuations: vector.requested_max_no_progress_continuations,
        now: PINNED_TIMESTAMP,
      })
      expect(goal.max_no_progress_continuations).toBe(vector.effective_max_no_progress_continuations)
    },
  )

  it('consumed every recorded clamping vector', () => {
    expect(goalVectors.continuation_cap_clamping).toHaveLength(6)
    expect(goalVectors.no_progress_cap_clamping).toHaveLength(4)
  })
})

describe('goal gate matrix parity vectors', () => {
  it.each(goalVectors.gate_matrix.map((vector) => [vector.name, vector] as const))('gate %s', (_name, vector) => {
    const goal = buildGoalState(OBJECTIVE, { now: PINNED_TIMESTAMP })
    goal.continuation_count = vector.continuation_count
    goal.no_progress_count = vector.no_progress_count
    expect(goal.max_continuations).toBe(vector.max_continuations)
    expect(goal.max_no_progress_continuations).toBe(vector.max_no_progress_continuations)
    expect(shouldContinueGoal(goal, vector.evaluation, vector.no_progress_count)).toBe(vector.should_continue_goal)
    expect(standDownReason(goal, vector.evaluation, vector.no_progress_count)).toBe(vector.stand_down_reason)
  })

  it('consumed every recorded gate vector', () => {
    expect(goalVectors.gate_matrix).toHaveLength(11)
  })
})

describe('no-progress breaker sequences', () => {
  it.each(goalVectors.no_progress_sequences.map((sequence) => [sequence.name, sequence] as const))(
    'sequence %s',
    (_name, sequence) => {
      let goal = buildGoalState(OBJECTIVE, { now: PINNED_TIMESTAMP })
      for (const step of sequence.steps) {
        const evl = evaluation(false, 'goal_not_met_yet', `turn ${step.turn} reworded reason`)
        const noProgress = computeNoProgressCount(goal, evl, step.evidence_signature)
        const standDown = standDownReason(goal, evl, noProgress)
        const decision =
          standDown !== null || !shouldContinueGoal(goal, evl, noProgress) ? 'stand_down' : 'continue'
        const nextContinuation = goal.continuation_count + (decision === 'continue' ? 1 : 0)
        goal = attachGoalEvaluation(goal, evl, {
          runId: `run-${step.turn}`,
          continuationCount: nextContinuation,
          noProgressCount: noProgress,
          standDownReason: standDown,
          evidenceSignature: step.evidence_signature,
          now: PINNED_SENTINEL,
        })

        expect(computeGoalProgressKey(evl, step.evidence_signature), `turn ${step.turn} progress_key`).toBe(
          step.progress_key,
        )
        expect(noProgress, `turn ${step.turn} no_progress_count`).toBe(step.no_progress_count)
        expect(decision, `turn ${step.turn} decision`).toBe(step.decision)
        expect(standDown, `turn ${step.turn} stand_down_reason`).toBe(step.stand_down_reason)
        expect(goal.continuation_count, `turn ${step.turn} continuation_count_after`).toBe(step.continuation_count_after)
        expect(goal, `turn ${step.turn} goal_after`).toEqual(step.goal_after)
      }
    },
  )

  it('consumed every recorded sequence step', () => {
    expect(goalVectors.no_progress_sequences).toHaveLength(3)
    expect(goalVectors.no_progress_sequences.flatMap((sequence) => sequence.steps)).toHaveLength(11)
  })
})

describe('continuation cap walk', () => {
  it('trips at exactly the recorded turn', () => {
    let goal = buildGoalState(OBJECTIVE, { now: PINNED_TIMESTAMP })
    for (const step of goalVectors.continuation_cap_walk) {
      const evl = evaluation(false, 'goal_not_met_yet')
      const signature = `sig-${step.turn}`
      const noProgress = computeNoProgressCount(goal, evl, signature)
      const standDown = standDownReason(goal, evl, noProgress)
      const shouldContinue = shouldContinueGoal(goal, evl, noProgress)

      expect(goal.continuation_count, `turn ${step.turn} continuation_count_before`).toBe(step.continuation_count_before)
      expect(shouldContinue, `turn ${step.turn} should_continue_goal`).toBe(step.should_continue_goal)
      expect(standDown, `turn ${step.turn} stand_down_reason`).toBe(step.stand_down_reason)

      goal = attachGoalEvaluation(goal, evl, {
        runId: `run-${step.turn}`,
        continuationCount: goal.continuation_count + (shouldContinue && standDown === null ? 1 : 0),
        noProgressCount: noProgress,
        standDownReason: standDown,
        evidenceSignature: signature,
        now: PINNED_SENTINEL,
      })
    }
    expect(goalVectors.continuation_cap_walk).toHaveLength(10)
  })
})

describe('goal edge cases', () => {
  it('pins the engine constants', () => {
    expect(DEFAULT_MAX_GOAL_CONTINUATIONS).toBe(8)
    expect(DEFAULT_MAX_NO_PROGRESS_CONTINUATIONS).toBe(2)
    expect(MAX_GOAL_OBJECTIVE_CHARS).toBe(4000)
  })

  it('normalizes and bounds the objective', () => {
    expect(normalizeGoalObjective('  ship   the\n port ')).toBe('ship the port')
    expect(() => normalizeGoalObjective('   ')).toThrow(InvalidGoalObjectiveError)
    expect(() => normalizeGoalObjective('x'.repeat(MAX_GOAL_OBJECTIVE_CHARS + 1))).toThrow(InvalidGoalObjectiveError)
  })

  it('emits a progress key in the original Python json.dumps encoding', () => {
    expect(computeGoalProgressKey(evaluation(false, 'goal_not_met_yet'), 'sig-A')).toBe(
      '{"blocker": "goal_not_met_yet", "evidence_signature": "sig-A", "satisfied": false}',
    )
  })

  it('resets the no-progress counter when the goal is satisfied', () => {
    const goal = buildGoalState(OBJECTIVE, { now: PINNED_TIMESTAMP })
    goal.no_progress_count = 2
    expect(computeNoProgressCount(goal, evaluation(true, 'none'), 'sig-A')).toBe(0)
  })

  it('omits stand_down_reason from last_evaluation when the run may continue', () => {
    const goal = buildGoalState(OBJECTIVE, { now: PINNED_TIMESTAMP })
    const attached = attachGoalEvaluation(goal, evaluation(false, 'goal_not_met_yet'), {
      runId: 'run-1',
      now: PINNED_SENTINEL,
      standDownReason: null,
    })
    expect(attached.last_evaluation).not.toHaveProperty('stand_down_reason')
    expect(goal.last_evaluation).toBeUndefined()
  })
})
