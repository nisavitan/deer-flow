import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  MAX_HISTORY_ENTRIES,
  MAX_PATHS_PER_ENTRY,
  appendChangesEntry,
  applyWorkspaceChanges,
  buildChangesEntry,
  describesSameDelta,
  latestChangesEntry,
  renderChangeContent,
  workspaceChangesPath,
  type WorkspaceChangesEntry,
  type WorkspaceChangesPayload,
} from './workspace-changes.js'
import { readStateFile } from '../state/atomic-io.js'
import type { WorkspaceDiff, WorkspaceFileChange, WorkspaceRootName } from './snapshot.js'

const NOW = '2026-08-01T12:00:00.000Z'
const THREAD = 'thread-changes'
let root: string
let env: NodeJS.ProcessEnv

function change(path: string, root_: WorkspaceRootName = 'outputs'): WorkspaceFileChange {
  return {
    path,
    root: root_,
    status: 'created',
    binary: false,
    sensitive: false,
    symlink: false,
    size_before: null,
    size_after: 1,
    sha256_before: null,
    sha256_after: 'a'.repeat(64),
    content_unavailable_reason: null,
  }
}

function diffOf(created: string[], modified: string[] = [], deleted: string[] = []): WorkspaceDiff {
  return {
    created: created.map((path) => change(path)),
    modified: modified.map((path) => ({ ...change(path), status: 'modified' as const })),
    deleted: deleted.map((path) => ({ ...change(path), status: 'deleted' as const })),
    truncated: false,
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'deerflow-changes-'))
  env = { CLAUDE_PROJECT_DIR: root }
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('renderChangeContent', () => {
  it('names the three buckets and pluralises the file count', () => {
    expect(renderChangeContent({ created: 1, modified: 0, deleted: 0, truncated: false })).toBe('1 file changed +1 ~0 -0')
    expect(renderChangeContent({ created: 2, modified: 1, deleted: 3, truncated: false })).toBe('6 files changed +2 ~1 -3')
  })

  it('flags a truncated record', () => {
    expect(renderChangeContent({ created: 200, modified: 0, deleted: 0, truncated: true })).toContain('(truncated)')
  })
})

describe('buildChangesEntry', () => {
  it('records the summary, the three path lists and the outputs delta', () => {
    const entry = buildChangesEntry(diffOf(['outputs/a.md'], ['src/x.ts'], ['outputs/old.md']), NOW)

    expect(entry.recorded_at).toBe(NOW)
    expect(entry.summary).toEqual({ created: 1, modified: 1, deleted: 1, truncated: false })
    expect(entry.created).toEqual(['outputs/a.md'])
    expect(entry.outputs_changed).toEqual(['outputs/a.md', 'src/x.ts'])
    expect(entry.paths_truncated).toBe(false)
  })

  it('excludes deletions from outputs_changed', () => {
    const entry = buildChangesEntry(diffOf([], [], ['outputs/gone.md']), NOW)
    expect(entry.outputs_changed).toEqual([])
  })

  it('caps each path list at MAX_PATHS_PER_ENTRY and says so', () => {
    const many = Array.from({ length: MAX_PATHS_PER_ENTRY + 5 }, (_, index) => `outputs/f-${index}.md`)
    const entry = buildChangesEntry(diffOf(many), NOW)

    expect(entry.created).toHaveLength(MAX_PATHS_PER_ENTRY)
    expect(entry.paths_truncated).toBe(true)
    expect(entry.summary.created).toBe(MAX_PATHS_PER_ENTRY + 5)
  })
})

describe('appendChangesEntry', () => {
  const entryFor = (path: string, at: string): WorkspaceChangesEntry => buildChangesEntry(diffOf([path]), at)

  it('appends oldest-first', () => {
    const list = appendChangesEntry(appendChangesEntry(null, entryFor('outputs/a.md', NOW)), entryFor('outputs/b.md', NOW))
    expect(list.map((entry) => entry.created[0])).toEqual(['outputs/a.md', 'outputs/b.md'])
  })

  it('keeps at most MAX_HISTORY_ENTRIES, dropping the oldest', () => {
    let list: WorkspaceChangesEntry[] = []
    for (let index = 0; index < MAX_HISTORY_ENTRIES + 4; index++) {
      list = appendChangesEntry(list, entryFor(`outputs/f-${index}.md`, NOW))
    }

    expect(list).toHaveLength(MAX_HISTORY_ENTRIES)
    expect(list[0]?.created).toEqual(['outputs/f-4.md'])
    expect(list[list.length - 1]?.created).toEqual([`outputs/f-${MAX_HISTORY_ENTRIES + 3}.md`])
  })

  it('does not re-append a delta identical to the newest one', () => {
    // Exactly what a blocked Stop produces: the continuation turn re-diffs the same baseline.
    const first = entryFor('outputs/a.md', NOW)
    const repeat = entryFor('outputs/a.md', '2026-08-01T12:05:00.000Z')

    expect(describesSameDelta(first, repeat)).toBe(true)
    const list = appendChangesEntry(appendChangesEntry(null, first), repeat)
    expect(list).toHaveLength(1)
    expect(list[0]?.recorded_at).toBe(NOW)
  })

  it('does append when the delta actually changed', () => {
    const list = appendChangesEntry(appendChangesEntry(null, entryFor('outputs/a.md', NOW)), entryFor('outputs/b.md', NOW))
    expect(list).toHaveLength(2)
  })
})

describe('the workspace-changes state channel', () => {
  it('persists an entry and reads the newest one back', () => {
    const filePath = workspaceChangesPath(THREAD, env)
    applyWorkspaceChanges(filePath, buildChangesEntry(diffOf(['outputs/a.md']), NOW), { now: NOW })
    applyWorkspaceChanges(filePath, buildChangesEntry(diffOf(['outputs/b.md']), NOW), { now: NOW })

    const payload = readStateFile<WorkspaceChangesPayload>(filePath)?.payload ?? null
    expect(payload?.entries).toHaveLength(2)
    expect(latestChangesEntry(payload)?.created).toEqual(['outputs/b.md'])
  })

  it('returns null from latestChangesEntry for an empty or absent channel', () => {
    expect(latestChangesEntry(null)).toBeNull()
    expect(latestChangesEntry({ entries: [] })).toBeNull()
  })
})
