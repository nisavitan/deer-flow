// Parity suite G3 — replays parity/baseline/tool_meta.json against src/middleware/tool-meta.ts.
//
// Every one of the 38 `normalize_tool_result_cases` and 4 `stamp_exception_meta_cases` is asserted
// as a WHOLE meta object (`toEqual`), not field by field: a port that got `status` right and
// `recommended_next_action` wrong would still hand the model the wrong instruction.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  ERROR_RULES,
  asStatusLine,
  classifyErrorShell,
  extractJsonErrorText,
  isProblemMeta,
  normalizeToolResult,
  stampExceptionMeta,
  type ToolResultMeta,
} from './tool-meta.js'

interface NormalizeCase {
  readonly name: string
  readonly input: {
    readonly tool_name: string
    readonly content: string
    readonly status: 'success' | 'error'
    readonly pre_existing_meta: ToolResultMeta | null
  }
  readonly deerflow_tool_meta: ToolResultMeta
}

interface ExceptionCase {
  readonly name: string
  readonly input: { readonly exc_info: string }
  readonly deerflow_tool_meta: ToolResultMeta
}

const BASELINE = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../parity/baseline/tool_meta.json', import.meta.url)), 'utf8'),
) as {
  readonly normalize_tool_result_cases: NormalizeCase[]
  readonly stamp_exception_meta_cases: ExceptionCase[]
}

describe('tool meta — normalize_tool_result (38 baseline cases)', () => {
  it.each(BASELINE.normalize_tool_result_cases.map((testCase) => [testCase.name, testCase] as const))(
    '%s',
    (_name, testCase) => {
      expect(
        normalizeToolResult({
          toolName: testCase.input.tool_name,
          content: testCase.input.content,
          status: testCase.input.status,
          preExistingMeta: testCase.input.pre_existing_meta,
        }),
      ).toEqual(testCase.deerflow_tool_meta)
    },
  )

  it('consumed all 38 recorded cases', () => {
    expect(BASELINE.normalize_tool_result_cases).toHaveLength(38)
  })
})

describe('tool meta — stamp_exception_meta (4 baseline cases)', () => {
  it.each(BASELINE.stamp_exception_meta_cases.map((testCase) => [testCase.name, testCase] as const))(
    '%s',
    (_name, testCase) => {
      expect(stampExceptionMeta(testCase.input.exc_info)).toEqual(testCase.deerflow_tool_meta)
    },
  )

  it('consumed all 4 recorded cases', () => {
    expect(BASELINE.stamp_exception_meta_cases).toHaveLength(4)
  })
})

describe('tool meta — taxonomy shape', () => {
  it('ships all eight error types in the original order', () => {
    expect(ERROR_RULES.map(([, attributes]) => attributes.error_type)).toEqual([
      'auth',
      'rate_limited',
      'transient',
      'config',
      'permission',
      'no_results',
      'not_found',
      'internal',
    ])
  })

  it('classifies a non-string content as an empty success, never a crash', () => {
    expect(normalizeToolResult({ toolName: 'generic_tool', content: { blocks: [] }, status: 'success' })).toEqual({
      status: 'success',
      error_type: null,
      recoverable_by_model: true,
      recommended_next_action: 'continue',
      source: 'content_analysis',
    })
  })

  it('flags error and partial_success as problems, success as not', () => {
    const meta = (status: 'success' | 'error'): ToolResultMeta =>
      normalizeToolResult({ toolName: 'generic_tool', content: status === 'error' ? 'Error: 401' : 'fine', status })
    expect(isProblemMeta(meta('error'))).toBe(true)
    expect(isProblemMeta(meta('success'))).toBe(false)
    expect(
      isProblemMeta(normalizeToolResult({ toolName: 'generic_tool', content: 'truncated', status: 'success' })),
    ).toBe(true)
  })
})

describe('tool meta — helpers the case matrix exercises only indirectly', () => {
  it('treats every semantic-zero error string as no error', () => {
    for (const sentinel of ['none', 'NULL', ' False ', 'no', 'OK', 'success', 'n/a', '']) {
      expect(extractJsonErrorText(`{"error": ${JSON.stringify(sentinel)}}`)).toBeNull()
    }
  })

  it('serializes a non-string error value the way json.dumps would', () => {
    expect(extractJsonErrorText('{"error": 404}')).toBe('404')
    expect(extractJsonErrorText('{"error": ["a", "b"]}')).toBe('["a", "b"]')
    expect(extractJsonErrorText('not json at all')).toBeNull()
  })

  it('reduces status-line titles but keeps documents intact', () => {
    expect(asStatusLine('404 Not Found')).toBe('not found')
    expect(asStatusLine('HTTP Error 404 - Not Found')).toBe('not found')
    expect(asStatusLine('404 - File or directory not found.')).toBe('not found')
    expect(asStatusLine('404 Ways to Cook Rice')).toBe('ways to cook rice')
    expect(asStatusLine('404')).toBeNull()
  })

  it('gates the error-shell rule on the tool name, not the content', () => {
    expect(classifyErrorShell('web_fetch', '# 404 Not Found\nnginx')).not.toBeNull()
    expect(classifyErrorShell('read_file', '# 404 Not Found\nnginx')).toBeNull()
  })
})
