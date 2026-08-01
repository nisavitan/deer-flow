// The two read-before-write hooks are tested together because neither one is meaningful alone: the
// property under test is the HANDSHAKE — a Read opens the gate for exactly the version it saw, and a
// write closes it again.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { evaluateWriteGate } from './write-gate.js'
import { stampReadFromPayload } from './read-mark.js'
import { DISABLE_READ_GATE_ENV_VAR, loadReadMarks, readMarksPath } from '../middleware/read-marks.js'

const NOW = '2026-08-01T00:00:00.000Z'
const THREAD = 'thread-gate'
let root: string
let env: NodeJS.ProcessEnv

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'deerflow-write-gate-'))
  env = { CLAUDE_PROJECT_DIR: root }
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function fixture(name: string, content: string): string {
  const filePath = join(root, name)
  mkdirSync(join(filePath, '..'), { recursive: true })
  writeFileSync(filePath, content, 'utf8')
  return filePath
}

function read(filePath: string): string | null {
  return stampReadFromPayload(
    { session_id: THREAD, tool_name: 'Read', tool_input: { file_path: filePath } },
    { now: NOW, env },
  )
}

function write(toolName: string, filePath: string): ReturnType<typeof evaluateWriteGate> {
  return evaluateWriteGate({ session_id: THREAD, tool_name: toolName, tool_input: { file_path: filePath } }, { env })
}

describe('read-before-write — the handshake', () => {
  it('denies an unread existing file and allows it after a Read', () => {
    const filePath = fixture('doc.md', 'v1\n')

    const denied = write('Edit', filePath)
    expect(denied?.deny).toContain('already exists and you have not read its current version')
    expect(denied?.deny).toContain(filePath)

    expect(read(filePath)).toBe(filePath)
    expect(write('Edit', filePath)).toBeNull()
    expect(write('Write', filePath)).toBeNull()
  })

  it('re-closes the gate once the file changes (writes never refresh a mark)', () => {
    const filePath = fixture('doc.md', 'v1\n')
    read(filePath)
    expect(write('Edit', filePath)).toBeNull()

    // The write lands. Nothing stamps a new mark, so the next modification must re-read.
    writeFileSync(filePath, 'v1\nv2\n', 'utf8')
    expect(write('Edit', filePath)?.deny).toContain('Any write invalidates earlier reads')

    read(filePath)
    expect(write('Edit', filePath)).toBeNull()
  })

  it('names the NATIVE read tool in the deny message, not read_file', () => {
    const filePath = fixture('doc.md', 'v1\n')
    const deny = write('Write', filePath)?.deny ?? ''
    expect(deny).toContain('Call Read on it')
    expect(deny).not.toContain('read_file')
  })

  it('allows creating a file that does not exist', () => {
    expect(write('Write', join(root, 'brand-new.md'))).toBeNull()
  })

  it('does not gate tools outside Write/Edit', () => {
    const filePath = fixture('doc.md', 'v1\n')
    expect(write('Read', filePath)).toBeNull()
    expect(write('Bash', filePath)).toBeNull()
    expect(write('NotebookEdit', filePath)).toBeNull()
  })

  it('stands down on a malformed payload instead of denying', () => {
    expect(evaluateWriteGate({ session_id: THREAD, tool_name: 'Write', tool_input: {} }, { env })).toBeNull()
    expect(evaluateWriteGate({ session_id: THREAD, tool_name: 'Write', tool_input: null }, { env })).toBeNull()
    // No resolvable thread -> no mark store to consult -> fail open.
    expect(
      evaluateWriteGate({ tool_name: 'Write', tool_input: { file_path: fixture('a.md', 'x') } }, { env }),
    ).toBeNull()
  })
})

describe('read-before-write — the escape hatch', () => {
  it('disables both halves together', () => {
    const disabled = { ...env, [DISABLE_READ_GATE_ENV_VAR]: '1' }
    const filePath = fixture('doc.md', 'v1\n')

    expect(
      stampReadFromPayload(
        { session_id: THREAD, tool_name: 'Read', tool_input: { file_path: filePath } },
        { now: NOW, env: disabled },
      ),
    ).toBeNull()
    expect(loadReadMarks(readMarksPath(THREAD, disabled))).toEqual([])
    expect(
      evaluateWriteGate({ session_id: THREAD, tool_name: 'Write', tool_input: { file_path: filePath } }, {
        env: disabled,
      }),
    ).toBeNull()
  })
})

describe('read-mark stamping', () => {
  it('marks nothing for a non-Read tool, a missing path, or an absent file', () => {
    expect(
      stampReadFromPayload({ session_id: THREAD, tool_name: 'Bash', tool_input: { file_path: '/x' } }, { now: NOW, env }),
    ).toBeNull()
    expect(stampReadFromPayload({ session_id: THREAD, tool_name: 'Read', tool_input: {} }, { now: NOW, env })).toBeNull()
    expect(
      stampReadFromPayload(
        { session_id: THREAD, tool_name: 'Read', tool_input: { file_path: join(root, 'gone.md') } },
        { now: NOW, env },
      ),
    ).toBeNull()
  })

  it('keeps one mark per path, refreshed on each read', () => {
    const filePath = fixture('doc.md', 'v1\n')
    read(filePath)
    writeFileSync(filePath, 'v2\n', 'utf8')
    read(filePath)
    const marks = loadReadMarks(readMarksPath(THREAD, env))
    expect(marks).toHaveLength(1)
    expect(marks[0]?.path).toBe(filePath)
  })
})
