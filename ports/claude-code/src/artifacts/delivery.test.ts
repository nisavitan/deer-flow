import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  DELIVERY_INCOMPLETE_ERROR,
  OUTPUTS_DELIVERY_POLICY,
  buildDeliveryReceipt,
  coversProducedPath,
  evaluateDelivery,
  extractFinalAssistantText,
  extractPresentedPaths,
  recordDeliveryReceipt,
  renderDeliveryBlockReason,
} from './delivery.js'
import { applyRunTransition, readStateFile, runMetaPath, startRun, type RunMetaPayload } from '../state/index.js'

const NOW = '2026-08-01T12:00:00.000Z'
const LATER = '2026-08-01T13:00:00.000Z'
const THREAD = 'thread-delivery'
let root: string
let env: NodeJS.ProcessEnv

function seedRun(status: 'running' | 'pending' = 'running'): string {
  const filePath = runMetaPath(THREAD, env)
  startRun(filePath, { runId: 'run-1', threadId: THREAD, commitSha: 'abc123', status, now: NOW }, { now: NOW })
  return filePath
}

function readRun(filePath: string) {
  return readStateFile<RunMetaPayload>(filePath)?.payload.run ?? null
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'deerflow-delivery-'))
  env = { CLAUDE_PROJECT_DIR: root }
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('the ported contract strings', () => {
  it('keeps _DELIVERY_INCOMPLETE_ERROR verbatim', () => {
    expect(DELIVERY_INCOMPLETE_ERROR).toBe('Artifact delivery incomplete: no produced output artifact was presented')
  })

  it('keeps the sandbox-contract §3 policy sentence verbatim', () => {
    expect(OUTPUTS_DELIVERY_POLICY).toBe(
      'Files produced for the user land in ./outputs/, and every file placed there MUST be listed in the final response.',
    )
  })
})

describe('extractPresentedPaths', () => {
  it('finds relative paths, bare filenames and backticked paths', () => {
    expect(extractPresentedPaths('I wrote `outputs/report.md` and also summary.csv for you.')).toEqual([
      'outputs/report.md',
      'summary.csv',
    ])
  })

  it('strips markdown wrappers, ./ prefixes and trailing punctuation', () => {
    expect(extractPresentedPaths('See [the report](./outputs/report.md), plus outputs/data.json.')).toEqual([
      'outputs/data.json',
      'outputs/report.md',
    ])
  })

  it('normalises Windows separators', () => {
    expect(extractPresentedPaths('wrote outputs\\report.md')).toEqual(['outputs/report.md'])
  })

  it('keeps prose out: no extension, one-letter extension, or digits-only extension', () => {
    expect(extractPresentedPaths('Done, e.g. everything worked in v1.20 and took 3.5 seconds.')).toEqual([])
  })

  it('deduplicates and sorts', () => {
    expect(extractPresentedPaths('outputs/a.md and outputs/a.md and b.md')).toEqual(['b.md', 'outputs/a.md'])
  })

  it('returns nothing for empty or non-string input', () => {
    expect(extractPresentedPaths('')).toEqual([])
    expect(extractPresentedPaths(undefined as unknown as string)).toEqual([])
  })
})

describe('coversProducedPath', () => {
  it('accepts the exact path, the basename, and an absolute mention', () => {
    expect(coversProducedPath('outputs/report.md', 'outputs/report.md')).toBe(true)
    expect(coversProducedPath('report.md', 'outputs/report.md')).toBe(true)
    expect(coversProducedPath('/home/me/proj/outputs/report.md', 'outputs/report.md')).toBe(true)
  })

  it('refuses a different file whose name merely ends the same way', () => {
    expect(coversProducedPath('other-report.md', 'outputs/report.md')).toBe(false)
    expect(coversProducedPath('outputs/report.md', 'outputs/final-report.md')).toBe(false)
  })
})

