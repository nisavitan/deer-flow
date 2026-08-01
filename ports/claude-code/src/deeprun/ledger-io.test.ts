// Tests for the deep-run -> delegation-ledger glue.
// The reducer itself is already vector-tested in src/state/delegations.test.ts against
// parity/baseline/delegations_ledger.json; these tests cover only the mapping this module
// adds, plus the invariant that matters most: a terminal write can never be downgraded.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DESCRIPTION_CAP,
  delegationId,
  dispatchEntry,
  runLedgerEntries,
  terminalEntry,
  writeDelegations,
} from './ledger-io.js'
import { delegationsPath, mergeDelegations } from '../state/delegations.js'
import type { PlannedTask } from './batching.js'
import type { DeepRunTaskResult } from './task-schema.js'

const RUN_ID = 'run-abc'
const CREATED_AT = '2026-08-01T00:00:00.000Z'

function planned(index: number, overrides: Partial<PlannedTask> = {}): PlannedTask {
  return {
    index,
    description: `task ${index}`,
    prompt: `do ${index}`,
    agentType: 'deerflow-general-purpose',
    timeoutMs: 1_800_000,
    ...overrides,
  }
}

describe('delegationId', () => {
  it('is deterministic and resume-stable', () => {
    expect(delegationId(RUN_ID, 2)).toBe('run-abc:2')
    expect(delegationId(RUN_ID, 2)).toBe(delegationId(RUN_ID, 2))
  })

  it('is unique per task within a run', () => {
    const ids = new Set([0, 1, 2, 3].map((index) => delegationId(RUN_ID, index)))
    expect(ids.size).toBe(4)
  })
})

describe('dispatchEntry', () => {
  it('records a non-terminal in_progress entry tagged with the run', () => {
    expect(dispatchEntry(planned(0), { runId: RUN_ID, createdAt: CREATED_AT })).toEqual({
      id: 'run-abc:0',
      run_id: RUN_ID,
      description: 'task 0',
      subagent_type: 'deerflow-general-purpose',
      status: 'in_progress',
      created_at: CREATED_AT,
    })
  })

  it('carries the commit sha when supplied', () => {
    const entry = dispatchEntry(planned(0), { runId: RUN_ID, createdAt: CREATED_AT, commitSha: 'deadbee' })
    expect(entry.commit_sha).toBe('deadbee')
  })

  it('bounds an over-long description', () => {
    const entry = dispatchEntry(planned(0, { description: 'z'.repeat(500) }), {
      runId: RUN_ID,
      createdAt: CREATED_AT,
    })
    expect(entry.description).toHaveLength(DESCRIPTION_CAP)
  })
})

describe('terminalEntry', () => {
  const dispatch = dispatchEntry(planned(0), { runId: RUN_ID, createdAt: CREATED_AT })

  it('upgrades to completed with a brief and a digest of the full result', () => {
    const result: DeepRunTaskResult = { status: 'completed', result: 'FINDINGS: three defects.', stop_reason: null }
    expect(terminalEntry(dispatch, result)).toEqual({
      ...dispatch,
      status: 'completed',
      result_brief: 'FINDINGS: three defects.',
      result_sha256: '5738a3b16d714f3f6e89e7929d26cad3b7bfc97a90658e07a8fde78611a33b86',
    })
  })

  it('records the cap on a capped completion', () => {
    const entry = terminalEntry(dispatch, { status: 'completed', result: 'partial', stop_reason: 'turn_capped' })
    expect(entry.status).toBe('completed')
    expect(entry.stop_reason).toBe('turn_capped')
    expect(entry.result_brief).toBe('partial')
  })

  it('carries no result brief for a failure', () => {
    const entry = terminalEntry(dispatch, { status: 'failed', result: 'boom', stop_reason: null })
    expect(entry.status).toBe('failed')
    expect(entry.result_brief).toBeUndefined()
    expect(entry.result_sha256).toBeUndefined()
  })

  it('preserves id, run_id and created_at from the dispatch entry', () => {
    const entry = terminalEntry(dispatch, { status: 'timed_out', result: '', stop_reason: null })
    expect(entry.id).toBe(dispatch.id)
    expect(entry.run_id).toBe(RUN_ID)
    expect(entry.created_at).toBe(CREATED_AT)
  })
})

describe('runLedgerEntries', () => {
  it('emits one terminal entry per accepted task, in order', () => {
    const tasks = [planned(0), planned(1)]
    const results: DeepRunTaskResult[] = [
      { status: 'completed', result: 'a', stop_reason: null },
      { status: 'failed', result: 'b', stop_reason: null },
    ]
    const entries = runLedgerEntries(tasks, results, { runId: RUN_ID, createdAt: CREATED_AT })
    expect(entries.map((entry) => [entry.id, entry.status])).toEqual([
      ['run-abc:0', 'completed'],
      ['run-abc:1', 'failed'],
    ])
  })

  it('skips a task with no matching result rather than inventing one', () => {
    expect(runLedgerEntries([planned(0), planned(1)], [{ status: 'completed', result: 'a' }], {
      runId: RUN_ID,
      createdAt: CREATED_AT,
    })).toHaveLength(1)
  })

  it('emits nothing for an empty plan', () => {
    expect(runLedgerEntries([], [], { runId: RUN_ID, createdAt: CREATED_AT })).toEqual([])
  })
})

describe('reducer interaction', () => {
  it('lets a terminal entry replace its own dispatch entry', () => {
    const dispatch = dispatchEntry(planned(0), { runId: RUN_ID, createdAt: CREATED_AT })
    const terminal = terminalEntry(dispatch, { status: 'completed', result: 'done', stop_reason: null })
    const merged = mergeDelegations([dispatch], [terminal])
    expect(merged).toHaveLength(1)
    expect(merged[0]?.status).toBe('completed')
  })

  it('never lets a late dispatch entry downgrade a terminal one', () => {
    const dispatch = dispatchEntry(planned(0), { runId: RUN_ID, createdAt: CREATED_AT })
    const terminal = terminalEntry(dispatch, { status: 'completed', result: 'done', stop_reason: null })
    const merged = mergeDelegations([terminal], [dispatch])
    expect(merged[0]?.status).toBe('completed')
  })
})

describe('writeDelegations', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'deerflow-ledger-io-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('persists entries through the atomic state library', () => {
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: root }
    const dispatch = dispatchEntry(planned(0), { runId: RUN_ID, createdAt: CREATED_AT })
    const terminal = terminalEntry(dispatch, { status: 'completed', result: 'done', stop_reason: null })

    const first = writeDelegations('thread-1', [dispatch], { now: CREATED_AT }, env)
    expect(first.payload.entries).toHaveLength(1)
    expect(first.payload.entries[0]?.status).toBe('in_progress')

    const second = writeDelegations('thread-1', [terminal], { now: CREATED_AT }, env)
    expect(second.payload.entries).toHaveLength(1)
    expect(second.payload.entries[0]?.status).toBe('completed')

    expect(delegationsPath('thread-1', env)).toBe(join(root, '.deerflow', 'state', 'thread-1', 'delegations.json'))
    const onDisk = readFileSync(delegationsPath('thread-1', env), 'utf8')
    expect(onDisk).toContain('"status": "completed"')
  })
})
