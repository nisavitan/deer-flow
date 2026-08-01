// Ported from backend/packages/harness/deerflow/workspace_changes/types.py:WorkspaceChangeLimits,FileSnapshot,WorkspaceSnapshot,WorkspaceFileChange @ 0950924 — mechanical TypeScript translation
// Ported from backend/packages/harness/deerflow/workspace_changes/scanner.py:scan_workspace_roots,_snapshot_file,_snapshot_symlink,is_sensitive_workspace_path @ 0950924 — mechanical TypeScript translation
// Ported from backend/packages/harness/deerflow/workspace_changes/diff.py:compare_snapshots,get_changed_paths,get_changed_output_paths,_same_file,_status @ 0950924 — structural translation
//
// WHAT THIS IS. DeerFlow snapshots the two sandbox roots (`/mnt/user-data/workspace` and
// `/mnt/user-data/outputs`) before a run and again after it, and turns the delta into one
// `workspace_changes` event plus the input to the run's delivery verdict. This module is the port
// of the snapshot + delta half; `./delivery.ts` is the port of the verdict half.
//
// THE LIMITS ARE THE ORIGINAL'S, CITED (types.py:18-27, `WorkspaceChangeLimits` defaults):
//   max_files                 = 200        reported changes; beyond it the result is `truncated`
//   max_scanned_files         = 2000       files visited by one scan; beyond it the scan stops
//   max_file_bytes_for_diff   = 256 KiB    per file; above it no sha256 is computed (reason "large")
//   max_total_diff_bytes      = 1 MiB      aggregate unified-diff budget
// The first three are enforced here byte-for-byte. The fourth is carried as a declared constant and
// is INERT in the port, because the port produces no unified diffs at all — see
// parity/DISCREPANCIES.md §M13 entry 1 for why (there is no UI to render them) and for the
// invariants that are kept regardless.
//
// THE THREE METADATA-ONLY RULES ARE THE ORIGINAL'S:
//   - sensitive-looking path  -> no hash at all (scanner.py:176-187). A sha256 of a secret is a
//     fingerprint of the secret; the original returns `sha256=None` and so does this.
//   - large (> 256 KiB)       -> no hash (scanner.py:196). Change detection falls back to
//     (size, mtime), exactly as `_same_file` does upstream (diff.py:156-159).
//   - symlink                 -> lstat + readlink, NEVER followed (scanner.py:118-125, 232-238).
//     The target can point anywhere on the host, including outside the scanned root.
// A binary file IS still hashed (scanner.py:196 hashes it; only `content_unavailable_reason`
// becomes "binary"), because in this port no file content is ever carried anyway — every snapshot
// entry is metadata-only, and `content_unavailable_reason` records *why* content would have been
// unavailable upstream.
//
// TWO CARRIER CHANGES, DECLARED IN parity/DISCREPANCIES.md §M13:
//   1. Roots. The port has no `/mnt/user-data`; `sandbox-contract.md` §2.1 maps
//      `/mnt/user-data/workspace` -> the project working directory and `/mnt/user-data/outputs` ->
//      `./outputs/`. Because `outputs/` lives INSIDE the working directory here (it was a sibling
//      mount upstream), the workspace walk prunes it so a file is never snapshotted twice.
//   2. mtime resolution. The original stores `st_mtime_ns`; Node's portable stat field is
//      `mtimeMs`. Sub-millisecond edits to a file too large to hash can therefore read as
//      unchanged. Files at or below 256 KiB — every realistic deliverable — are compared by
//      sha256, where the resolution question does not arise.
import { closeSync, lstatSync, openSync, readSync, readdirSync, readlinkSync, statSync, type Dirent } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative, sep } from 'node:path'
import { isSecretLikeName } from '../policy/env-scrub.js'
import { readStateFile, threadStateFile, writeStateFile, type StateEnvelope } from '../state/index.js'

/** Snapshot envelope version, bumped when the on-disk shape changes. */
export const WORKSPACE_SNAPSHOT_VERSION = 1

export interface WorkspaceChangeLimits {
  /** Maximum number of reported changes. Beyond it the diff is `truncated`. */
  readonly maxFiles: number
  /** Maximum number of files one scan visits. Beyond it the snapshot is `truncated`. */
  readonly maxScannedFiles: number
  /** Per-file byte ceiling for hashing. Above it the entry is metadata-only, reason `large`. */
  readonly maxFileBytesForDiff: number
  /** Aggregate unified-diff budget. Declared for parity; inert in the port (no diffs produced). */
  readonly maxTotalDiffBytes: number
}

