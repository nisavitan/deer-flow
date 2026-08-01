// Vector-driven parity tests for the subagent delegation caps.
// Source of truth: parity/baseline/caps_clamping.json (extracted by executing
// deerflow.config.subagents_config clamps and SubagentLimitMiddleware at commit 0950924).
// `error: "TypeError"` rows record the real exception the original raised for a None input;
// the port refuses the input with a typed error instead of fabricating a clamped value.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  MAX_CONCURRENT_SUBAGENT_CALLS,
  MAX_TOTAL_SUBAGENTS_PER_RUN,
  MIN_CONCURRENT_SUBAGENT_CALLS,
  MIN_TOTAL_SUBAGENTS_PER_RUN,
  SUBAGENT_LIMIT_NOTE,
  SUBAGENT_LIMIT_STOP_REASON,
  SubagentLimitTypeError,
  allowedThisResponse,
  clampSubagentConcurrency,
  clampTotalSubagentsPerRun,
  createSubagentLimits,
  priorDelegationsForRun,
} from './caps.js'
import type { DelegationEntry } from '../state/delegations.js'

interface ClampVector {
  input: number | null
  effective: number | null
  error: string | null
}

interface ConstructorVector {
  input: number | null
  effective_max_concurrent: number | null
  effective_max_total: number | null
  error: string | null
}

interface TruncationVector {
  configured_max_concurrent: number
  configured_max_total: number
  prior_current_run_delegations: number
  requested_task_calls: number
  allowed_task_calls: number
  middleware_returned_update: boolean
  limit_note_appended: boolean
  message_content: string | null
  stop_reason: string | null
}

const vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../parity/baseline/caps_clamping.json', import.meta.url)), 'utf8'),
) as {
  max_concurrent_subagents_clamp: ClampVector[]
  max_total_subagents_clamp: ClampVector[]
  middleware_constructor: ConstructorVector[]
  allowed_this_response: TruncationVector[]
  missing_run_id: {
    prior_ledger_entries: number
    requested_task_calls: number
    allowed_task_calls: number
    limit_note_appended: boolean
    stop_reason: string | null
  }
}

/** The extractor built the AIMessage with content "dispatching" for every truncation vector. */
const DISPATCH_CONTENT = 'dispatching'

function delegation(id: string, runId: string): DelegationEntry {
  return {
    id,
    run_id: runId,
    description: `task ${id}`,
    subagent_type: 'general-purpose',
    status: 'completed',
    created_at: '1970-01-01T00:00:00+00:00',
  }
}

describe('clamp parity vectors', () => {
  it.each(vectors.max_concurrent_subagents_clamp.map((v) => [String(v.input), v] as const))(
    'clamp_subagent_concurrency(%s)',
    (_input, vector) => {
      if (vector.error !== null) {
        expect(() => clampSubagentConcurrency(vector.input)).toThrow(SubagentLimitTypeError)
        expect(() => clampSubagentConcurrency(vector.input)).toThrow(TypeError)
        return
      }
      expect(clampSubagentConcurrency(vector.input)).toBe(vector.effective)
    },
  )

  it.each(vectors.max_total_subagents_clamp.map((v) => [String(v.input), v] as const))(
    'clamp_total_subagents_per_run(%s)',
    (_input, vector) => {
      if (vector.error !== null) {
        expect(() => clampTotalSubagentsPerRun(vector.input)).toThrow(SubagentLimitTypeError)
        return
      }
      expect(clampTotalSubagentsPerRun(vector.input)).toBe(vector.effective)
    },
  )

  it.each(vectors.middleware_constructor.map((v) => [String(v.input), v] as const))(
    'createSubagentLimits(%s, %s)',
    (_input, vector) => {
      if (vector.error !== null) {
        expect(() => createSubagentLimits(vector.input, vector.input)).toThrow(SubagentLimitTypeError)
        return
      }
      expect(createSubagentLimits(vector.input, vector.input)).toEqual({
        maxConcurrent: vector.effective_max_concurrent,
        maxTotal: vector.effective_max_total,
      })
    },
  )

  it('consumed every recorded clamp vector', () => {
    expect(vectors.max_concurrent_subagents_clamp).toHaveLength(10)
    expect(vectors.max_total_subagents_clamp).toHaveLength(10)
    expect(vectors.middleware_constructor).toHaveLength(10)
  })
})

