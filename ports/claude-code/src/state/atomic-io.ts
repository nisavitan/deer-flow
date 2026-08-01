// Ported from backend/packages/harness/deerflow/runtime/checkpoint_state.py:CheckpointStateAccessor @ 0950924 — structural translation
// The original's durability comes from LangGraph's transactional checkpoint row plus optimistic CAS
// on the head checkpoint id (notes/runtime-and-persistence.md §2). The port replaces the row with one
// JSON file per channel and reproduces the two properties that carry correctness:
//   1. never-torn reads  -> temp file + fsync + rename(2) in the same directory;
//   2. staleness detection -> per-file monotonic `rev` compare-and-set, standing down on movement
//      exactly like deerflow.runtime.goal:GoalWriteConflict.
// Schema handling is fail-closed (migrate-or-discard, docs/claude-code-port/state-checkpoint-resume.md §4).
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
import { dirname, basename, join } from 'node:path'

/** Current envelope version written by this library. */
export const STATE_SCHEMA_VERSION = 1

/** Reserved envelope keys; every other key belongs to the channel payload. */
export const ENVELOPE_KEYS = ['schema_version', 'rev', 'updated_at'] as const

export type StatePayload = Record<string, unknown>

export interface StateEnvelope<T extends StatePayload> {
  readonly schemaVersion: number
  /** Monotonic per-file counter; 0 means "file does not exist yet". */
  readonly rev: number
  readonly updatedAt: string
  readonly payload: T
}

/** Migration hook point: `fromVersion -> upgrade payload by exactly one version`. */
export type StateMigrations = Record<number, (payload: StatePayload) => StatePayload>

export interface ReadOptions {
  /** Version this reader understands. Defaults to {@link STATE_SCHEMA_VERSION}. */
  readonly schemaVersion?: number
  readonly migrations?: StateMigrations
}

export interface WriteOptions {
  /** ISO-8601 timestamp stamped as `updated_at`. Injected so pure logic never calls Date.now(). */
  readonly now: string
  /**
   * `rev` the caller read. The write is rejected when the file has moved since.
   * Use 0 to assert the file does not exist yet. Omit to write unconditionally.
   */
  readonly expectedRev?: number
  readonly schemaVersion?: number
}

/** Raised when a state file carries a schema version this build cannot interpret. */
export class StateSchemaVersionError extends Error {
  override readonly name = 'StateSchemaVersionError'
  constructor(
    readonly filePath: string,
    readonly foundVersion: unknown,
    readonly expectedVersion: number,
  ) {
    super(`Unsupported schema_version ${String(foundVersion)} in ${filePath} (this build reads ${expectedVersion})`)
  }
}

/** Raised when a compare-and-set write loses the race — the port's `GoalWriteConflict`. */
export class StateRevConflictError extends Error {
  override readonly name = 'StateRevConflictError'
  constructor(
    readonly filePath: string,
    readonly expectedRev: number,
    readonly actualRev: number,
  ) {
    super(`Stale state write for ${filePath}: expected rev ${expectedRev}, found ${actualRev}`)
  }
}