/** `WorkspaceChangeLimits()` defaults, verbatim from types.py:18-27. */
export const DEFAULT_WORKSPACE_LIMITS: WorkspaceChangeLimits = Object.freeze({
  maxFiles: 200,
  maxScannedFiles: 2000,
  maxFileBytesForDiff: 256 * 1024,
  maxTotalDiffBytes: 1024 * 1024,
})

/**
 * Directories never descended into.
 *
 * Verbatim from `scanner.py:EXCLUDED_DIR_NAMES` (19-32), including `.browser-frames`
 * (`constants.py:BROWSER_FRAMES_DIRNAME`), plus one port-only entry: `.deerflow`, which holds this
 * port's own state tree. Without it the pre-turn snapshot would record itself and every turn would
 * report a change.
 */
export const EXCLUDED_DIR_NAMES: ReadonlySet<string> = Object.freeze(
  new Set([
    '.git',
    '.hg',
    '.svn',
    '.cache',
    '.next',
    '.venv',
    '.browser-frames',
    '__pycache__',
    'build',
    'dist',
    'node_modules',
    '.deerflow',
  ]),
)

/** Verbatim from `scanner.py:BINARY_EXTENSIONS` (35-65). Lower-case, leading dot included. */
export const BINARY_EXTENSIONS: ReadonlySet<string> = Object.freeze(
  new Set([
    '.7z',
    '.avif',
    '.bmp',
    '.class',
    '.db',
    '.dll',
    '.dmg',
    '.doc',
    '.docx',
    '.exe',
    '.gif',
    '.gz',
    '.ico',
    '.jar',
    '.jpeg',
    '.jpg',
    '.mov',
    '.mp3',
    '.mp4',
    '.o',
    '.pdf',
    '.png',
    '.pyc',
    '.so',
    '.tar',
    '.webp',
    '.xls',
    '.xlsx',
    '.zip',
  ]),
)

/**
 * Sensitive-name patterns that `src/policy/env-scrub.ts` does NOT already cover.
 *
 * The scanner's `SENSITIVE_PATH_PATTERNS` (scanner.py:67-79) are
 * `.env`, `.env.*`, `*api_key*`, `*apikey*`, `*.key`, `*.pem`, `*credential*`, `*password*`,
 * `*private_key*`, `*secret*`, `*token*`. Six of those eleven fall out of `isSecretLikeName`'s
 * `*KEY*` / `*SECRET*` / `*TOKEN*` / `*PASS*` / `*CREDENTIAL*` patterns (`api_key`, `apikey`,
 * `.key`, `private_key`, `password`, `credential`, `secret`, `token`), so reusing that module is
 * both the instruction and the smaller surface. These five cover the rest, plus the two SSH key
 * names a project tree actually contains.
 */
const EXTRA_SENSITIVE_PATTERNS: readonly RegExp[] = Object.freeze([
  /^\.env$/i,
  /^\.env\..*$/i,
  /\.pem$/i,
  /^id_rsa(\..*)?$/i,
  /^id_ed25519(\..*)?$/i,
])

/**
 * True when any path segment looks like it holds a credential.
 *
 * Mirrors `scanner.py:is_sensitive_workspace_path` (82-91), which matches its patterns against the
 * basename, the whole path, AND every segment. Over-matching is the fail-safe direction and the
 * one `env-scrub.ts` already documents: the cost is a metadata-only entry (no hash), never a
 * dropped file and never a missed delivery obligation.
 */
export function isSensitiveWorkspacePath(path: string): boolean {
  for (const segment of path.split('/')) {
    if (segment.length === 0) continue
    if (isSecretLikeName(segment)) return true
    if (EXTRA_SENSITIVE_PATTERNS.some((pattern) => pattern.test(segment))) return true
  }
  return false
}

/** Lower-cased final extension of a basename, or `''`. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return ''
  return name.slice(dot).toLowerCase()
}

/** Bytes of the leading sample inspected for a NUL byte. `scanner.py:SAMPLE_BYTES = 4096`. */
export const SAMPLE_BYTES = 4096

/** A NUL byte in the first 4 KiB, the original's primary binary signal (`scanner.py:_looks_binary`). */
function looksBinary(filePath: string, size: number): boolean {
  if (size === 0) return false
  let fd: number
  try {
    fd = openSync(filePath, 'r')
  } catch {
    return false
  }
  try {
    const buffer = Buffer.allocUnsafe(Math.min(SAMPLE_BYTES, size))
    const read = readSync(fd, buffer, 0, buffer.length, 0)
    return buffer.subarray(0, read).includes(0)
  } catch {
    return false
  } finally {
    closeSync(fd)
  }
}

