// Drives ledger-cli against a realistic `workflows/deep-run.js` result — the exact shape that file
// returns, including the two nulls it cannot fill (`created_at`, `result_sha256`).
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { LedgerValidationError, buildLedgerEntries, parseArgs, persistDeepRunLedger } from './ledger-cli.js'
import { readStateFile } from '../state/atomic-io.js'
import { delegationsPath, type DelegationsPayload } from '../state/delegations.js'
import { runMetaPath, startRun, type RunMetaPayload } from '../state/run-meta.js'

const NOW = '2026-08-01T12:00:00.000Z'
const THREAD = 'thread-ledger'
let root: string
let env: NodeJS.ProcessEnv

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'deerflow-ledger-cli-'))
  env = { CLAUDE_PROJECT_DIR: root }
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const FULL_RESULT = 'A long synthesis of the middleware chain, well past the brief cap in a real run.'

/** The shape workflows/deep-run.js returns (trimmed to the fields this CLI reads). */
function deepRunResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    milestone: 'M6',
    run_id: 'run-1',
    commit_sha: 'abc123',
    results: [
      { index: 0, status: 'completed', result: FULL_RESULT, files_produced: [] },
      { index: 1, status: 'failed', result: 'Execution timed out', files_produced: [] },
    ],
    ledger_entries: [
      {
        id: 'run-1:0',
        run_id: 'run-1',
        description: 'survey the middleware chain',
        subagent_type: 'deerflow-general-purpose',
        status: 'completed',
        stop_reason: null,
        result_brief: FULL_RESULT,
        result_sha256: null,
        created_at: null,
        commit_sha: 'abc123',
      },
      {
        id: 'run-1:1',
        run_id: 'run-1',
        description: 'inventory the config schemas',
        subagent_type: 'deerflow-bash',
        status: 'failed',
        stop_reason: null,
        result_brief: null,
        result_sha256: null,
        created_at: null,
        commit_sha: 'abc123',
      },
    ],
    stop_reason: null,
    ...overrides,
  }
}

