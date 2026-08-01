// Vector-driven parity tests for the deep-run batch planner.
// Source of truth: parity/baseline/caps_clamping.json -> `allowed_this_response`, extracted by
// executing SubagentLimitMiddleware._truncate_task_calls at commit 0950924.
//
// The planner replays that per-response decision once per batch, so the vectors are reused
// against the FIRST batch (which is exactly one response's worth of dispatch) and the
// multi-batch composition is then checked on top.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SUBAGENT_TIMEOUT_MS, planBatches, resolveAgentType, type DeepRunTask } from './batching.js'
import {
  DEFAULT_MAX_CONCURRENT_SUBAGENT_CALLS,
  DEFAULT_MAX_TOTAL_SUBAGENTS_PER_RUN,
  SUBAGENT_LIMIT_NOTE,
  SUBAGENT_LIMIT_STOP_REASON,
  createSubagentLimits,
} from '../policy/caps.js'

interface AllowedVector {
  configured_max_concurrent: number
  configured_max_total: number
  prior_current_run_delegations: number
  requested_task_calls: number
  allowed_task_calls: number
  limit_note_appended: boolean
  message_content: string | null
  stop_reason: string | null
}

const VECTORS: { allowed_this_response: AllowedVector[] } = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../parity/baseline/caps_clamping.json', import.meta.url)), 'utf8'),
) as { allowed_this_response: AllowedVector[] }

function makeTasks(count: number, type = 'deerflow-general-purpose'): DeepRunTask[] {
  return Array.from({ length: count }, (_unused, index) => ({
    description: `task ${index}`,
    prompt: `do work ${index}`,
    subagent_type: type,
  }))
}

describe('planBatches — allowed_this_response vectors (first batch = one response)', () => {
  for (const vector of VECTORS.allowed_this_response) {
    const name =
      `concurrent=${vector.configured_max_concurrent} total=${vector.configured_max_total} ` +
      `prior=${vector.prior_current_run_delegations} requested=${vector.requested_task_calls}`
    it(`allows ${vector.allowed_task_calls} in the first batch for ${name}`, () => {
      const plan = planBatches({
        tasks: makeTasks(vector.requested_task_calls),
        priorDelegations: vector.prior_current_run_delegations,
        limits: createSubagentLimits(vector.configured_max_concurrent, vector.configured_max_total),
        messageContent: vector.message_content === null ? null : 'dispatching',
      })

      expect(plan.batches[0]?.length ?? 0).toBe(vector.allowed_task_calls)

      const firstDecision = plan.decisions[0]
      expect(firstDecision).toBeDefined()
      expect(firstDecision?.allowedTaskCalls).toBe(vector.allowed_task_calls)
      expect(firstDecision?.limitNoteAppended).toBe(vector.limit_note_appended)
      expect(firstDecision?.stopReason).toBe(vector.stop_reason)
      if (vector.limit_note_appended) {
        expect(firstDecision?.messageContent).toBe(vector.message_content)
      }
    })
  }
})

