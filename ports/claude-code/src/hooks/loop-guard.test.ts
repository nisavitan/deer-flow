// End-to-end for the M7 loop guard: real state files, real thresholds, no mocks.
//
// The scenario mirrors parity-test-plan.md S10 ("force identical Grep calls"): allow through the
// warn, keep allowing, then deny with the `[FORCED STOP]` marker, and leave `loop_capped` behind in
// the state files.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DISABLE_ENV_VAR, LOOP_STATE_FILE, evaluateLoopGuard } from './loop-guard.js'
import { LOOP_HARD_STOP_MESSAGE, LOOP_STOP_REASON, LOOP_WARNING_MESSAGE } from '../middleware/loop-detection.js'
import { threadStateFile } from '../state/paths.js'
import { runMetaPath, startRun, type RunMetaPayload } from '../state/run-meta.js'
import { readStateFile } from '../state/atomic-io.js'

const NOW = '2026-08-01T00:00:00.000Z'
const THREAD = 'thread-loop'
let root: string
let env: NodeJS.ProcessEnv

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'deerflow-loop-guard-'))
  env = { CLAUDE_PROJECT_DIR: root }
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function fire(toolName: string, toolInput: unknown): ReturnType<typeof evaluateLoopGuard> {
  return evaluateLoopGuard({ session_id: THREAD, tool_name: toolName, tool_input: toolInput }, { now: NOW, env })
}

describe('loop guard — the S10 walk', () => {
  it('warns at the third identical call and denies from the fifth', () => {
    const input = { pattern: 'TODO', path: '/src' }
    const outputs = [1, 2, 3, 4, 5, 6].map(() => fire('Grep', input))

    expect(outputs[0]).toBeNull()
    expect(outputs[1]).toBeNull()

    // Third: the DeerFlow warning, delivered as context AND as a transcript line. Crucially it is
    // NOT a permission decision — the call still runs under the platform's normal permission flow.
    expect(outputs[2]).toEqual({ additionalContext: LOOP_WARNING_MESSAGE, systemMessage: LOOP_WARNING_MESSAGE })

    // Fourth: warn-once semantics — the same hash does not re-warn while it stays in the window.
    expect(outputs[3]).toBeNull()

    // Fifth and every call after: denied with the verbatim forced-stop text.
    expect(outputs[4]).toEqual({ deny: LOOP_HARD_STOP_MESSAGE })
    expect(outputs[5]).toEqual({ deny: LOOP_HARD_STOP_MESSAGE })
    expect(LOOP_HARD_STOP_MESSAGE).toContain('[FORCED STOP]')
  })

  it('records loop_capped in the loop state file', () => {
    for (let index = 0; index < 5; index += 1) fire('Grep', { pattern: 'TODO', path: '/src' })
    const stored = JSON.parse(readFileSync(threadStateFile(THREAD, LOOP_STATE_FILE, env), 'utf8')) as {
      stop_reason: string
    }
    expect(stored.stop_reason).toBe(LOOP_STOP_REASON)
  })

  it('stamps loop_capped onto an existing run record', () => {
    const filePath = runMetaPath(THREAD, env)
    startRun(filePath, { runId: 'run-1', threadId: THREAD, commitSha: 'abc', now: NOW }, { now: NOW })

    for (let index = 0; index < 5; index += 1) fire('Grep', { pattern: 'TODO', path: '/src' })

    const run = readStateFile<RunMetaPayload>(filePath)?.payload.run
    expect(run?.stop_reason).toBe(LOOP_STOP_REASON)
    // The guard reports a cap; it does not terminate the run record.
    expect(run?.status).toBe('running')
  })

  it('denies without a run record present (a missing record is not a reason to allow the loop)', () => {
    for (let index = 0; index < 4; index += 1) fire('Grep', { pattern: 'TODO', path: '/src' })
    expect(fire('Grep', { pattern: 'TODO', path: '/src' })).toEqual({ deny: LOOP_HARD_STOP_MESSAGE })
  })
})

describe('loop guard — what it does not touch', () => {
  it('ignores unguarded tools entirely, however often they repeat', () => {
    for (let index = 0; index < 10; index += 1) {
      expect(fire('Agent', { description: 'same task' })).toBeNull()
    }
  })

  it('stands down when no thread id can be resolved', () => {
    const output = evaluateLoopGuard({ tool_name: 'Grep', tool_input: { pattern: 'x' } }, { now: NOW, env })
    expect(output).toBeNull()
  })

  it('honours the disable switch', () => {
    const disabled = { ...env, [DISABLE_ENV_VAR]: '1' }
    for (let index = 0; index < 8; index += 1) {
      expect(
        evaluateLoopGuard(
          { session_id: THREAD, tool_name: 'Grep', tool_input: { pattern: 'x' } },
          { now: NOW, env: disabled },
        ),
      ).toBeNull()
    }
  })

  it('does not conflate distinct calls to the same tool at the hash layer', () => {
    for (let index = 0; index < 8; index += 1) {
      expect(fire('Grep', { pattern: `unique-${index}`, path: '/src' })).toBeNull()
    }
  })
})

describe('loop guard — the frequency layer reaches the model too', () => {
  it('warns at 30 distinct calls to one tool and denies at 50', () => {
    const decisions: (ReturnType<typeof evaluateLoopGuard>)[] = []
    for (let index = 0; index < 50; index += 1) {
      decisions.push(fire('Read', { file_path: `/repo/f${index}.ts` }))
    }
    const warned = decisions.filter((output) => output?.systemMessage !== undefined)
    expect(warned).toHaveLength(1)
    expect(warned[0]?.systemMessage).toContain('You have called read_file 30 times')
    expect(decisions[49]).toEqual({ deny: expect.stringContaining('[FORCED STOP] Tool read_file called 50 times') })
  })
})
