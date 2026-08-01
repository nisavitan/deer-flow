// Ported from backend/packages/harness/deerflow/agents/middlewares/read_before_write_middleware.py
//   @ 0950924 — mechanical TypeScript translation of `_BLOCK_MESSAGE` (57-62), `_content_hash` (86),
//   `_normalize_mark_path` (82), `_latest_mark_hash` (223-236) and `_check_write_gate` (186-214).
//   Behavioural spec: docs/claude-code-port/notes/middlewares.md §2.11.
//   No baseline vectors exist for this middleware (it is not in the frozen G1-G7 set), so the
//   authority is the source and `backend/tests/test_read_before_write_middleware.py`.
//
// THE CARRIER CHANGES, THE INVARIANT DOES NOT. The original keeps its state IN THE CONVERSATION:
// the sha256 of a file's content is stamped onto the `read_file` ToolMessage's `additional_kwargs`,
// and the gate scans `state["messages"]` in reverse for the newest mark on that path. That has a
// property worth naming, because the port loses it: summarization deleting the read result deletes
// the mark with it, so the gate can never pass on evidence the model no longer has.
//
// Claude Code hooks cannot write to the transcript, so the port keeps marks in a state FILE
// (`.deerflow/state/<thread>/read-marks.json`). Consequences, both recorded in parity/DISCREPANCIES.md:
//   (a) a mark now outlives the Read result in context — after a compaction the gate may pass on a
//       file the model can no longer see. The hash still guarantees the file has not CHANGED since
//       it was read, which is the property the middleware exists for (#3857's duplicate-output bug
//       came from blind appends, not from forgotten reads);
//   (b) the mark list needs its own bound, since it is no longer bounded by the message window.
//
// THREE INVARIANTS ARE CARRIED EXACTLY:
//   1. the NEWEST mark for a path must equal the file's CURRENT hash — a stale mark is no mark;
//   2. writes NEVER refresh marks, so consecutive modifications each require a fresh read (this is
//      structural here: only the Read hook stamps, and it stamps after the read);
//   3. FAIL-OPEN — a missing file (creation) or an unreadable one allows the write, and the tool
//      produces its own error.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { threadStateFile } from '../state/paths.js'
import { readStateFile, updateStateFile, type StateEnvelope, type UpdateOptions } from '../state/atomic-io.js'
import { posixNormpath } from './python-json.js'

/** File name of the read-mark channel inside a thread's state directory. */
export const READ_MARKS_FILE = 'read-marks.json'

/**
 * Escape hatch for the whole feature — the port's stand-in for `read_before_write.enabled`.
 *
 * The original config defaults the feature ON, so the port's default is ON too and this variable
 * turns it OFF. It governs BOTH halves (gate and mark stamping), exactly as the single config flag
 * did: a store that kept filling while the gate was off would only mislead a later re-enable.
 */
export const DISABLE_READ_GATE_ENV_VAR = 'DEERFLOW_DISABLE_READ_GATE'

/** `READ_MARK_KEY` — kept as the payload key so the file is self-describing. */
export const READ_MARK_KEY = 'deerflow_read_mark'

/**
 * Port addition: how many distinct paths keep a mark. The original was bounded by the message
 * window; a file is not. 200 paths is far past any plausible read-then-write set in one thread, and
 * eviction is oldest-stamp-first, so evicting can only ever cause a *re-read demand*, never a
 * wrongly-allowed write.
 */
export const MAX_TRACKED_MARKS = 200

/**
 * `_UNINSPECTABLE_CONTENT_PREFIX` — AIO/E2B-style sandboxes return read failures as `"Error: ..."`
 * strings instead of raising. Content with this prefix means "cannot inspect": fail open, stamp
 * nothing.
 */
export const UNINSPECTABLE_CONTENT_PREFIX = 'Error:'

/** The original's read tool name, which the message tells the model to call. */
export const ORIGINAL_READ_TOOL_NAME = 'read_file'

/**
 * Verbatim `_BLOCK_MESSAGE`. Model-facing text — do not reword.
 *
 * The leading `"Error: "` is kept: in the original this string was the CONTENT of a
 * `ToolMessage(status="error")`, and the model was trained by every other tool error to read that
 * prefix as "this call did not happen". As a PreToolUse deny reason it plays exactly the same role.
 *
 * `readToolName` is the ONE declared deviation, and it defaults to the original's `read_file` so
 * this function stays verbatim by default. The hook passes `"Read"`, because instructing a Claude
 * Code model to "call read_file" names a tool that does not exist — the same DeerFlow-name to
 * native-name substitution the port already whitelists for the lead prompt (M3,
 * src/prompts/substitutions.ts). Recorded in parity/DISCREPANCIES.md.
 */
export function blockMessage(toolName: string, path: string, readToolName: string = ORIGINAL_READ_TOOL_NAME): string {
  return (
    `Error: ${toolName} blocked — ${path} already exists and you have not read its current version. ` +
    'Any write invalidates earlier reads, so re-read before every modification. ' +
    `Call ${readToolName} on it (a ranged read of the relevant section is enough, e.g. the last ~30 lines ` +
    'before an append), check what is already there, then retry.'
  )
}