/** Raised when a file exists but is not a parseable JSON object envelope. */
export class StateFileCorruptError extends Error {
  override readonly name = 'StateFileCorruptError'
  constructor(
    readonly filePath: string,
    readonly detail: string,
  ) {
    super(`Corrupt state file ${filePath}: ${detail}`)
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

/**
 * Temp-file name used by {@link writeStateFile}. Exported so crash-simulation tests can
 * plant a half-written temp file at exactly the path a killed writer would have left.
 */
export function tempFileName(filePath: string, pid: number = process.pid, counter = 0): string {
  return join(dirname(filePath), `${basename(filePath)}.tmp-${pid}-${counter}`)
}

let tempCounter = 0

/**
 * Read one state file.
 *
 * Returns `null` when the file does not exist (an absent channel is empty, never an error).
 * An unknown or newer `schema_version` is never partially parsed: a registered migration is
 * applied in memory, otherwise {@link StateSchemaVersionError} is thrown so the caller can
 * discard the file via {@link discardStateFile}.
 */
export function readStateFile<T extends StatePayload = StatePayload>(
  filePath: string,
  options: ReadOptions = {},
): StateEnvelope<T> | null {
  const expectedVersion = options.schemaVersion ?? STATE_SCHEMA_VERSION
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new StateFileCorruptError(filePath, error instanceof Error ? error.message : 'unparseable JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new StateFileCorruptError(filePath, 'envelope is not a JSON object')
  }

  const envelope = parsed as StatePayload
  const foundVersion = envelope['schema_version']
  if (typeof foundVersion !== 'number' || !Number.isInteger(foundVersion)) {
    throw new StateSchemaVersionError(filePath, foundVersion, expectedVersion)
  }

  const payload: StatePayload = {}
  for (const [key, value] of Object.entries(envelope)) {
    if ((ENVELOPE_KEYS as readonly string[]).includes(key)) continue
    payload[key] = value
  }

  let version = foundVersion
  let migrated = payload
  const migrations = options.migrations ?? {}
  while (version < expectedVersion) {
    const step = migrations[version]
    if (step === undefined) break
    migrated = step(migrated)
    version += 1
  }
  if (version !== expectedVersion) {
    throw new StateSchemaVersionError(filePath, foundVersion, expectedVersion)
  }

  const rev = envelope['rev']
  const updatedAt = envelope['updated_at']
  return {
    schemaVersion: expectedVersion,
    rev: typeof rev === 'number' && Number.isInteger(rev) ? rev : 0,
    updatedAt: typeof updatedAt === 'string' ? updatedAt : '',
    payload: migrated as T,
  }
}

/**
 * Read the current `rev` without interpreting the payload — used by the CAS path so a file
 * written under an unreadable schema still blocks a blind overwrite.
 */
function readRawRev(filePath: string): number {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch (error) {
    if (isMissing(error)) return 0
    throw error
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null) {
      const rev = (parsed as StatePayload)['rev']
      if (typeof rev === 'number' && Number.isInteger(rev)) return rev
    }
  } catch {
    // A corrupt file has no usable rev; treat it as rev 0 so a fresh write can replace it.
  }
  return 0
}

/**
 * Write one state file atomically, bumping `rev`.
 *
 * The payload is written to `<name>.tmp-<pid>-<n>` in the *same* directory, fsynced, then
 * renamed over the target — so a crash at any instant leaves the previous complete version
 * in place. Never partially updates a file.
 */
export function writeStateFile<T extends StatePayload>(
  filePath: string,
  payload: T,
  options: WriteOptions,
): StateEnvelope<T> {
  const schemaVersion = options.schemaVersion ?? STATE_SCHEMA_VERSION
  const currentRev = readRawRev(filePath)
  if (options.expectedRev !== undefined && options.expectedRev !== currentRev) {
    throw new StateRevConflictError(filePath, options.expectedRev, currentRev)
  }

  const nextRev = currentRev + 1
  const envelope: StatePayload = {
    schema_version: schemaVersion,
    rev: nextRev,
    updated_at: options.now,
    ...payload,
  }
  const body = `${JSON.stringify(envelope, null, 2)}\n`

  const dir = dirname(filePath)
  mkdirSync(dir, { recursive: true })
  const tempPath = tempFileName(filePath, process.pid, tempCounter++)
  const fd = openSync(tempPath, 'w')
  try {
    writeSync(fd, body)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tempPath, filePath)
  try {
    const dirFd = openSync(dir, 'r')
    try {
      fsyncSync(dirFd)
    } finally {
      closeSync(dirFd)
    }
  } catch {
    // Directory fsync is a durability nicety; some platforms reject it. The rename is
    // already atomic, so a failure here never leaves a torn file.
  }

  return { schemaVersion, rev: nextRev, updatedAt: options.now, payload }
}

export interface UpdateOptions extends ReadOptions {
  readonly now: string
  /** CAS retries before standing down, mirroring the original's bounded goal-write retry. */
  readonly maxAttempts?: number
}

/**
 * Read-modify-write one state file under `rev` compare-and-set.
 *
 * The mutator receives the current payload (`null` when the channel is empty) and returns the
 * next one. On a losing CAS the read is retried; after `maxAttempts` the caller stands down
 * with {@link StateRevConflictError} instead of clobbering a newer write.
 */
export function updateStateFile<T extends StatePayload>(
  filePath: string,
  mutate: (current: T | null) => T,
  options: UpdateOptions,
): StateEnvelope<T> {
  const maxAttempts = options.maxAttempts ?? 3
  let lastError: StateRevConflictError | null = null
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const current = readStateFile<T>(filePath, options)
    const next = mutate(current?.payload ?? null)
    try {
      const writeOptions: WriteOptions = {
        now: options.now,
        expectedRev: current?.rev ?? 0,
        ...(options.schemaVersion === undefined ? {} : { schemaVersion: options.schemaVersion }),
      }
      return writeStateFile(filePath, next, writeOptions)
    } catch (error) {
      if (!(error instanceof StateRevConflictError)) throw error
      lastError = error
    }
  }
  throw lastError ?? new StateRevConflictError(filePath, -1, -1)
}

/**
 * Migrate-or-discard, discard half: rename an uninterpretable file to
 * `<name>.invalid-<timestamp>` and leave the channel empty. Returns the quarantine path.
 */
export function discardStateFile(filePath: string, timestamp: string): string {
  const quarantined = `${filePath}.invalid-${timestamp.replace(/[:.]/g, '-')}`
  renameSync(filePath, quarantined)
  return quarantined
}
