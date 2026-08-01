// Unit tests for crash / orphan recovery against on-disk fixtures.
// These pin guarantee G9 (ownership fencing collapsed to the startup recovery scan) and the
// §5 recovery procedure from docs/claude-code-port/state-checkpoint-resume.md: orphan scan,
// terminal write with stop_reason `orphan_recovered`, zero-receipt backfill that never
// overwrites an existing receipt, and terminal/fresh records left untouched.
// DeerFlow anchor: manager reconciliation tests (`claim_for_takeover` + put_if_absent).
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeStateFile } from '../state/atomic-io.js'
import { RUN_META_FILE, buildRunMeta, transitionRunMeta, type RunMeta, type RunStatus } from '../state/run-meta.js'
import {
  ORPHAN_EXPIRY_MS,
  applyRecovery,
  classifyOrphan,
  listStateThreads,
  readRunMeta,
  recoverOrphanRuns,
  scanOrphanRuns,
} from './recovery.js'

const START = '2026-08-01T09:00:00.000Z'
const NOW = '2026-08-01T12:00:00.000Z' // 3 h after START — past the 2 h expiry.
const RECENT = '2026-08-01T11:30:00.000Z' // 30 min before NOW — inside the expiry.
const SHA = '0950924aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'deerflow-recovery-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

interface FixtureOptions {
  readonly status?: RunStatus
  readonly updatedAt?: string
  readonly sessionId?: string
  readonly delivery?: { presented_paths: string[]; receipt_at: string }
}

/** Write one thread's run-meta.json through the real state library. */
function writeRun(threadId: string, options: FixtureOptions = {}): RunMeta {
  const status = options.status ?? 'running'
  const base = buildRunMeta({
    runId: `r-${threadId}`,
    threadId,
    commitSha: SHA,
    now: START,
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
  })
  let run: RunMeta = { ...base, status, updated_at: options.updatedAt ?? START }
  if (options.delivery !== undefined) run = { ...run, delivery: options.delivery }
  mkdirSync(join(root, threadId), { recursive: true })
  writeStateFile(join(root, threadId, RUN_META_FILE), { run }, { now: run.updated_at })
  return run
}

function readRun(threadId: string): RunMeta | null {
  return readRunMeta(join(root, threadId, RUN_META_FILE))
}

describe('state-root scan', () => {
  it('lists only thread-shaped directories, sorted', () => {
    mkdirSync(join(root, 'thread-b'), { recursive: true })
    mkdirSync(join(root, 'thread-a'), { recursive: true })
    mkdirSync(join(root, 'not a thread id!'), { recursive: true })
    writeFileSync(join(root, 'stray.json'), '{}')
    expect(listStateThreads(root)).toEqual(['thread-a', 'thread-b'])
  })

  it('returns nothing for a state root that does not exist', () => {
    expect(listStateThreads(join(root, 'absent'))).toEqual([])
  })

  it('skips a thread whose run-meta.json is uninterpretable instead of failing the scan', () => {
    writeRun('good')
    mkdirSync(join(root, 'bad'), { recursive: true })
    writeFileSync(join(root, 'bad', RUN_META_FILE), JSON.stringify({ schema_version: 99, rev: 1 }))
    const orphans = scanOrphanRuns({ stateRoot: root, now: NOW })
    expect(orphans.map((orphan) => orphan.threadId)).toEqual(['good'])
  })
})

describe('orphan classification', () => {
  it('marks a non-terminal run older than the expiry', () => {
    const run = writeRun('old', { updatedAt: START })
    expect(classifyOrphan(run, NOW, ORPHAN_EXPIRY_MS)).toMatchObject({ action: 'mark_interrupted', ageMs: 10800000 })
  })

  it('offers a recently updated non-terminal run as a resume candidate', () => {
    const run = writeRun('recent', { updatedAt: RECENT })
    expect(classifyOrphan(run, NOW, ORPHAN_EXPIRY_MS)).toMatchObject({ action: 'resume_candidate', ageMs: 1800000 })
  })

  it('marks a record whose updated_at cannot be parsed (fail-closed)', () => {
    const run = { ...writeRun('broken'), updated_at: 'not-a-timestamp' }
    expect(classifyOrphan(run, NOW, ORPHAN_EXPIRY_MS)).toMatchObject({ action: 'mark_interrupted', ageMs: null })
  })

  it('pins the 2 h expiry constant', () => {
    expect(ORPHAN_EXPIRY_MS).toBe(7200000)
  })
})

describe('scan selection', () => {
  it('ignores terminal runs', () => {
    for (const status of ['completed', 'error', 'interrupted'] as RunStatus[]) {
      writeRun(`t-${status}`, { status, updatedAt: START })
    }
    expect(scanOrphanRuns({ stateRoot: root, now: NOW })).toEqual([])
  })

  it('ignores a non-terminal run recorded by the current session', () => {
    writeRun('mine', { sessionId: 'session-1', updatedAt: START })
    writeRun('theirs', { sessionId: 'session-2', updatedAt: START })
    const orphans = scanOrphanRuns({ stateRoot: root, now: NOW, currentSessionId: 'session-1' })
    expect(orphans.map((orphan) => orphan.threadId)).toEqual(['theirs'])
  })

  it('finds both pending and running records', () => {
    writeRun('p', { status: 'pending', updatedAt: START })
    writeRun('r', { status: 'running', updatedAt: START })
    expect(scanOrphanRuns({ stateRoot: root, now: NOW }).map((orphan) => orphan.threadId)).toEqual(['p', 'r'])
  })
})

