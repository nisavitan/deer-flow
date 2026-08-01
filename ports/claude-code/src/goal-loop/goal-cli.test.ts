// CLI-surface tests for /deerflow:goal. The clamping vectors from
// parity/baseline/goal_counters.json are replayed through `set` so the command surface, not only
// the state library, is pinned to the original's `build_goal_state` clamp.
import { readFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_MAX_GOAL_CONTINUATIONS, type GoalState } from '../state/goal.js'
import { readGoal, runGoalCli } from './goal-cli.js'

const NOW = '2026-08-01T00:00:00+00:00'
const THREAD = 'thread-cli'

const clamping = (
  JSON.parse(
    readFileSync(fileURLToPath(new URL('../../parity/baseline/goal_counters.json', import.meta.url)), 'utf8'),
  ) as {
    continuation_cap_clamping: { requested_max_continuations: number; effective_max_continuations: number }[]
  }
).continuation_cap_clamping

let env: NodeJS.ProcessEnv

beforeEach(() => {
  env = { CLAUDE_PROJECT_DIR: mkdtempSync(join(tmpdir(), 'deerflow-goalcli-')), DEERFLOW_THREAD_ID: THREAD }
})

function run(...argv: string[]): { exitCode: number; body: Record<string, unknown>; stderr: string } {
  const result = runGoalCli(argv, { env, now: NOW })
  return {
    exitCode: result.exitCode,
    body: result.stdout.trim().startsWith('{') ? (JSON.parse(result.stdout) as Record<string, unknown>) : {},
    stderr: result.stderr,
  }
}

describe('goal-cli', () => {
  it('set / status / clear round-trip', () => {
    const set = run('set', 'finish the audit')
    expect(set.exitCode).toBe(0)
    expect((set.body['goal'] as GoalState).objective).toBe('finish the audit')
    expect(readGoal(THREAD, env)?.max_continuations).toBe(DEFAULT_MAX_GOAL_CONTINUATIONS)

    expect((run('status').body['goal'] as GoalState).objective).toBe('finish the audit')

    expect(run('clear').body['goal']).toBeNull()
    expect(readGoal(THREAD, env)).toBeNull()
    expect(run('status').body['goal']).toBeNull()
  })

  it('normalizes the objective and rejects an empty one', () => {
    expect((run('set', '  finish   the\n audit ').body['goal'] as GoalState).objective).toBe('finish the audit')
    expect(run('set', '   ').exitCode).toBe(1)
    expect(run('set').stderr).toContain('requires an objective')
  })

  for (const vector of clamping) {
    it(`clamps max_continuations ${vector.requested_max_continuations} -> ${vector.effective_max_continuations}`, () => {
      const body = run('set', 'finish the audit', String(vector.requested_max_continuations)).body
      expect((body['goal'] as GoalState).max_continuations).toBe(vector.effective_max_continuations)
    })
  }

  it('record-continuation bumps the counter and refuses without a goal', () => {
    expect(run('record-continuation').exitCode).toBe(1)
    run('set', 'finish the audit')
    expect((run('record-continuation').body['goal'] as GoalState).continuation_count).toBe(1)
    expect((run('record-continuation').body['goal'] as GoalState).continuation_count).toBe(2)
  })

  it('record-evaluation: satisfied clears the goal', () => {
    run('set', 'finish the audit')
    const body = run('record-evaluation', '{"satisfied": true, "blocker": "none", "reason": "done"}').body
    expect(body['action']).toBe('clear_goal')
    expect(readGoal(THREAD, env)).toBeNull()
  })

  it('record-evaluation: continuable verdict returns the hidden continuation prompt', () => {
    run('set', 'finish the audit')
    const body = run(
      'record-evaluation',
      '{"satisfied": false, "blocker": "goal_not_met_yet", "reason": "two files left", "evidence_summary": "e"}',
    ).body
    expect(body['action']).toBe('continue_with_hidden_prompt')
    expect(String(body['hidden_prompt'])).toContain('<goal_continuation>')
    expect(readGoal(THREAD, env)?.continuation_count).toBe(1)
  })

  it('record-evaluation: a non-continuable blocker stands the loop down', () => {
    run('set', 'finish the audit')
    const body = run(
      'record-evaluation',
      '{"satisfied": false, "blocker": "needs_user_input", "reason": "which repo?", "evidence_summary": "e"}',
    ).body
    expect(body['action']).toBe('stand_down')
    expect(body['stand_down_reason']).toBe('blocked:needs_user_input')
    expect(readGoal(THREAD, env)?.last_evaluation?.stand_down_reason).toBe('blocked:needs_user_input')
  })

  it('record-evaluation: a malformed verdict fails closed to evaluation_failed', () => {
    run('set', 'finish the audit')
    const body = run('record-evaluation', 'I think it is done').body
    expect(body['parsed']).toBe(false)
    expect(body['action']).toBe('stand_down')
    expect(body['stand_down_reason']).toBe('evaluation_failed')
    expect(readGoal(THREAD, env)?.continuation_count).toBe(0)
  })

  it('reports usage and rejects unknown commands / missing thread ids', () => {
    expect(runGoalCli([], { env, now: NOW }).exitCode).toBe(1)
    expect(runGoalCli(['help'], { env, now: NOW }).stdout).toContain('usage: goal-cli')
    expect(runGoalCli(['nope'], { env, now: NOW }).exitCode).toBe(1)
    expect(runGoalCli(['status'], { env: { CLAUDE_PROJECT_DIR: env['CLAUDE_PROJECT_DIR'] ?? '' }, now: NOW }).stderr).toContain(
      'no thread id',
    )
  })

  it('--thread overrides the environment', () => {
    const result = runGoalCli(['set', 'other goal', '--thread', 'thread-other'], { env, now: NOW })
    expect(result.exitCode).toBe(0)
    expect(readGoal('thread-other', env)?.objective).toBe('other goal')
    expect(readGoal(THREAD, env)).toBeNull()
  })
})
