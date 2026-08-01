// Unit tests for run identity and the terminal-status / receipt invariants.
// No baseline vector file covers run identity; these pin guarantee G6 (receipt-with-status
// atomicity) and the RunStore terminal-status rule from
// docs/claude-code-port/state-checkpoint-resume.md §2 (`run-meta.json`), §5 and §7.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ACTIVE_RUN_STATUSES,
  ActiveRunExistsError,
  TERMINAL_RUN_STATUSES,
  TerminalRunStatusError,
  applyRunTransition,
  buildRunMeta,
  isTerminalRunStatus,
  recoverOrphanedRun,
  startRun,
  transitionRunMeta,
  type RunStatus,
} from './run-meta.js'

const START = '2026-08-01T12:00:00Z'
const END = '2026-08-01T12:05:00Z'
let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'deerflow-run-'))
  file = join(dir, 'run-meta.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function newRun() {
  return buildRunMeta({ runId: 'r-1', threadId: 't-1', commitSha: '0950924', now: START })
}

describe('run identity record', () => {
  it('records the identity tuple with caller-injected timestamps', () => {
    const run = newRun()
    expect(run).toMatchObject({
      run_id: 'r-1',
      thread_id: 't-1',
      commit_sha: '0950924',
      status: 'running',
      stop_reason: null,
      started_at: START,
      updated_at: START,
      ended_at: null,
    })
    expect(run.schema_version).toBe(1)
  })

  it('pins the status vocabulary', () => {
    expect([...TERMINAL_RUN_STATUSES].sort()).toEqual(['completed', 'error', 'interrupted'])
    expect([...ACTIVE_RUN_STATUSES].sort()).toEqual(['pending', 'running'])
    for (const status of ['completed', 'error', 'interrupted'] as RunStatus[]) {
      expect(isTerminalRunStatus(status)).toBe(true)
    }
    for (const status of ['pending', 'running'] as RunStatus[]) {
      expect(isTerminalRunStatus(status)).toBe(false)
    }
  })
})

describe('terminal status guard', () => {
  it('never lets a non-terminal write overwrite a terminal record', () => {
    const terminal = transitionRunMeta(newRun(), { status: 'completed', now: END })
    expect(() => transitionRunMeta(terminal, { status: 'running', now: END })).toThrow(TerminalRunStatusError)
    expect(() => transitionRunMeta(terminal, { status: 'pending', now: END })).toThrow(TerminalRunStatusError)
  })

  it('allows a terminal-to-terminal correction and stamps ended_at', () => {
    const terminal = transitionRunMeta(newRun(), { status: 'error', now: END, error: 'boom' })
    expect(terminal.ended_at).toBe(END)
    const corrected = transitionRunMeta(terminal, { status: 'interrupted', now: END, stopReason: 'orphan_recovered' })
    expect(corrected.status).toBe('interrupted')
    expect(corrected.stop_reason).toBe('orphan_recovered')
  })
})

describe('receipt-with-status atomicity (G6)', () => {
  it('writes the delivery receipt and the terminal status in one atomic file write', () => {
    startRun(file, { runId: 'r-1', threadId: 't-1', commitSha: '0950924', now: START }, { now: START })
    const envelope = applyRunTransition(
      file,
      {
        status: 'completed',
        now: END,
        delivery: { presented_paths: ['outputs/report.pdf'], receipt_at: END },
      },
      { now: END },
    )
    expect(envelope.rev).toBe(2)

    // One rename carries both facts: there is no window where the status is terminal
    // but the receipt is missing.
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { rev: number; run: Record<string, unknown> }
    expect(raw.rev).toBe(2)
    expect(raw.run['status']).toBe('completed')
    expect(raw.run['delivery']).toEqual({ presented_paths: ['outputs/report.pdf'], receipt_at: END })
  })

  it('preserves an existing receipt instead of overwriting it (put_if_absent)', () => {
    const withReceipt = transitionRunMeta(newRun(), {
      status: 'running',
      now: END,
      delivery: { presented_paths: ['a.md'], receipt_at: END },
    })
    const terminal = transitionRunMeta(withReceipt, {
      status: 'completed',
      now: END,
      delivery: { presented_paths: [], receipt_at: END },
    })
    expect(terminal.delivery).toEqual({ presented_paths: ['a.md'], receipt_at: END })
  })

  it('backfills a zero receipt when recovering an orphaned run', () => {
    const recovered = recoverOrphanedRun(newRun(), END)
    expect(recovered.status).toBe('interrupted')
    expect(recovered.stop_reason).toBe('orphan_recovered')
    expect(recovered.delivery).toEqual({ presented_paths: [], receipt_at: END })
    expect(recovered.ended_at).toBe(END)
  })
})

describe('one active run per thread', () => {
  it('refuses to admit a run while a non-terminal one is recorded', () => {
    startRun(file, { runId: 'r-1', threadId: 't-1', commitSha: '0950924', now: START }, { now: START })
    expect(() =>
      startRun(file, { runId: 'r-2', threadId: 't-1', commitSha: '0950924', now: START }, { now: START }),
    ).toThrow(ActiveRunExistsError)
  })

  it('admits the next run once the previous one is terminal', () => {
    startRun(file, { runId: 'r-1', threadId: 't-1', commitSha: '0950924', now: START }, { now: START })
    applyRunTransition(file, { status: 'completed', now: END }, { now: END })
    const envelope = startRun(
      file,
      { runId: 'r-2', threadId: 't-1', commitSha: '0950924', now: END },
      { now: END },
    )
    expect(envelope.payload.run?.run_id).toBe('r-2')
    expect(envelope.rev).toBe(3)
  })
})