describe('applying recovery', () => {
  it('terminalizes an expired non-terminal run with orphan_recovered and a zero receipt', () => {
    writeRun('old', { updatedAt: START })
    const outcome = recoverOrphanRuns({ stateRoot: root, now: NOW })

    expect(outcome.interrupted.map((orphan) => orphan.threadId)).toEqual(['old'])
    expect(outcome.resumable).toEqual([])
    expect(outcome.failures).toEqual([])

    const recovered = readRun('old')
    expect(recovered).toMatchObject({
      status: 'interrupted',
      stop_reason: 'orphan_recovered',
      updated_at: NOW,
      ended_at: NOW,
      delivery: { presented_paths: [], receipt_at: NOW },
    })
  })

  it('preserves a receipt written before the crash (put_if_absent, never overwrite)', () => {
    writeRun('delivered', {
      updatedAt: START,
      delivery: { presented_paths: ['outputs/report.pdf'], receipt_at: START },
    })
    recoverOrphanRuns({ stateRoot: root, now: NOW })
    expect(readRun('delivered')?.delivery).toEqual({ presented_paths: ['outputs/report.pdf'], receipt_at: START })
    expect(readRun('delivered')?.stop_reason).toBe('orphan_recovered')
  })

  it('leaves a terminal record untouched, byte for byte', () => {
    writeRun('done', { status: 'completed', updatedAt: START })
    const before = readFileSync(join(root, 'done', RUN_META_FILE), 'utf8')
    const outcome = recoverOrphanRuns({ stateRoot: root, now: NOW })
    expect(outcome.orphans).toEqual([])
    expect(readFileSync(join(root, 'done', RUN_META_FILE), 'utf8')).toBe(before)
  })

  it('leaves a fresh non-terminal record untouched and reports it as resumable', () => {
    writeRun('live', { updatedAt: RECENT })
    const before = readFileSync(join(root, 'live', RUN_META_FILE), 'utf8')
    const outcome = recoverOrphanRuns({ stateRoot: root, now: NOW })
    expect(outcome.interrupted).toEqual([])
    expect(outcome.resumable.map((orphan) => orphan.threadId)).toEqual(['live'])
    expect(readFileSync(join(root, 'live', RUN_META_FILE), 'utf8')).toBe(before)
  })

  it('writes status and receipt in one rev bump (no window with a terminal status and no receipt)', () => {
    writeRun('old', { updatedAt: START })
    recoverOrphanRuns({ stateRoot: root, now: NOW })
    const raw = JSON.parse(readFileSync(join(root, 'old', RUN_META_FILE), 'utf8')) as {
      rev: number
      run: Record<string, unknown>
    }
    expect(raw.rev).toBe(2) // fixture write + exactly one recovery write
    expect(raw.run['status']).toBe('interrupted')
    expect(raw.run['delivery']).toEqual({ presented_paths: [], receipt_at: NOW })
  })

  it('never writes for a resume candidate', () => {
    writeRun('live', { updatedAt: RECENT })
    const orphan = scanOrphanRuns({ stateRoot: root, now: NOW })[0]
    expect(orphan?.action).toBe('resume_candidate')
    expect(applyRecovery(orphan!, { now: NOW })).toBeNull()
  })

  it('does not downgrade a record another writer terminalized between scan and apply', () => {
    writeRun('raced', { updatedAt: START })
    const orphan = scanOrphanRuns({ stateRoot: root, now: NOW })[0]!
    // The scan holds a snapshot; the real writer finishes the run in the meantime.
    const completed = transitionRunMeta(orphan.run, {
      status: 'completed',
      now: RECENT,
      delivery: { presented_paths: ['outputs/a.md'], receipt_at: RECENT },
    })
    writeStateFile(join(root, 'raced', RUN_META_FILE), { run: completed }, { now: RECENT })

    // applyRunTransition re-reads under CAS, so recovery stamps interrupted/orphan_recovered
    // over the terminal record (terminal-to-terminal is legal) but the delivered receipt
    // survives — a crash-after-receipt is never turned into a zero receipt.
    applyRecovery(orphan, { now: NOW })
    expect(readRun('raced')).toMatchObject({
      status: 'interrupted',
      stop_reason: 'orphan_recovered',
      delivery: { presented_paths: ['outputs/a.md'], receipt_at: RECENT },
    })
  })

  it('collects a write failure instead of throwing out of the scan', () => {
    writeRun('old', { updatedAt: START })
    const readOnlyDir = join(root, 'old')
    chmodSync(readOnlyDir, 0o500)
    try {
      const outcome = recoverOrphanRuns({ stateRoot: root, now: NOW })
      expect(outcome.interrupted).toEqual([])
      expect(outcome.failures.map((failure) => failure.threadId)).toEqual(['old'])
    } finally {
      chmodSync(readOnlyDir, 0o700)
    }
  })

  it('recovers several threads in one pass', () => {
    writeRun('a', { updatedAt: START })
    writeRun('b', { updatedAt: START })
    writeRun('c', { updatedAt: RECENT })
    writeRun('d', { status: 'completed', updatedAt: START })
    const outcome = recoverOrphanRuns({ stateRoot: root, now: NOW })
    expect(outcome.interrupted.map((orphan) => orphan.threadId)).toEqual(['a', 'b'])
    expect(outcome.resumable.map((orphan) => orphan.threadId)).toEqual(['c'])
    expect(readRun('d')?.status).toBe('completed')
  })
})
