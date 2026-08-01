import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DISABLE_ENV_VAR, captureTurnSnapshot } from './turn-snapshot.js'
import { readPreSnapshot, workspacePrePath } from '../artifacts/snapshot.js'

const NOW = '2026-08-01T12:00:00.000Z'
const THREAD = 'thread-snap'
let root: string
let env: NodeJS.ProcessEnv

function write(relative: string, contents: string): void {
  const absolute = join(root, relative)
  mkdirSync(join(absolute, '..'), { recursive: true })
  writeFileSync(absolute, contents)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'deerflow-turn-snapshot-'))
  env = { CLAUDE_PROJECT_DIR: root }
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('the pre-turn snapshot hook', () => {
  it('writes a baseline the Stop hook can read back', () => {
    write('outputs/report.md', '# report')
    write('src/index.ts', 'export {}')

    const outcome = captureTurnSnapshot({ session_id: THREAD }, { now: NOW, env })

    expect(outcome.threadId).toBe(THREAD)
    expect(outcome.filePath).toBe(workspacePrePath(THREAD, env))
    expect(outcome.scanned).toBe(2)
    const restored = readPreSnapshot(outcome.filePath ?? '')
    expect(Object.keys(restored?.files ?? {}).sort()).toEqual(['outputs/report.md', 'src/index.ts'])
  })

  it('replaces the previous baseline rather than appending to it', () => {
    write('outputs/first.md', 'x')
    captureTurnSnapshot({ session_id: THREAD }, { now: NOW, env })
    write('outputs/second.md', 'x')
    captureTurnSnapshot({ session_id: THREAD }, { now: NOW, env })

    const restored = readPreSnapshot(workspacePrePath(THREAD, env))
    expect(Object.keys(restored?.files ?? {}).sort()).toEqual(['outputs/first.md', 'outputs/second.md'])
  })

  it('never records its own state tree — the second turn does not see the first turn baseline', () => {
    write('outputs/a.md', 'x')
    captureTurnSnapshot({ session_id: THREAD }, { now: NOW, env }) // creates .deerflow/state/...
    captureTurnSnapshot({ session_id: THREAD }, { now: NOW, env })
    const restored = readPreSnapshot(workspacePrePath(THREAD, env))

    expect(Object.keys(restored?.files ?? {})).toEqual(['outputs/a.md'])
  })

  it('prefers DEERFLOW_THREAD_ID over the session id', () => {
    const outcome = captureTurnSnapshot(
      { session_id: 'ignored' },
      { now: NOW, env: { ...env, DEERFLOW_THREAD_ID: 'explicit-thread' } },
    )
    expect(outcome.threadId).toBe('explicit-thread')
  })

  it('stands down silently when no thread id resolves', () => {
    const outcome = captureTurnSnapshot({ session_id: 'not a valid id!' }, { now: NOW, env })

    expect(outcome).toEqual({ threadId: null, filePath: null, scanned: 0, truncated: false })
  })

  it('stands down when the escape hatch is set', () => {
    write('outputs/a.md', 'x')
    const outcome = captureTurnSnapshot({ session_id: THREAD }, { now: NOW, env: { ...env, [DISABLE_ENV_VAR]: '1' } })

    expect(outcome.filePath).toBeNull()
    expect(readPreSnapshot(workspacePrePath(THREAD, env))).toBeNull()
  })

  it('never throws when the state file cannot be written', () => {
    const filePath = workspacePrePath(THREAD, env)
    mkdirSync(filePath, { recursive: true }) // A directory where the file belongs.

    expect(() => captureTurnSnapshot({ session_id: THREAD }, { now: NOW, env })).not.toThrow()
    expect(captureTurnSnapshot({ session_id: THREAD }, { now: NOW, env }).filePath).toBeNull()
  })

  it('contains no model, network, or process-spawn call', () => {
    const source = readFileSync(new URL('./turn-snapshot.ts', import.meta.url), 'utf8')

    expect(source).not.toMatch(/child_process|spawn\(|execSync|fetch\(|https?:\/\/(?!\S*deer)/)
    expect(source).not.toContain('process.stdout.write')
  })
})
