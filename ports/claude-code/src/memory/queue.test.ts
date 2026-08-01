// Capture-queue tests: defensive transcript parsing plus the import-safety invariant.
//
// The import-safety test exists because of a real defect found by end-to-end smoke testing and
// NOT by unit tests: `store-cli.ts` originally imported `queuePath` from the hook module, whose
// top level *is* the executable Stop hook. Importing it therefore ran the hook, which attached
// stdin listeners and destroyed the stream — so `store-cli.js apply` never received its piped
// input and exited on an unsettled top-level await. The fix was this module; the test below
// keeps the boundary from being re-crossed.
import { readFileSync } from 'node:fs'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_CAPTURED_CHARS, QUEUE_FILE_NAME, appendQueueEntry, clearQueue, extractText, extractTurn, queuePath, readQueue } from './queue.js'

const HERE = dirname(fileURLToPath(import.meta.url))
let projectDir: string
let env: NodeJS.ProcessEnv

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'deerflow-queue-'))
  env = { CLAUDE_PROJECT_DIR: projectDir }
})

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true })
})

function transcriptOf(...records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n')
}

describe('import safety', () => {
  it('the queue module has no executable top level (no bare await / process.exit)', () => {
    const source = readFileSync(join(HERE, 'queue.ts'), 'utf8')
    const topLevel = source.split('\n').filter((line) => line.length > 0 && !line.startsWith(' ') && !line.startsWith('}') && !line.startsWith('//'))
    for (const line of topLevel) {
      expect(line).not.toMatch(/^await /)
      expect(line).not.toMatch(/^process\./)
      expect(line).not.toMatch(/^try \{/)
    }
  })

  it('store-cli does not import from the executable hook module', () => {
    // Importing src/hooks/memory-extract.js RUNS the Stop hook, consuming the CLI's stdin.
    const source = readFileSync(join(HERE, 'store-cli.ts'), 'utf8')
    expect(source).not.toContain('hooks/memory-extract')
  })

  it('the hook module keeps its reusable logic in the queue module', () => {
    const source = readFileSync(join(HERE, '..', 'hooks', 'memory-extract.ts'), 'utf8')
    expect(source).toContain("from '../memory/queue.js'")
  })
})

describe('extractText', () => {
  it('passes a bare string through', () => {
    expect(extractText('hello')).toBe('hello')
  })

  it('joins the text blocks of an array', () => {
    expect(extractText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('a b')
  })

  it('ignores blocks with no text field (tool_use / tool_result / images)', () => {
    expect(extractText([{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }])).toBe('')
    expect(extractText([{ type: 'tool_result', content: 'output' }])).toBe('')
    expect(extractText([{ type: 'image', source: {} }, { type: 'text', text: 'caption' }])).toBe('caption')
  })

  it.each([[null], [undefined], [42], [{}], [[null, 1, true]]])('returns "" for the unusable content %p', (content) => {
    expect(extractText(content)).toBe('')
  })
})

describe('extractTurn', () => {
  it('picks the LAST user message and the LAST assistant response', () => {
    const turn = extractTurn(
      transcriptOf(
        { type: 'user', message: { role: 'user', content: 'first question' } },
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] } },
        { type: 'user', message: { role: 'user', content: 'second question' } },
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'second answer' }] } },
      ),
    )
    expect(turn).toEqual({ user: 'second question', assistant: 'second answer' })
  })

  it('accepts a record that carries role at the top level', () => {
    expect(extractTurn(transcriptOf({ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }))).toEqual({ user: 'q', assistant: 'a' })
  })

  it('requires BOTH a human and an AI message, matching deer_mem.py:202-293', () => {
    expect(extractTurn(transcriptOf({ type: 'user', message: { role: 'user', content: 'q' } }))).toBeNull()
    expect(extractTurn(transcriptOf({ type: 'assistant', message: { role: 'assistant', content: 'a' } }))).toBeNull()
    expect(extractTurn('')).toBeNull()
  })

  it('does not treat a tool_result user record as a user utterance', () => {
    const turn = extractTurn(
      transcriptOf(
        { type: 'user', message: { role: 'user', content: 'run the tests' } },
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash' }] } },
        { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: '911 passed' }] } },
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'all green' }] } },
      ),
    )
    expect(turn).toEqual({ user: 'run the tests', assistant: 'all green' })
  })

  it('skips a corrupt line without discarding the turn', () => {
    const transcript = ['{"type":"user","message":{"role":"user","content":"q"}}', '{ this is not json', '', '{"type":"assistant","message":{"role":"assistant","content":"a"}}'].join('\n')
    expect(extractTurn(transcript)).toEqual({ user: 'q', assistant: 'a' })
  })

  it('ignores records with unknown roles', () => {
    const turn = extractTurn(transcriptOf({ type: 'system', message: { role: 'system', content: 'ignore me' } }, { role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }))
    expect(turn).toEqual({ user: 'q', assistant: 'a' })
  })

  it('clamps an oversized message', () => {
    const turn = extractTurn(transcriptOf({ role: 'user', content: 'x'.repeat(MAX_CAPTURED_CHARS + 5000) }, { role: 'assistant', content: 'a' }))
    expect(turn?.user.endsWith('\n[truncated]')).toBe(true)
    expect(turn?.user.length).toBe(MAX_CAPTURED_CHARS + '\n[truncated]'.length)
  })
})

describe('queue file', () => {
  it('lives at .deerflow/memory/queue.jsonl', () => {
    expect(queuePath(env)).toBe(join(projectDir, '.deerflow', 'memory', QUEUE_FILE_NAME))
  })

  it('reads empty before anything is captured', () => {
    expect(readQueue(env)).toEqual([])
  })

  it('appends and reads back, preserving order', () => {
    appendQueueEntry({ capturedAt: 't1', sessionId: 's1', user: 'q1', assistant: 'a1' }, env)
    appendQueueEntry({ capturedAt: 't2', sessionId: 's1', user: 'q2', assistant: 'a2' }, env)
    expect(readQueue(env).map((entry) => entry.user)).toEqual(['q1', 'q2'])
  })

  it('coalesces several turns into one batch — the surviving half of the debounce', () => {
    for (let index = 0; index < 5; index += 1) appendQueueEntry({ capturedAt: `t${index}`, sessionId: 's', user: `q${index}`, assistant: `a${index}` }, env)
    expect(readQueue(env)).toHaveLength(5)
  })

  it('skips a corrupt or incomplete line without losing the rest', () => {
    mkdirSync(dirname(queuePath(env)), { recursive: true })
    writeFileSync(queuePath(env), ['{"user":"q1","assistant":"a1"}', 'not json', '{"user":"only-user"}', '{"user":"q2","assistant":"a2"}'].join('\n'), 'utf8')
    expect(readQueue(env).map((entry) => entry.user)).toEqual(['q1', 'q2'])
  })

  it('clears, and clearing an absent queue is not an error', () => {
    appendQueueEntry({ capturedAt: 't', sessionId: null, user: 'q', assistant: 'a' }, env)
    clearQueue(env)
    expect(readQueue(env)).toEqual([])
    expect(() => clearQueue(env)).not.toThrow()
  })
})