describe('evaluateDelivery — the verdict matrix', () => {
  it('is satisfied when every produced path is mentioned by full path', () => {
    const verdict = evaluateDelivery({
      producedPaths: ['outputs/a.md', 'outputs/b.csv'],
      finalMessageText: 'Wrote outputs/a.md and outputs/b.csv.',
    })

    expect(verdict.satisfied).toBe(true)
    expect(verdict.produced_paths).toEqual(['outputs/a.md', 'outputs/b.csv'])
    expect(verdict.matched_paths).toEqual(['outputs/a.md', 'outputs/b.csv'])
    expect(verdict.missing).toEqual([])
    expect(verdict.presented_paths).toEqual(['outputs/a.md', 'outputs/b.csv'])
  })

  it('is satisfied when a produced path is mentioned only by basename', () => {
    const verdict = evaluateDelivery({
      producedPaths: ['outputs/report.md'],
      finalMessageText: 'The analysis is in report.md.',
    })

    expect(verdict.satisfied).toBe(true)
    expect(verdict.matched_paths).toEqual(['outputs/report.md'])
    expect(verdict.presented_paths).toEqual(['report.md'])
  })

  it('is unsatisfied when one of two produced paths is unmentioned', () => {
    const verdict = evaluateDelivery({
      producedPaths: ['outputs/a.md', 'outputs/b.csv'],
      finalMessageText: 'Here is outputs/a.md.',
    })

    expect(verdict.satisfied).toBe(false)
    expect(verdict.matched_paths).toEqual(['outputs/a.md'])
    expect(verdict.missing).toEqual(['outputs/b.csv'])
  })

  it('is unsatisfied when the message mentions nothing at all', () => {
    const verdict = evaluateDelivery({ producedPaths: ['outputs/a.md'], finalMessageText: 'All done!' })

    expect(verdict.satisfied).toBe(false)
    expect(verdict.missing).toEqual(['outputs/a.md'])
    expect(verdict.matched_paths).toEqual([])
  })

  it('is satisfied by construction when nothing was produced', () => {
    const verdict = evaluateDelivery({ producedPaths: [], finalMessageText: '' })

    expect(verdict.satisfied).toBe(true)
    expect(verdict.produced_paths).toEqual([])
    expect(verdict.missing).toEqual([])
  })

  it('deduplicates and sorts the produced set', () => {
    const verdict = evaluateDelivery({
      producedPaths: ['outputs/b.md', 'outputs/a.md', 'outputs/b.md'],
      finalMessageText: '',
    })
    expect(verdict.produced_paths).toEqual(['outputs/a.md', 'outputs/b.md'])
  })
})

describe('renderDeliveryBlockReason', () => {
  it('leads with the verbatim contract error, lists every missing file, and states the policy', () => {
    const verdict = evaluateDelivery({
      producedPaths: ['outputs/a.md', 'outputs/b.csv'],
      finalMessageText: 'Here is outputs/a.md.',
    })
    const reason = renderDeliveryBlockReason(verdict)

    expect(reason.startsWith(`${DELIVERY_INCOMPLETE_ERROR}.`)).toBe(true)
    expect(reason).toContain('  - outputs/b.csv')
    expect(reason).not.toContain('  - outputs/a.md')
    expect(reason).toContain(OUTPUTS_DELIVERY_POLICY)
    expect(reason).toContain('move it out of ./outputs/')
  })

  it('reads naturally for a single missing file', () => {
    const reason = renderDeliveryBlockReason(
      evaluateDelivery({ producedPaths: ['outputs/a.md'], finalMessageText: '' }),
    )
    expect(reason).toContain('created or modified a file under ./outputs/')
    expect(reason).toContain('Present it to the user now')
  })
})

