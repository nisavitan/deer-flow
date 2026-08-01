// Contract tests for the schema deep-run.js hands to agent().
// Source of truth: contracts/subagent_status_contract.json, mirrored into
// parity/baseline/subagent_status_contract.json at commit 0950924.
//
// The point of these tests is that the schema's allowed values are DERIVED from the contract
// rather than retyped: if the contract's stop-reason list ever changes, the schema changes
// with it and the divergence surfaces here.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  DEEP_RUN_AGENT_TYPES,
  DEEP_RUN_DELEGATION_POLICY,
  DEEP_RUN_PLAN_SCHEMA,
  DEEP_RUN_TASK_RESULT_SCHEMA,
  TASK_RESULT_STATUS_VALUES,
  TASK_RESULT_STOP_REASON_VALUES,
  normalizeTaskResult,
} from './task-schema.js'
import { SUBAGENT_STATUS_VALUES, SUBAGENT_STOP_REASON_VALUES } from '../policy/stop-reason.js'

const CONTRACT: {
  contract_json: { valid_status_values: string[]; valid_stop_reason_values: string[]; version: number }
} = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../parity/baseline/subagent_status_contract.json', import.meta.url)), 'utf8'),
) as { contract_json: { valid_status_values: string[]; valid_stop_reason_values: string[]; version: number } }

const SENTINEL = 'No response generated'

describe('allowed values against the contract', () => {
  it('takes its stop reasons verbatim from the contract', () => {
    expect([...TASK_RESULT_STOP_REASON_VALUES]).toEqual(CONTRACT.contract_json.valid_stop_reason_values)
    expect([...TASK_RESULT_STOP_REASON_VALUES]).toEqual([...SUBAGENT_STOP_REASON_VALUES])
  })

  it('reports a subset of the contract statuses, minus the polling-only one', () => {
    for (const status of TASK_RESULT_STATUS_VALUES) {
      expect(CONTRACT.contract_json.valid_status_values).toContain(status)
    }
    // `polling_timed_out` is produced only by the original's 5s polling loop, which the port
    // does not have — the Agent tool blocks until the subagent returns.
    expect([...TASK_RESULT_STATUS_VALUES]).not.toContain('polling_timed_out')
    expect(
      SUBAGENT_STATUS_VALUES.filter((status) => !(TASK_RESULT_STATUS_VALUES as readonly string[]).includes(status)),
    ).toEqual(['polling_timed_out'])
  })

  it('excludes subagent_limit_capped — a dispatcher reason, not a subagent one', () => {
    expect([...TASK_RESULT_STOP_REASON_VALUES]).not.toContain('subagent_limit_capped')
    expect(DEEP_RUN_TASK_RESULT_SCHEMA.properties.stop_reason.enum).not.toContain('subagent_limit_capped')
  })
})

describe('DEEP_RUN_TASK_RESULT_SCHEMA', () => {
  it('mirrors the contract enums into the JSON Schema', () => {
    expect(DEEP_RUN_TASK_RESULT_SCHEMA.properties.status.enum).toEqual([...TASK_RESULT_STATUS_VALUES])
    expect(DEEP_RUN_TASK_RESULT_SCHEMA.properties.stop_reason.enum).toEqual([
      ...TASK_RESULT_STOP_REASON_VALUES,
      null,
    ])
  })

  it('requires status and result, and leaves the optional fields optional', () => {
    expect(DEEP_RUN_TASK_RESULT_SCHEMA.required).toEqual(['status', 'result'])
    expect(DEEP_RUN_TASK_RESULT_SCHEMA.additionalProperties).toBe(false)
    expect(Object.keys(DEEP_RUN_TASK_RESULT_SCHEMA.properties)).toEqual([
      'status',
      'result',
      'stop_reason',
      'files_produced',
    ])
  })

  it('types files_produced as a string array', () => {
    expect(DEEP_RUN_TASK_RESULT_SCHEMA.properties.files_produced.type).toBe('array')
    expect(DEEP_RUN_TASK_RESULT_SCHEMA.properties.files_produced.items.type).toBe('string')
  })
})

