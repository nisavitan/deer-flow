// Vector-driven parity tests for the subagent result formatter.
// Source of truth: parity/baseline/subagent_status_contract.json, extracted by executing
// deerflow.subagents.status_contract:format_subagent_result_message and
// :make_subagent_additional_kwargs at commit 0950924 over every status x stop_reason x
// input-shape combination (60 rows).
// The test iterates the vector file rather than hard-coding expectations, so a render the
// extractor adds later fails here instead of passing silently.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  SUBAGENT_METADATA_TEXT_MAX_CHARS,
  boundMetadataText,
  formatSubagentResultMessage,
  makeSubagentAdditionalKwargs,
  normalizeTokenUsage,
} from './result-format.js'
import {
  SUBAGENT_STATUS_VALUES,
  SUBAGENT_STOP_REASON_VALUES,
  SubagentContractValueError,
  type SubagentStatus,
  type SubagentStopReason,
} from '../policy/stop-reason.js'

interface RenderVector {
  status: SubagentStatus
  stop_reason: SubagentStopReason | null
  input_shape: string
  result: string | null
  error: string | null
  model_visible_content: string
  metadata_error: string | null
  additional_kwargs: Record<string, unknown>
}

interface ContractVectors {
  contract_json: {
    version: number
    valid_status_values: string[]
    valid_stop_reason_values: string[]
  }
  result_message_formats: RenderVector[]
  status_values: string[]
  stop_reason_values: string[]
}

const VECTORS: ContractVectors = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../parity/baseline/subagent_status_contract.json', import.meta.url)), 'utf8'),
) as ContractVectors

const label = (vector: RenderVector): string =>
  `${vector.status} / ${vector.stop_reason ?? 'no-cap'} / ${vector.input_shape}`

describe('contract enums', () => {
  it('pins the status vocabulary against the fixture', () => {
    expect([...SUBAGENT_STATUS_VALUES]).toEqual(VECTORS.contract_json.valid_status_values)
    expect([...SUBAGENT_STATUS_VALUES]).toEqual(VECTORS.status_values)
  })

  it('pins the stop-reason vocabulary against the fixture', () => {
    expect([...SUBAGENT_STOP_REASON_VALUES]).toEqual(VECTORS.contract_json.valid_stop_reason_values)
    expect([...SUBAGENT_STOP_REASON_VALUES]).toEqual(VECTORS.stop_reason_values)
  })

  it('covers the full status x stop_reason x shape cross-product', () => {
    // 5 statuses x (3 caps + no cap) x 3 input shapes.
    expect(VECTORS.result_message_formats).toHaveLength(60)
  })
})

describe('formatSubagentResultMessage — golden renders', () => {
  for (const vector of VECTORS.result_message_formats) {
    it(`renders ${label(vector)} byte-exactly`, () => {
      const formatted = formatSubagentResultMessage(vector.status, {
        result: vector.result,
        error: vector.error,
        stopReason: vector.stop_reason,
      })
      expect(formatted.modelVisibleContent).toBe(vector.model_visible_content)
      expect(formatted.metadataError).toBe(vector.metadata_error)
    })
  }
})