describe('planBatches — run-level composition', () => {
  it('uses the documented defaults: 3 concurrent, 6 total, 1800s per task', () => {
    const plan = planBatches({ tasks: makeTasks(1) })
    expect(plan.limits).toEqual({ maxConcurrent: 3, maxTotal: 6 })
    expect(DEFAULT_MAX_CONCURRENT_SUBAGENT_CALLS).toBe(3)
    expect(DEFAULT_MAX_TOTAL_SUBAGENTS_PER_RUN).toBe(6)
    expect(plan.timeoutMs).toBe(DEFAULT_SUBAGENT_TIMEOUT_MS)
    expect(DEFAULT_SUBAGENT_TIMEOUT_MS).toBe(1800 * 1000)
  })

  it('fills the run budget across several batches of the concurrency cap', () => {
    const plan = planBatches({ tasks: makeTasks(6) })
    expect(plan.batches.map((batch) => batch.length)).toEqual([3, 3])
    expect(plan.accepted).toHaveLength(6)
    expect(plan.dropped).toHaveLength(0)
    expect(plan.limitNote).toBeNull()
    expect(plan.stopReason).toBeNull()
  })

  it('drops the excess beyond the run cap with the verbatim limit note', () => {
    const plan = planBatches({ tasks: makeTasks(8), messageContent: 'dispatching' })
    expect(plan.batches.map((batch) => batch.length)).toEqual([3, 3])
    expect(plan.accepted).toHaveLength(6)
    expect(plan.dropped.map((task) => task.description)).toEqual(['task 6', 'task 7'])
    expect(plan.limitNote).toBe(SUBAGENT_LIMIT_NOTE)
    expect(plan.stopReason).toBe(SUBAGENT_LIMIT_STOP_REASON)
    expect(plan.messageContent).toBe(`dispatching\n\n${SUBAGENT_LIMIT_NOTE}`)
  })

  it('drops everything when the run budget is already exhausted', () => {
    const plan = planBatches({ tasks: makeTasks(2), priorDelegations: 6 })
    expect(plan.batches).toHaveLength(0)
    expect(plan.accepted).toHaveLength(0)
    expect(plan.dropped).toHaveLength(2)
    expect(plan.limitNote).toBe(SUBAGENT_LIMIT_NOTE)
    expect(plan.stopReason).toBe(SUBAGENT_LIMIT_STOP_REASON)
  })

  it('honours prior delegations from earlier in the run', () => {
    const plan = planBatches({ tasks: makeTasks(4), priorDelegations: 4 })
    // remaining = 6 - 4 = 2, so one batch of 2 and two dropped.
    expect(plan.batches.map((batch) => batch.length)).toEqual([2])
    expect(plan.dropped).toHaveLength(2)
    expect(plan.limitNote).toBe(SUBAGENT_LIMIT_NOTE)
  })

  it('serialises the run when concurrency is clamped to 1', () => {
    const plan = planBatches({ tasks: makeTasks(4), limits: createSubagentLimits(1, 6) })
    expect(plan.batches.map((batch) => batch.length)).toEqual([1, 1, 1, 1])
    expect(plan.dropped).toHaveLength(0)
  })

  it('clamps an over-range concurrency request to 4 and an over-range total to 50', () => {
    const plan = planBatches({ tasks: makeTasks(8), limits: createSubagentLimits(99, 51) })
    expect(plan.limits).toEqual({ maxConcurrent: 4, maxTotal: 50 })
    expect(plan.batches.map((batch) => batch.length)).toEqual([4, 4])
    expect(plan.dropped).toHaveLength(0)
  })

  it('never drops a task while run budget remains', () => {
    for (let count = 0; count <= 12; count += 1) {
      const plan = planBatches({ tasks: makeTasks(count) })
      const expectedAccepted = Math.min(count, 6)
      expect(plan.accepted).toHaveLength(expectedAccepted)
      expect(plan.dropped).toHaveLength(count - expectedAccepted)
      // The note appears if and only if something was dropped.
      expect(plan.limitNote === null).toBe(plan.dropped.length === 0)
    }
  })

  it('returns an empty plan for an empty task list without a limit note', () => {
    const plan = planBatches({ tasks: [] })
    expect(plan.batches).toHaveLength(0)
    expect(plan.decisions).toHaveLength(0)
    expect(plan.limitNote).toBeNull()
  })

  it('preserves original task order and index across batches', () => {
    const plan = planBatches({ tasks: makeTasks(6) })
    expect(plan.accepted.map((task) => task.index)).toEqual([0, 1, 2, 3, 4, 5])
    expect(plan.accepted.map((task) => task.description)).toEqual([
      'task 0',
      'task 1',
      'task 2',
      'task 3',
      'task 4',
      'task 5',
    ])
  })

  it('carries the per-task timeout onto every planned task', () => {
    const plan = planBatches({ tasks: makeTasks(3), timeoutMs: 1234 })
    expect(plan.accepted.every((task) => task.timeoutMs === 1234)).toBe(true)
  })
})

describe('resolveAgentType', () => {
  it.each([
    ['deerflow-bash', 'deerflow-bash'],
    ['bash', 'deerflow-bash'],
    ['deerflow-general-purpose', 'deerflow-general-purpose'],
    ['general-purpose', 'deerflow-general-purpose'],
  ])('resolves %s to %s', (input, expected) => {
    expect(resolveAgentType(input)).toBe(expected)
  })

  it.each([['unknown-type'], [''], [null], [undefined]])(
    'falls back to general-purpose for %s instead of failing the batch',
    (input) => {
      expect(resolveAgentType(input as string | null | undefined)).toBe('deerflow-general-purpose')
    },
  )

  it('routes bash tasks to the bash agent inside a plan', () => {
    const plan = planBatches({ tasks: makeTasks(2, 'bash') })
    expect(plan.accepted.map((task) => task.agentType)).toEqual(['deerflow-bash', 'deerflow-bash'])
  })
})
