import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  DISABLE_ENV_VAR,
  decideDeliveryGate,
  evaluateDeliveryGate,
  readFinalMessage,
  renderHookOutput,
  resolveThreadId,
  type DeliveryGateInput,
} from './delivery-gate.js'
import { captureTurnSnapshot } from './turn-snapshot.js'
import { DELIVERY_INCOMPLETE_ERROR } from '../artifacts/delivery.js'
import { defaultScanRoots, emptySnapshot, scanWorkspace, type WorkspaceSnapshot } from '../artifacts/snapshot.js'
import { workspaceChangesPath, type WorkspaceChangesPayload } from '../artifacts/workspace-changes.js'
import { readStateFile } from '../state/atomic-io.js'
import { runMetaPath, startRun, type RunMetaPayload } from '../state/run-meta.js'

const NOW = '2026-08-01T12:00:00.000Z'
const THREAD = 'thread-gate'
let root: string
let transcriptDir: string
let env: NodeJS.ProcessEnv

function write(relative: string, contents: string): void {
  const absolute = join(root, relative)
  mkdirSync(join(absolute, '..'), { recursive: true })
  writeFileSync(absolute, contents)
}

function scan(): WorkspaceSnapshot {
  return scanWorkspace(defaultScanRoots(root), root)
}

/** A JSONL transcript whose final assistant message is `text`, written OUTSIDE the scanned tree. */
function transcript(text: string): string {
  const path = join(transcriptDir, 'transcript.jsonl')
  writeFileSync(
    path,
    [
      JSON.stringify({ type: 'user', message: { content: 'do the thing' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }),
    ].join('\n'),
  )
  return path
}

function gateInput(overrides: Partial<DeliveryGateInput> = {}): DeliveryGateInput {
  return {
    pre: emptySnapshot(),
    post: emptySnapshot(),
    finalMessageText: '',
    stopHookActive: false,
    now: NOW,
    ...overrides,
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'deerflow-gate-'))
  transcriptDir = mkdtempSync(join(tmpdir(), 'deerflow-gate-transcript-'))
  env = { CLAUDE_PROJECT_DIR: root }
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(transcriptDir, { recursive: true, force: true })
})

