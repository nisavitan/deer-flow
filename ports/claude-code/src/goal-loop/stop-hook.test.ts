// Tests for the Stop-hook half of the goal loop: the deterministic gate (`decideStopHook`, pure)
// and the thin IO shell around it (`src/hooks/stop-goal-evaluator.ts`).
//
// The three gates the port's termination guarantee rests on are pinned here:
//   cap exhausted        -> NO block;
//   active goal + fresh evidence -> block, carrying the verbatim evaluator rubric;
//   breaker tripped      -> NO block, and `no_progress_detected` recorded on the goal.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MAX_GOAL_CONTINUATIONS,
  buildGoalState,
  computeGoalProgressKey,
  goalPath,
  type GoalState,
} from '../state/goal.js'
import { GOAL_EVALUATOR_SYSTEM_INSTRUCTION, evidenceSignatureOf } from './evaluator-prompt.js'
import { CONTINUATION_NOT_RECORDED, NO_ACTIVE_GOAL, PENDING_SELF_EVALUATION, decideStopHook } from './orchestrate.js'
import { readGoal, writeGoal } from './goal-cli.js'
import {
  evaluateStop,
  parseTranscriptMessages,
  renderHookOutput,
  resolveThreadId,
  type StopHookPayload,
} from '../hooks/stop-goal-evaluator.js'

const NOW = '2026-08-01T00:00:00+00:00'
const THREAD = 'thread-m11'
const OBJECTIVE = 'finish the audit'
const EVIDENCE = 'Assistant: I edited two files.'

function activeGoal(overrides: Partial<GoalState> = {}): GoalState {
  return { ...buildGoalState(OBJECTIVE, { now: NOW }), ...overrides }
}

