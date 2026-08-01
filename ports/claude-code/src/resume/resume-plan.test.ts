// Unit tests for the resume report.
// The report is what `/deerflow:status` renders and what a resumed session consumes, so the
// whole object is asserted exactly for a fixture state dir — a silently changed field would
// change what a resumed run believes about its own history.
// Design: docs/claude-code-port/state-checkpoint-resume.md §3.2 (state-file-keyed resume),
// §4 (commit binding) and §5 (recovery quantum = stage).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeStateFile } from '../state/atomic-io.js'
import { ARTIFACTS_FILE } from '../state/artifacts.js'
import { DELEGATIONS_FILE, type DelegationEntry } from '../state/delegations.js'
import { GOAL_FILE, type GoalState } from '../state/goal.js'
import { RUN_META_FILE, buildRunMeta, transitionRunMeta } from '../state/run-meta.js'
import { TODOS_FILE } from '../state/todos.js'
import { SUMMARY_FILE, buildResumePlan, buildResumePlans, renderResumeLine, renderResumeReport } from './resume-plan.js'

const START = '2026-08-01T09:00:00.000Z'
const NOW = '2026-08-01T12:00:00.000Z'
const SHA = '0950924aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const OTHER_SHA = 'deadbee0000000000000000000000000000000000'

let root: string
let stateDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'deerflow-resume-'))
  stateDir = join(root, 'thread-1')
  mkdirSync(stateDir, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function write(fileName: string, payload: Record<string, unknown>): void {
  writeStateFile(join(stateDir, fileName), payload, { now: START })
}

const GOAL: GoalState = {
  objective: 'Ship the resume report',
  status: 'active',
  created_at: START,
  updated_at: START,
  continuation_count: 2,
  max_continuations: 8,
  no_progress_count: 0,
  max_no_progress_continuations: 2,
  last_evaluation: {
    satisfied: false,
    blocker: 'goal_not_met_yet',
    reason: 'still working',
    evidence_summary: 'two stages done',
    run_id: 'r-1',
    evaluated_at: START,
    progress_key: 'abc',
  },
}

const DELEGATIONS: DelegationEntry[] = [
  {
    id: 'r-1:0',
    run_id: 'r-1',
    description: 'Survey   the   ledger',
    subagent_type: 'deerflow-general-purpose',
    status: 'completed',
    created_at: START,
    commit_sha: SHA,
  },
  {
    id: 'r-1:1',
    run_id: 'r-1',
    description: 'Draft the report',
    subagent_type: 'deerflow-general-purpose',
    status: 'completed',
    created_at: START,
    commit_sha: OTHER_SHA,
  },
  {
    id: 'r-1:2',
    run_id: 'r-1',
    description: 'Untagged legacy entry',
    subagent_type: 'deerflow-bash',
    status: 'failed',
    created_at: START,
  },
]

/** A complete thread: live run, goal, todos, ledger, artifacts, summary. */
function writeFullFixture(): void {
  const run = buildRunMeta({
    runId: 'r-1',
    threadId: 'thread-1',
    commitSha: SHA,
    sessionId: 'session-1',
    branch: 'port/claude-code-architecture',
    now: START,
  })
  write(RUN_META_FILE, { run })
  write(GOAL_FILE, { goal: GOAL })
  write(TODOS_FILE, {
    todos: [
      { content: 'Write staleness.ts', status: 'completed' },
      { content: 'Write recovery.ts', status: 'in_progress' },
      { content: 'Write the status skill', status: 'pending' },
      { status: 'pending' }, // no content: not a todo the user can act on
      'not an object',
    ],
  })
  write(DELEGATIONS_FILE, { entries: DELEGATIONS })
  write(ARTIFACTS_FILE, { artifacts: ['outputs/report.md', 42] })
  write(SUMMARY_FILE, { summary_text: 'Two   stages complete;\nthird pending.' })
}

describe('exact report for a fixture state dir', () => {
  it('assembles every channel with the tree binding intact', () => {
    writeFullFixture()
    const report = buildResumePlan({
      threadId: 'thread-1',
      stateDir,
      currentCommitSha: SHA,
      currentBranch: 'port/claude-code-architecture',
    })

    expect(report).toEqual({
      thread_id: 'thread-1',
      state_dir: stateDir,
      run: {
        schema_version: 1,
        run_id: 'r-1',
        thread_id: 'thread-1',
        session_id: 'session-1',
        commit_sha: SHA,
        branch: 'port/claude-code-architecture',
        status: 'running',
        stop_reason: null,
        error: null,
        started_at: START,
        updated_at: START,
        ended_at: null,
      },
      run_active: true,
      goal: {
        objective: 'Ship the resume report',
        status: 'active',
        continuation_count: 2,
        max_continuations: 8,
        no_progress_count: 0,
        max_no_progress_continuations: 2,
        blocker: 'goal_not_met_yet',
        satisfied: false,
      },
      open_todos: [
        { content: 'Write recovery.ts', status: 'in_progress' },
        { content: 'Write the status skill', status: 'pending' },
      ],
      open_todo_count: 2,
      delegations: {
        total: 3,
        by_status: { completed: 2, failed: 1 },
        reusable: 1,
        invalidated: 2,
        recent: [
          {
            id: 'r-1:0',
            description: 'Survey the ledger',
            subagent_type: 'deerflow-general-purpose',
            status: 'completed',
            commit_sha: SHA,
            reusable: true,
          },
          {
            id: 'r-1:1',
            description: 'Draft the report',
            subagent_type: 'deerflow-general-purpose',
            status: 'completed',
            commit_sha: OTHER_SHA,
            reusable: false,
          },
          {
            id: 'r-1:2',
            description: 'Untagged legacy entry',
            subagent_type: 'deerflow-bash',
            status: 'failed',
            commit_sha: null,
            reusable: false,
          },
        ],
      },
      artifacts: ['outputs/report.md'],
      summary_text: 'Two stages complete; third pending.',
      staleness: {
        verdict: 'fresh',
        reason: 'state matches HEAD 0950924',
        stateCommitSha: SHA,
        currentCommitSha: SHA,
        stateBranch: 'port/claude-code-architecture',
        currentBranch: 'port/claude-code-architecture',
        commitMatches: true,
        branchMatches: true,
        invalidatesCachedResults: false,
      },
      recommended_action: 'continue',
      unreadable: [],
    })
  })
})

describe('recommended action', () => {
  it('is nothing_to_resume for an empty state dir', () => {
    const report = buildResumePlan({ threadId: 'thread-1', stateDir, currentCommitSha: SHA })
    expect(report.recommended_action).toBe('nothing_to_resume')
    expect(report.run).toBeNull()
    expect(report.goal).toBeNull()
    expect(report.delegations).toEqual({ total: 0, by_status: {}, reusable: 0, invalidated: 0, recent: [] })
    expect(report.summary_text).toBeNull()
  })

  it('is nothing_to_resume when the run finished and nothing is pending', () => {
    const run = transitionRunMeta(
      buildRunMeta({ runId: 'r-1', threadId: 'thread-1', commitSha: SHA, now: START }),
      { status: 'completed', now: NOW, delivery: { presented_paths: ['outputs/a.md'], receipt_at: NOW } },
    )
    write(RUN_META_FILE, { run })
    write(DELEGATIONS_FILE, { entries: DELEGATIONS })
    const report = buildResumePlan({ threadId: 'thread-1', stateDir, currentCommitSha: SHA })
    // A finished ledger is history, not work: cached results alone never justify a resume.
    expect(report.run_active).toBe(false)
    expect(report.delegations.total).toBe(3)
    expect(report.recommended_action).toBe('nothing_to_resume')
  })

  it('is continue when only a goal is set', () => {
    write(GOAL_FILE, { goal: GOAL })
    expect(buildResumePlan({ threadId: 'thread-1', stateDir, currentCommitSha: SHA }).recommended_action).toBe(
      'continue',
    )
  })

  it('is continue when only open todos remain', () => {
    write(TODOS_FILE, { todos: [{ content: 'finish', status: 'pending' }] })
    expect(buildResumePlan({ threadId: 'thread-1', stateDir, currentCommitSha: SHA }).recommended_action).toBe(
      'continue',
    )
  })

  it('is restart_stale when HEAD moved, and invalidates every cached result', () => {
    writeFullFixture()
    const report = buildResumePlan({ threadId: 'thread-1', stateDir, currentCommitSha: OTHER_SHA })
    expect(report.recommended_action).toBe('restart_stale')
    expect(report.staleness.verdict).toBe('stale_commit')
    expect(report.delegations.reusable).toBe(1) // the entry tagged with the NEW head
    expect(report.delegations.invalidated).toBe(2)
  })

  it('is restart_stale when HEAD cannot be read (fail-closed)', () => {
    writeFullFixture()
    const report = buildResumePlan({ threadId: 'thread-1', stateDir, currentCommitSha: null })
    expect(report.recommended_action).toBe('restart_stale')
    expect(report.delegations.reusable).toBe(0)
  })

  it('is continue on a branch move at the same commit', () => {
    writeFullFixture()
    const report = buildResumePlan({
      threadId: 'thread-1',
      stateDir,
      currentCommitSha: SHA,
      currentBranch: 'other-branch',
    })
    expect(report.staleness.verdict).toBe('stale_branch')
    expect(report.recommended_action).toBe('continue')
    expect(report.delegations.reusable).toBe(1)
  })
})

describe('stage-skip predicate', () => {
  it('never reuses a non-terminal entry, even at the current commit', () => {
    write(DELEGATIONS_FILE, {
      entries: [
        { id: 'd-1', description: 'finished', subagent_type: 'x', status: 'completed', created_at: START, commit_sha: SHA },
        { id: 'd-2', description: 'still running', subagent_type: 'x', status: 'in_progress', created_at: START, commit_sha: SHA },
      ] satisfies DelegationEntry[],
    })
    const report = buildResumePlan({ threadId: 'thread-1', stateDir, currentCommitSha: SHA })
    expect(report.delegations).toMatchObject({ total: 2, reusable: 1, invalidated: 1 })
    expect(report.delegations.recent.map((entry) => [entry.id, entry.reusable])).toEqual([
      ['d-1', true],
      ['d-2', false],
    ])
  })

  it('reuses every terminal status the contract defines when the commit matches', () => {
    write(DELEGATIONS_FILE, {
      entries: ['completed', 'failed', 'cancelled', 'timed_out', 'polling_timed_out'].map((status, index) => ({
        id: `d-${index}`,
        description: status,
        subagent_type: 'x',
        status,
        created_at: START,
        commit_sha: SHA,
      })) satisfies DelegationEntry[],
    })
    const report = buildResumePlan({ threadId: 'thread-1', stateDir, currentCommitSha: SHA })
    expect(report.delegations).toMatchObject({ total: 5, reusable: 5, invalidated: 0 })
  })
})

describe('uninterpretable channels', () => {
  it('reads a bad channel as empty and names it instead of guessing', () => {
    writeFullFixture()
    writeFileSync(join(stateDir, GOAL_FILE), JSON.stringify({ schema_version: 99, rev: 1 }))
    writeFileSync(join(stateDir, TODOS_FILE), '{not json')
    const report = buildResumePlan({ threadId: 'thread-1', stateDir, currentCommitSha: SHA })
    expect(report.unreadable).toEqual([GOAL_FILE, TODOS_FILE])
    expect(report.goal).toBeNull()
    expect(report.open_todos).toEqual([])
    expect(report.run_active).toBe(true)
  })
})

describe('caps', () => {
  it('caps the recent-delegation tail and the todo list, keeping the true counts', () => {
    const entries: DelegationEntry[] = Array.from({ length: 12 }, (_, index) => ({
      id: `r-1:${index}`,
      description: `task ${index}`,
      subagent_type: 'deerflow-general-purpose',
      status: 'completed',
      created_at: START,
      commit_sha: SHA,
    }))
    write(DELEGATIONS_FILE, { entries })
    write(TODOS_FILE, {
      todos: Array.from({ length: 5 }, (_, index) => ({ content: `todo ${index}`, status: 'pending' })),
    })
    const report = buildResumePlan({
      threadId: 'thread-1',
      stateDir,
      currentCommitSha: SHA,
      maxDelegations: 3,
      maxTodos: 2,
    })
    expect(report.delegations.total).toBe(12)
    expect(report.delegations.recent.map((entry) => entry.id)).toEqual(['r-1:9', 'r-1:10', 'r-1:11'])
    expect(report.open_todo_count).toBe(5)
    expect(report.open_todos).toHaveLength(2)
  })

  it('bounds a long summary digest', () => {
    write(SUMMARY_FILE, { summary_text: 'x'.repeat(2000) })
    const report = buildResumePlan({ threadId: 'thread-1', stateDir, currentCommitSha: SHA })
    expect(report.summary_text).toHaveLength(600)
    expect(report.summary_text?.endsWith('…')).toBe(true)
  })
})

describe('rendering', () => {
  it('renders a one-line digest for the SessionStart notice', () => {
    writeFullFixture()
    const report = buildResumePlan({ threadId: 'thread-1', stateDir, currentCommitSha: SHA })
    expect(renderResumeLine(report)).toBe(
      'thread thread-1; run r-1 running; goal "Ship the resume report" (2/8 continuations); ' +
        '2 open todo(s); 3 delegation(s), 1 reusable; state matches HEAD 0950924; action: continue',
    )
  })

  it('renders markdown carrying the action and the staleness verdict', () => {
    writeFullFixture()
    const markdown = renderResumeReport(
      buildResumePlan({ threadId: 'thread-1', stateDir, currentCommitSha: OTHER_SHA }),
    )
    expect(markdown).toContain('## Thread `thread-1`')
    expect(markdown).toContain('**Staleness:** stale_commit')
    expect(markdown).toContain('1 reusable at this commit, 2 to re-run')
    expect(markdown).toContain('**Recommended action:** restart_stale')
  })

  it('renders an empty thread without inventing state', () => {
    const markdown = renderResumeReport(buildResumePlan({ threadId: 'thread-1', stateDir, currentCommitSha: SHA }))
    expect(markdown).toContain('- **Run:** none recorded')
    expect(markdown).toContain('- **Goal:** none set')
    expect(markdown).toContain('- **Open todos:** none')
    expect(markdown).toContain('**Recommended action:** nothing_to_resume')
  })
})

describe('multi-thread plans', () => {
  it('builds one report per thread, in the order given', () => {
    writeFullFixture()
    mkdirSync(join(root, 'thread-2'), { recursive: true })
    const reports = buildResumePlans(['thread-1', 'thread-2'], root, { currentCommitSha: SHA })
    expect(reports.map((report) => report.thread_id)).toEqual(['thread-1', 'thread-2'])
    expect(reports.map((report) => report.recommended_action)).toEqual(['continue', 'nothing_to_resume'])
  })
})