function sha256Of(filePath: string): string | null {
  try {
    const fd = openSync(filePath, 'r')
    try {
      const digest = createHash('sha256')
      const buffer = Buffer.allocUnsafe(64 * 1024)
      for (;;) {
        const read = readSync(fd, buffer, 0, buffer.length, null)
        if (read <= 0) break
        digest.update(buffer.subarray(0, read))
      }
      return digest.digest('hex')
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

/** Why a snapshot entry carries no content (and, for `sensitive`, no hash either). */
export type ContentUnavailableReason = 'binary' | 'large' | 'sensitive' | 'symlink'

/** Which of the two mapped roots a path belongs to. */
export type WorkspaceRootName = 'workspace' | 'outputs'

/** One file as of one instant. `FileSnapshot` (types.py:41-54) minus the content fields. */
export interface FileSnapshot {
  /** POSIX path relative to the project root, e.g. `outputs/report.md`. */
  readonly path: string
  readonly root: WorkspaceRootName
  readonly size: number
  /** `stat.mtimeMs`. See the carrier-change note at the top of this file. */
  readonly mtime_ms: number
  /** `null` for sensitive, oversized, or symlinked entries — the metadata-only marker. */
  readonly sha256: string | null
  readonly binary: boolean
  readonly sensitive: boolean
  readonly symlink: boolean
  readonly symlink_target: string | null
  readonly content_unavailable_reason: ContentUnavailableReason | null
}

/** `WorkspaceSnapshot` (types.py:57-60), keyed by project-relative path. */
export interface WorkspaceSnapshot {
  readonly version: number
  readonly files: Record<string, FileSnapshot>
  /** True when the scan hit `maxScannedFiles` and stopped early. */
  readonly truncated: boolean
  readonly scanned: number
}

/** One root of a scan. `maxDepth` is the port's addition — see {@link FAST_WORKSPACE_MAX_DEPTH}. */
export interface ScanRoot {
  readonly name: WorkspaceRootName
  /** Absolute directory on disk. A missing directory contributes nothing (scanner.py:104-105). */
  readonly dir: string
  /** Deepest directory level listed, root itself being 0. `null` means unbounded. */
  readonly maxDepth: number | null
  /** Directory names pruned in addition to {@link EXCLUDED_DIR_NAMES}. */
  readonly prune?: ReadonlySet<string>
}

/** Directory holding files produced for the user. `sandbox-contract.md` §2.1. */
export const OUTPUTS_DIR_NAME = 'outputs'

/**
 * Depth cap for the project-tree half of a hook-time scan.
 *
 * A `UserPromptSubmit` hook runs on the critical path of every turn, so the walk must be bounded by
 * something other than the 2000-file cap alone: a deep monorepo would spend the whole budget three
 * directories down and never reach the files a turn actually touches. `outputs/` is always walked
 * in full — it is small by construction and it is what the delivery contract is about.
 */
export const FAST_WORKSPACE_MAX_DEPTH = 2

/**
 * The two roots both hooks scan, in the order the original listed them
 * (`recorder.py:build_thread_workspace_roots`, 27-40).
 *
 * BOTH HOOKS MUST USE THE SAME SPEC. A pre-snapshot taken at one depth and a post-snapshot taken at
 * another fabricates creations and deletions out of the depth difference alone.
 */
export function defaultScanRoots(projectRoot: string, workspaceMaxDepth: number | null = FAST_WORKSPACE_MAX_DEPTH): ScanRoot[] {
  return [
    {
      name: 'workspace',
      dir: projectRoot,
      maxDepth: workspaceMaxDepth,
      // `outputs/` is a sibling mount upstream but a child directory here; pruning it keeps each
      // file in exactly one root.
      prune: new Set([OUTPUTS_DIR_NAME]),
    },
    { name: 'outputs', dir: join(projectRoot, OUTPUTS_DIR_NAME), maxDepth: null },
  ]
}

/** Project-relative POSIX path, the snapshot's key. */
function relativePosix(projectRoot: string, absolute: string): string {
  return relative(projectRoot, absolute).split(sep).join('/')
}

function snapshotSymlink(projectRoot: string, absolute: string, root: WorkspaceRootName): FileSnapshot | null {
  // Deliberately never followed: no stat(), no open(). `scanner.py:_snapshot_symlink` (232-238).
  let size = 0
  let mtimeMs = 0
  try {
    const stats = lstatSync(absolute)
    size = stats.size
    mtimeMs = stats.mtimeMs
  } catch {
    return null
  }
  let target: string | null = null
  try {
    target = readlinkSync(absolute)
  } catch {
    target = null
  }
  const path = relativePosix(projectRoot, absolute)
  return {
    path,
    root,
    size,
    mtime_ms: mtimeMs,
    sha256: null,
    binary: false,
    sensitive: isSensitiveWorkspacePath(path),
    symlink: true,
    symlink_target: target,
    content_unavailable_reason: 'symlink',
  }
}

function snapshotFile(
  projectRoot: string,
  absolute: string,
  root: WorkspaceRootName,
  limits: WorkspaceChangeLimits,
): FileSnapshot | null {
  let size: number
  let mtimeMs: number
  try {
    const stats = statSync(absolute)
    if (!stats.isFile()) return null
    size = stats.size
    mtimeMs = stats.mtimeMs
  } catch {
    return null
  }

  const path = relativePosix(projectRoot, absolute)
  const base = path.slice(path.lastIndexOf('/') + 1)

  if (isSensitiveWorkspacePath(path)) {
    // scanner.py:176-187 — sensitive files return early with sha256=None, before any read.
    return {
      path,
      root,
      size,
      mtime_ms: mtimeMs,
      sha256: null,
      binary: false,
      sensitive: true,
      symlink: false,
      symlink_target: null,
      content_unavailable_reason: 'sensitive',
    }
  }

  const binary = BINARY_EXTENSIONS.has(extensionOf(base)) || looksBinary(absolute, size)
  const oversized = size > limits.maxFileBytesForDiff
  const sha256 = oversized ? null : sha256Of(absolute)
  const reason: ContentUnavailableReason | null = binary ? 'binary' : oversized ? 'large' : null

  return {
    path,
    root,
    size,
    mtime_ms: mtimeMs,
    sha256,
    binary,
    sensitive: false,
    symlink: false,
    symlink_target: null,
    content_unavailable_reason: reason,
  }
}

export interface ScanOptions {
  readonly limits?: WorkspaceChangeLimits
}

/**
 * Walk the given roots and record one metadata entry per regular file and per symlink.
 *
 * Mechanical port of `scanner.py:scan_workspace_roots` (94-152): roots in order, directory names in
 * `EXCLUDED_DIR_NAMES` pruned, symlinked directories never descended into, entries sorted so two
 * scans of an unchanged tree are byte-identical, and the whole scan stopping the moment
 * `maxScannedFiles` is reached (`truncated: true`).
 *
 * Never throws: an unreadable directory or file contributes nothing.
 */
export function scanWorkspace(roots: readonly ScanRoot[], projectRoot: string, options: ScanOptions = {}): WorkspaceSnapshot {
  const limits = options.limits ?? DEFAULT_WORKSPACE_LIMITS
  const files: Record<string, FileSnapshot> = {}
  let scanned = 0
  let truncated = false

  for (const root of roots) {
    if (truncated) break
    const queue: Array<{ dir: string; depth: number }> = [{ dir: root.dir, depth: 0 }]
    while (queue.length > 0) {
      const current = queue.shift()
      if (current === undefined) break
      let entries: Dirent[]
      try {
        entries = readdirSync(current.dir, { withFileTypes: true })
      } catch {
        continue // Missing or unreadable root/dir contributes nothing (scanner.py:104-105).
      }
      const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      const subdirs: Array<{ dir: string; depth: number }> = []
      for (const entry of sorted) {
        const absolute = join(current.dir, entry.name)
        if (entry.isSymbolicLink()) {
          // A symlink is recorded whether it points at a file or a directory, and is never
          // followed for either purpose.
          const snapshot = snapshotSymlink(projectRoot, absolute, root.name)
          if (snapshot !== null) {
            files[snapshot.path] = snapshot
            scanned += 1
            if (scanned >= limits.maxScannedFiles) {
              truncated = true
              return { version: WORKSPACE_SNAPSHOT_VERSION, files, truncated, scanned }
            }
          }
          continue
        }
        if (entry.isDirectory()) {
          if (EXCLUDED_DIR_NAMES.has(entry.name)) continue
          if (root.prune?.has(entry.name) === true && current.depth === 0) continue
          if (root.maxDepth !== null && current.depth + 1 > root.maxDepth) continue
          subdirs.push({ dir: absolute, depth: current.depth + 1 })
          continue
        }
        if (!entry.isFile()) continue
        const snapshot = snapshotFile(projectRoot, absolute, root.name, limits)
        if (snapshot === null) continue
        files[snapshot.path] = snapshot
        scanned += 1
        if (scanned >= limits.maxScannedFiles) {
          truncated = true
          return { version: WORKSPACE_SNAPSHOT_VERSION, files, truncated, scanned }
        }
      }
      // Breadth-first so a depth cap keeps the shallow, interesting files rather than whichever
      // deep branch the walker happened to enter first.
      queue.push(...subdirs)
    }
  }

  return { version: WORKSPACE_SNAPSHOT_VERSION, files, truncated, scanned }
}

/** The empty snapshot — what an absent pre-turn record reads as. */
export function emptySnapshot(): WorkspaceSnapshot {
  return { version: WORKSPACE_SNAPSHOT_VERSION, files: {}, truncated: false, scanned: 0 }
}

export type ChangeStatus = 'created' | 'modified' | 'deleted'

/** `WorkspaceFileChange` (types.py:63-86) minus the diff/additions/deletions fields. */
export interface WorkspaceFileChange {
  readonly path: string
  readonly root: WorkspaceRootName
  readonly status: ChangeStatus
  readonly binary: boolean
  readonly sensitive: boolean
  readonly symlink: boolean
  readonly size_before: number | null
  readonly size_after: number | null
  readonly sha256_before: string | null
  readonly sha256_after: string | null
  readonly content_unavailable_reason: ContentUnavailableReason | null
}

export interface WorkspaceDiff {
  readonly created: WorkspaceFileChange[]
  readonly modified: WorkspaceFileChange[]
  readonly deleted: WorkspaceFileChange[]
  /** True when either snapshot was truncated, or more than `maxFiles` paths changed. */
  readonly truncated: boolean
}

/**
 * `diff.py:_same_file` (155-159), verbatim: sha256 when both sides have one, else (size, mtime).
 *
 * The fallback is what makes the metadata-only rules safe — a sensitive or oversized file is still
 * seen to change, it just is not fingerprinted.
 */
function sameFile(before: FileSnapshot, after: FileSnapshot): boolean {
  if (before.sha256 !== null && after.sha256 !== null) return before.sha256 === after.sha256
  return before.size === after.size && before.mtime_ms === after.mtime_ms
}

function toChange(status: ChangeStatus, before: FileSnapshot | null, after: FileSnapshot | null): WorkspaceFileChange {
  const sample = after ?? before
  /* c8 ignore next */
  if (sample === null) throw new Error('unreachable: a change needs at least one side')
  return {
    path: sample.path,
    root: sample.root,
    status,
    binary: sample.binary,
    sensitive: sample.sensitive,
    symlink: sample.symlink,
    size_before: before?.size ?? null,
    size_after: after?.size ?? null,
    sha256_before: before?.sha256 ?? null,
    sha256_after: after?.sha256 ?? null,
    content_unavailable_reason: sample.content_unavailable_reason,
  }
}

/**
 * Pure delta between two snapshots.
 *
 * Port of `diff.py:compare_snapshots` (17-100) with the content half removed: paths are visited in
 * sorted order, unchanged files are skipped, and once `maxFiles` changes have been recorded the
 * rest are counted only through `truncated` — the original's exact overflow behaviour
 * (diff.py:83-84).
 *
 * The original's fourth status, `symlink_created`, is collapsed here: a symlink appearing where a
 * regular file stood is `modified` (both sides exist), and a brand-new one is `created`. The
 * distinction existed upstream to stop such a path being reported `deleted` (diff.py:130-136),
 * which this two-sided classification cannot produce. The `symlink` flag survives on every change.
 */
export function diffSnapshots(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
  limits: WorkspaceChangeLimits = DEFAULT_WORKSPACE_LIMITS,
): WorkspaceDiff {
  const created: WorkspaceFileChange[] = []
  const modified: WorkspaceFileChange[] = []
  const deleted: WorkspaceFileChange[] = []
  let truncated = before.truncated || after.truncated
  let recorded = 0

  const paths = [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].sort()
  for (const path of paths) {
    const beforeFile = before.files[path] ?? null
    const afterFile = after.files[path] ?? null
    if (beforeFile !== null && afterFile !== null && sameFile(beforeFile, afterFile)) continue
    if (recorded >= limits.maxFiles) {
      truncated = true
      continue
    }
    recorded += 1
    if (beforeFile === null) created.push(toChange('created', null, afterFile))
    else if (afterFile === null) deleted.push(toChange('deleted', beforeFile, null))
    else modified.push(toChange('modified', beforeFile, afterFile))
  }

  return { created, modified, deleted, truncated }
}

export interface WorkspaceChangeSummary {
  readonly created: number
  readonly modified: number
  readonly deleted: number
  readonly truncated: boolean
}

/** `WorkspaceChangeSummary` (types.py:89-99) minus the line counters no diff produces. */
export function summarizeDiff(diff: WorkspaceDiff): WorkspaceChangeSummary {
  return {
    created: diff.created.length,
    modified: diff.modified.length,
    deleted: diff.deleted.length,
    truncated: diff.truncated,
  }
}

/** True when the diff holds nothing at all — the original's `WorkspaceChangeResult.has_changes()`. */
export function hasChanges(diff: WorkspaceDiff): boolean {
  return diff.created.length > 0 || diff.modified.length > 0 || diff.deleted.length > 0
}

/**
 * Created or modified REGULAR files under `outputs/`, sorted.
 *
 * Verbatim contract of `diff.py:get_changed_output_paths` (114-121): deletions do not count (you
 * cannot present a file you removed) and symlinks are excluded (never followed, so never proven to
 * be a deliverable). This list is the input to the delivery verdict.
 */
export function changedOutputPaths(diff: WorkspaceDiff): string[] {
  return [...diff.created, ...diff.modified]
    .filter((change) => change.root === 'outputs' && !change.symlink)
    .map((change) => change.path)
    .sort()
}

// --- the pre-turn snapshot channel -------------------------------------------------------------
//
// The original held the pre-run snapshot in the worker's memory for the lifetime of the run
// (`capture_workspace_snapshot` -> local variable -> `record_workspace_changes`, worker.py:673-681,
// 1044-1060). Two hooks are two processes, so the port has to durably hand it over; it uses the
// same atomic-write + `rev`-CAS envelope as every other channel.

/** File name of the pre-turn snapshot handed from the UserPromptSubmit hook to the Stop hook. */
export const WORKSPACE_PRE_FILE = 'workspace-pre.json'

export interface WorkspaceSnapshotPayload {
  snapshot: WorkspaceSnapshot
  [key: string]: unknown
}

/** Absolute path of a thread's `workspace-pre.json`. */
export function workspacePrePath(threadId: string, env?: NodeJS.ProcessEnv): string {
  return threadStateFile(threadId, WORKSPACE_PRE_FILE, env)
}

/** Persist the pre-turn snapshot atomically, replacing the previous turn's. */
export function writePreSnapshot(
  filePath: string,
  snapshot: WorkspaceSnapshot,
  now: string,
): StateEnvelope<WorkspaceSnapshotPayload> {
  // Unconditional write, no CAS: this channel has exactly one writer (the UserPromptSubmit hook)
  // and each turn's value fully supersedes the last, so a lost race has no meaning here.
  return writeStateFile<WorkspaceSnapshotPayload>(filePath, { snapshot }, { now })
}

/**
 * Read the pre-turn snapshot, or `null` when there is none this build can use.
 *
 * `null` is load-bearing for the Stop hook: without a pre-snapshot every file on disk would diff as
 * `created` and the delivery gate would block on the whole project tree. The caller MUST stand
 * down on `null` rather than substitute the empty snapshot.
 */
export function readPreSnapshot(filePath: string): WorkspaceSnapshot | null {
  let payload: WorkspaceSnapshotPayload | null
  try {
    payload = readStateFile<WorkspaceSnapshotPayload>(filePath)?.payload ?? null
  } catch {
    return null // Corrupt or future-schema: no usable baseline.
  }
  const snapshot = payload?.snapshot
  if (typeof snapshot !== 'object' || snapshot === null) return null
  const files = (snapshot as WorkspaceSnapshot).files
  if (typeof files !== 'object' || files === null || Array.isArray(files)) return null
  return {
    version: typeof snapshot.version === 'number' ? snapshot.version : WORKSPACE_SNAPSHOT_VERSION,
    files,
    truncated: snapshot.truncated === true,
    scanned: typeof snapshot.scanned === 'number' ? snapshot.scanned : Object.keys(files).length,
  }
}
