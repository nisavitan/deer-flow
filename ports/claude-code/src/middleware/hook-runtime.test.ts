import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  appendHookLog,
  flattenToolResponse,
  formatCurrentDate,
  hookLogPath,
  inferResultStatus,
  parseHookPayload,
  renderHookOutput,
  resolveThreadId,
} from './hook-runtime.js'

describe('hook runtime — payload handling', () => {
  it('parses an object payload and rejects everything else', () => {
    expect(parseHookPayload('{"tool_name":"Bash"}')).toEqual({ tool_name: 'Bash' })
    expect(parseHookPayload('')).toBeNull()
    expect(parseHookPayload('[]')).toBeNull()
    expect(parseHookPayload('"a string"')).toBeNull()
    expect(parseHookPayload('{ truncated')).toBeNull()
  })

  it('prefers DEERFLOW_THREAD_ID, falls back to a contract-shaped session id', () => {
    expect(resolveThreadId({ session_id: 'sess-1' }, { DEERFLOW_THREAD_ID: 'thread-a' })).toBe('thread-a')
    expect(resolveThreadId({ session_id: 'sess-1' }, {})).toBe('sess-1')
    // A session id that cannot be a directory name yields null rather than inventing one.
    expect(resolveThreadId({ session_id: '../escape' }, {})).toBeNull()
    expect(resolveThreadId({}, {})).toBeNull()
    expect(resolveThreadId({ session_id: 'sess-1' }, { DEERFLOW_THREAD_ID: 'bad/id' })).toBe('sess-1')
  })
})

describe('hook runtime — output protocol', () => {
  it('emits a deny decision only for PreToolUse', () => {
    expect(renderHookOutput('PreToolUse', { deny: 'nope' })).toBe(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'nope' },
      }),
    )
    // A deny on a PostToolUse event is meaningless and is dropped rather than emitted malformed.
    expect(renderHookOutput('PostToolUse', { deny: 'nope' })).toBeNull()
  })

  it('NEVER emits permissionDecision "allow" — allowing is abstaining', () => {
    const rendered = renderHookOutput('PreToolUse', { additionalContext: 'warning', systemMessage: 'warning' })
    expect(rendered).not.toContain('permissionDecision')
    expect(rendered).toContain('"additionalContext":"warning"')
    expect(rendered).toContain('"systemMessage":"warning"')
  })

  it('writes nothing at all for an empty decision', () => {
    expect(renderHookOutput('PostToolUse', {})).toBeNull()
    expect(renderHookOutput('UserPromptSubmit', { additionalContext: '' })).toBeNull()
  })
})

describe('hook runtime — the current date', () => {
  it('formats exactly as strftime("%Y-%m-%d, %A")', () => {
    // 2026-08-01 is a Saturday.
    expect(formatCurrentDate(new Date(2026, 7, 1, 12, 0, 0))).toBe('2026-08-01, Saturday')
    expect(formatCurrentDate(new Date(2026, 0, 5, 0, 0, 0))).toBe('2026-01-05, Monday')
  })
})

describe('hook runtime — tool responses', () => {
  it('flattens every shape a tool result can arrive in', () => {
    expect(flattenToolResponse('plain')).toBe('plain')
    expect(flattenToolResponse([{ type: 'text', text: 'a' }, 'b'])).toBe('a\nb')
    expect(flattenToolResponse({ stdout: 'out', stderr: 'err' })).toBe('out\nerr')
    expect(flattenToolResponse({ content: [{ type: 'text', text: 'nested' }] })).toBe('nested')
    expect(flattenToolResponse(42)).toBe('')
    expect(flattenToolResponse(null)).toBe('')
  })

  it('infers an error status only from an explicit failure flag', () => {
    expect(inferResultStatus({ is_error: true })).toBe('error')
    expect(inferResultStatus({ isError: true })).toBe('error')
    expect(inferResultStatus({ success: false })).toBe('error')
    expect(inferResultStatus({ interrupted: true })).toBe('error')
    // Erring toward success: a false "error" would tell the model to abandon a tool that worked.
    expect(inferResultStatus({ stdout: 'error: something in the OUTPUT' })).toBe('success')
    expect(inferResultStatus('plain text')).toBe('success')
  })
})

