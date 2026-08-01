// Unit tests for the SessionStart recovery hook's decision layer.
// The subprocess shell (stdin read, exit code) is not tested here — `runSessionRecovery` is
// the whole behaviour: scan, terminalize what expired, decide what the session is told.
// Design: docs/claude-code-port/state-checkpoint-resume.md §5 (recovery at startup).
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeStateFile } from '../state/atomic-io.js'
import { GOAL_FILE, type GoalState } from '../state/goal.js'
import { RUN_META_FILE, buildRunMeta, type RunMeta, type RunStatus } from '../state/run-meta.js'
import { readRunMeta } from '../resume/recovery.js'
import { MAX_CONTEXT_THREADS, renderHookOutput, runSessionRecovery } from './session-recover.js'

const START = '2026-08-01T09:00:00.000Z' // 3 h before NOW: past the 2 h expiry.
const RECENT = '2026-08-01T11:30:00.000Z'
const NOW = '2026-08-01T12:00:00.000Z'
const SHA = '0950924aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'deerflow-session-recover-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function writeRun(threadId: string, options: { status?: RunStatus; updatedAt?: string; sessionId?: string } = {}): void {
  const run: RunMeta = {
    ...buildRunMeta({
      runId: `r-${threadId}`,
      threadId,
      commitSha: SHA,
      now: START,
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    }),
    status: options.status ?? 'running',
    updated_at: options.updatedAt ?? START,
  }
  mkdirSync(join(root, threadId), { recursive: true })
  writeStateFile(join(root, threadId, RUN_META_FILE), { run }, { now: run.updated_at })
}

function writeGoal(threadId: string, objective: string): void {
  const goal: GoalState = {
    objective,
    status: 'active',
    created_at: START,
    updated_at: START,
    continuation_count: 1,
    max_continuations: 8,
    no_progress_count: 0,
    max_no_progress_continuations: 2,
  }
  mkdirSync(join(root, threadId), { recursive: true })
  writeStateFile(join(root, threadId, GOAL_FILE), { goal }, { now: START })
}

const BASE = { now: NOW, currentSessionId: null, currentCommitSha: SHA, currentBranch: 'main' } as const

describe('recovery at session start', () => {
  it('says nothing when there is no state at all', () => {
    const result = runSessionRecovery({ ...BASE, stateRoot: join(root, 'absent') })
    expect(result.additionalContext).toBeNull()
    expect(result.reports).toEqual([])
  })

  it('says nothing when every run is terminal and no goal is set', () => {
    writeRun('done', { status: 'completed', updatedAt: START })
    const result = runSessionRecovery({ ...BASE, stateRoot: root })
    expect(result.outcome.orphans).toEqual([])
    expect(result.additionalContext).toBeNull()
  })

  it('terminalizes an expired run and reports the recovery in the injected block', () => {
    writeRun('old', { updatedAt: START })
    const result = runSessionRecovery({ ...BASE, stateRoot: root })

    expect(result.outcome.interrupted.map((orphan) => orphan.threadId)).toEqual(['old'])
    expect(readRunMeta(join(root, 'old', RUN_META_FILE))).toMatchObject({
      status: 'interrupted',
      stop_reason: 'orphan_recovered',
      delivery: { presented_paths: [], receipt_at: NOW },
    })
    // The run is no longer live, so it is not offered as resumable work.
    expect(result.additionalContext).toBeNull()
  })

  it('announces a still-live run from a dead session', () => {
    writeRun('live', { updatedAt: RECENT, sessionId: 'session-old' })
    const result = runSessionRecovery({ ...BASE, stateRoot: root, currentSessionId: 'session-new' })

    expect(result.outcome.resumable.map((orphan) => orphan.threadId)).toEqual(['live'])
    expect(result.additionalContext).toBe(
      'DeerFlow state present: thread live; run r-live running; state matches HEAD 0950924; action: continue\n' +
        'Run /deerflow:status for details.',
    )
  })

  it('announces a set goal even when no run is recorded', () => {
    writeGoal('goal-only', 'Finish the port')
    const result = runSessionRecovery({ ...BASE, stateRoot: root })
    expect(result.additionalContext).toContain('goal "Finish the port" (1/8 continuations)')
    expect(result.additionalContext).toContain('Run /deerflow:status for details.')
  })

  it('leaves a run recorded by the current session alone', () => {
    writeRun('mine', { updatedAt: START, sessionId: 'session-1' })
    const result = runSessionRecovery({ ...BASE, stateRoot: root, currentSessionId: 'session-1' })
    expect(result.outcome.orphans).toEqual([])
    expect(readRunMeta(join(root, 'mine', RUN_META_FILE))?.status).toBe('running')
  })

  it('mentions the recovery count when it terminalized something and other work remains', () => {
    writeRun('old', { updatedAt: START })
    writeGoal('other', 'Keep going')
    const result = runSessionRecovery({ ...BASE, stateRoot: root })
    expect(result.additionalContext).toContain(
      'Recovered 1 abandoned run(s): marked interrupted with stop_reason orphan_recovered.',
    )
  })

  it('caps the block at MAX_CONTEXT_THREADS and counts the rest', () => {
    for (let index = 0; index < MAX_CONTEXT_THREADS + 2; index++) writeGoal(`t-${index}`, `objective ${index}`)
    const result = runSessionRecovery({ ...BASE, stateRoot: root })
    const lines = (result.additionalContext ?? '').split('\n')
    expect(lines.filter((line) => line.startsWith('DeerFlow state present:'))).toHaveLength(MAX_CONTEXT_THREADS)
    expect(lines).toContain('(+2 more thread(s) with durable state)')
  })

  it('reports a stale tree in the injected line so a resumed session does not trust the cache', () => {
    writeRun('live', { updatedAt: RECENT })
    const result = runSessionRecovery({ ...BASE, stateRoot: root, currentCommitSha: 'ffffffff' })
    expect(result.additionalContext).toContain('HEAD moved 0950924 -> fffffff')
    expect(result.additionalContext).toContain('action: restart_stale')
  })
})

describe('hook stdout protocol', () => {
  it('emits SessionStart additionalContext as one JSON line', () => {
    const out = renderHookOutput('hello')
    expect(out.endsWith('\n')).toBe(true)
    expect(JSON.parse(out)).toEqual({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'hello' },
    })
  })
})
