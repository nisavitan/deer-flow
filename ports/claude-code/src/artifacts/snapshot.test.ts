import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  BINARY_EXTENSIONS,
  DEFAULT_WORKSPACE_LIMITS,
  EXCLUDED_DIR_NAMES,
  FAST_WORKSPACE_MAX_DEPTH,
  changedOutputPaths,
  defaultScanRoots,
  diffSnapshots,
  emptySnapshot,
  hasChanges,
  isSensitiveWorkspacePath,
  readPreSnapshot,
  scanWorkspace,
  summarizeDiff,
  workspacePrePath,
  writePreSnapshot,
  type WorkspaceSnapshot,
} from './snapshot.js'

const NOW = '2026-08-01T12:00:00.000Z'
let root: string
let env: NodeJS.ProcessEnv

function write(relative: string, contents: string | Buffer): string {
  const absolute = join(root, relative)
  mkdirSync(join(absolute, '..'), { recursive: true })
  writeFileSync(absolute, contents)
  return absolute
}

function scan(): WorkspaceSnapshot {
  return scanWorkspace(defaultScanRoots(root), root)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'deerflow-artifacts-'))
  env = { CLAUDE_PROJECT_DIR: root }
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('limits are the original workspace_changes limits', () => {
  it('carries WorkspaceChangeLimits() defaults verbatim (types.py:18-27)', () => {
    expect(DEFAULT_WORKSPACE_LIMITS).toEqual({
      maxFiles: 200,
      maxScannedFiles: 2000,
      maxFileBytesForDiff: 256 * 1024,
      maxTotalDiffBytes: 1024 * 1024,
    })
  })

  it('prunes the original EXCLUDED_DIR_NAMES plus the port-only .deerflow state tree', () => {
    for (const name of ['.git', '.hg', '.svn', '.cache', '.next', '.venv', '.browser-frames', '__pycache__', 'build', 'dist', 'node_modules']) {
      expect(EXCLUDED_DIR_NAMES.has(name)).toBe(true)
    }
    expect(EXCLUDED_DIR_NAMES.has('.deerflow')).toBe(true)
  })

  it('carries the original binary extension set', () => {
    for (const extension of ['.png', '.pdf', '.zip', '.xlsx', '.pyc', '.7z']) {
      expect(BINARY_EXTENSIONS.has(extension)).toBe(true)
    }
    expect(BINARY_EXTENSIONS.size).toBe(29)
  })
})

describe('scanning the two mapped roots', () => {
  it('records project files as workspace and outputs/ files as outputs, keyed by relative POSIX path', () => {
    write('notes.md', 'hello')
    write('outputs/report.md', '# report')
    const snapshot = scan()

    expect(Object.keys(snapshot.files).sort()).toEqual(['notes.md', 'outputs/report.md'])
    expect(snapshot.files['notes.md']?.root).toBe('workspace')
    expect(snapshot.files['outputs/report.md']?.root).toBe('outputs')
    expect(snapshot.truncated).toBe(false)
  })

  it('records outputs/ exactly once even though it lives inside the project root', () => {
    write('outputs/a.md', 'a')
    write('outputs/nested/b.md', 'b')
    const snapshot = scan()

    expect(Object.keys(snapshot.files).sort()).toEqual(['outputs/a.md', 'outputs/nested/b.md'])
    expect(snapshot.files['outputs/nested/b.md']?.root).toBe('outputs')
    expect(snapshot.scanned).toBe(2)
  })

  it('never descends into an excluded directory', () => {
    write('.git/config', 'x')
    write('node_modules/pkg/index.js', 'x')
    write('.deerflow/state/t/goal.json', '{}')
    write('dist/bundle.js', 'x')
    write('kept.txt', 'x')

    expect(Object.keys(scan().files)).toEqual(['kept.txt'])
  })

  it('walks outputs/ to any depth but caps the project tree at FAST_WORKSPACE_MAX_DEPTH', () => {
    write('a/b/c/d/deep.txt', 'x')
    write('outputs/a/b/c/d/deep.txt', 'x')
    const paths = Object.keys(scan().files)

    expect(FAST_WORKSPACE_MAX_DEPTH).toBe(2)
    expect(paths).not.toContain('a/b/c/d/deep.txt')
    expect(paths).toContain('outputs/a/b/c/d/deep.txt')
  })

  it('walks the project tree unbounded when the depth cap is removed', () => {
    write('a/b/c/d/deep.txt', 'x')
    const snapshot = scanWorkspace(defaultScanRoots(root, null), root)
    expect(Object.keys(snapshot.files)).toContain('a/b/c/d/deep.txt')
  })

  it('stops at maxScannedFiles and reports truncated', () => {
    for (let index = 0; index < 12; index++) write(`outputs/file-${index}.txt`, 'x')
    const snapshot = scanWorkspace(defaultScanRoots(root), root, {
      limits: { ...DEFAULT_WORKSPACE_LIMITS, maxScannedFiles: 5 },
    })

    expect(snapshot.scanned).toBe(5)
    expect(snapshot.truncated).toBe(true)
    expect(Object.keys(snapshot.files)).toHaveLength(5)
  })

  it('treats a missing outputs/ directory as contributing nothing', () => {
    write('only.txt', 'x')
    expect(Object.keys(scan().files)).toEqual(['only.txt'])
  })
})