describe('the delivery receipt in run-meta.json', () => {
  it('builds a receipt carrying produced, presented and matched paths', () => {
    const verdict = evaluateDelivery({
      producedPaths: ['outputs/a.md', 'outputs/b.csv'],
      finalMessageText: 'Here is outputs/a.md.',
    })
    const receipt = buildDeliveryReceipt(verdict, NOW)

    expect(receipt).toEqual({
      presented_paths: ['outputs/a.md'],
      matched_paths: ['outputs/a.md'],
      produced_paths: ['outputs/a.md', 'outputs/b.csv'],
      satisfied: false,
      receipt_at: NOW,
    })
  })

  it('writes the receipt into the existing run record without changing its status', () => {
    const filePath = seedRun()
    const verdict = evaluateDelivery({ producedPaths: ['outputs/a.md'], finalMessageText: 'see outputs/a.md' })
    const outcome = recordDeliveryReceipt(filePath, verdict, { now: LATER })

    expect(outcome.kind).toBe('written')
    const run = readRun(filePath)
    expect(run?.status).toBe('running')
    expect(run?.ended_at).toBeNull()
    expect(run?.delivery).toEqual({
      presented_paths: ['outputs/a.md'],
      matched_paths: ['outputs/a.md'],
      produced_paths: ['outputs/a.md'],
      satisfied: true,
      receipt_at: LATER,
    })
  })

  it('is put-if-absent: an existing receipt survives untouched', () => {
    const filePath = seedRun()
    applyRunTransition(
      filePath,
      { status: 'completed', now: NOW, delivery: { presented_paths: ['outputs/first.md'], receipt_at: NOW } },
      { now: NOW },
    )
    const outcome = recordDeliveryReceipt(
      filePath,
      evaluateDelivery({ producedPaths: ['outputs/second.md'], finalMessageText: '' }),
      { now: LATER },
    )

    expect(outcome.kind).toBe('preserved')
    expect(readRun(filePath)?.delivery).toEqual({ presented_paths: ['outputs/first.md'], receipt_at: NOW })
  })

  it('never terminalizes a live run, and never downgrades a terminal one', () => {
    const filePath = seedRun()
    applyRunTransition(filePath, { status: 'completed', now: NOW }, { now: NOW })
    const outcome = recordDeliveryReceipt(
      filePath,
      evaluateDelivery({ producedPaths: ['outputs/a.md'], finalMessageText: '' }),
      { now: LATER },
    )

    expect(outcome.kind).toBe('written')
    expect(readRun(filePath)?.status).toBe('completed')
  })

  it('reports no-run when the thread has no run record at all', () => {
    const outcome = recordDeliveryReceipt(
      runMetaPath(THREAD, env),
      evaluateDelivery({ producedPaths: ['outputs/a.md'], finalMessageText: '' }),
      { now: NOW },
    )
    expect(outcome).toEqual({ kind: 'no-run' })
  })
})

describe('extractFinalAssistantText', () => {
  const line = (entry: unknown): string => JSON.stringify(entry)

  it('returns the assistant text that follows the last user entry', () => {
    const raw = [
      line({ type: 'user', message: { content: 'first question' } }),
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'old answer' }] } }),
      line({ type: 'user', message: { content: 'second question' } }),
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'wrote outputs/a.md' }] } }),
    ].join('\n')

    expect(extractFinalAssistantText(raw)).toBe('wrote outputs/a.md')
  })

  it('joins several assistant entries of the same turn', () => {
    const raw = [
      line({ type: 'user', message: { content: 'go' } }),
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'thinking out loud' }] } }),
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'wrote outputs/a.md' }] } }),
    ].join('\n')

    expect(extractFinalAssistantText(raw)).toBe('thinking out loud\nwrote outputs/a.md')
  })

  it('treats a tool-result user entry as a boundary without losing the answer after it', () => {
    const raw = [
      line({ type: 'user', message: { content: 'go' } }),
      line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write' }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } }),
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'wrote outputs/a.md' }] } }),
    ].join('\n')

    expect(extractFinalAssistantText(raw)).toBe('wrote outputs/a.md')
  })

  it('skips malformed lines, unknown types and empty text rather than aborting', () => {
    const raw = [
      'not json',
      '[]',
      line({ type: 'system', message: { content: 'ignored' } }),
      line({ type: 'assistant', message: { content: [] } }),
      line({ type: 'assistant', content: 'bare content field: outputs/a.md' }),
    ].join('\n')

    expect(extractFinalAssistantText(raw)).toBe('bare content field: outputs/a.md')
  })

  it('returns an empty string for an empty transcript', () => {
    expect(extractFinalAssistantText('')).toBe('')
  })
})
