// Ported from backend/packages/harness/deerflow/agents/thread_state.py:merge_skill_context,_normalize_skill_entry @ 0950924 — mechanical TypeScript translation
// Parity vectors: parity/baseline/state_reducers.json -> merge_skill_context.
import { threadStateFile } from './paths.js'
import { updateStateFile, type StateEnvelope, type UpdateOptions } from './atomic-io.js'

/** File name of the skill-context channel inside a thread's state directory. */
export const SKILL_CONTEXT_FILE = 'skill-context.json'

/** Recency cap — `_SKILL_CONTEXT_MAX_ENTRIES` in the original. */
export const SKILL_CONTEXT_MAX_ENTRIES = 8

/** Description cap — `_SKILL_DESCRIPTION_MAX_CHARS` in the original. */
export const SKILL_DESCRIPTION_MAX_CHARS = 500

/** Declared as a type alias (not an interface) so entries stay assignable to `Record<string, unknown>`. */
export type SkillEntry = {
  name: string
  path: string
  description: string
  /** Observational only: message indices reset after compaction. */
  loaded_at: number
}

export interface SkillContextPayload {
  entries: SkillEntry[]
  [key: string]: unknown
}

/** Raised when a skill-context write carries no `path` to dedupe on. */
export class MissingSkillPathError extends Error {
  override readonly name = 'MissingSkillPathError'
  constructor() {
    super('Skill-context entries must carry a "path"')
  }
}

/** Python truthiness for the `entry.get("name") or ""` fallback. */
function orEmpty(value: unknown): string {
  if (value === undefined || value === null || value === '' || value === false || value === 0) return ''
  return String(value)
}

/** Collapse runs of whitespace, mirroring Python's `" ".join(text.split())`. */
function collapseWhitespace(text: string): string {
  return text.split(/\s+/).filter((part) => part.length > 0).join(' ')
}

/**
 * Drop legacy payload keys (notably a verbatim SKILL.md `body`/`content`) before storing
 * skill_context back to state, whitespace-collapse the description and cap its length.
 */
export function normalizeSkillEntry(entry: Record<string, unknown>): SkillEntry {
  const path = entry['path']
  if (path === undefined || path === null) throw new MissingSkillPathError()
  const description = entry['description']
  const loadedAt = entry['loaded_at']
  return {
    name: orEmpty(entry['name']),
    path: String(path),
    description: typeof description === 'string' ? collapseWhitespace(description).slice(0, SKILL_DESCRIPTION_MAX_CHARS) : '',
    loaded_at: typeof loadedAt === 'number' && Number.isInteger(loadedAt) ? loadedAt : 0,
  }
}

/**
 * Reducer for the skill-context channel.
 *
 * - incoming None/empty -> preserve existing (still normalized: legacy bodies are dropped);
 * - dedup by `path`; a later read refreshes recency and replaces the reference;
 * - cap by keeping the {@link SKILL_CONTEXT_MAX_ENTRIES} most recently read entries.
 */
export function mergeSkillContext(
  existing: readonly Record<string, unknown>[] | null | undefined,
  incoming: readonly Record<string, unknown>[] | null | undefined,
): SkillEntry[] {
  const normalizedExisting = (existing ?? []).map(normalizeSkillEntry)
  if (incoming === null || incoming === undefined || incoming.length === 0) {
    return normalizedExisting
  }

  const byPath = new Map<string, SkillEntry>()
  for (const entry of normalizedExisting) {
    // A repeated path keeps its first-seen position and the latest payload.
    byPath.set(entry.path, entry)
  }

  for (const raw of incoming) {
    const entry = normalizeSkillEntry(raw)
    // Re-reading a skill moves it to the most-recent slot, so `delete` before `set`.
    byPath.delete(entry.path)
    byPath.set(entry.path, entry)
  }

  const merged = [...byPath.values()]
  return merged.length > SKILL_CONTEXT_MAX_ENTRIES ? merged.slice(-SKILL_CONTEXT_MAX_ENTRIES) : merged
}

/** Absolute path of a thread's `skill-context.json`. */
export function skillContextPath(threadId: string, env?: NodeJS.ProcessEnv): string {
  return threadStateFile(threadId, SKILL_CONTEXT_FILE, env)
}

/** Apply a skill-context write under atomic-write + `rev` CAS. */
export function applySkillContext(
  filePath: string,
  incoming: readonly Record<string, unknown>[] | null,
  options: UpdateOptions,
): StateEnvelope<SkillContextPayload> {
  return updateStateFile<SkillContextPayload>(
    filePath,
    (current) => ({ entries: mergeSkillContext(current?.entries ?? null, incoming) }),
    options,
  )
}
