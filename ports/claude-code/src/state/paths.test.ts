// Unit tests for state-root resolution and the thread-id contract.
// The thread-id pattern is the original's, verbatim
// (backend/packages/harness/deerflow/utils/thread_id.py:THREAD_ID_PATTERN @ 0950924).
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  InvalidThreadIdError,
  THREAD_ID_PATTERN,
  resolveProjectRoot,
  stateRoot,
  threadRunsDir,
  threadStateDir,
  threadStateFile,
  validateThreadId,
} from './paths.js'

describe('thread id validation', () => {
  it('accepts the documented character set and length range', () => {
    for (const id of ['a', 'A', '0', 'thread-1', 'thread_1', 'a'.repeat(64)]) {
      expect(validateThreadId(id)).toBe(id)
    }
  })

  it('rejects anything the persistence and filesystem backends could not key on', () => {
    for (const id of ['', 'a'.repeat(65), '../escape', 'a/b', 'a.b', 'thread id', 'thréad', 'a\n']) {
      expect(() => validateThreadId(id), JSON.stringify(id)).toThrow(InvalidThreadIdError)
    }
  })

  it('rejects non-string input', () => {
    expect(() => validateThreadId(undefined)).toThrow(InvalidThreadIdError)
    expect(() => validateThreadId(42)).toThrow(InvalidThreadIdError)
  })

  it('pins the pattern itself', () => {
    expect(THREAD_ID_PATTERN.source).toBe('^[A-Za-z0-9_-]{1,64}$')
  })
})

describe('state root resolution', () => {
  it('prefers CLAUDE_PROJECT_DIR over the working directory', () => {
    expect(resolveProjectRoot({ CLAUDE_PROJECT_DIR: '/proj' })).toBe('/proj')
    expect(stateRoot({ CLAUDE_PROJECT_DIR: '/proj' })).toBe(join('/proj', '.deerflow', 'state'))
  })

  it('falls back to the working directory when the variable is absent or empty', () => {
    expect(resolveProjectRoot({})).toBe(process.cwd())
    expect(resolveProjectRoot({ CLAUDE_PROJECT_DIR: '' })).toBe(process.cwd())
  })

  it('keys the state directory on a validated thread id', () => {
    const env = { CLAUDE_PROJECT_DIR: '/proj' }
    expect(threadStateDir('t-1', env)).toBe(join('/proj', '.deerflow', 'state', 't-1'))
    expect(threadStateFile('t-1', 'goal.json', env)).toBe(join('/proj', '.deerflow', 'state', 't-1', 'goal.json'))
    expect(threadRunsDir('t-1', env)).toBe(join('/proj', '.deerflow', 'state', 't-1', 'runs'))
    expect(() => threadStateDir('../etc', env)).toThrow(InvalidThreadIdError)
  })

  it('refuses a state file name that could escape the thread directory', () => {
    const env = { CLAUDE_PROJECT_DIR: '/proj' }
    for (const name of ['', '../goal.json', 'sub/goal.json', 'a\\b']) {
      expect(() => threadStateFile('t-1', name, env), JSON.stringify(name)).toThrow(/Invalid state file name/)
    }
  })
})
