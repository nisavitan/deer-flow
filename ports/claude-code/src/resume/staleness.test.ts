// Unit tests for the stale-state predicate.
// No baseline vector file covers staleness: the original has no changed-commit detection at
// all (state-checkpoint-resume.md §4, experiment-results.md E3 item 3). These pin the port's
// own verdict matrix, the commit-binding half of the §3.2 re-verification predicate, and the
// migrate-or-discard gate's discard half.
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeStateFile } from '../state/atomic-io.js'
import {
  STALENESS_VERDICTS,
  checkSchemaGate,
  discardIfUnreadable,
  evaluateStaleness,
  isCommitBindingReusable,
  partitionByCommitBinding,
} from './staleness.js'

const A = '0950924aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const B = 'deadbee0000000000000000000000000000000000'
const NOW = '2026-08-01T12:00:00Z'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'deerflow-staleness-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('verdict matrix', () => {
  it('pins the vocabulary', () => {
    expect([...STALENESS_VERDICTS]).toEqual(['fresh', 'stale_commit', 'stale_branch'])
  })

  const cases: Array<{
    name: string
    stateCommitSha: string | null
    currentCommitSha: string | null
    stateBranch: string | null
    currentBranch: string | null
    verdict: string
    invalidates: boolean
  }> = [
    { name: 'same commit, same branch', stateCommitSha: A, currentCommitSha: A, stateBranch: 'main', currentBranch: 'main', verdict: 'fresh', invalidates: false },
    { name: 'same commit, branch unknown on both sides', stateCommitSha: A, currentCommitSha: A, stateBranch: null, currentBranch: null, verdict: 'fresh', invalidates: false },
    { name: 'same commit, branch known only in state', stateCommitSha: A, currentCommitSha: A, stateBranch: 'main', currentBranch: null, verdict: 'fresh', invalidates: false },
    { name: 'same commit, branch known only currently', stateCommitSha: A, currentCommitSha: A, stateBranch: null, currentBranch: 'main', verdict: 'fresh', invalidates: false },
    { name: 'same commit, different branch', stateCommitSha: A, currentCommitSha: A, stateBranch: 'main', currentBranch: 'feature', verdict: 'stale_branch', invalidates: false },
    { name: 'different commit, same branch', stateCommitSha: A, currentCommitSha: B, stateBranch: 'main', currentBranch: 'main', verdict: 'stale_commit', invalidates: true },
    { name: 'different commit, different branch (commit wins)', stateCommitSha: A, currentCommitSha: B, stateBranch: 'main', currentBranch: 'feature', verdict: 'stale_commit', invalidates: true },
    { name: 'no recorded commit', stateCommitSha: null, currentCommitSha: A, stateBranch: 'main', currentBranch: 'main', verdict: 'stale_commit', invalidates: true },
    { name: 'HEAD unreadable', stateCommitSha: A, currentCommitSha: null, stateBranch: 'main', currentBranch: 'main', verdict: 'stale_commit', invalidates: true },
    { name: 'both commits unknown', stateCommitSha: null, currentCommitSha: null, stateBranch: null, currentBranch: null, verdict: 'stale_commit', invalidates: true },
  ]

  for (const testCase of cases) {
    it(`${testCase.name} -> ${testCase.verdict}`, () => {
      const report = evaluateStaleness(testCase)
      expect(report.verdict).toBe(testCase.verdict)
      expect(report.invalidatesCachedResults).toBe(testCase.invalidates)
    })
  }

  it('treats a blank sha as absent rather than as a matching value', () => {
    const report = evaluateStaleness({ stateCommitSha: '   ', currentCommitSha: '   ' })
    expect(report.verdict).toBe('stale_commit')
    expect(report.stateCommitSha).toBeNull()
    expect(report.commitMatches).toBe(false)
  })

  it('ignores surrounding whitespace when comparing', () => {
    expect(evaluateStaleness({ stateCommitSha: `${A}\n`, currentCommitSha: A }).verdict).toBe('fresh')
  })

  it('reports the move in the reason text', () => {
    expect(evaluateStaleness({ stateCommitSha: A, currentCommitSha: B }).reason).toBe('HEAD moved 0950924 -> deadbee')
    expect(evaluateStaleness({ stateCommitSha: A, currentCommitSha: A }).reason).toBe('state matches HEAD 0950924')
  })
})