describe('hook runtime — O3 hook log', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'deerflow-hooklog-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('resolves the log path under CLAUDE_PROJECT_DIR', () => {
    expect(hookLogPath({ CLAUDE_PROJECT_DIR: root } as NodeJS.ProcessEnv)).toBe(
      join(root, '.deerflow', 'logs', 'hooks.jsonl'),
    )
  })

  it('appends one valid JSON line per call, creating the log directory on demand', () => {
    const env = { CLAUDE_PROJECT_DIR: root } as NodeJS.ProcessEnv
    appendHookLog({ hook: 'write-gate', event: 'PreToolUse', thread: 'thread-1', decision: 'deny', summary: 'path=x' }, env)
    appendHookLog({ hook: 'turn-context', event: 'UserPromptSubmit', thread: null, decision: 'context' }, env)

    const lines = readFileSync(hookLogPath(env), 'utf8').split('\n').filter((line) => line !== '')
    expect(lines).toHaveLength(2)
    const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(records[0]).toMatchObject({
      hook: 'write-gate',
      event: 'PreToolUse',
      thread: 'thread-1',
      decision: 'deny',
      summary: 'path=x',
    })
    // The timestamp is stamped by the writer, first, and is a parseable ISO-8601 instant.
    expect(Object.keys(records[0] as object)[0]).toBe('ts')
    expect(Number.isNaN(Date.parse(String(records[0]?.['ts'])))).toBe(false)
    // An omitted summary is omitted from the record rather than written as null.
    expect(records[1]).toMatchObject({ hook: 'turn-context', thread: null, decision: 'context' })
    expect(records[1]).not.toHaveProperty('summary')
  })

  it('never throws when the log directory cannot be created', () => {
    // `/dev/null` is not a directory, so every mkdir below it fails with ENOTDIR.
    expect(() =>
      appendHookLog(
        { hook: 'env-guard', event: 'PreToolUse', thread: null, decision: 'deny' },
        { CLAUDE_PROJECT_DIR: '/dev/null/x' } as NodeJS.ProcessEnv,
      ),
    ).not.toThrow()
  })

  it('never throws when the log path is an unwritable file', () => {
    // A directory where the log file must be: appendFileSync fails with EISDIR.
    mkdirSync(join(root, '.deerflow', 'logs', 'hooks.jsonl'), { recursive: true })
    expect(() =>
      appendHookLog(
        { hook: 'env-guard', event: 'PreToolUse', thread: null, decision: 'deny' },
        { CLAUDE_PROJECT_DIR: root } as NodeJS.ProcessEnv,
      ),
    ).not.toThrow()
  })
})

// The end-to-end assertion the Tier-2 suite depends on: a REAL hook process, launched the way
// Claude Code launches it (compiled JS, payload on stdin, cwd inside the project), leaves a deny
// line in hooks.jsonl. Everything above tests the writer; this tests the wiring.
describe('hook runtime — O3 end to end (built hook subprocess)', () => {
  const projectRoot = fileURLToPath(new URL('../../', import.meta.url))
  let outDir: string
  let workspace: string

  beforeAll(() => {
    // `realpathSync` matters: on macOS `tmpdir()` is the symlink /var → /private/var, and every hook
    // decides whether it was invoked as a program by comparing `import.meta.url` (which Node has
    // already resolved) against `process.argv[1]` (which it has not). A symlinked argv[1] makes the
    // hook import silently instead of running.
    outDir = realpathSync(mkdtempSync(join(tmpdir(), 'deerflow-hookdist-')))
    // Compile the current sources rather than trusting a checked-in dist/, so this can never pass
    // against stale output.
    execFileSync(
      process.execPath,
      [join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(projectRoot, 'tsconfig.json'), '--outDir', outDir],
      { stdio: 'pipe' },
    )
  }, 180_000)

  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    workspace = realpathSync(mkdtempSync(join(tmpdir(), 'deerflow-hookrun-')))
  })

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true })
  })

  it('write-gate denies an unread file and records the deny in .deerflow/logs/hooks.jsonl', () => {
    const target = join(workspace, 'notes.md')
    writeFileSync(target, 'content the model has never read\n', 'utf8')

    const stdout = execFileSync(process.execPath, [join(outDir, 'hooks', 'write-gate.js')], {
      cwd: workspace,
      input: JSON.stringify({
        session_id: 'thread-e2e',
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: target },
      }),
      // A deliberately minimal env: only the project dir, so nothing in the developer's shell can
      // disable the gate or redirect the log.
      env: { PATH: process.env['PATH'] ?? '', CLAUDE_PROJECT_DIR: workspace } as NodeJS.ProcessEnv,
      encoding: 'utf8',
    })

    expect(stdout).toContain('"permissionDecision":"deny"')

    const records = readFileSync(join(workspace, '.deerflow', 'logs', 'hooks.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      hook: 'write-gate',
      event: 'PreToolUse',
      thread: 'thread-e2e',
      decision: 'deny',
      summary: `path=${target}`,
    })
  }, 30_000)
})
