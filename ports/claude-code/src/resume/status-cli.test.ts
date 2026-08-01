// Unit tests for the `/deerflow:status` renderer: argument parsing, the empty-state document,
// and the multi-thread document. The git lookup is covered at its pure edge (branch
// interpretation) — shelling out to git is not re-tested here.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeStateFile } from '../state/atomic-io.js'
import { RUN_META_FILE, buildRunMeta } from '../state/run-meta.js'
import { interpretBranch } from './git-head.js'
import { collectReports, parseArgs, renderStatusDocument, type StatusRenderOptions } from './status-cli.js'

const START = '2026-08-01T09:00:00.000Z'
const SHA = '0950924aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'deerflow-status-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('argument parsing', () => {
  it('defaults the thread to DEERFLOW_THREAD_ID and renders markdown', () => {
    expect(parseArgs([], { DEERFLOW_THREAD_ID: 'thread-9' })).toEqual({
      threadId: 'thread-9',
      stateRoot: null,
      json: false,
    })
  })

  it('accepts --thread, --state-root and --json', () => {
    expect(parseArgs(['--thread', 't', '--state-root', '/tmp/s', '--json'], {})).toEqual({
      threadId: 't',
      stateRoot: '/tmp/s',
      json: true,
    })
  })

  it('rejects an unknown flag and a flag with no value', () => {
    expect(() => parseArgs(['--nope'], {})).toThrow('Unknown argument: --nope')
    expect(() => parseArgs(['--thread'], {})).toThrow('Missing value for --thread')
  })
})

describe('document rendering', () => {
  it('says so plainly when there is no state', () => {
    const options: StatusRenderOptions = { stateRoot: root, threadIds: [], currentCommitSha: SHA, currentBranch: 'main' }
    const document = renderStatusDocument([], options)
    expect(document).toContain('No DeerFlow state found')
    expect(document).toContain('/deerflow:run')
  })

  it('renders a header plus one section per thread and the action key', () => {
    for (const threadId of ['thread-a', 'thread-b']) {
      mkdirSync(join(root, threadId), { recursive: true })
      const run = buildRunMeta({ runId: `r-${threadId}`, threadId, commitSha: SHA, now: START })
      writeStateFile(join(root, threadId, RUN_META_FILE), { run }, { now: START })
    }
    const options: StatusRenderOptions = {
      stateRoot: root,
      threadIds: ['thread-a', 'thread-b'],
      currentCommitSha: SHA,
      currentBranch: 'main',
    }
    const reports = collectReports(options)
    expect(reports.map((report) => report.recommended_action)).toEqual(['continue', 'continue'])

    const document = renderStatusDocument(reports, options)
    expect(document).toContain('- **Current HEAD:** 0950924 (main)')
    expect(document).toContain('- **Threads:** 2')
    expect(document).toContain('## Thread `thread-a`')
    expect(document).toContain('## Thread `thread-b`')
    expect(document).toContain('**Action key:**')
  })

  it('says HEAD is unknown rather than inventing one', () => {
    const options: StatusRenderOptions = {
      stateRoot: root,
      threadIds: ['thread-a'],
      currentCommitSha: null,
      currentBranch: null,
    }
    mkdirSync(join(root, 'thread-a'), { recursive: true })
    const document = renderStatusDocument(collectReports(options), options)
    expect(document).toContain('- **Current HEAD:** unknown (detached or unknown)')
  })
})

describe('branch interpretation', () => {
  it('treats a detached HEAD and empty output as no branch', () => {
    expect(interpretBranch('HEAD')).toBeNull()
    expect(interpretBranch('')).toBeNull()
    expect(interpretBranch(null)).toBeNull()
    expect(interpretBranch(' main \n')).toBe('main')
  })
})
