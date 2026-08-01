// Unit tests for the summary.json channel.
// No baseline vector file covers `summary_text` (it is a LangGraph LastValue channel, not a
// reducer with recorded vectors); semantics are pinned by
// docs/claude-code-port/notes/lead-agent-and-state.md §4 and
// summarization_middleware.py:_nonempty_summary (lines 235-245) @ 0950924.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { StateRevConflictError, writeStateFile } from '../state/atomic-io.js'
import {
  COMPACTION_HISTORY_MAX_ENTRIES,
  InvalidSummaryUpdatedByError,
  SUMMARY_FILE,
  applySummary,
  assertSummaryUpdatedBy,
  mergeSummaryText,
  readSummary,
  summaryPath,
  type SummaryDigest,
} from './summary-state.js'

const NOW = '2026-08-01T12:00:00Z'
let dir: string
let file: string

const DIGEST: SummaryDigest = {
  generated_at: NOW,
  trigger: 'auto',
  objectives: ['ship the port'],
  open_todos: [{ content: 'write tests', status: 'in_progress' }],
  delegations: { total: 2, by_status: { completed: 1, failed: 1 } },
  artifacts: ['outputs/report.md'],
  source_message_count: 42,
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'deerflow-summary-'))
  file = join(dir, SUMMARY_FILE)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('summary_text LastValue merge', () => {
  it('replaces wholesale on a real write', () => {
    expect(mergeSummaryText('old', 'new')).toBe('new')
  })

  it('preserves the previous text when the writer produced nothing', () => {
    expect(mergeSummaryText('old', null)).toBe('old')
    expect(mergeSummaryText('old', undefined)).toBe('old')
  })

  it('treats a blank or whitespace-only summary as a generation failure, not a value', () => {
    // summarization_middleware.py:_nonempty_summary — committing "" would drop history for
    // an empty replacement, so it is a failure and the channel stays unchanged.
    expect(mergeSummaryText('old', '')).toBe('old')
    expect(mergeSummaryText('old', '   \n\t ')).toBe('old')
  })

  it('is empty (never null) when nothing was ever written', () => {
    expect(mergeSummaryText(null, null)).toBe('')
    expect(mergeSummaryText(undefined, '')).toBe('')
  })
})

describe('updated_by vocabulary', () => {
  it('accepts the three declared writers', () => {
    expect(assertSummaryUpdatedBy('precompact')).toBe('precompact')
    expect(assertSummaryUpdatedBy('manual')).toBe('manual')
    expect(assertSummaryUpdatedBy('deep-run')).toBe('deep-run')
  })

  it('rejects anything else instead of writing an unknown provenance', () => {
    expect(() => assertSummaryUpdatedBy('model')).toThrow(InvalidSummaryUpdatedByError)
    expect(() => applySummary(file, { summaryText: 'x', updatedBy: 'nope' as never }, { now: NOW })).toThrow(
      InvalidSummaryUpdatedByError,
    )
  })
})

describe('summary channel file', () => {
  it('writes the declared envelope fields and bumps rev', () => {
    const envelope = applySummary(
      file,
      { summaryText: 'first', updatedBy: 'precompact', commitSha: '0950924', digest: DIGEST },
      { now: NOW },
    )
    expect(envelope.rev).toBe(1)
    expect(envelope.schemaVersion).toBe(1)
    expect(envelope.payload).toMatchObject({
      summary_text: 'first',
      updated_by: 'precompact',
      commit_sha: '0950924',
      source_message_count: 42,
    })
    expect(envelope.payload.digest).toEqual(DIGEST)
  })

  it('defaults source_message_count from the digest and keeps an explicit override', () => {
    applySummary(file, { summaryText: 'a', updatedBy: 'precompact', digest: DIGEST }, { now: NOW })
    expect(readSummary(file)?.payload.source_message_count).toBe(42)

    applySummary(
      file,
      { summaryText: 'b', updatedBy: 'manual', digest: DIGEST, sourceMessageCount: 7 },
      { now: NOW },
    )
    expect(readSummary(file)?.payload.source_message_count).toBe(7)
  })

  it('records the latest writer even when the summary itself was blank', () => {
    applySummary(file, { summaryText: 'kept', updatedBy: 'deep-run' }, { now: NOW })
    applySummary(file, { summaryText: '  ', updatedBy: 'precompact' }, { now: NOW })
    const payload = readSummary(file)?.payload
    expect(payload?.summary_text).toBe('kept')
    expect(payload?.updated_by).toBe('precompact')
  })

  it('carries commit_sha and digest forward when a later write omits them', () => {
    applySummary(
      file,
      { summaryText: 'a', updatedBy: 'precompact', commitSha: '0950924', digest: DIGEST },
      { now: NOW },
    )
    applySummary(file, { summaryText: 'b', updatedBy: 'manual' }, { now: NOW })
    const payload = readSummary(file)?.payload
    expect(payload?.commit_sha).toBe('0950924')
    expect(payload?.digest).toEqual(DIGEST)
  })

  it('appends compaction records and caps the history', () => {
    for (let index = 0; index < COMPACTION_HISTORY_MAX_ENTRIES + 5; index++) {
      applySummary(
        file,
        {
          summaryText: `s${index}`,
          updatedBy: 'precompact',
          compaction: { at: `2026-08-01T12:00:${String(index).padStart(2, '0')}Z`, trigger: 'auto', updated_by: 'precompact' },
        },
        { now: NOW },
      )
    }
    const compactions = readSummary(file)?.payload.compactions ?? []
    expect(compactions).toHaveLength(COMPACTION_HISTORY_MAX_ENTRIES)
    expect(compactions[compactions.length - 1]?.at).toBe('2026-08-01T12:00:24Z')
  })

  it('does not append a compaction record when none was supplied', () => {
    applySummary(file, { summaryText: 'a', updatedBy: 'manual' }, { now: NOW })
    expect(readSummary(file)?.payload.compactions).toEqual([])
  })

  it('returns null for a thread that never compacted', () => {
    expect(readSummary(file)).toBeNull()
  })

  it('merges on top of a concurrent write instead of resurrecting a stale value', () => {
    applySummary(file, { summaryText: 'mine', updatedBy: 'manual' }, { now: NOW })
    // Another writer replaces the channel between our read and our write.
    writeStateFile(file, { summary_text: 'theirs', updated_by: 'deep-run' }, { now: NOW })
    const after = applySummary(file, { summaryText: null, updatedBy: 'precompact' }, { now: NOW })
    expect(after.payload.summary_text).toBe('theirs')
    expect(after.rev).toBe(3)
  })

  it('is CAS-guarded: a write against a stale rev is rejected, not applied', () => {
    applySummary(file, { summaryText: 'mine', updatedBy: 'manual' }, { now: NOW })
    expect(() => writeStateFile(file, { summary_text: 'stale' }, { now: NOW, expectedRev: 0 })).toThrow(
      StateRevConflictError,
    )
    expect(readSummary(file)?.payload.summary_text).toBe('mine')
  })
})

describe('summaryPath', () => {
  it('resolves under the thread state dir', () => {
    const path = summaryPath('thread-1', { CLAUDE_PROJECT_DIR: '/proj' } as NodeJS.ProcessEnv)
    expect(path).toBe(join('/proj', '.deerflow', 'state', 'thread-1', SUMMARY_FILE))
  })
})
