// Drift guard between workflows/deep-run.js and its TypeScript twins.
//
// The workflow sandbox has no module system, so deep-run.js carries an inline copy of the
// caps arithmetic, the batch planner, and the result formatter. Comments asking a future
// editor to "keep these in sync" are not a mechanism — this test is. It extracts the pure
// region of deep-run.js verbatim, evaluates it, and drives the SAME parity vectors through
// the inline copy that result-format.test.ts and batching.test.ts drive through the TS
// modules. A divergence in either direction fails here.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { formatSubagentResultMessage, boundMetadataText } from './result-format.js'
import {
  planBatches,
  resolveAgentType,
  qualifyAgentType,
  DEFAULT_SUBAGENT_TIMEOUT_MS,
  type DeepRunTask,
} from './batching.js'
import {
  normalizeTaskResult,
  coerceWorkflowArgs,
  DEEP_RUN_TASK_RESULT_SCHEMA,
  DEEP_RUN_PLAN_SCHEMA,
  DEEP_RUN_DELEGATION_POLICY,
} from './task-schema.js'
import { SUBAGENT_LIMIT_NOTE, SUBAGENT_LIMIT_STOP_REASON, createSubagentLimits } from '../policy/caps.js'
import type { SubagentStatus, SubagentStopReason } from '../policy/stop-reason.js'

const WORKFLOW_PATH = fileURLToPath(new URL('../../workflows/deep-run.js', import.meta.url))
const WORKFLOW_SOURCE = readFileSync(WORKFLOW_PATH, 'utf8')

const BEGIN = '// <<<PORTED-LOGIC-BEGIN>>>'
const END = '// <<<PORTED-LOGIC-END>>>'

