// Unit tests for the PreCompact digest hook.
// The three rules the hook must never break (see its file header): no model call, exit 0
// always, no stdout protocol. The first is structural (nothing here can reach a model), the
// second and third are pinned below.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { queuePath, readQueue } from '../memory/queue.js'
import { applyTodos } from '../state/todos.js'
import { readSummary, summaryPath } from '../summary/summary-state.js'
import { resolveThreadId, resolveTrigger, snapshotSummary, snapshotSummaryDetailed } from './precompact-summary.js'

const NOW = '2026-08-01T12:00:00Z'
let root: string
let env: NodeJS.ProcessEnv

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'deerflow-precompact-'))
  env = { CLAUDE_PROJECT_DIR: root } as NodeJS.ProcessEnv
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('thread resolution', () => {
  it('prefers an exported DEERFLOW_THREAD_ID', () => {
    expect(resolveThreadId({ session_id: 'sess-1' }, { DEERFLOW_THREAD_ID: 'thread-9' } as NodeJS.ProcessEnv)).toBe(
      'thread-9',
    )
  })

  it('falls back to the session id, which IS the port thread id', () => {
    expect(resolveThreadId({ session_id: 'sess-1' }, {} as NodeJS.ProcessEnv)).toBe('sess-1')
  })

  it('stands down rather than inventing a directory for an unusable id', () => {
    expect(resolveThreadId({ session_id: 'has/slash' }, {} as NodeJS.ProcessEnv)).toBeNull()
    expect(resolveThreadId({ session_id: 42 }, {} as NodeJS.ProcessEnv)).toBeNull()
    expect(resolveThreadId({}, {} as NodeJS.ProcessEnv)).toBeNull()
    expect(resolveThreadId({ session_id: 'ok' }, { DEERFLOW_THREAD_ID: 'bad/id' } as NodeJS.ProcessEnv)).toBe('ok')
  })
})

describe('trigger normalization', () => {
  it('passes through the two documented triggers and records anything else as unknown', () => {
    expect(resolveTrigger({ trigger: 'auto' })).toBe('auto')
    expect(resolveTrigger({ trigger: 'manual' })).toBe('manual')
    expect(resolveTrigger({ trigger: 'weird' })).toBe('unknown')
    expect(resolveTrigger({})).toBe('unknown')
  })
})

describe('snapshotSummary', () => {
  it('writes summary.json with the digest, provenance, and a compaction record', () => {
    mkdirSync(join(root, '.deerflow', 'state', 'thread-1'), { recursive: true })
    applyTodos(join(root, '.deerflow', 'state', 'thread-1', 'todos.json'), [{ content: 'ship', status: 'pending' }], {
      now: NOW,
    })
    const transcript = join(root, 'session.jsonl')
    writeFileSync(transcript, `${JSON.stringify({ message: { role: 'user', content: 'ship the port' } })}\n`)

    const written = snapshotSummary(
      { session_id: 'thread-1', transcript_path: transcript, trigger: 'auto' },
      { now: NOW, env },
    )

    expect(written).toBe(summaryPath('thread-1', env))
    const payload = readSummary(written as string)?.payload
    expect(payload?.updated_by).toBe('precompact')
    expect(payload?.digest?.objectives).toEqual(['ship the port'])
    expect(payload?.digest?.open_todos).toEqual([{ content: 'ship', status: 'pending' }])
    expect(payload?.compactions).toEqual([{ at: NOW, trigger: 'auto', updated_by: 'precompact' }])
    expect(payload?.summary_text).toContain('Deterministic checkpoint digest (no model was called)')
  })

  it('creates the state directory for a thread that has none yet', () => {
    const written = snapshotSummary({ session_id: 'fresh' }, { now: NOW, env })
    expect(written).toBe(summaryPath('fresh', env))
    expect(readSummary(written as string)?.payload.digest?.source_message_count).toBe(0)
  })

  it('records repeated compactions in order', () => {
    snapshotSummary({ session_id: 't', trigger: 'auto' }, { now: NOW, env })
    snapshotSummary({ session_id: 't', trigger: 'manual' }, { now: '2026-08-01T13:00:00Z', env })
    const compactions = readSummary(summaryPath('t', env))?.payload.compactions ?? []
    expect(compactions.map((record) => record.trigger)).toEqual(['auto', 'manual'])
  })

  it('stands down (no throw, no file) when the thread cannot be resolved', () => {
    expect(snapshotSummary({ session_id: 'bad/id' }, { now: NOW, env })).toBeNull()
  })

  it('survives an unreadable transcript and still writes the state-derived digest', () => {
    const written = snapshotSummary(
      { session_id: 'thread-2', transcript_path: join(root, 'gone.jsonl') },
      { now: NOW, env },
    )
    expect(written).not.toBeNull()
    expect(readSummary(written as string)?.payload.digest?.objectives).toEqual([])
  })

  it('never throws when the state path cannot be written', () => {
    // A file where the thread directory must be: mkdir fails inside the writer.
    const stateDir = join(root, '.deerflow', 'state')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 'blocked'), 'not a directory')
    expect(snapshotSummary({ session_id: 'blocked' }, { now: NOW, env })).toBeNull()
  })

  it('does not read or write anything outside the thread state dir', () => {
    const written = snapshotSummary({ session_id: 'scoped' }, { now: NOW, env }) as string
    expect(written.startsWith(join(root, '.deerflow', 'state', 'scoped'))).toBe(true)
  })
})

