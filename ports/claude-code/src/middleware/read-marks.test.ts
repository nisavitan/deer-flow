// Covers src/middleware/read-marks.ts against the invariants of
// backend/packages/harness/deerflow/agents/middlewares/read_before_write_middleware.py @ 0950924.
//
// No frozen vectors exist for this middleware (it is outside the baseline's G1-G7 set), so the
// assertions are written from the source's own contract, one test per invariant it states:
// newest-mark-must-match-current, writes-never-refresh, missing-file-allows, fail-open-on-unreadable,
// path normalization, and the verbatim block message.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  MAX_TRACKED_MARKS,
  applyReadMark,
  blockMessage,
  checkWriteGate,
  contentHash,
  hashFileIfReadable,
  latestMarkHash,
  loadReadMarks,
  normalizeMarkPath,
  parseReadMarks,
  readMarksPath,
  stampReadMark,
  type ReadMark,
} from './read-marks.js'

const NOW = '2026-08-01T00:00:00.000Z'
let root: string
let env: NodeJS.ProcessEnv

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'deerflow-read-marks-'))
  env = { CLAUDE_PROJECT_DIR: root }
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function writeFixture(name: string, content: string): string {
  const filePath = join(root, name)
  mkdirSync(join(filePath, '..'), { recursive: true })
  writeFileSync(filePath, content, 'utf8')
  return filePath
}

function mark(path: string, hash: string, at = NOW): ReadMark {
  return { path: normalizeMarkPath(path), hash, at }
}

describe('read marks — hashing and path normalization', () => {
  it('hashes the full content with sha256', () => {
    // Pinned against `hashlib.sha256(b"hello").hexdigest()`.
    expect(contentHash('hello')).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
  })

  it('normalizes a path the way posixpath.normpath does', () => {
    expect(normalizeMarkPath('/a/b/../c')).toBe('/a/c')
    expect(normalizeMarkPath('/a//b/')).toBe('/a/b')
    expect(normalizeMarkPath('./a/./b')).toBe('a/b')
    expect(normalizeMarkPath('')).toBe('.')
    expect(normalizeMarkPath('//a/b')).toBe('//a/b')
  })

  it('reads a real file and refuses an unreadable one without throwing', () => {
    const filePath = writeFixture('notes.md', 'line one\n')
    expect(hashFileIfReadable(filePath)).toBe(contentHash('line one\n'))
    expect(hashFileIfReadable(join(root, 'absent.md'))).toBeNull()
  })

  it('treats an error-string read channel as uninspectable (fail open, no mark)', () => {
    const filePath = writeFixture('sandboxed.md', 'Error: sandbox refused the read')
    expect(hashFileIfReadable(filePath)).toBeNull()
  })
})

describe('read marks — the gate', () => {
  it('allows a write when the newest mark matches the current hash', () => {
    const hash = contentHash('body')
    expect(
      checkWriteGate({ toolName: 'Write', path: '/repo/a.md', currentHash: hash, marks: [mark('/repo/a.md', hash)] }),
    ).toEqual({ allowed: true })
  })

  it('denies a write to an existing file with no mark at all', () => {
    const decision = checkWriteGate({
      toolName: 'Write',
      path: '/repo/a.md',
      currentHash: contentHash('body'),
      marks: [],
    })
    expect(decision.allowed).toBe(false)
    expect(decision.allowed === false && decision.reason).toBe(blockMessage('Write', '/repo/a.md'))
  })

  it('denies a write when the file changed after the read (stale mark)', () => {
    const decision = checkWriteGate({
      toolName: 'Edit',
      path: '/repo/a.md',
      currentHash: contentHash('body v2'),
      marks: [mark('/repo/a.md', contentHash('body v1'))],
    })
    expect(decision.allowed).toBe(false)
    expect(decision.allowed === false && decision.reason).toContain('already exists and you have not read its current version')
  })

  it('allows creation of a file that does not exist (fail-open, no mark needed)', () => {
    expect(checkWriteGate({ toolName: 'Write', path: '/repo/new.md', currentHash: null, marks: [] })).toEqual({
      allowed: true,
    })
  })

  it('matches a mark through path normalization, not raw string equality', () => {
    const hash = contentHash('body')
    expect(
      checkWriteGate({
        toolName: 'Write',
        path: '/repo/./sub/../a.md',
        currentHash: hash,
        marks: [mark('/repo/a.md', hash)],
      }),
    ).toEqual({ allowed: true })
  })

  it('quotes the path back exactly as requested, not normalized', () => {
    const decision = checkWriteGate({
      toolName: 'Write',
      path: './relative/a.md',
      currentHash: contentHash('x'),
      marks: [],
    })
    expect(decision.allowed === false && decision.reason).toContain('./relative/a.md')
  })
})