describe('decideStopHook — deterministic gates', () => {
  it('no active goal: never blocks and writes nothing', () => {
    const decision = decideStopHook({ goal: null, evidenceText: EVIDENCE, stopHookActive: false, runId: 'r', now: NOW })
    expect(decision.block).toBe(false)
    expect(decision.standDownReason).toBe(NO_ACTIVE_GOAL)
    expect(decision.nextGoal).toBeNull()
  })

  it('active goal + fresh evidence: blocks with the verbatim rubric and consumes a continuation', () => {
    const goal = activeGoal()
    const decision = decideStopHook({ goal, evidenceText: EVIDENCE, stopHookActive: false, runId: 'r', now: NOW })
    expect(decision.block).toBe(true)
    expect(decision.standDownReason).toBeNull()
    expect(decision.continuationCount).toBe(1)
    expect(decision.nextGoal?.continuation_count).toBe(1)
    expect(decision.nextGoal?.last_evaluation?.stand_down_reason).toBeUndefined()

    const reason = decision.blockReason ?? ''
    expect(reason).toContain(GOAL_EVALUATOR_SYSTEM_INSTRUCTION)
    expect(reason).toContain(`Active goal:\n${OBJECTIVE}`)
    expect(reason).toContain(`Visible conversation evidence:\n${EVIDENCE}`)
    expect(reason).toContain('Is the active goal fully satisfied?')
    expect(reason).toContain('node dist/goal-loop/goal-cli.js clear')
    expect(reason).toContain(`Continuation 1 of ${DEFAULT_MAX_GOAL_CONTINUATIONS}`)
  })

  it('cap exhausted: does NOT block and records max_continuations_reached', () => {
    const goal = activeGoal({ continuation_count: DEFAULT_MAX_GOAL_CONTINUATIONS })
    const decision = decideStopHook({ goal, evidenceText: EVIDENCE, stopHookActive: true, runId: 'r', now: NOW })
    expect(decision.block).toBe(false)
    expect(decision.blockReason).toBeNull()
    expect(decision.standDownReason).toBe('max_continuations_reached')
    expect(decision.nextGoal?.last_evaluation?.stand_down_reason).toBe('max_continuations_reached')
    expect(decision.nextGoal?.continuation_count).toBe(DEFAULT_MAX_GOAL_CONTINUATIONS)
  })

  it('a zero cap blocks the very first stop', () => {
    const decision = decideStopHook({
      goal: activeGoal({ max_continuations: 0 }),
      evidenceText: EVIDENCE,
      stopHookActive: false,
      runId: 'r',
      now: NOW,
    })
    expect(decision.block).toBe(false)
    expect(decision.standDownReason).toBe('max_continuations_reached')
  })

  it('breaker tripped: does NOT block and records no_progress_detected', () => {
    const signature = evidenceSignatureOf(EVIDENCE)
    const goal = activeGoal({
      continuation_count: 3,
      no_progress_count: 1,
      last_evaluation: {
        satisfied: false,
        blocker: 'goal_not_met_yet',
        reason: 'previous turn',
        evidence_summary: '',
        run_id: 'run-prev',
        evaluated_at: NOW,
        progress_key: computeGoalProgressKey(PENDING_SELF_EVALUATION, signature),
      },
    })
    const decision = decideStopHook({ goal, evidenceText: EVIDENCE, stopHookActive: true, runId: 'r', now: NOW })
    expect(decision.noProgressCount).toBe(2)
    expect(decision.block).toBe(false)
    expect(decision.standDownReason).toBe('no_progress_detected')
    expect(decision.nextGoal?.last_evaluation?.stand_down_reason).toBe('no_progress_detected')
    expect(decision.nextGoal?.no_progress_count).toBe(2)
  })

  it('one repeated turn is not enough: the breaker needs two', () => {
    const signature = evidenceSignatureOf(EVIDENCE)
    const goal = activeGoal({
      continuation_count: 1,
      last_evaluation: {
        satisfied: false,
        blocker: 'goal_not_met_yet',
        reason: 'previous turn',
        evidence_summary: '',
        run_id: 'run-prev',
        evaluated_at: NOW,
        progress_key: computeGoalProgressKey(PENDING_SELF_EVALUATION, signature),
      },
    })
    const decision = decideStopHook({ goal, evidenceText: EVIDENCE, stopHookActive: true, runId: 'r', now: NOW })
    expect(decision.noProgressCount).toBe(1)
    expect(decision.block).toBe(true)
  })

  it('no visible assistant evidence: stands down with blocked:missing_evidence (goal.py:291-297)', () => {
    const decision = decideStopHook({ goal: activeGoal(), evidenceText: '', stopHookActive: false, runId: 'r', now: NOW })
    expect(decision.block).toBe(false)
    expect(decision.standDownReason).toBe('blocked:missing_evidence')
    expect(decision.nextGoal?.last_evaluation?.blocker).toBe('missing_evidence')
  })

  it('a prior block that left no recorded continuation stops the loop instead of extending it', () => {
    const decision = decideStopHook({
      goal: activeGoal({ continuation_count: 0 }),
      evidenceText: EVIDENCE,
      stopHookActive: true,
      runId: 'r',
      now: NOW,
    })
    expect(decision.block).toBe(false)
    expect(decision.standDownReason).toBe(CONTINUATION_NOT_RECORDED)
  })

  it('the loop terminates at the cap even when every turn brings new evidence', () => {
    let goal: GoalState | null = activeGoal()
    let blocks = 0
    for (let turn = 0; turn < 50; turn++) {
      const decision = decideStopHook({
        goal,
        evidenceText: `assistant output ${turn}`,
        stopHookActive: turn > 0,
        runId: 'r',
        now: NOW,
      })
      goal = decision.nextGoal
      if (!decision.block) break
      blocks += 1
    }
    expect(blocks).toBe(DEFAULT_MAX_GOAL_CONTINUATIONS)
    expect(goal?.last_evaluation?.stand_down_reason).toBe('max_continuations_reached')
  })
})

describe('transcript parsing (defensive)', () => {
  it('skips malformed lines, unknown types and empty text', () => {
    const raw = [
      'not json at all',
      '[]',
      '{"type":"system","message":{"content":"ignored"}}',
      '{"type":"user","message":{"content":[{"type":"text","text":"go"}]}}',
      '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"x"},{"type":"text","text":"done"}]}}',
      '{"type":"assistant","message":{"content":[]}}',
      '',
    ].join('\n')
    expect(parseTranscriptMessages(raw)).toEqual([
      { role: 'user', text: 'go' },
      { role: 'assistant', text: 'done' },
    ])
  })

  it('accepts plain-string content and a top-level content field', () => {
    const raw = ['{"type":"assistant","message":{"content":"plain"}}', '{"type":"user","content":"top level"}'].join('\n')
    expect(parseTranscriptMessages(raw)).toEqual([
      { role: 'assistant', text: 'plain' },
      { role: 'user', text: 'top level' },
    ])
  })

  it('returns nothing for an empty transcript', () => {
    expect(parseTranscriptMessages('')).toEqual([])
  })
})