describe('allowed-this-response parity vectors', () => {
  it.each(
    vectors.allowed_this_response.map(
      (vector) =>
        [
          `c=${vector.configured_max_concurrent} t=${vector.configured_max_total} prior=${vector.prior_current_run_delegations} req=${vector.requested_task_calls}`,
          vector,
        ] as const,
    ),
  )('%s', (_label, vector) => {
    const decision = allowedThisResponse({
      limits: createSubagentLimits(vector.configured_max_concurrent, vector.configured_max_total),
      requestedTaskCalls: vector.requested_task_calls,
      priorDelegations: vector.prior_current_run_delegations,
      messageContent: DISPATCH_CONTENT,
    })
    expect(decision.allowedTaskCalls).toBe(vector.allowed_task_calls)
    expect(decision.truncated).toBe(vector.middleware_returned_update)
    expect(decision.limitNoteAppended).toBe(vector.limit_note_appended)
    expect(decision.messageContent).toBe(vector.message_content)
    expect(decision.stopReason).toBe(vector.stop_reason)
  })

  it('counts the whole ledger when no run id is in scope (fail-restrictive)', () => {
    const ledger = Array.from({ length: vectors.missing_run_id.prior_ledger_entries }, (_unused, index) =>
      delegation(`old${index}`, 'run-OLD'),
    )
    const prior = priorDelegationsForRun(ledger, null)
    expect(prior).toBe(vectors.missing_run_id.prior_ledger_entries)

    const decision = allowedThisResponse({
      limits: createSubagentLimits(3, 6),
      requestedTaskCalls: vectors.missing_run_id.requested_task_calls,
      priorDelegations: prior,
      messageContent: 'go',
    })
    expect(decision.allowedTaskCalls).toBe(vectors.missing_run_id.allowed_task_calls)
    expect(decision.limitNoteAppended).toBe(vectors.missing_run_id.limit_note_appended)
    expect(decision.stopReason).toBe(vectors.missing_run_id.stop_reason)
  })

  it('consumed every recorded truncation vector', () => {
    expect(vectors.allowed_this_response).toHaveLength(9)
  })
})

describe('caps edge cases', () => {
  it('pins the enforced ranges', () => {
    expect([MIN_CONCURRENT_SUBAGENT_CALLS, MAX_CONCURRENT_SUBAGENT_CALLS]).toEqual([1, 4])
    expect([MIN_TOTAL_SUBAGENTS_PER_RUN, MAX_TOTAL_SUBAGENTS_PER_RUN]).toEqual([1, 50])
  })

  it('pins the limit note text and stop reason recorded in the vectors', () => {
    const capped = vectors.allowed_this_response.find((vector) => vector.limit_note_appended)
    expect(capped?.message_content).toBe(`${DISPATCH_CONTENT}\n\n${SUBAGENT_LIMIT_NOTE}`)
    expect(capped?.stop_reason).toBe(SUBAGENT_LIMIT_STOP_REASON)
  })

  it('uses the note alone when the response carried no visible text', () => {
    const decision = allowedThisResponse({
      limits: createSubagentLimits(3, 6),
      requestedTaskCalls: 2,
      priorDelegations: 6,
      messageContent: null,
    })
    expect(decision.messageContent).toBe(SUBAGENT_LIMIT_NOTE)
    expect(decision.allowedTaskCalls).toBe(0)
  })

  it('rejects non-integer limits rather than coercing them', () => {
    expect(() => clampSubagentConcurrency(undefined)).toThrow(SubagentLimitTypeError)
    expect(() => clampSubagentConcurrency(2.5)).toThrow(SubagentLimitTypeError)
    expect(() => clampTotalSubagentsPerRun('6')).toThrow(SubagentLimitTypeError)
  })

  it('never reports more allowed calls than were requested', () => {
    const decision = allowedThisResponse({
      limits: createSubagentLimits(4, 50),
      requestedTaskCalls: 1,
      priorDelegations: 0,
      messageContent: DISPATCH_CONTENT,
    })
    expect(decision.allowedTaskCalls).toBe(1)
    expect(decision.truncated).toBe(false)
    expect(decision.messageContent).toBeNull()
  })
})