describe('read marks — the store', () => {
  it('keeps only the newest mark per path and consults it', () => {
    let marks: ReadMark[] = []
    marks = stampReadMark(marks, mark('/a.md', 'h1', '2026-08-01T00:00:00.000Z'))
    marks = stampReadMark(marks, mark('/b.md', 'h2', '2026-08-01T00:00:01.000Z'))
    marks = stampReadMark(marks, mark('/a.md', 'h3', '2026-08-01T00:00:02.000Z'))
    expect(marks).toHaveLength(2)
    expect(latestMarkHash(marks, '/a.md')).toBe('h3')
    expect(latestMarkHash(marks, '/b.md')).toBe('h2')
    expect(latestMarkHash(marks, '/missing.md')).toBeNull()
  })

  it('evicts oldest-first at the tracked-mark cap', () => {
    let marks: ReadMark[] = []
    for (let index = 0; index < MAX_TRACKED_MARKS + 5; index += 1) {
      marks = stampReadMark(marks, mark(`/f${index}.md`, `h${index}`))
    }
    expect(marks).toHaveLength(MAX_TRACKED_MARKS)
    expect(latestMarkHash(marks, '/f0.md')).toBeNull()
    expect(latestMarkHash(marks, `/f${MAX_TRACKED_MARKS + 4}.md`)).toBe(`h${MAX_TRACKED_MARKS + 4}`)
  })

  it('persists and reloads marks through the atomic state file', () => {
    const filePath = readMarksPath('thread-a', env)
    applyReadMark(filePath, mark('/repo/a.md', 'h1'), { now: NOW })
    applyReadMark(filePath, mark('/repo/b.md', 'h2'), { now: NOW })
    const reloaded = loadReadMarks(filePath)
    expect(reloaded.map((entry) => entry.path)).toEqual(['/repo/a.md', '/repo/b.md'])
    expect(latestMarkHash(reloaded, '/repo/a.md')).toBe('h1')
  })

  it('a write never refreshes a mark — only a fresh read reopens the gate', () => {
    const filePath = writeFixture('doc.md', 'v1')
    const marksFile = readMarksPath('thread-b', env)
    applyReadMark(marksFile, mark(filePath, contentHash('v1')), { now: NOW })

    // The write lands; the file's hash moves. No new mark is stamped by the write path.
    writeFileSync(filePath, 'v2', 'utf8')
    const afterWrite = checkWriteGate({
      toolName: 'Edit',
      path: filePath,
      currentHash: hashFileIfReadable(filePath),
      marks: loadReadMarks(marksFile),
    })
    expect(afterWrite.allowed).toBe(false)

    // Only a fresh read re-opens the gate.
    applyReadMark(marksFile, mark(filePath, contentHash('v2')), { now: NOW })
    expect(
      checkWriteGate({
        toolName: 'Edit',
        path: filePath,
        currentHash: hashFileIfReadable(filePath),
        marks: loadReadMarks(marksFile),
      }),
    ).toEqual({ allowed: true })
  })

  it('degrades a corrupt or foreign store to "no marks", never to an exception', () => {
    expect(parseReadMarks(null)).toEqual([])
    expect(parseReadMarks({ marks: 'nope' })).toEqual([])
    expect(parseReadMarks({ marks: [{ path: '/a' }, { path: '/b', hash: 'h' }, 7] })).toEqual([
      { path: '/b', hash: 'h', at: '' },
    ])

    const filePath = readMarksPath('thread-c', env)
    mkdirSync(join(filePath, '..'), { recursive: true })
    writeFileSync(filePath, '{ not json', 'utf8')
    expect(loadReadMarks(filePath)).toEqual([])
    expect(loadReadMarks(join(root, 'nowhere', 'read-marks.json'))).toEqual([])
  })
})