// DISCREPANCIES §M8 entry 4: the loss window at the compaction boundary. Upstream's
// `before_summarization` hooks flush the messages about to disappear into durable memory; the port
// does the same here, through the same queue the Stop hook uses.
describe('memory flush at the compaction boundary', () => {
  function transcriptWith(...records: { role: string; content: string }[]): string {
    return `${records.map((record) => JSON.stringify({ type: record.role, message: record })).join('\n')}\n`
  }

  it('enqueues the conversation tail alongside the digest, tagged with its source', () => {
    const transcript = join(root, 'session.jsonl')
    writeFileSync(
      transcript,
      transcriptWith(
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: 'first answer' },
        { role: 'user', content: 'port the flush' },
        { role: 'assistant', content: 'flushed at the boundary' },
      ),
    )

    const outcome = snapshotSummaryDetailed({ session_id: 'thread-1', transcript_path: transcript }, { now: NOW, env })

    expect(outcome.filePath).toBe(summaryPath('thread-1', env))
    expect(outcome.queued).toBe(1)
    // Last user + last assistant, exactly like the Stop hook's capture.
    expect(readQueue(env)).toEqual([
      {
        capturedAt: NOW,
        sessionId: 'thread-1',
        user: 'port the flush',
        assistant: 'flushed at the boundary',
        source: 'precompact-flush',
      },
    ])
  })

  it('writes nothing to the queue when the transcript yields no complete turn', () => {
    const transcript = join(root, 'partial.jsonl')
    // A user message with no assistant reply: `extractTurn` requires both halves.
    writeFileSync(transcript, transcriptWith({ role: 'user', content: 'only half a turn' }))

    const outcome = snapshotSummaryDetailed({ session_id: 'thread-1', transcript_path: transcript }, { now: NOW, env })

    expect(outcome.filePath).not.toBeNull()
    expect(outcome.queued).toBe(0)
    expect(existsSync(queuePath(env))).toBe(false)
  })

  it('never throws and never queues on a malformed transcript — the digest is still written', () => {
    const transcript = join(root, 'corrupt.jsonl')
    writeFileSync(transcript, '{ truncated\nnot json at all\n[]\n')

    const outcome = snapshotSummaryDetailed({ session_id: 'thread-2', transcript_path: transcript }, { now: NOW, env })

    expect(outcome.filePath).toBe(summaryPath('thread-2', env))
    expect(outcome.queued).toBe(0)
    expect(readQueue(env)).toEqual([])
  })

  it('does not flush when the hook stood down before writing a digest', () => {
    const transcript = join(root, 'orphan.jsonl')
    writeFileSync(transcript, transcriptWith({ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }))

    expect(snapshotSummaryDetailed({ session_id: 'bad/id', transcript_path: transcript }, { now: NOW, env })).toEqual({
      filePath: null,
      digest: null,
      queued: 0,
    })
    expect(readQueue(env)).toEqual([])
  })
})

describe('hook module shape', () => {
  it('contains no model, network, or process-spawn call', () => {
    // Rule 1 is structural; this asserts it stays that way under future edits.
    const source = readFileSync(new URL('./precompact-summary.ts', import.meta.url), 'utf8')
    for (const forbidden of ['fetch(', 'https://', 'child_process', 'execSync', 'spawn(']) {
      expect(source).not.toContain(forbidden)
    }
  })
})