describe('DEEP_RUN_PLAN_SCHEMA', () => {
  it('constrains subagent_type to the registered agent types', () => {
    expect(DEEP_RUN_PLAN_SCHEMA.properties.tasks.items.properties.subagent_type.enum).toEqual([...DEEP_RUN_AGENT_TYPES])
    expect([...DEEP_RUN_AGENT_TYPES]).toEqual(['deerflow-general-purpose', 'deerflow-bash'])
  })

  it('requires the three task-tool arguments', () => {
    expect(DEEP_RUN_PLAN_SCHEMA.properties.tasks.items.required).toEqual(['description', 'prompt', 'subagent_type'])
  })
})

describe('DEEP_RUN_DELEGATION_POLICY', () => {
  it('names the ported agent types, not the original ones', () => {
    expect(DEEP_RUN_DELEGATION_POLICY).toContain('**deerflow-general-purpose**')
    expect(DEEP_RUN_DELEGATION_POLICY).toContain('**deerflow-bash**')
    expect(DEEP_RUN_DELEGATION_POLICY).not.toContain('AioSandboxProvider')
    expect(DEEP_RUN_DELEGATION_POLICY).not.toContain('config.yaml')
    expect(DEEP_RUN_DELEGATION_POLICY).not.toContain('ALWAYS PROVIDE THIS PARAMETER')
  })

  it('keeps the policy sections that carry the delegation judgement', () => {
    for (const heading of [
      'Useful benefits are:',
      'When to use this tool:',
      'When NOT to use this tool:',
      'Costs to include in the delegation decision:',
    ]) {
      expect(DEEP_RUN_DELEGATION_POLICY).toContain(heading)
    }
  })

  it('matches the golden description on every non-substituted line', () => {
    const golden = readFileSync(
      fileURLToPath(new URL('../../parity/baseline/prompt_renders/task_tool_description.txt', import.meta.url)),
      'utf8',
    )
    const body = golden.split('# ---8<--- render begins on the next line ---8<---\n')[1] ?? ''
    // Lines the substitutions did not touch must survive verbatim.
    for (const line of [
      '- Material wall-clock savings from independent parallel work',
      '- Specialist tools, skills, models, or domain instructions',
      '- Parallel work with overlapping files, shared mutable state, or external side effects',
      '- Repeating the same repository discovery in multiple contexts',
      '- Any task the parent can complete more cheaply with direct tools',
    ]) {
      expect(body).toContain(line)
      expect(DEEP_RUN_DELEGATION_POLICY).toContain(line)
    }
  })
})

describe('normalizeTaskResult', () => {
  it('passes a well-formed result through', () => {
    expect(
      normalizeTaskResult(
        { status: 'completed', result: 'done', stop_reason: 'turn_capped', files_produced: ['outputs/a.md'] },
        SENTINEL,
      ),
    ).toEqual({ status: 'completed', result: 'done', stop_reason: 'turn_capped', files_produced: ['outputs/a.md'] })
  })

  it.each([[null], [undefined], ['a string'], [[1, 2]], [42]])(
    'maps a non-object agent return (%s) to failed + the sentinel',
    (raw) => {
      expect(normalizeTaskResult(raw, SENTINEL)).toEqual({ status: 'failed', result: SENTINEL, stop_reason: null })
    },
  )

  it('normalizes an out-of-contract status to failed rather than throwing', () => {
    expect(normalizeTaskResult({ status: 'polling_timed_out', result: 'x' }, SENTINEL)).toMatchObject({
      status: 'failed',
      result: 'x',
    })
    expect(normalizeTaskResult({ status: 'nonsense', result: 'x' }, SENTINEL)).toMatchObject({ status: 'failed' })
  })

  it('drops an out-of-contract stop_reason to null', () => {
    expect(
      normalizeTaskResult({ status: 'completed', result: 'x', stop_reason: 'subagent_limit_capped' }, SENTINEL)
        .stop_reason,
    ).toBeNull()
  })

  it('substitutes the sentinel for an empty failed result but not an empty completed one', () => {
    expect(normalizeTaskResult({ status: 'failed', result: '' }, SENTINEL).result).toBe(SENTINEL)
    expect(normalizeTaskResult({ status: 'completed', result: '' }, SENTINEL).result).toBe('')
  })

  it('filters non-string entries out of files_produced', () => {
    expect(
      normalizeTaskResult({ status: 'completed', result: 'x', files_produced: ['a', 3, null, 'b'] }, SENTINEL)
        .files_produced,
    ).toEqual(['a', 'b'])
  })
})
