import { describe, expect, it } from 'vitest'

import {
  flattenToolResponse,
  formatCurrentDate,
  inferResultStatus,
  parseHookPayload,
  renderHookOutput,
  resolveThreadId,
} from './hook-runtime.js'

describe('hook runtime — payload handling', () => {
  it('parses an object payload and rejects everything else', () => {
    expect(parseHookPayload('{"tool_name":"Bash"}')).toEqual({ tool_name: 'Bash' })
    expect(parseHookPayload('')).toBeNull()
    expect(parseHookPayload('[]')).toBeNull()
    expect(parseHookPayload('"a string"')).toBeNull()
    expect(parseHookPayload('{ truncated')).toBeNull()
  })

  it('prefers DEERFLOW_THREAD_ID, falls back to a contract-shaped session id', () => {
    expect(resolveThreadId({ session_id: 'sess-1' }, { DEERFLOW_THREAD_ID: 'thread-a' })).toBe('thread-a')
    expect(resolveThreadId({ session_id: 'sess-1' }, {})).toBe('sess-1')
    // A session id that cannot be a directory name yields null rather than inventing one.
    expect(resolveThreadId({ session_id: '../escape' }, {})).toBeNull()
    expect(resolveThreadId({}, {})).toBeNull()
    expect(resolveThreadId({ session_id: 'sess-1' }, { DEERFLOW_THREAD_ID: 'bad/id' })).toBe('sess-1')
  })
})

describe('hook runtime — output protocol', () => {
  it('emits a deny decision only for PreToolUse', () => {
    expect(renderHookOutput('PreToolUse', { deny: 'nope' })).toBe(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'nope' },
      }),
    )
    // A deny on a PostToolUse event is meaningless and is dropped rather than emitted malformed.
    expect(renderHookOutput('PostToolUse', { deny: 'nope' })).toBeNull()
  })

  it('NEVER emits permissionDecision "allow" — allowing is abstaining', () => {
    const rendered = renderHookOutput('PreToolUse', { additionalContext: 'warning', systemMessage: 'warning' })
    expect(rendered).not.toContain('permissionDecision')
    expect(rendered).toContain('"additionalContext":"warning"')
    expect(rendered).toContain('"systemMessage":"warning"')
  })

  it('writes nothing at all for an empty decision', () => {
    expect(renderHookOutput('PostToolUse', {})).toBeNull()
    expect(renderHookOutput('UserPromptSubmit', { additionalContext: '' })).toBeNull()
  })
})

describe('hook runtime — the current date', () => {
  it('formats exactly as strftime("%Y-%m-%d, %A")', () => {
    // 2026-08-01 is a Saturday.
    expect(formatCurrentDate(new Date(2026, 7, 1, 12, 0, 0))).toBe('2026-08-01, Saturday')
    expect(formatCurrentDate(new Date(2026, 0, 5, 0, 0, 0))).toBe('2026-01-05, Monday')
  })
})

describe('hook runtime — tool responses', () => {
  it('flattens every shape a tool result can arrive in', () => {
    expect(flattenToolResponse('plain')).toBe('plain')
    expect(flattenToolResponse([{ type: 'text', text: 'a' }, 'b'])).toBe('a\nb')
    expect(flattenToolResponse({ stdout: 'out', stderr: 'err' })).toBe('out\nerr')
    expect(flattenToolResponse({ content: [{ type: 'text', text: 'nested' }] })).toBe('nested')
    expect(flattenToolResponse(42)).toBe('')
    expect(flattenToolResponse(null)).toBe('')
  })

  it('infers an error status only from an explicit failure flag', () => {
    expect(inferResultStatus({ is_error: true })).toBe('error')
    expect(inferResultStatus({ isError: true })).toBe('error')
    expect(inferResultStatus({ success: false })).toBe('error')
    expect(inferResultStatus({ interrupted: true })).toBe('error')
    // Erring toward success: a false "error" would tell the model to abandon a tool that worked.
    expect(inferResultStatus({ stdout: 'error: something in the OUTPUT' })).toBe('success')
    expect(inferResultStatus('plain text')).toBe('success')
  })
})
