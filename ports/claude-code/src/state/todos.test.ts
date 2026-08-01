// Unit tests for the todos channel.
// No baseline vector file covers merge_todos; semantics pinned by
// docs/claude-code-port/notes/lead-agent-and-state.md §4 (thread_state.py:110-120 @ 0950924).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyTodos, mergeTodos } from './todos.js'

const NOW = '2026-08-01T12:00:00Z'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'deerflow-todos-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('merge_todos', () => {
  it('preserves existing when the writer did not touch todos', () => {
    const existing = [{ content: 'a', status: 'pending' }]
    expect(mergeTodos(existing, null)).toEqual(existing)
    expect(mergeTodos(existing, undefined)).toEqual(existing)
    expect(mergeTodos(null, null)).toBeNull()
  })

  it('treats an explicit empty list as a real update that replaces', () => {
    expect(mergeTodos([{ content: 'a', status: 'pending' }], [])).toEqual([])
  })

  it('is last-write-wins for a non-empty update', () => {
    expect(mergeTodos([{ content: 'a' }], [{ content: 'b' }])).toEqual([{ content: 'b' }])
  })

  it('never mutates its inputs', () => {
    const existing = [{ content: 'a' }]
    mergeTodos(existing, null)?.push({ content: 'x' })
    expect(existing).toEqual([{ content: 'a' }])
  })
})

describe('todos channel file', () => {
  it('persists the last write under an incrementing rev', () => {
    const file = join(dir, 'todos.json')
    applyTodos(file, [{ content: 'a', status: 'pending' }], { now: NOW })
    const second = applyTodos(file, [{ content: 'a', status: 'completed' }], { now: NOW })
    expect(second.payload.todos).toEqual([{ content: 'a', status: 'completed' }])
    expect(second.rev).toBe(2)

    const preserved = applyTodos(file, null, { now: NOW })
    expect(preserved.payload.todos).toEqual([{ content: 'a', status: 'completed' }])
  })
})