describe('metadata-only rules', () => {
  it('recognises the original sensitive path patterns through env-scrub plus the extras', () => {
    for (const path of [
      '.env',
      '.env.production',
      'outputs/api_key.txt',
      'config/apikey.json',
      'certs/server.pem',
      'certs/server.key',
      'id_rsa',
      'id_ed25519.pub',
      'db_password.txt',
      'my_secret/report.md',
      'auth_token.json',
      'aws_credentials',
    ]) {
      expect(isSensitiveWorkspacePath(path), path).toBe(true)
    }
    for (const path of ['outputs/report.md', 'src/index.ts', 'notes/plan.txt']) {
      expect(isSensitiveWorkspacePath(path), path).toBe(false)
    }
  })

  it('never hashes a sensitive-looking file', () => {
    write('outputs/api_key.txt', 'sk-live-abcdefghijklmnop')
    const file = scan().files['outputs/api_key.txt']

    expect(file?.sensitive).toBe(true)
    expect(file?.sha256).toBeNull()
    expect(file?.content_unavailable_reason).toBe('sensitive')
    expect(file?.size).toBeGreaterThan(0)
  })

  it('never hashes a file above the 256 KiB per-file ceiling', () => {
    write('outputs/big.bin', 'a'.repeat(DEFAULT_WORKSPACE_LIMITS.maxFileBytesForDiff + 1))
    const file = scan().files['outputs/big.bin']

    expect(file?.sha256).toBeNull()
    expect(file?.content_unavailable_reason).toBe('large')
    expect(file?.sensitive).toBe(false)
  })

  it('still hashes a small binary file, marking only its content unavailable', () => {
    write('outputs/chart.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const file = scan().files['outputs/chart.png']

    expect(file?.binary).toBe(true)
    expect(file?.content_unavailable_reason).toBe('binary')
    expect(file?.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('detects binary content by NUL byte, not only by extension', () => {
    write('outputs/blob.dat', Buffer.from([0x41, 0x00, 0x42]))
    expect(scan().files['outputs/blob.dat']?.binary).toBe(true)
    write('outputs/plain.dat', 'no nul here')
    expect(scan().files['outputs/plain.dat']?.binary).toBe(false)
  })

  it('records a symlink from lstat without ever following it', () => {
    write('outputs/real.md', 'real content')
    symlinkSync(join(root, 'outputs/real.md'), join(root, 'outputs/link.md'))
    const file = scan().files['outputs/link.md']

    expect(file?.symlink).toBe(true)
    expect(file?.sha256).toBeNull()
    expect(file?.content_unavailable_reason).toBe('symlink')
    expect(file?.symlink_target).toContain('real.md')
  })

  it('never descends into a symlinked directory', () => {
    write('elsewhere/secret-plan.md', 'x')
    mkdirSync(join(root, 'outputs'), { recursive: true })
    symlinkSync(join(root, 'elsewhere'), join(root, 'outputs/linked'))
    const paths = Object.keys(scan().files)

    expect(paths).toContain('outputs/linked')
    expect(paths).not.toContain('outputs/linked/secret-plan.md')
  })
})

describe('diffSnapshots', () => {
  it('classifies created, modified and deleted, skipping unchanged files', () => {
    write('outputs/keep.md', 'same')
    write('outputs/change.md', 'before')
    write('outputs/gone.md', 'bye')
    const before = scan()

    write('outputs/change.md', 'after')
    write('outputs/new.md', 'new')
    rmSync(join(root, 'outputs/gone.md'))
    const diff = diffSnapshots(before, scan())

    expect(diff.created.map((change) => change.path)).toEqual(['outputs/new.md'])
    expect(diff.modified.map((change) => change.path)).toEqual(['outputs/change.md'])
    expect(diff.deleted.map((change) => change.path)).toEqual(['outputs/gone.md'])
    expect(summarizeDiff(diff)).toEqual({ created: 1, modified: 1, deleted: 1, truncated: false })
    expect(hasChanges(diff)).toBe(true)
  })

  it('reports no changes for an identical tree', () => {
    write('outputs/report.md', 'stable')
    const before = scan()
    const diff = diffSnapshots(before, scan())

    expect(hasChanges(diff)).toBe(false)
    expect(summarizeDiff(diff)).toEqual({ created: 0, modified: 0, deleted: 0, truncated: false })
  })

  it('carries before/after size and hash onto the change record', () => {
    write('outputs/report.md', 'before')
    const before = scan()
    write('outputs/report.md', 'a much longer after')
    const change = diffSnapshots(before, scan()).modified[0]

    expect(change?.size_before).toBe(6)
    expect(change?.size_after).toBe(19)
    expect(change?.sha256_before).not.toBe(change?.sha256_after)
    expect(change?.sha256_before).toMatch(/^[0-9a-f]{64}$/)
  })

  it('falls back to (size, mtime) for a file with no hash on either side', () => {
    write('outputs/api_key.txt', 'aaaa')
    const before = scan()
    // Same size, different content: only the metadata fallback can see this.
    write('outputs/api_key.txt', 'bbbb')
    utimesSync(join(root, 'outputs/api_key.txt'), new Date(2030, 0, 1), new Date(2030, 0, 1))
    const diff = diffSnapshots(before, scan())

    expect(diff.modified.map((change) => change.path)).toEqual(['outputs/api_key.txt'])
    expect(diff.modified[0]?.sha256_after).toBeNull()
  })

  it('caps reported changes at maxFiles and marks the result truncated', () => {
    const before = scan()
    for (let index = 0; index < 6; index++) write(`outputs/new-${index}.md`, 'x')
    const diff = diffSnapshots(before, scan(), { ...DEFAULT_WORKSPACE_LIMITS, maxFiles: 3 })

    expect(diff.created).toHaveLength(3)
    expect(diff.truncated).toBe(true)
  })

  it('inherits truncation from either snapshot', () => {
    const truncated: WorkspaceSnapshot = { ...emptySnapshot(), truncated: true }
    expect(diffSnapshots(truncated, emptySnapshot()).truncated).toBe(true)
    expect(diffSnapshots(emptySnapshot(), truncated).truncated).toBe(true)
  })
})

describe('changedOutputPaths — the delivery verdict input', () => {
  it('returns created and modified regular files under outputs/, sorted', () => {
    write('outputs/b.md', 'b')
    write('src/code.ts', 'x')
    const before = scan()

    write('outputs/a.md', 'a')
    write('outputs/b.md', 'b changed')
    write('src/code.ts', 'x changed')
    const diff = diffSnapshots(before, scan())

    expect(changedOutputPaths(diff)).toEqual(['outputs/a.md', 'outputs/b.md'])
  })

  it('excludes deletions and symlinks', () => {
    write('outputs/gone.md', 'x')
    write('target.md', 'x')
    const before = scan()

    rmSync(join(root, 'outputs/gone.md'))
    symlinkSync(join(root, 'target.md'), join(root, 'outputs/link.md'))
    const diff = diffSnapshots(before, scan())

    expect(changedOutputPaths(diff)).toEqual([])
  })
})

describe('the pre-turn snapshot channel', () => {
  it('round-trips a snapshot through the atomic state file', () => {
    write('outputs/report.md', 'x')
    const snapshot = scan()
    const filePath = workspacePrePath('thread-a', env)
    writePreSnapshot(filePath, snapshot, NOW)

    const restored = readPreSnapshot(filePath)
    expect(restored?.files['outputs/report.md']?.sha256).toBe(snapshot.files['outputs/report.md']?.sha256)
    expect(diffSnapshots(restored ?? emptySnapshot(), snapshot).created).toEqual([])
  })

  it('returns null for an absent baseline rather than an empty snapshot', () => {
    expect(readPreSnapshot(workspacePrePath('thread-missing', env))).toBeNull()
  })

  it('returns null for a corrupt or shapeless baseline', () => {
    const filePath = workspacePrePath('thread-b', env)
    mkdirSync(join(filePath, '..'), { recursive: true })
    writeFileSync(filePath, 'not json at all')
    expect(readPreSnapshot(filePath)).toBeNull()

    writeFileSync(filePath, JSON.stringify({ schema_version: 1, rev: 1, snapshot: { files: [] } }))
    expect(readPreSnapshot(filePath)).toBeNull()
  })

  it('overwrites the previous turn rather than accumulating', () => {
    const filePath = workspacePrePath('thread-c', env)
    write('outputs/first.md', 'x')
    writePreSnapshot(filePath, scan(), NOW)
    rmSync(join(root, 'outputs/first.md'))
    write('outputs/second.md', 'x')
    writePreSnapshot(filePath, scan(), NOW)

    const restored = readPreSnapshot(filePath)
    expect(Object.keys(restored?.files ?? {})).toEqual(['outputs/second.md'])
  })
})