describe('hook shell', () => {
  const payload = (overrides: Partial<StopHookPayload> = {}): StopHookPayload => ({
    session_id: THREAD,
    hook_event_name: 'Stop',
    stop_hook_active: false,
    ...overrides,
  })

  function makeProject(): { env: NodeJS.ProcessEnv; transcript: string } {
    const dir = mkdtempSync(join(tmpdir(), 'deerflow-goal-'))
    const transcript = join(dir, 'transcript.jsonl')
    writeFileSync(
      transcript,
      [
        '{"type":"user","message":{"content":[{"type":"text","text":"go"}]}}',
        '{"type":"assistant","message":{"content":[{"type":"text","text":"I edited two files."}]}}',
      ].join('\n'),
      'utf8',
    )
    return { env: { CLAUDE_PROJECT_DIR: dir }, transcript }
  }

  it('resolves the thread id from DEERFLOW_THREAD_ID, then the session id', () => {
    expect(resolveThreadId(payload(), { DEERFLOW_THREAD_ID: 'explicit' })).toBe('explicit')
    expect(resolveThreadId(payload(), {})).toBe(THREAD)
    expect(resolveThreadId(payload({ session_id: 'not a valid id!' }), {})).toBeNull()
  })

  it('stands down silently when there is no goal file', () => {
    const { env, transcript } = makeProject()
    const outcome = evaluateStop(payload({ transcript_path: transcript }), { now: NOW, env })
    expect(outcome.decision?.standDownReason).toBe(NO_ACTIVE_GOAL)
    expect(outcome.persisted).toBe(false)
    expect(renderHookOutput(outcome)).toBe('')
  })

  it('blocks on an active goal and persists the continuation BEFORE emitting the block', () => {
    const { env, transcript } = makeProject()
    writeGoal(goalPath(THREAD, env), activeGoal(), NOW)

    const outcome = evaluateStop(payload({ transcript_path: transcript }), { now: NOW, env })
    expect(outcome.decision?.block).toBe(true)
    expect(outcome.persisted).toBe(true)
    expect(readGoal(THREAD, env)?.continuation_count).toBe(1)

    const rendered = JSON.parse(renderHookOutput(outcome)) as { decision: string; reason: string }
    expect(rendered.decision).toBe('block')
    expect(rendered.reason).toContain(GOAL_EVALUATOR_SYSTEM_INSTRUCTION)
    expect(rendered.reason).toContain('Assistant: I edited two files.')
  })

  it('cap-exhausted goal: emits no decision and records the stand-down', () => {
    const { env, transcript } = makeProject()
    writeGoal(goalPath(THREAD, env), activeGoal({ continuation_count: DEFAULT_MAX_GOAL_CONTINUATIONS }), NOW)

    const outcome = evaluateStop(payload({ transcript_path: transcript, stop_hook_active: true }), { now: NOW, env })
    expect(outcome.decision?.block).toBe(false)
    expect(renderHookOutput(outcome)).toBe('')
    expect(readGoal(THREAD, env)?.last_evaluation?.stand_down_reason).toBe('max_continuations_reached')
  })

  it('an unreadable transcript is treated as no evidence, never as an exception', () => {
    const { env } = makeProject()
    writeGoal(goalPath(THREAD, env), activeGoal(), NOW)
    const outcome = evaluateStop(payload({ transcript_path: '/nonexistent/transcript.jsonl' }), { now: NOW, env })
    expect(outcome.decision?.block).toBe(false)
    expect(outcome.decision?.standDownReason).toBe('blocked:missing_evidence')
  })

  it('an unresolvable thread id stands down before touching the filesystem', () => {
    const outcome = evaluateStop(payload({ session_id: 42 }), { now: NOW, env: {} })
    expect(outcome.decision).toBeNull()
    expect(outcome.threadId).toBeNull()
    expect(renderHookOutput(outcome)).toBe('')
  })
})
