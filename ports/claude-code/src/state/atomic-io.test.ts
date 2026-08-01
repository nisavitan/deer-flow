// Unit tests for the atomic-write + rev-CAS + schema-version discipline.
// No baseline vector file covers file IO (the original's durability lives in LangGraph);
// these pin the port-side guarantees stated in docs/claude-code-port/state-checkpoint-resume.md
// §2 (never-torn reads), §4 (migrate-or-discard) and guarantee G2 (CAS stand-down).
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  STATE_SCHEMA_VERSION,
  StateFileCorruptError,
  StateRevConflictError,
  StateSchemaVersionError,
  discardStateFile,
  readStateFile,
  tempFileName,
  updateStateFile,
  writeStateFile,
} from './atomic-io.js'

const NOW = '2026-08-01T12:00:00Z'
let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'deerflow-state-'))
  file = join(dir, 'goal.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('read/write envelope', () => {
  it('returns null for a channel that has no file yet', () => {
    expect(readStateFile(file)).toBeNull()
  })

  it('round-trips the payload and stamps the envelope at the top level', () => {
    writeStateFile(file, { goal: { objective: 'ship' } }, { now: NOW })
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    expect(raw['schema_version']).toBe(STATE_SCHEMA_VERSION)
    expect(raw['rev']).toBe(1)
    expect(raw['updated_at']).toBe(NOW)
    expect(raw['goal']).toEqual({ objective: 'ship' })

    const envelope = readStateFile(file)
    expect(envelope?.rev).toBe(1)
    expect(envelope?.payload).toEqual({ goal: { objective: 'ship' } })
  })

  it('increments rev on every write', () => {
    expect(writeStateFile(file, { n: 1 }, { now: NOW }).rev).toBe(1)
    expect(writeStateFile(file, { n: 2 }, { now: NOW }).rev).toBe(2)
    expect(readStateFile(file)?.rev).toBe(2)
  })

  it('rejects a file that is not a JSON object envelope', () => {
    writeFileSync(file, '{ not json')
    expect(() => readStateFile(file)).toThrow(StateFileCorruptError)
    writeFileSync(file, '[1, 2]')
    expect(() => readStateFile(file)).toThrow(StateFileCorruptError)
  })
})

describe('atomic write discipline', () => {
  it('leaves no temp file behind on a completed write', () => {
    writeStateFile(file, { n: 1 }, { now: NOW })
    expect(readdirSync(dir)).toEqual(['goal.json'])
  })

  it('a crash between temp-write and rename leaves the reader on the old state', () => {
    writeStateFile(file, { n: 1 }, { now: NOW })

    // Simulate a writer killed after writing its temp file but before rename(2).
    const orphanTemp = tempFileName(file, 4242, 0)
    writeFileSync(orphanTemp, '{"schema_version": 1, "rev": 99, "n": 2, "trunc')

    expect(readStateFile(file)?.payload).toEqual({ n: 1 })
    expect(readStateFile(file)?.rev).toBe(1)
    expect(existsSync(orphanTemp)).toBe(true)

    // The next real write still lands cleanly on top of the last complete version.
    expect(writeStateFile(file, { n: 3 }, { now: NOW }).rev).toBe(2)
    expect(readStateFile(file)?.payload).toEqual({ n: 3 })
  })

  it('writes the temp file in the same directory as the target', () => {
    expect(tempFileName(file, 7, 1)).toBe(join(dir, 'goal.json.tmp-7-1'))
  })
})

describe('rev compare-and-set', () => {
  it('accepts a write anchored to the rev the caller read', () => {
    writeStateFile(file, { n: 1 }, { now: NOW })
    const current = readStateFile(file)
    expect(writeStateFile(file, { n: 2 }, { now: NOW, expectedRev: current?.rev ?? 0 }).rev).toBe(2)
  })

  it('stands down when the file moved under the reader', () => {
    writeStateFile(file, { n: 1 }, { now: NOW })
    const stale = readStateFile(file)?.rev ?? 0
    writeStateFile(file, { n: 2 }, { now: NOW })

    expect(() => writeStateFile(file, { n: 3 }, { now: NOW, expectedRev: stale })).toThrow(StateRevConflictError)
    expect(readStateFile(file)?.payload).toEqual({ n: 2 })
  })

  it('expectedRev 0 asserts the file does not exist yet', () => {
    writeStateFile(file, { n: 1 }, { now: NOW })
    expect(() => writeStateFile(file, { n: 2 }, { now: NOW, expectedRev: 0 })).toThrow(StateRevConflictError)
  })

  it('updateStateFile performs a read-modify-write under CAS', () => {
    updateStateFile<{ items: number[] }>(file, (current) => ({ items: [...(current?.items ?? []), 1] }), { now: NOW })
    const envelope = updateStateFile<{ items: number[] }>(
      file,
      (current) => ({ items: [...(current?.items ?? []), 2] }),
      { now: NOW },
    )
    expect(envelope.payload.items).toEqual([1, 2])
    expect(envelope.rev).toBe(2)
  })

  it('updateStateFile gives up after the bounded retries when a competing writer keeps winning', () => {
    writeStateFile(file, { n: 0 }, { now: NOW })
    let attempts = 0
    expect(() =>
      updateStateFile<{ n: number }>(
        file,
        (current) => {
          attempts += 1
          // A competing writer lands between our read and our write, every time.
          writeStateFile(file, { n: (current?.n ?? 0) + 100 }, { now: NOW })
          return { n: (current?.n ?? 0) + 1 }
        },
        { now: NOW, maxAttempts: 3 },
      ),
    ).toThrow(StateRevConflictError)
    expect(attempts).toBe(3)
  })
})

describe('schema versioning (migrate-or-discard)', () => {
  it('refuses to interpret an unknown or newer schema_version', () => {
    writeFileSync(file, JSON.stringify({ schema_version: 99, rev: 1, n: 1 }))
    expect(() => readStateFile(file)).toThrow(StateSchemaVersionError)

    writeFileSync(file, JSON.stringify({ rev: 1, n: 1 }))
    expect(() => readStateFile(file)).toThrow(StateSchemaVersionError)
  })

  it('applies a registered migration in memory', () => {
    writeFileSync(file, JSON.stringify({ schema_version: 0, rev: 4, updated_at: NOW, legacy: 'x' }))
    const envelope = readStateFile(file, {
      migrations: { 0: (payload) => ({ modern: payload['legacy'] }) },
    })
    expect(envelope?.payload).toEqual({ modern: 'x' })
    expect(envelope?.schemaVersion).toBe(STATE_SCHEMA_VERSION)
    expect(envelope?.rev).toBe(4)
  })

  it('quarantines a file it cannot interpret instead of partially parsing it', () => {
    writeFileSync(file, JSON.stringify({ schema_version: 99, rev: 1, n: 1 }))
    const quarantined = discardStateFile(file, '2026-08-01T12:00:00.000Z')
    expect(existsSync(file)).toBe(false)
    expect(existsSync(quarantined)).toBe(true)
    expect(quarantined.startsWith(`${file}.invalid-`)).toBe(true)
    // The channel starts empty rather than corrupt.
    expect(readStateFile(file)).toBeNull()
  })

  it('does not let an unreadable file be silently overwritten by a CAS write', () => {
    writeFileSync(file, JSON.stringify({ schema_version: 99, rev: 7, n: 1 }))
    expect(() => writeStateFile(file, { n: 2 }, { now: NOW, expectedRev: 0 })).toThrow(StateRevConflictError)
  })
})
