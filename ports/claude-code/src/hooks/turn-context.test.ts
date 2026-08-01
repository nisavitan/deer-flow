import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DISABLE_ENV_VAR, buildTurnContext, evaluateTurnContext, renderDateReminder } from './turn-context.js'
import { AUTHORITY_CONTRACT } from '../summary/durable-context.js'
import { applyDelegations, delegationsPath } from '../state/delegations.js'
import { applySummary, summaryPath } from '../summary/summary-state.js'

const NOW = new Date(2026, 7, 1, 9, 30, 0) // 2026-08-01, a Saturday
const ISO = '2026-08-01T00:00:00.000Z'
const THREAD = 'thread-turn'
let root: string
let env: NodeJS.ProcessEnv

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'deerflow-turn-context-'))
  env = { CLAUDE_PROJECT_DIR: root }
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('turn context — the date reminder', () => {
  it('renders the original reminder format verbatim', () => {
    expect(renderDateReminder(NOW)).toBe(
      ['<system-reminder>', '<current_date>2026-08-01, Saturday</current_date>', '</system-reminder>'].join('\n'),
    )
  })

  it('injects the date on every turn, even with no state at all', () => {
    const context = buildTurnContext({ session_id: THREAD, prompt: 'hello' }, { now: NOW, env })
    expect(context).toBe(renderDateReminder(NOW))
  })

  it('injects the date even when no thread id resolves', () => {
    expect(buildTurnContext({ prompt: 'hello' }, { now: NOW, env })).toBe(renderDateReminder(NOW))
  })

  it('honours the disable switch', () => {
    expect(buildTurnContext({ session_id: THREAD }, { now: NOW, env: { ...env, [DISABLE_ENV_VAR]: '1' } })).toBeNull()
  })
})

describe('turn context — the durable projection', () => {
  it('appends the authority contract and the fenced data block once state exists', () => {
    applySummary(
      summaryPath(THREAD, env),
      { summaryText: 'The user is porting DeerFlow to Claude Code.', updatedBy: 'precompact' },
      { now: ISO },
    )
    applyDelegations(
      delegationsPath(THREAD, env),
      [
        {
          id: 'run-1:0',
          run_id: 'run-1',
          description: 'survey the middleware chain',
          subagent_type: 'general-purpose',
          status: 'completed',
          created_at: ISO,
        },
      ],
      { now: ISO },
    )

    const context = buildTurnContext({ session_id: THREAD }, { now: NOW, env }) ?? ''
    expect(context.startsWith(renderDateReminder(NOW))).toBe(true)
    expect(context).toContain(AUTHORITY_CONTRACT)
    expect(context).toContain('<durable_context_data>')
    expect(context).toContain('</durable_context_data>')
    expect(context).toContain('The user is porting DeerFlow to Claude Code.')
    expect(context).toContain('survey the middleware chain')
  })

  it('emits no data block at all when every channel is empty', () => {
    const context = buildTurnContext({ session_id: THREAD }, { now: NOW, env }) ?? ''
    expect(context).not.toContain('<durable_context_data>')
    expect(context).not.toContain(AUTHORITY_CONTRACT)
  })

  it('still injects the date when the state tree is unreadable', () => {
    // A corrupt channel must not cost the turn its date.
    const corrupt = { CLAUDE_PROJECT_DIR: join(root, 'does', 'not', 'exist') }
    expect(buildTurnContext({ session_id: THREAD }, { now: NOW, env: corrupt })).toBe(renderDateReminder(NOW))
  })

  it('wraps the block as UserPromptSubmit additionalContext', () => {
    const output = evaluateTurnContext({ session_id: THREAD }, { now: NOW, env })
    expect(output).toEqual({ additionalContext: renderDateReminder(NOW) })
  })
})