/** One stamped read: `{"path": <normalized>, "hash": <sha256>}` plus the port's ordering stamp. */
export interface ReadMark {
  readonly path: string
  readonly hash: string
  /** ISO-8601 stamp time. The port's replacement for "position in the message list". */
  readonly at: string
}

export interface ReadMarksPayload {
  readonly marks: ReadMark[]
  readonly [key: string]: unknown
}

/** `_normalize_mark_path` — `posixpath.normpath`, the exact key the gate looks up. */
export function normalizeMarkPath(path: string): string {
  return posixNormpath(path)
}

/** `_content_hash` — sha256 of the full file content, hex. */
export function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/**
 * Hash a file's current content, or `null` when it cannot be inspected.
 *
 * `null` is the fail-open signal and covers both of the original's allow branches: `FileNotFoundError`
 * (write_file creates the file; str_replace surfaces its own error) and "any reader exception".
 */
export function hashFileIfReadable(filePath: string): string | null {
  try {
    const content = readFileSync(filePath, 'utf8')
    if (content.startsWith(UNINSPECTABLE_CONTENT_PREFIX)) return null
    return contentHash(content)
  } catch {
    return null
  }
}

/** Defensive read of the marks list from an untrusted payload. Never throws. */
export function parseReadMarks(value: unknown): ReadMark[] {
  if (typeof value !== 'object' || value === null) return []
  const raw = (value as Record<string, unknown>)['marks']
  if (!Array.isArray(raw)) return []
  const marks: ReadMark[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const path = record['path']
    const hash = record['hash']
    const at = record['at']
    if (typeof path === 'string' && typeof hash === 'string') {
      marks.push({ path, hash, at: typeof at === 'string' ? at : '' })
    }
  }
  return marks
}

/**
 * `_latest_mark_hash` — the NEWEST mark for a path, or `null`.
 *
 * Reverse scan, exactly like the original's walk back through `state["messages"]`.
 */
export function latestMarkHash(marks: readonly ReadMark[], normalizedPath: string): string | null {
  for (let index = marks.length - 1; index >= 0; index -= 1) {
    const mark = marks[index]
    if (mark !== undefined && mark.path === normalizedPath) return mark.hash
  }
  return null
}

/**
 * Stamp a read.
 *
 * Prior marks for the same path are dropped rather than kept: the newest is the only one the gate
 * would ever consult, and keeping the history would only grow the file. Oldest-first eviction at
 * {@link MAX_TRACKED_MARKS}.
 */
export function stampReadMark(marks: readonly ReadMark[], mark: ReadMark): ReadMark[] {
  const next = marks.filter((existing) => existing.path !== mark.path)
  next.push(mark)
  return next.length > MAX_TRACKED_MARKS ? next.slice(-MAX_TRACKED_MARKS) : next
}

export type WriteGateDecision = { readonly allowed: true } | { readonly allowed: false; readonly reason: string }

export interface WriteGateInput {
  /** The write tool's name, as it appears in the deny message. */
  readonly toolName: string
  /** The path exactly as the caller requested it — this is what the message quotes back. */
  readonly path: string
  /** sha256 of the file's CURRENT content, or `null` when it does not exist / cannot be read. */
  readonly currentHash: string | null
  readonly marks: readonly ReadMark[]
  /** Read tool the deny message names. Defaults to the original's `read_file`. */
  readonly readToolName?: string
}

/**
 * `_check_write_gate` — allow, or deny with the ported re-read guidance.
 *
 * Allowed when the file cannot be inspected (fail-open, `currentHash === null`) or when the newest
 * mark for the normalized path equals the current hash. Everything else — no mark at all, or a mark
 * from before the file changed — is denied.
 */
export function checkWriteGate(input: WriteGateInput): WriteGateDecision {
  if (input.currentHash === null) return { allowed: true }
  const normalized = normalizeMarkPath(input.path)
  if (latestMarkHash(input.marks, normalized) === input.currentHash) return { allowed: true }
  return { allowed: false, reason: blockMessage(input.toolName, input.path, input.readToolName) }
}

/** Absolute path of a thread's `read-marks.json`. */
export function readMarksPath(threadId: string, env?: NodeJS.ProcessEnv): string {
  return threadStateFile(threadId, READ_MARKS_FILE, env)
}

/**
 * Read the stored marks for a thread.
 *
 * A missing, corrupt, or future-schema file is an EMPTY mark set, never an exception: an unreadable
 * mark store must degrade into "re-read the file", which is the safe direction. The opposite
 * degradation (throwing, and the hook failing open) is the one that would let a blind write through.
 */
export function loadReadMarks(filePath: string): ReadMark[] {
  try {
    const envelope = readStateFile<ReadMarksPayload>(filePath)
    return envelope === null ? [] : parseReadMarks(envelope.payload)
  } catch {
    return []
  }
}

/** Persist one stamped read under the state library's atomic write + `rev` compare-and-set. */
export function applyReadMark(
  filePath: string,
  mark: ReadMark,
  options: UpdateOptions,
): StateEnvelope<ReadMarksPayload> {
  return updateStateFile<ReadMarksPayload>(
    filePath,
    (current) => ({ marks: stampReadMark(parseReadMarks(current), mark) }),
    options,
  )
}