/**
 * Drop comments so a structural check inspects CODE, not prose.
 *
 * The file's comments legitimately mention `agent()` and `Date.now()` while explaining why
 * the code does not use them; without this the checks below would fire on their own
 * documentation. No string literal in deep-run.js contains `//` or a comment opener, so the
 * naive strip is safe here (asserted by the round-trip check on DELEGATION_POLICY, which
 * would be mangled if a literal were touched).
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

function extractPortedRegion(source: string): string {
  const start = source.indexOf(BEGIN)
  const end = source.indexOf(END)
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`deep-run.js is missing its ${BEGIN} / ${END} markers`)
  }
  return source.slice(start + BEGIN.length, end)
}

interface InlinePort {
  SUBAGENT_LIMIT_NOTE: string
  SUBAGENT_LIMIT_STOP_REASON: string
  NO_RESPONSE_SENTINEL: string
  DEFAULT_SUBAGENT_TIMEOUT_MS: number
  DEFAULT_MAX_CONCURRENT_SUBAGENT_CALLS: number
  DEFAULT_MAX_TOTAL_SUBAGENTS_PER_RUN: number
  TASK_RESULT_SCHEMA: unknown
  PLAN_SCHEMA: unknown
  DELEGATION_POLICY: string
  STOP_REASON_LABELS: Record<string, string>
  clampConcurrency: (value: unknown) => number
  clampTotal: (value: unknown) => number
  resolveAgentType: (value: unknown) => string
  qualifyAgentType: (value: string) => string
  planBatches: (
    tasks: readonly DeepRunTask[],
    limits: { maxConcurrent: number; maxTotal: number },
    prior: number,
    timeoutMs: number,
  ) => {
    batches: { index: number; description: string; agentType: string; timeoutMs: number }[][]
    accepted: { index: number; description: string; agentType: string }[]
    dropped: DeepRunTask[]
    limitNote: string | null
    stopReason: string | null
  }
  formatSubagentResultMessage: (
    status: string,
    result: string | null,
    error: string | null,
    stopReason: string | null,
  ) => { modelVisibleContent: string; metadataError: string | null }
  boundMetadataText: (text: string, cap?: number) => string
  normalizeTaskResult: (raw: unknown) => {
    status: string
    result: string
    stop_reason: string | null
    files_produced: string[]
  }
  coerceWorkflowArgs: (raw: unknown) => Record<string, unknown>
}

const EXPORTED_NAMES = [
  'SUBAGENT_LIMIT_NOTE',
  'SUBAGENT_LIMIT_STOP_REASON',
  'NO_RESPONSE_SENTINEL',
  'DEFAULT_SUBAGENT_TIMEOUT_MS',
  'DEFAULT_MAX_CONCURRENT_SUBAGENT_CALLS',
  'DEFAULT_MAX_TOTAL_SUBAGENTS_PER_RUN',
  'TASK_RESULT_SCHEMA',
  'PLAN_SCHEMA',
  'DELEGATION_POLICY',
  'STOP_REASON_LABELS',
  'clampConcurrency',
  'clampTotal',
  'resolveAgentType',
  'qualifyAgentType',
  'planBatches',
  'formatSubagentResultMessage',
  'boundMetadataText',
  'normalizeTaskResult',
  'coerceWorkflowArgs',
] as const

function loadInlinePort(): InlinePort {
  const region = extractPortedRegion(WORKFLOW_SOURCE)
  const factory = new Function(`${region}\nreturn { ${EXPORTED_NAMES.join(', ')} };`) as () => InlinePort
  return factory()
}

const inline = loadInlinePort()

interface RenderVector {
  status: SubagentStatus
  stop_reason: SubagentStopReason | null
  input_shape: string
  result: string | null
  error: string | null
  model_visible_content: string
  metadata_error: string | null
}

const RENDERS: RenderVector[] = (
  JSON.parse(
    readFileSync(fileURLToPath(new URL('../../parity/baseline/subagent_status_contract.json', import.meta.url)), 'utf8'),
  ) as { result_message_formats: RenderVector[] }
).result_message_formats

interface AllowedVector {
  configured_max_concurrent: number
  configured_max_total: number
  prior_current_run_delegations: number
  requested_task_calls: number
  allowed_task_calls: number
}

const ALLOWED: AllowedVector[] = (
  JSON.parse(readFileSync(fileURLToPath(new URL('../../parity/baseline/caps_clamping.json', import.meta.url)), 'utf8')) as {
    allowed_this_response: AllowedVector[]
  }
).allowed_this_response

function makeTasks(count: number, type = 'deerflow-general-purpose'): DeepRunTask[] {
  return Array.from({ length: count }, (_unused, index) => ({
    description: `task ${index}`,
    prompt: `do work ${index}`,
    subagent_type: type,
  }))
}

describe('deep-run.js structure', () => {
  it('exposes the extraction markers around a region free of runtime globals', () => {
    const region = stripComments(extractPortedRegion(WORKFLOW_SOURCE))
    // The injected globals split into callables and values. For callables only a CALL counts:
    // the delegation policy prose legitimately ends a sentence with "...run in parallel." and
    // that must not read as a use of `parallel()`.
    for (const callable of ['agent', 'parallel', 'pipeline', 'phase', 'log', 'workflow']) {
      expect({ [callable]: new RegExp(`(?<![\\w.])${callable}\\s*\\(`).test(region) }).toEqual({ [callable]: false })
    }
    // `args` is a bare value; a use of it anywhere in the region is disqualifying.
    expect({ args: /(?<![\w.])args(?![\w])/.test(region) }).toEqual({ args: false })
    // `budget` is only usable through its members (`budget.total`, `budget.spent()`), so the
    // check is property access — the phrase "token budget" in the cap labels is prose.
    expect({ budget: /(?<![\w.])budget\s*\./.test(region) }).toEqual({ budget: false })
  })

  it('declares the three phases in meta and calls each one', () => {
    for (const title of ['Plan', 'Delegate', 'Synthesize']) {
      expect(WORKFLOW_SOURCE).toContain(`{ title: '${title}'`)
      expect(WORKFLOW_SOURCE).toContain(`phase('${title}')`)
    }
  })

  it('names its TypeScript source of truth so the sync obligation is discoverable', () => {
    expect(WORKFLOW_SOURCE).toContain('src/deeprun/result-format.ts')
    expect(WORKFLOW_SOURCE).toContain('src/deeprun/batching.ts')
    expect(WORKFLOW_SOURCE).toContain('src/deeprun/ledger-io.ts')
  })

  it('never reads the clock or the RNG, which the sandbox forbids', () => {
    const code = stripComments(WORKFLOW_SOURCE)
    expect(code).not.toContain('Date.now(')
    expect(code).not.toContain('Math.random(')
    expect(code).not.toContain('new Date(')
  })

  it('always clears the timeout timer so a 30-minute timer cannot outlive the run', () => {
    expect(WORKFLOW_SOURCE).toContain('clearTimeout(timer)')
  })
})

describe('inline constants match the TypeScript modules', () => {
  it('carries the verbatim subagent limit note and stop reason', () => {
    expect(inline.SUBAGENT_LIMIT_NOTE).toBe(SUBAGENT_LIMIT_NOTE)
    expect(inline.SUBAGENT_LIMIT_STOP_REASON).toBe(SUBAGENT_LIMIT_STOP_REASON)
  })

  it('carries the same caps defaults and per-task timeout', () => {
    expect(inline.DEFAULT_SUBAGENT_TIMEOUT_MS).toBe(DEFAULT_SUBAGENT_TIMEOUT_MS)
    expect(inline.DEFAULT_MAX_CONCURRENT_SUBAGENT_CALLS).toBe(3)
    expect(inline.DEFAULT_MAX_TOTAL_SUBAGENTS_PER_RUN).toBe(6)
  })

  it('carries the same result schema, plan schema and delegation policy', () => {
    expect(inline.TASK_RESULT_SCHEMA).toEqual(DEEP_RUN_TASK_RESULT_SCHEMA)
    expect(inline.PLAN_SCHEMA).toEqual(DEEP_RUN_PLAN_SCHEMA)
    expect(inline.DELEGATION_POLICY).toBe(DEEP_RUN_DELEGATION_POLICY)
  })

  it('carries the same no-response sentinel the executor uses', () => {
    expect(inline.NO_RESPONSE_SENTINEL).toBe('No response generated')
  })

  it('carries the same stop-reason labels', () => {
    expect(inline.STOP_REASON_LABELS).toEqual({
      token_capped: 'token budget',
      turn_capped: 'turn budget',
      loop_capped: 'repeated tool-call loop',
    })
  })
})

describe('inline formatter reproduces all 60 golden renders', () => {
  for (const vector of RENDERS) {
    const name = `${vector.status} / ${vector.stop_reason ?? 'no-cap'} / ${vector.input_shape}`
    it(`renders ${name} identically to the TypeScript twin and the golden`, () => {
      const fromWorkflow = inline.formatSubagentResultMessage(
        vector.status,
        vector.result,
        vector.error,
        vector.stop_reason,
      )
      const fromModule = formatSubagentResultMessage(vector.status, {
        result: vector.result,
        error: vector.error,
        stopReason: vector.stop_reason,
      })
      expect(fromWorkflow.modelVisibleContent).toBe(vector.model_visible_content)
      expect(fromWorkflow.metadataError).toBe(vector.metadata_error)
      expect(fromWorkflow).toEqual({
        modelVisibleContent: fromModule.modelVisibleContent,
        metadataError: fromModule.metadataError,
      })
    })
  }
})

describe('inline caps match the TypeScript twin', () => {
  it.each([
    [-1, 1],
    [0, 1],
    [1, 1],
    [3, 3],
    [4, 4],
    [5, 4],
    [51, 4],
  ])('clamps concurrency %i to %i', (input, expected) => {
    expect(inline.clampConcurrency(input)).toBe(expected)
  })

  it.each([
    [-1, 1],
    [0, 1],
    [1, 1],
    [5, 5],
    [50, 50],
    [51, 50],
  ])('clamps total %i to %i', (input, expected) => {
    expect(inline.clampTotal(input)).toBe(expected)
  })

  it('falls back to the defaults for a non-integer instead of throwing mid-run', () => {
    // DELIBERATE DIVERGENCE from the TS twin, which refuses the input with
    // SubagentLimitTypeError (matching the original's TypeError, pinned by caps_clamping.json).
    // The twin sits at a typed API boundary; the workflow reads an untyped tool-call payload
    // and must not abort a whole delegation run over one malformed cap field, so it degrades
    // to the documented default. Recorded in parity/DISCREPANCIES.md.
    expect(inline.clampConcurrency(null)).toBe(3)
    expect(inline.clampConcurrency(undefined)).toBe(3)
    expect(inline.clampConcurrency(2.5)).toBe(3)
    expect(inline.clampTotal(null)).toBe(6)
    expect(inline.clampTotal('6')).toBe(6)
  })

  for (const vector of ALLOWED) {
    const name =
      `concurrent=${vector.configured_max_concurrent} total=${vector.configured_max_total} ` +
      `prior=${vector.prior_current_run_delegations} requested=${vector.requested_task_calls}`
    it(`allows ${vector.allowed_task_calls} in the first batch for ${name}`, () => {
      const result = inline.planBatches(
        makeTasks(vector.requested_task_calls),
        {
          maxConcurrent: inline.clampConcurrency(vector.configured_max_concurrent),
          maxTotal: inline.clampTotal(vector.configured_max_total),
        },
        vector.prior_current_run_delegations,
        DEFAULT_SUBAGENT_TIMEOUT_MS,
      )
      expect(result.batches[0]?.length ?? 0).toBe(vector.allowed_task_calls)
    })
  }
})

describe('inline planner matches the TypeScript planner', () => {
  const scenarios: { name: string; count: number; prior: number; concurrent: number; total: number }[] = [
    { name: 'exact fit', count: 6, prior: 0, concurrent: 3, total: 6 },
    { name: 'overflow', count: 8, prior: 0, concurrent: 3, total: 6 },
    { name: 'batching demo (4 tasks, total 3)', count: 4, prior: 0, concurrent: 3, total: 3 },
    { name: 'exhausted budget', count: 2, prior: 6, concurrent: 3, total: 6 },
    { name: 'partial budget', count: 4, prior: 4, concurrent: 3, total: 6 },
    { name: 'serialised', count: 4, prior: 0, concurrent: 1, total: 6 },
    { name: 'empty', count: 0, prior: 0, concurrent: 3, total: 6 },
  ]

  for (const scenario of scenarios) {
    it(`agrees on ${scenario.name}`, () => {
      const tasks = makeTasks(scenario.count)
      const limits = createSubagentLimits(scenario.concurrent, scenario.total)
      const fromModule = planBatches({ tasks, limits, priorDelegations: scenario.prior })
      const fromWorkflow = inline.planBatches(tasks, limits, scenario.prior, DEFAULT_SUBAGENT_TIMEOUT_MS)

      expect(fromWorkflow.batches.map((batch) => batch.length)).toEqual(
        fromModule.batches.map((batch) => batch.length),
      )
      expect(fromWorkflow.accepted.map((task) => task.index)).toEqual(fromModule.accepted.map((task) => task.index))
      expect(fromWorkflow.dropped.length).toBe(fromModule.dropped.length)
      expect(fromWorkflow.limitNote).toBe(fromModule.limitNote)
      expect(fromWorkflow.stopReason).toBe(fromModule.stopReason)
    })
  }

  it('proves the smoke scenario: 4 tasks with max_total 3 run 3 and drop 1', () => {
    const result = inline.planBatches(makeTasks(4), { maxConcurrent: 3, maxTotal: 3 }, 0, DEFAULT_SUBAGENT_TIMEOUT_MS)
    expect(result.accepted).toHaveLength(3)
    expect(result.dropped).toHaveLength(1)
    expect(result.dropped[0]?.description).toBe('task 3')
    expect(result.limitNote).toBe(SUBAGENT_LIMIT_NOTE)
    expect(result.stopReason).toBe(SUBAGENT_LIMIT_STOP_REASON)
  })

  it('routes bash tasks the same way as the TypeScript twin', () => {
    for (const input of [
      'bash',
      'deerflow-bash',
      'deerflow:deerflow-bash',
      'general-purpose',
      'deerflow-general-purpose',
      'deerflow:deerflow-general-purpose',
      'unknown',
      '',
      null,
      undefined,
    ]) {
      expect(inline.resolveAgentType(input)).toBe(resolveAgentType(input as string | null | undefined))
    }
  })

  it('qualifies the agent type with the plugin namespace, as the live registry requires', () => {
    // Verified live in the M6 smoke: the bare name is NOT in the agent registry; only
    // `deerflow:deerflow-general-purpose` / `deerflow:deerflow-bash` resolve.
    expect(inline.qualifyAgentType('deerflow-general-purpose')).toBe('deerflow:deerflow-general-purpose')
    expect(inline.qualifyAgentType('deerflow-bash')).toBe('deerflow:deerflow-bash')
    expect(qualifyAgentType('deerflow-general-purpose')).toBe('deerflow:deerflow-general-purpose')
    expect(qualifyAgentType('deerflow-bash')).toBe('deerflow:deerflow-bash')
  })

  it('does not double-qualify an already-namespaced type', () => {
    expect(inline.qualifyAgentType('deerflow:deerflow-bash')).toBe('deerflow:deerflow-bash')
    expect(qualifyAgentType('deerflow:deerflow-bash')).toBe('deerflow:deerflow-bash')
  })

  it('dispatches through the qualified type, but keeps the bare name on the plan', () => {
    expect(WORKFLOW_SOURCE).toContain('agentType: qualifyAgentType(task.agentType)')
    // The ledger records the agent's own frontmatter name, unqualified.
    expect(WORKFLOW_SOURCE).toContain('subagent_type: task.agentType')
  })
})

describe('inline helpers match the TypeScript twins', () => {
  it.each([
    ['under the cap', 'hello', 2000],
    ['exactly at the cap', 'a'.repeat(30), 30],
    ['middle truncation', 'a'.repeat(60) + 'b'.repeat(60), 30],
    ['marker does not fit', 'abcdefghij', 4],
    ['astral text', '😀'.repeat(40), 30],
  ])('boundMetadataText agrees on %s', (_name, text, cap) => {
    expect(inline.boundMetadataText(text as string, cap as number)).toBe(
      boundMetadataText(text as string, cap as number),
    )
  })

  it.each([
    ['{"objective":"probe","tasks":[{"description":"d"}]}'],
    ['not json at all'],
    ['[1,2,3]'],
    ['"just a string"'],
    [{ objective: 'probe' }],
    [null],
    [undefined],
    [[1, 2]],
    [42],
  ])('coerceWorkflowArgs agrees on %s', (raw) => {
    expect(inline.coerceWorkflowArgs(raw)).toEqual(coerceWorkflowArgs(raw))
  })

  it('recovers the stringified args the lead actually sends (observed live in the M6 smoke)', () => {
    const stringified = JSON.stringify({ objective: 'probe', run_id: 'smoke-c', tasks: [{ description: 'echo probe' }] })
    expect(inline.coerceWorkflowArgs(stringified).objective).toBe('probe')
    expect(coerceWorkflowArgs(stringified)['objective']).toBe('probe')
  })

  it.each([
    [null],
    [undefined],
    ['a string'],
    [[1, 2]],
    [{ status: 'completed', result: 'ok', stop_reason: null }],
    [{ status: 'completed', result: 'ok', stop_reason: 'turn_capped', files_produced: ['a', 3] }],
    [{ status: 'nonsense', result: 'x' }],
    [{ status: 'failed', result: '' }],
    [{ status: 'completed', result: '', stop_reason: 'subagent_limit_capped' }],
  ])('normalizeTaskResult agrees on %s', (raw) => {
    const fromModule = normalizeTaskResult(raw, 'No response generated')
    expect(inline.normalizeTaskResult(raw)).toEqual({
      status: fromModule.status,
      result: fromModule.result,
      stop_reason: fromModule.stop_reason ?? null,
      files_produced: fromModule.files_produced ?? [],
    })
  })
})