describe('ledger-cli — entry completion', () => {
  it('stamps created_at and the digest of the FULL result, not the brief', () => {
    const entries = buildLedgerEntries(deepRunResult(), NOW)
    expect(entries).toHaveLength(2)
    expect(entries[0]?.created_at).toBe(NOW)
    expect(entries[0]?.result_sha256).toBe(createHash('sha256').update(FULL_RESULT, 'utf8').digest('hex'))
    // A failed task carries no result digest, matching makeSubagentAdditionalKwargs.
    expect(entries[1]?.result_sha256).toBeUndefined()
    expect(entries[1]?.status).toBe('failed')
  })

  it('preserves a created_at or digest the producer already supplied', () => {
    const result = deepRunResult()
    const first = (result['ledger_entries'] as Record<string, unknown>[])[0] as Record<string, unknown>
    first['created_at'] = '2020-01-01T00:00:00.000Z'
    first['result_sha256'] = 'deadbeef'
    const entries = buildLedgerEntries(result, NOW)
    expect(entries[0]?.created_at).toBe('2020-01-01T00:00:00.000Z')
    expect(entries[0]?.result_sha256).toBe('deadbeef')
  })

  it('refuses a result with no ledger_entries at all', () => {
    expect(() => buildLedgerEntries({}, NOW)).toThrow(LedgerValidationError)
    expect(() => buildLedgerEntries({ ledger_entries: 'nope' }, NOW)).toThrow(/not an array/)
  })

  it('reports every unusable entry at once rather than persisting a partial ledger', () => {
    let thrown: unknown
    try {
      buildLedgerEntries({ ledger_entries: [{ description: 'x' }, 7, { id: 'a', description: 'b' }] }, NOW)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(LedgerValidationError)
    const problems = (thrown as LedgerValidationError).problems
    expect(problems).toContain('entry 0 has no `id`')
    expect(problems).toContain('entry 1 is not an object')
    expect(problems).toContain('entry 2 has no `subagent_type`')
  })

  it('accepts an empty ledger (a run that delegated nothing)', () => {
    expect(buildLedgerEntries({ ledger_entries: [] }, NOW)).toEqual([])
  })
})

describe('ledger-cli — persistence', () => {
  it('writes the entries into the thread ledger', () => {
    const outcome = persistDeepRunLedger(deepRunResult(), { threadId: THREAD, now: NOW, env })
    expect(outcome.entries).toBe(2)
    expect(outcome.totalEntries).toBe(2)
    expect(outcome.path).toBe(delegationsPath(THREAD, env))
    expect(outcome.runStopReason).toBeNull()

    const stored = readStateFile<DelegationsPayload>(delegationsPath(THREAD, env))?.payload.entries ?? []
    expect(stored.map((entry) => entry.id)).toEqual(['run-1:0', 'run-1:1'])
    expect(stored[0]?.run_id).toBe('run-1')
  })

  it('is idempotent — a re-run keeps the first-seen created_at and adds no duplicates', () => {
    persistDeepRunLedger(deepRunResult(), { threadId: THREAD, now: NOW, env })
    const second = persistDeepRunLedger(deepRunResult(), {
      threadId: THREAD,
      now: '2026-08-02T12:00:00.000Z',
      env,
    })
    expect(second.totalEntries).toBe(2)
    const stored = readStateFile<DelegationsPayload>(delegationsPath(THREAD, env))?.payload.entries ?? []
    expect(stored[0]?.created_at).toBe(NOW)
  })

  it('reflects a run-level cap onto the run record without ending the run', () => {
    const filePath = runMetaPath(THREAD, env)
    startRun(filePath, { runId: 'run-1', threadId: THREAD, commitSha: 'abc123', now: NOW }, { now: NOW })

    const outcome = persistDeepRunLedger(deepRunResult({ stop_reason: 'subagent_limit_capped' }), {
      threadId: THREAD,
      now: NOW,
      env,
    })
    expect(outcome.runStopReason).toBe('subagent_limit_capped')

    const run = readStateFile<RunMetaPayload>(filePath)?.payload.run
    expect(run?.stop_reason).toBe('subagent_limit_capped')
    expect(run?.status).toBe('running')
    expect(run?.ended_at).toBeNull()
  })

  it('leaves a run record belonging to a different run alone', () => {
    const filePath = runMetaPath(THREAD, env)
    startRun(filePath, { runId: 'run-OTHER', threadId: THREAD, commitSha: 'abc123', now: NOW }, { now: NOW })
    const outcome = persistDeepRunLedger(deepRunResult({ stop_reason: 'subagent_limit_capped' }), {
      threadId: THREAD,
      now: NOW,
      env,
    })
    expect(outcome.runStopReason).toBeNull()
    expect(readStateFile<RunMetaPayload>(filePath)?.payload.run?.stop_reason).toBeNull()
  })

  it('persists the ledger even when there is no run record to update', () => {
    const outcome = persistDeepRunLedger(deepRunResult({ stop_reason: 'subagent_limit_capped' }), {
      threadId: THREAD,
      now: NOW,
      env,
    })
    expect(outcome.entries).toBe(2)
    expect(outcome.runStopReason).toBeNull()
  })

  it('ignores a stop reason outside the run vocabulary', () => {
    const filePath = runMetaPath(THREAD, env)
    startRun(filePath, { runId: 'run-1', threadId: THREAD, commitSha: 'abc123', now: NOW }, { now: NOW })
    const outcome = persistDeepRunLedger(deepRunResult({ stop_reason: 'made_up_reason' }), {
      threadId: THREAD,
      now: NOW,
      env,
    })
    expect(outcome.runStopReason).toBeNull()
  })
})

describe('ledger-cli — argument parsing', () => {
  it('takes the thread from the flag, then the environment', () => {
    expect(parseArgs(['--thread', 'abc'], {})).toEqual({ threadId: 'abc', json: false })
    expect(parseArgs([], { DEERFLOW_THREAD_ID: 'from-env' })).toEqual({ threadId: 'from-env', json: false })
    expect(parseArgs(['--json'], { DEERFLOW_THREAD_ID: 'x' }).json).toBe(true)
  })

  it('refuses an unknown or incomplete flag', () => {
    expect(() => parseArgs(['--nope'], {})).toThrow(/Unknown argument/)
    expect(() => parseArgs(['--thread'], {})).toThrow(/Missing value/)
  })
})