describe('decideDeliveryGate — the pure decision', () => {
  it('stands down entirely when there is no baseline', () => {
    write('outputs/a.md', 'x')
    const decision = decideDeliveryGate(gateInput({ pre: null, post: scan() }))

    expect(decision).toEqual({ entry: null, verdict: null, recordReceipt: false, block: false, blockReason: null })
  })

  it('stands down silently when nothing changed', () => {
    write('outputs/a.md', 'x')
    const snapshot = scan()
    const decision = decideDeliveryGate(gateInput({ pre: snapshot, post: snapshot }))

    expect(decision.entry).toBeNull()
    expect(decision.block).toBe(false)
  })

  it('records the change but never blocks when the change is outside outputs/', () => {
    const pre = scan()
    write('src/index.ts', 'export {}')
    const decision = decideDeliveryGate(gateInput({ pre, post: scan() }))

    expect(decision.entry?.created).toEqual(['src/index.ts'])
    expect(decision.entry?.outputs_changed).toEqual([])
    expect(decision.verdict).toBeNull()
    expect(decision.block).toBe(false)
    expect(decision.recordReceipt).toBe(false)
  })

  it('blocks with the ported contract text when an outputs file is unmentioned', () => {
    const pre = scan()
    write('outputs/report.md', '# report')
    const decision = decideDeliveryGate(gateInput({ pre, post: scan(), finalMessageText: 'All done!' }))

    expect(decision.block).toBe(true)
    expect(decision.blockReason).toContain(DELIVERY_INCOMPLETE_ERROR)
    expect(decision.blockReason).toContain('  - outputs/report.md')
    expect(decision.verdict?.missing).toEqual(['outputs/report.md'])
    // Not written yet: the continuation turn is expected to fix the verdict.
    expect(decision.recordReceipt).toBe(false)
  })

  it('does not block when every outputs file is mentioned, and records the receipt', () => {
    const pre = scan()
    write('outputs/report.md', '# report')
    const decision = decideDeliveryGate(
      gateInput({ pre, post: scan(), finalMessageText: 'Wrote outputs/report.md for you.' }),
    )

    expect(decision.block).toBe(false)
    expect(decision.recordReceipt).toBe(true)
    expect(decision.verdict?.satisfied).toBe(true)
  })

  it('accepts a mention by basename alone', () => {
    const pre = scan()
    write('outputs/report.md', '# report')
    const decision = decideDeliveryGate(gateInput({ pre, post: scan(), finalMessageText: 'See report.md.' }))

    expect(decision.block).toBe(false)
  })

  it('never double-blocks: stop_hook_active suppresses the block and finalises the receipt', () => {
    const pre = scan()
    write('outputs/report.md', '# report')
    const decision = decideDeliveryGate(
      gateInput({ pre, post: scan(), finalMessageText: 'All done!', stopHookActive: true }),
    )

    expect(decision.block).toBe(false)
    expect(decision.blockReason).toBeNull()
    expect(decision.verdict?.satisfied).toBe(false)
    expect(decision.recordReceipt).toBe(true)
  })

  it('never blocks on a deleted outputs file', () => {
    write('outputs/gone.md', 'x')
    const pre = scan()
    rmSync(join(root, 'outputs/gone.md'))
    const decision = decideDeliveryGate(gateInput({ pre, post: scan(), finalMessageText: 'All done!' }))

    expect(decision.entry?.deleted).toEqual(['outputs/gone.md'])
    expect(decision.block).toBe(false)
  })

  it('terminates: one block, then the continuation turn cannot block again', () => {
    const pre = scan()
    write('outputs/report.md', '# report')
    const post = scan()

    const first = decideDeliveryGate(gateInput({ pre, post, finalMessageText: 'All done!' }))
    // Whatever the model does next, stop_hook_active is set on the continued turn.
    const second = decideDeliveryGate(gateInput({ pre, post, finalMessageText: 'Still done!', stopHookActive: true }))

    expect([first.block, second.block]).toEqual([true, false])
  })
})