describe('makeSubagentAdditionalKwargs — golden metadata', () => {
  for (const vector of VECTORS.result_message_formats) {
    it(`stamps ${label(vector)}`, () => {
      const kwargs = makeSubagentAdditionalKwargs(vector.status, {
        result: vector.result,
        error: vector.error,
        stopReason: vector.stop_reason,
      })
      expect(kwargs).toEqual(vector.additional_kwargs)
    })
  }

  it('rejects an out-of-contract status at the producer boundary', () => {
    expect(() => makeSubagentAdditionalKwargs('max_turns_reached' as SubagentStatus)).toThrow(SubagentContractValueError)
  })

  it('rejects an out-of-contract stop_reason at the producer boundary', () => {
    expect(() =>
      makeSubagentAdditionalKwargs('completed', { stopReason: 'subagent_limit_capped' as SubagentStopReason }),
    ).toThrow(SubagentContractValueError)
  })

  it('drops a blank error rather than stamping subagent_error: ""', () => {
    expect(makeSubagentAdditionalKwargs('failed', { error: '   ' })).toEqual({ subagent_status: 'failed' })
  })

  it('never stamps a result brief for a non-completed status', () => {
    const kwargs = makeSubagentAdditionalKwargs('timed_out', { result: 'partial work' })
    expect(kwargs['subagent_result_brief']).toBeUndefined()
    expect(kwargs['subagent_result_sha256']).toBeUndefined()
  })

  it('hashes the FULL result even when the brief is truncated', () => {
    const long = 'x'.repeat(SUBAGENT_METADATA_TEXT_MAX_CHARS + 500)
    const kwargs = makeSubagentAdditionalKwargs('completed', { result: long })
    // sha256 of 2500 'x' characters — the full text, not the 2000-char brief.
    expect(kwargs['subagent_result_sha256']).toBe(
      '63939713c3d57421ab73577dd6d5cb07699deae2ee98de3ada79a5197aa6b915',
    )
    expect((kwargs['subagent_result_brief'] as string).length).toBeLessThanOrEqual(SUBAGENT_METADATA_TEXT_MAX_CHARS)
  })

  it('stamps model name and normalized token usage when supplied', () => {
    expect(
      makeSubagentAdditionalKwargs('completed', {
        result: 'ok',
        modelName: '  gpt-x  ',
        tokenUsage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
      }),
    ).toMatchObject({
      subagent_model_name: 'gpt-x',
      subagent_token_usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
    })
  })
})

describe('boundMetadataText', () => {
  it('returns stripped text under the cap unchanged', () => {
    expect(boundMetadataText('  hello  ')).toBe('hello')
  })

  it('middle-truncates with a head of 2/3 and a tail of the remainder', () => {
    const text = 'a'.repeat(60) + 'b'.repeat(60)
    const bounded = boundMetadataText(text, 30)
    // cap 30 -> head 20, marker 5, tail 5.
    expect(bounded).toBe('a'.repeat(20) + '\n...\n' + 'b'.repeat(5))
  })

  it('falls back to a head slice when the cap cannot fit the marker', () => {
    expect(boundMetadataText('abcdefghij', 4)).toBe('abcd')
  })

  it('slices by code points so a surrogate pair is never split', () => {
    // cap 12 -> head 8, tail 12-8-5 = -1 <= 0, so the head-slice fallback applies. Sliced by
    // code points it is 12 whole emoji; a UTF-16 slice would cut the 6th one in half and
    // leave a lone surrogate.
    const bounded = boundMetadataText('😀'.repeat(40), 12)
    expect(bounded).toBe('😀'.repeat(12))
    expect([...bounded]).toHaveLength(12)

    // Middle-truncation over astral text keeps whole code points on both sides of the marker.
    const middle = boundMetadataText('😀'.repeat(40), 30)
    expect(middle).toBe('😀'.repeat(20) + '\n...\n' + '😀'.repeat(5))
  })
})

describe('normalizeTokenUsage', () => {
  it('accepts a well-formed cumulative snapshot', () => {
    expect(normalizeTokenUsage({ input_tokens: 0, output_tokens: 5, total_tokens: 5 })).toEqual({
      input_tokens: 0,
      output_tokens: 5,
      total_tokens: 5,
    })
  })

  it.each([
    ['a missing key', { input_tokens: 1, output_tokens: 2 }],
    ['a negative count', { input_tokens: -1, output_tokens: 2, total_tokens: 1 }],
    ['a non-integer count', { input_tokens: 1.5, output_tokens: 2, total_tokens: 3 }],
    ['a boolean count', { input_tokens: true, output_tokens: 2, total_tokens: 3 }],
    ['a non-mapping', 'nope'],
    ['null', null],
    ['an array', [1, 2, 3]],
  ])('rejects %s', (_name, value) => {
    expect(normalizeTokenUsage(value)).toBeNull()
  })
})
