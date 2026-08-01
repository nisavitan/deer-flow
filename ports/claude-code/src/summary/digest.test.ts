// Unit tests for the deterministic checkpoint digest.
// The digest replaces a model-generated summary at the compaction boundary, so the property
// that matters is determinism: same state in, byte-identical text out, no model, no clock.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyArtifacts } from '../state/artifacts.js'
import { applyDelegations } from '../state/delegations.js'
import { applyTodos } from '../state/todos.js'
import { buildSummaryDigest, extractTranscriptTail, readTranscript, renderDigestText } from './digest.js'

const NOW = '2026-08-01T12:00:00Z'
let dir: string

function transcriptLine(role: string, content: unknown): string {
  return JSON.stringify({ type: role, message: { role, content } })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'deerflow-digest-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('transcript tail extraction', () => {
  it('keeps user text only, newest last, bounded to the tail window', () => {
    const raw = [
      transcriptLine('user', 'first objective'),
      transcriptLine('assistant', 'working'),
      transcriptLine('user', [{ type: 'text', text: 'second   objective' }]),
    ].join('\n')
    const tail = extractTranscriptTail(raw)
    expect(tail.objectives).toEqual(['first objective', 'second objective'])
    expect(tail.messageCount).toBe(3)
  })

  it('ignores tool_result blocks, which are platform replay and not objectives', () => {
    const raw = transcriptLine('user', [{ type: 'tool_result', content: 'exit 0' }])
    expect(extractTranscriptTail(raw).objectives).toEqual([])
  })

  it('caps the number of retained objectives', () => {
    const raw = Array.from({ length: 9 }, (_, index) => transcriptLine('user', `o${index}`)).join('\n')
    expect(extractTranscriptTail(raw).objectives).toEqual(['o4', 'o5', 'o6', 'o7', 'o8'])
  })

  it('skips unparseable and unexpected lines instead of failing', () => {
    const raw = ['not json', '', '{"broken":', JSON.stringify({ nope: true }), transcriptLine('user', 'ok')].join('\n')
    const tail = extractTranscriptTail(raw)
    expect(tail.objectives).toEqual(['ok'])
    expect(tail.messageCount).toBe(2) // the `{nope:true}` record and the user record
  })

  it('treats a missing transcript as absent, never as an error', () => {
    expect(readTranscript(join(dir, 'nope.jsonl'))).toBeNull()
    expect(readTranscript(null)).toBeNull()
  })
})

describe('buildSummaryDigest', () => {
  it('reads open todos, delegation counts, and artifacts from state files', () => {
    applyTodos(
      join(dir, 'todos.json'),
      [
        { content: 'write   tests', status: 'in_progress' },
        { content: 'ship', status: 'pending' },
        { content: 'done thing', status: 'completed' },
      ],
      { now: NOW },
    )
    applyDelegations(
      join(dir, 'delegations.json'),
      [
        { id: 'd1', description: 'a', subagent_type: 'explore', status: 'completed', created_at: NOW },
        { id: 'd2', description: 'b', subagent_type: 'explore', status: 'failed', created_at: NOW },
        { id: 'd3', description: 'c', subagent_type: 'explore', status: 'completed', created_at: NOW },
      ],
      { now: NOW },
    )
    applyArtifacts(join(dir, 'artifacts.json'), ['outputs/report.md'], { now: NOW })

    const transcript = join(dir, 'session.jsonl')
    writeFileSync(transcript, `${transcriptLine('user', 'ship the port')}\n`)

    const digest = buildSummaryDigest({ stateDir: dir, now: NOW, trigger: 'auto', transcriptPath: transcript })
    expect(digest).toEqual({
      generated_at: NOW,
      trigger: 'auto',
      objectives: ['ship the port'],
      open_todos: [
        { content: 'write tests', status: 'in_progress' },
        { content: 'ship', status: 'pending' },
      ],
      delegations: { total: 3, by_status: { completed: 2, failed: 1 } },
      artifacts: ['outputs/report.md'],
      source_message_count: 1,
    })
  })

  it('produces an empty-but-valid digest when no state file exists', () => {
    const digest = buildSummaryDigest({ stateDir: join(dir, 'missing'), now: NOW, trigger: 'manual' })
    expect(digest).toEqual({
      generated_at: NOW,
      trigger: 'manual',
      objectives: [],
      open_todos: [],
      delegations: { total: 0, by_status: {} },
      artifacts: [],
      source_message_count: 0,
    })
  })

  it('treats a corrupt state file as an empty channel rather than failing', () => {
    writeFileSync(join(dir, 'todos.json'), '{ not json')
    expect(buildSummaryDigest({ stateDir: dir, now: NOW, trigger: 'auto' }).open_todos).toEqual([])
  })

  it('is deterministic: two builds over the same state are byte-identical', () => {
    applyDelegations(
      join(dir, 'delegations.json'),
      [
        { id: 'z', description: 'z', subagent_type: 'explore', status: 'failed', created_at: NOW },
        { id: 'a', description: 'a', subagent_type: 'explore', status: 'completed', created_at: NOW },
      ],
      { now: NOW },
    )
    const first = buildSummaryDigest({ stateDir: dir, now: NOW, trigger: 'auto' })
    const second = buildSummaryDigest({ stateDir: dir, now: NOW, trigger: 'auto' })
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
    // Status keys are sorted, so key order cannot vary with ledger order.
    expect(Object.keys(first.delegations.by_status)).toEqual(['completed', 'failed'])
  })
})

describe('renderDigestText', () => {
  it('renders every populated section and states that no model was called', () => {
    const text = renderDigestText({
      generated_at: NOW,
      trigger: 'auto',
      objectives: ['ship the port'],
      open_todos: [{ content: 'write tests', status: 'in_progress' }],
      delegations: { total: 2, by_status: { completed: 1, failed: 1 } },
      artifacts: ['outputs/report.md'],
      source_message_count: 12,
    })
    expect(text).toContain('Deterministic checkpoint digest (no model was called).')
    expect(text).toContain('- ship the port')
    expect(text).toContain('- [in_progress] write tests')
    expect(text).toContain('Delegations: 2 total (completed=1, failed=1)')
    expect(text).toContain('- outputs/report.md')
    expect(text).toContain('it does not reproduce the compacted conversation')
  })

  it('omits empty sections and stays non-empty for an empty digest', () => {
    const text = renderDigestText({
      generated_at: NOW,
      trigger: 'unknown',
      objectives: [],
      open_todos: [],
      delegations: { total: 0, by_status: {} },
      artifacts: [],
      source_message_count: 0,
    })
    expect(text).not.toContain('Open todos')
    expect(text).not.toContain('Delegations:')
    expect(text.length).toBeGreaterThan(0)
  })
})
