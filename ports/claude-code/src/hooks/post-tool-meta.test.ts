import { describe, expect, it } from 'vitest'

import { DISABLE_ENV_VAR, NEXT_ACTION_GUIDANCE, OVERSIZED_RESULT_CHARS, evaluateToolResult } from './post-tool-meta.js'
import { TOOL_META_KEY } from '../middleware/tool-meta.js'

const env: NodeJS.ProcessEnv = {}

function fire(toolName: string, toolResponse: unknown): ReturnType<typeof evaluateToolResult> {
  return evaluateToolResult({ tool_name: toolName, tool_response: toolResponse }, { env })
}

describe('post-tool meta — silence on the happy path', () => {
  it('says nothing about a clean result', () => {
    expect(fire('Bash', { stdout: 'all tests passed' })).toBeNull()
    expect(fire('Read', 'file contents')).toBeNull()
  })

  it('says nothing about an unguarded tool, even a failing one', () => {
    expect(fire('Agent', { is_error: true, content: 'permission denied' })).toBeNull()
  })

  it('honours the disable switch', () => {
    expect(
      evaluateToolResult(
        { tool_name: 'Bash', tool_response: { is_error: true, stderr: 'permission denied' } },
        { env: { [DISABLE_ENV_VAR]: '1' } },
      ),
    ).toBeNull()
  })
})

describe('post-tool meta — the classification the model receives', () => {
  it('carries the full taxonomy JSON plus the next-action guidance', () => {
    const output = fire('Bash', { is_error: true, stderr: 'permission denied: /etc/shadow' })
    const context = output?.additionalContext ?? ''
    expect(context).toContain(`<${TOOL_META_KEY} tool="Bash">`)
    expect(context).toContain(
      JSON.stringify({
        status: 'error',
        error_type: 'permission',
        recoverable_by_model: true,
        recommended_next_action: 'try_alternative',
        source: 'tool_return',
      }),
    )
    expect(context).toContain(`Recommended next action: try_alternative — ${NEXT_ACTION_GUIDANCE.try_alternative}`)
    // Recoverable: no "do not retry" line.
    expect(context).not.toContain('not recoverable by the model')
  })

  it('adds the do-not-retry line for a non-recoverable class', () => {
    const context = fire('Bash', { is_error: true, stderr: '401 unauthorized' })?.additionalContext ?? ''
    expect(context).toContain('"error_type":"auth"')
    expect(context).toContain('"recommended_next_action":"stop"')
    expect(context).toContain('not recoverable by the model')
  })

  it('classifies a success-status result whose body is an error (JSON error field)', () => {
    const context = fire('mcp__x__search', '{"error": "rate limit exceeded"}')?.additionalContext ?? ''
    expect(context).toContain('"error_type":"rate_limited"')
    expect(context).toContain('"recommended_next_action":"summarize"')
  })

  it('applies the web_fetch error-shell rule through the tool-name mapping', () => {
    const shell = fire('WebFetch', '404 Not Found\nnginx/1.24.0')?.additionalContext ?? ''
    expect(shell).toContain('"error_type":"not_found"')
    expect(shell).toContain('"source":"content_analysis"')
    // The very same body from a file read is NOT an error shell.
    expect(fire('Read', '404 Not Found\nnginx/1.24.0')).toBeNull()
  })

  it('flags a partial-success result so the model rewrites the query', () => {
    const context = fire('WebSearch', 'no results found for that query')?.additionalContext ?? ''
    expect(context).toContain('"status":"partial_success"')
    expect(context).toContain('Recommended next action: rewrite_query')
  })
})

describe('post-tool meta — oversized results', () => {
  it('warns above the budget even when the result succeeded', () => {
    const context = fire('Bash', { stdout: 'x'.repeat(OVERSIZED_RESULT_CHARS + 1) })?.additionalContext ?? ''
    expect(context).toContain(`past the ${OVERSIZED_RESULT_CHARS}-character budget`)
    // Only the size note — a big successful result is not an error.
    expect(context).not.toContain(TOOL_META_KEY)
  })

  it('stays silent exactly at the budget', () => {
    expect(fire('Bash', { stdout: 'x'.repeat(OVERSIZED_RESULT_CHARS) })).toBeNull()
  })

  it('combines the classification and the size note when both apply', () => {
    const context =
      fire('Bash', { is_error: true, stderr: `no such file or directory\n${'x'.repeat(OVERSIZED_RESULT_CHARS)}` })
        ?.additionalContext ?? ''
    expect(context).toContain('"error_type":"not_found"')
    expect(context).toContain('-character budget')
  })
})