describe('commit-binding half of the re-verification predicate', () => {
  it('reuses only an entry whose recorded sha matches HEAD', () => {
    expect(isCommitBindingReusable(A, A)).toBe(true)
    expect(isCommitBindingReusable(A, B)).toBe(false)
  })

  it('never reuses an entry with no recorded sha', () => {
    expect(isCommitBindingReusable(undefined, A)).toBe(false)
    expect(isCommitBindingReusable(null, A)).toBe(false)
    expect(isCommitBindingReusable('', A)).toBe(false)
  })

  it('never reuses anything when HEAD is unknown', () => {
    expect(isCommitBindingReusable(A, null)).toBe(false)
  })

  it('keeps invalidated entries instead of dropping them (the ledger stays truthful)', () => {
    const entries = [
      { id: 'd-1', commit_sha: A },
      { id: 'd-2', commit_sha: B },
      { id: 'd-3' },
    ]
    const { reusable, invalidated } = partitionByCommitBinding(entries, A)
    expect(reusable.map((entry) => entry.id)).toEqual(['d-1'])
    expect(invalidated.map((entry) => entry.id)).toEqual(['d-2', 'd-3'])
    expect(reusable.length + invalidated.length).toBe(entries.length)
  })
})

describe('schema gate (migrate-or-discard)', () => {
  it('reports an absent file as an empty channel, not an error', () => {
    const gate = checkSchemaGate(join(dir, 'missing.json'))
    expect(gate.status).toBe('absent')
    expect(gate.envelope).toBeNull()
  })

  it('reads a current-version file', () => {
    const file = join(dir, 'goal.json')
    writeStateFile(file, { goal: null }, { now: NOW })
    const gate = checkSchemaGate(file)
    expect(gate.status).toBe('ok')
    expect(gate.envelope?.rev).toBe(1)
  })

  it('migrates in memory when a migration is registered (delegated to atomic-io)', () => {
    const file = join(dir, 'legacy.json')
    writeFileSync(file, JSON.stringify({ schema_version: 0, rev: 4, updated_at: NOW, value: 'old' }))
    const gate = checkSchemaGate<{ value: string }>(file, {
      migrations: { 0: (payload) => ({ ...payload, value: `${String(payload['value'])}+migrated` }) },
    })
    expect(gate.status).toBe('ok')
    expect(gate.envelope?.payload.value).toBe('old+migrated')
  })

  it('reports an unknown schema version as unreadable instead of partially parsing it', () => {
    const file = join(dir, 'future.json')
    writeFileSync(file, JSON.stringify({ schema_version: 99, rev: 1, updated_at: NOW, goal: { objective: 'x' } }))
    const gate = checkSchemaGate(file)
    expect(gate.status).toBe('unreadable')
    expect(gate.reason).toContain('Unsupported schema_version 99')
  })

  it('reports a corrupt file as unreadable', () => {
    const file = join(dir, 'corrupt.json')
    writeFileSync(file, '{not json')
    expect(checkSchemaGate(file).status).toBe('unreadable')
  })

  it('quarantines an uninterpretable file and leaves the channel empty', () => {
    const file = join(dir, 'future.json')
    writeFileSync(file, JSON.stringify({ schema_version: 99, rev: 1, updated_at: NOW }))
    const result = discardIfUnreadable(file, NOW)
    expect(result.status).toBe('unreadable')
    expect(result.quarantinePath).toBe(`${file}.invalid-2026-08-01T12-00-00Z`)
    expect(readdirSync(dir)).toEqual(['future.json.invalid-2026-08-01T12-00-00Z'])
    expect(readFileSync(result.quarantinePath as string, 'utf8')).toContain('"schema_version":99')
    expect(checkSchemaGate(file).status).toBe('absent')
  })

  it('discards nothing when the file reads cleanly', () => {
    const file = join(dir, 'goal.json')
    writeStateFile(file, { goal: null }, { now: NOW })
    const result = discardIfUnreadable(file, NOW)
    expect(result.status).toBe('ok')
    expect(result.quarantinePath).toBeNull()
    expect(readdirSync(dir)).toEqual(['goal.json'])
  })
})