describe('the Stop hook, end to end', () => {
  it('appends the workspace-changes record and writes the receipt on a satisfied turn', () => {
    startRun(runMetaPath(THREAD, env), { runId: 'run-1', threadId: THREAD, commitSha: 'abc', now: NOW }, { now: NOW })
    captureTurnSnapshot({ session_id: THREAD }, { now: NOW, env })
    write('outputs/report.md', '# report')

    const outcome = evaluateDeliveryGate(
      { session_id: THREAD, transcript_path: transcript('Wrote outputs/report.md.') },
      { now: NOW, env },
    )

    expect(outcome.decision.block).toBe(false)
    expect(outcome.recorded).toBe(true)
    expect(outcome.receipt?.kind).toBe('written')

    const changes = readStateFile<WorkspaceChangesPayload>(workspaceChangesPath(THREAD, env))?.payload
    expect(changes?.entries).toHaveLength(1)
    expect(changes?.entries[0]?.outputs_changed).toEqual(['outputs/report.md'])

    const run = readStateFile<RunMetaPayload>(runMetaPath(THREAD, env))?.payload.run
    expect(run?.delivery).toMatchObject({ satisfied: true, produced_paths: ['outputs/report.md'] })
    expect(run?.status).toBe('running')
  })

  it('blocks and writes no receipt when the file is unmentioned', () => {
    startRun(runMetaPath(THREAD, env), { runId: 'run-1', threadId: THREAD, commitSha: 'abc', now: NOW }, { now: NOW })
    captureTurnSnapshot({ session_id: THREAD }, { now: NOW, env })
    write('outputs/report.md', '# report')

    const outcome = evaluateDeliveryGate(
      { session_id: THREAD, transcript_path: transcript('All finished, let me know if you need anything else.') },
      { now: NOW, env },
    )

    expect(outcome.decision.block).toBe(true)
    expect(outcome.receipt).toBeNull()
    expect(readStateFile<RunMetaPayload>(runMetaPath(THREAD, env))?.payload.run?.delivery).toBeUndefined()
    expect(renderHookOutput(outcome)).toContain('"decision":"block"')
  })

  it('records the change even with no run record, reporting no-run for the receipt', () => {
    captureTurnSnapshot({ session_id: THREAD }, { now: NOW, env })
    write('outputs/report.md', '# report')

    const outcome = evaluateDeliveryGate(
      { session_id: THREAD, transcript_path: transcript('Wrote outputs/report.md.') },
      { now: NOW, env },
    )

    expect(outcome.recorded).toBe(true)
    expect(outcome.receipt).toEqual({ kind: 'no-run' })
  })

  it('does not append the same delta twice across a block and its continuation', () => {
    captureTurnSnapshot({ session_id: THREAD }, { now: NOW, env })
    write('outputs/report.md', '# report')

    evaluateDeliveryGate({ session_id: THREAD, transcript_path: transcript('All done!') }, { now: NOW, env })
    evaluateDeliveryGate(
      { session_id: THREAD, transcript_path: transcript('Wrote outputs/report.md.'), stop_hook_active: true },
      { now: NOW, env },
    )

    const changes = readStateFile<WorkspaceChangesPayload>(workspaceChangesPath(THREAD, env))?.payload
    expect(changes?.entries).toHaveLength(1)
  })

  it('stands down when the baseline is missing — it never blocks on the whole project tree', () => {
    write('outputs/report.md', '# report')
    write('src/index.ts', 'x')

    const outcome = evaluateDeliveryGate(
      { session_id: THREAD, transcript_path: transcript('All done!') },
      { now: NOW, env },
    )

    expect(outcome.decision.block).toBe(false)
    expect(outcome.recorded).toBe(false)
    expect(renderHookOutput(outcome)).toBe('')
  })

  it('stands down when no thread id resolves, and when the escape hatch is set', () => {
    expect(evaluateDeliveryGate({ session_id: 'not a valid id!' }, { now: NOW, env }).threadId).toBeNull()
    expect(
      evaluateDeliveryGate({ session_id: THREAD }, { now: NOW, env: { ...env, [DISABLE_ENV_VAR]: '1' } }).threadId,
    ).toBeNull()
  })

  it('treats an unreadable transcript as an empty final message rather than failing', () => {
    expect(readFinalMessage(join(root, 'missing.jsonl'))).toBe('')
    expect(readFinalMessage(null)).toBe('')
    expect(readFinalMessage('')).toBe('')
  })

  it('prefers DEERFLOW_THREAD_ID over the session id', () => {
    expect(resolveThreadId({ session_id: 'ignored' }, { DEERFLOW_THREAD_ID: 'explicit' })).toBe('explicit')
    expect(resolveThreadId({ session_id: 'sess-1' }, {})).toBe('sess-1')
    expect(resolveThreadId({}, {})).toBeNull()
  })
})

describe('hook stdout protocol', () => {
  it('emits nothing at all when there is no block', () => {
    expect(renderHookOutput({ decision: decideDeliveryGate(gateInput()), threadId: THREAD, recorded: false, receipt: null })).toBe('')
  })

  it('emits exactly one JSON line carrying the block reason', () => {
    write('outputs/a.md', 'x')
    const decision = decideDeliveryGate(gateInput({ pre: emptySnapshot(), post: scan(), finalMessageText: 'done' }))
    const rendered = renderHookOutput({ decision, threadId: THREAD, recorded: true, receipt: null })

    expect(rendered.endsWith('\n')).toBe(true)
    expect(rendered.trimEnd().split('\n')).toHaveLength(1)
    expect(JSON.parse(rendered) as { decision: string; reason: string }).toMatchObject({ decision: 'block' })
  })

  it('contains no model, network, or process-spawn call', () => {
    const source = readFileSync(new URL('./delivery-gate.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/child_process|spawn\(|execSync|fetch\(/)
  })
})
