// The adapter is behaviour, not glue: if `Read` did not become `read_file` the loop detector would
// silently stop bucketing ranged reads, and if `file_path` did not become `path` the salient-field
// rule would find nothing and fall back to hashing full args. Both failures are invisible at
// runtime — no error, just a guard that never fires — so they are asserted here as HASH outcomes,
// not as shapes.
import { describe, expect, it } from 'vitest'

import { hashToolCalls, stableToolKey } from './loop-detection.js'
import {
  GATED_WRITE_TOOL_NAMES,
  GUARDED_TOOL_NAMES,
  isGuardedToolName,
  toDeerflowMetaToolName,
  toDeerflowToolCall,
} from './tool-adapter.js'

describe('tool adapter — which tools are guarded', () => {
  it('guards the work tools and every MCP tool', () => {
    for (const name of ['Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch']) {
      expect(isGuardedToolName(name), name).toBe(true)
      expect(GUARDED_TOOL_NAMES.has(name)).toBe(true)
    }
    expect(isGuardedToolName('mcp__github__list_issues')).toBe(true)
  })

  it('leaves the harness control surface alone', () => {
    for (const name of ['Agent', 'Task', 'TaskCreate', 'TaskUpdate', 'AskUserQuestion', 'Skill', 'Workflow', '', null]) {
      expect(isGuardedToolName(name), String(name)).toBe(false)
    }
  })

  it('gates exactly the two write tools', () => {
    expect([...GATED_WRITE_TOOL_NAMES].sort()).toEqual(['Edit', 'Write'])
  })
})

describe('tool adapter — argument mapping keeps the key rules alive', () => {
  it('maps Read onto read_file so the 200-line bucketing applies', () => {
    const call = toDeerflowToolCall('Read', { file_path: '/repo/a.ts', offset: 1, limit: 100 })
    expect(call.name).toBe('read_file')
    // offset+limit-1 = the inclusive end line the original's read_file took.
    expect(call.args).toEqual({ path: '/repo/a.ts', start_line: 1, end_line: 100 })
    // Two reads inside the same 200-line bucket collapse to one hash; a far range does not.
    const near = toDeerflowToolCall('Read', { file_path: '/repo/a.ts', offset: 50, limit: 100 })
    const far = toDeerflowToolCall('Read', { file_path: '/repo/a.ts', offset: 900, limit: 100 })
    expect(hashToolCalls([call])).toBe(hashToolCalls([near]))
    expect(hashToolCalls([call])).not.toBe(hashToolCalls([far]))
  })

  it('reads the whole file as bucket 0 when offset/limit are absent', () => {
    expect(toDeerflowToolCall('Read', { file_path: '/repo/a.ts' }).args).toEqual({ path: '/repo/a.ts' })
    expect(stableToolKey('read_file', { path: '/repo/a.ts' }, null)).toBe('/repo/a.ts:0-0')
  })

  it('maps Write and Edit onto the content-sensitive tools', () => {
    const write = toDeerflowToolCall('Write', { file_path: '/repo/a.md', content: 'one' })
    expect(write.name).toBe('write_file')
    // Content-sensitive: rewriting the same path with different bytes is iteration, not a loop.
    expect(hashToolCalls([write])).not.toBe(
      hashToolCalls([toDeerflowToolCall('Write', { file_path: '/repo/a.md', content: 'two' })]),
    )

    const edit = toDeerflowToolCall('Edit', { file_path: '/repo/a.md', old_string: 'x', new_string: 'y' })
    expect(edit).toEqual({ name: 'str_replace', args: { path: '/repo/a.md', old_str: 'x', new_str: 'y' } })
    expect(hashToolCalls([edit])).not.toBe(
      hashToolCalls([toDeerflowToolCall('Edit', { file_path: '/repo/a.md', old_string: 'x', new_string: 'z' })]),
    )
  })

  it('maps the search and network tools onto their salient fields', () => {
    expect(toDeerflowToolCall('Bash', { command: 'npm test' })).toEqual({ name: 'bash', args: { command: 'npm test' } })
    expect(toDeerflowToolCall('Grep', { pattern: 'TODO', path: '/src' })).toEqual({
      name: 'grep',
      args: { pattern: 'TODO', path: '/src' },
    })
    expect(toDeerflowToolCall('Glob', { pattern: '**/*.ts' })).toEqual({ name: 'glob', args: { pattern: '**/*.ts' } })
    expect(toDeerflowToolCall('WebFetch', { url: 'https://x' })).toEqual({ name: 'web_fetch', args: { url: 'https://x' } })
    expect(toDeerflowToolCall('WebSearch', { query: 'q' })).toEqual({ name: 'web_search', args: { query: 'q' } })
  })

  it('ignores incidental Grep arguments that are not salient', () => {
    const a = toDeerflowToolCall('Grep', { pattern: 'TODO', path: '/src', output_mode: 'content', '-n': true })
    const b = toDeerflowToolCall('Grep', { pattern: 'TODO', path: '/src', output_mode: 'files_with_matches' })
    expect(hashToolCalls([a])).toBe(hashToolCalls([b]))
  })

  it('passes an MCP tool through with its own name and args', () => {
    const call = toDeerflowToolCall('mcp__gh__search', { query: 'repo:x' })
    expect(call).toEqual({ name: 'mcp__gh__search', args: { query: 'repo:x' } })
  })

  it('survives a missing or wrongly-typed tool_input', () => {
    expect(toDeerflowToolCall('Read', undefined).args).toEqual({})
    expect(toDeerflowToolCall('Bash', 'not an object').args).toEqual({})
    expect(toDeerflowToolCall('Read', { file_path: 42 }).args).toEqual({})
  })
})

describe('tool adapter — meta tool names', () => {
  it('renames only WebFetch, which is the one name the taxonomy branches on', () => {
    expect(toDeerflowMetaToolName('WebFetch')).toBe('web_fetch')
    expect(toDeerflowMetaToolName('Bash')).toBe('Bash')
    expect(toDeerflowMetaToolName('mcp__x__y')).toBe('mcp__x__y')
  })
})
