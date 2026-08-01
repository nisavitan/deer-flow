// Context-loss MEASUREMENT harness — port-authored, no original equivalent.
//
// WHY IT EXISTS. The user decision in force for v1 summarization is: native compaction +
// structured checkpoint summaries + atomic state, with the delta documented AND parity tests
// that MEASURE context loss after compaction/resume rather than asserting survival
// (PROGRESS.md, "User decisions in force"). Asserting "the thread still works after
// compaction" proves nothing about what was dropped; this module makes the loss a number.
//
// SHAPE OF THE MEASUREMENT. A pre-compaction snapshot enumerates the items that must survive
// (facts, decisions, files). After compaction/resume, the harness asks recall questions and
// collects the answers into a probe transcript. This module scores the probe against the
// snapshot and reports what was lost. It is pure: no I/O, no model, no clock — M14 owns
// running the probe, this owns the scoring so the number is reproducible.
//
// DELIBERATE LIMITS. Matching is literal-with-aliases, never semantic: a model that recalls a
// fact in different words scores as lost unless an alias covers it. That biases the score
// PESSIMISTIC (it can under-report recall, never over-report it), which is the safe direction
// for a loss metric — and it keeps the scorer deterministic, which an LLM judge would not be.

/** Which kind of context an item is. Reported separately so loss can be attributed. */
export const RECALL_ITEM_KINDS = ['fact', 'decision', 'file'] as const

export type RecallItemKind = (typeof RECALL_ITEM_KINDS)[number]

export interface RecallItem {
  /** Stable id used to name the item in `lost_items`. */
  readonly id: string
  readonly kind: RecallItemKind
  /** Canonical surface form. Counts as recall on its own. */
  readonly text: string
  /**
   * Additional surface forms that also count as recall (an abbreviation, an id, a
   * renamed path). Matching is OR across `text` and every alias.
   */
  readonly aliases?: readonly string[]
}

/**
 * Pre-compaction snapshot fixture.
 *
 * Fixture JSON shape (`parity/fixtures/context-loss/<case>.json`):
 * ```json
 * { "schema_version": 1,
 *   "case_id": "deep-run-3-agent",
 *   "facts":     [{ "id": "f1", "text": "the API key lives in .env.local" }],
 *   "decisions": [{ "id": "d1", "text": "chose vitest over jest", "aliases": ["vitest"] }],
 *   "files":     [{ "id": "p1", "text": "src/summary/wrapper.ts" }] }
 * ```
 * `kind` is implied by the array an item sits in and is filled in by {@link parseContextSnapshot}.
 */
export interface ContextSnapshot {
  readonly caseId: string
  readonly items: readonly RecallItem[]
}

/** Post-compaction probe: the answers given to the recall questions, in any order. */
export interface ProbeTranscript {
  readonly answers: readonly string[]
}

export interface LostItem {
  readonly id: string
  readonly kind: RecallItemKind
  readonly text: string
}

export interface KindTally {
  readonly total: number
  readonly recalled: number
}

export interface RecallScore {
  readonly case_id: string
  readonly items_total: number
  readonly items_recalled: number
  /** `items_recalled / items_total`, rounded to 4 decimals; 0 when there is nothing to recall. */
  readonly recall_rate: number
  readonly lost_items: readonly LostItem[]
  readonly by_kind: Readonly<Record<RecallItemKind, KindTally>>
}

/** Raised when a fixture does not match the declared shape. Fixtures are code; they fail loudly. */
export class InvalidContextFixtureError extends Error {
  override readonly name = 'InvalidContextFixtureError'
}

const KIND_BY_FIELD: Readonly<Record<string, RecallItemKind>> = {
  facts: 'fact',
  decisions: 'decision',
  files: 'file',
}

/** Lowercase and collapse whitespace so formatting differences never count as loss. */
export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .split(/\s+/u)
    .filter((part) => part.length > 0)
    .join(' ')
}

/** Trailing path segment of a `file` item, so `src/a/b.ts` is recalled by naming `b.ts`. */
function basename(path: string): string {
  const parts = path.split(/[/\\]/u).filter((part) => part.length > 0)
  return parts.length > 0 ? (parts[parts.length - 1] as string) : path
}

/** Every surface form that counts as recalling `item`. */
export function matchTargets(item: RecallItem): string[] {
  const targets = new Set<string>()
  const add = (value: string): void => {
    const normalized = normalizeForMatch(value)
    if (normalized.length > 0) targets.add(normalized)
  }
  add(item.text)
  for (const alias of item.aliases ?? []) add(alias)
  // A path is recalled by its basename too: compaction commonly keeps the file name and
  // drops the directory, and calling that "lost" would over-report loss.
  if (item.kind === 'file') add(basename(item.text))
  return [...targets]
}

/** True when the probe text contains any surface form of the item. */
export function isRecalled(item: RecallItem, normalizedProbe: string): boolean {
  return matchTargets(item).some((target) => normalizedProbe.includes(target))
}

function assertString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidContextFixtureError(`${path} must be a non-empty string`)
  }
  return value
}

/** Parse and validate a snapshot fixture. Throws {@link InvalidContextFixtureError} on any defect. */
export function parseContextSnapshot(raw: unknown): ContextSnapshot {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new InvalidContextFixtureError('fixture must be a JSON object')
  }
  const fixture = raw as Record<string, unknown>
  const caseId = assertString(fixture['case_id'], 'case_id')

  const items: RecallItem[] = []
  const seen = new Set<string>()
  for (const [field, kind] of Object.entries(KIND_BY_FIELD)) {
    const list = fixture[field]
    if (list === undefined || list === null) continue
    if (!Array.isArray(list)) throw new InvalidContextFixtureError(`${field} must be an array`)
    for (const [index, entry] of list.entries()) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw new InvalidContextFixtureError(`${field}[${index}] must be an object`)
      }
      const record = entry as Record<string, unknown>
      const id = assertString(record['id'], `${field}[${index}].id`)
      if (seen.has(id)) throw new InvalidContextFixtureError(`duplicate item id ${JSON.stringify(id)}`)
      seen.add(id)
      const text = assertString(record['text'], `${field}[${index}].text`)
      const rawAliases = record['aliases']
      if (rawAliases !== undefined && !Array.isArray(rawAliases)) {
        throw new InvalidContextFixtureError(`${field}[${index}].aliases must be an array`)
      }
      const aliases = (rawAliases ?? []).map((alias, aliasIndex) =>
        assertString(alias, `${field}[${index}].aliases[${aliasIndex}]`),
      )
      items.push(aliases.length > 0 ? { id, kind, text, aliases } : { id, kind, text })
    }
  }
  return { caseId, items }
}

/** Parse a probe transcript: `{ "answers": ["...", "..."] }` or a bare array of strings. */
export function parseProbeTranscript(raw: unknown): ProbeTranscript {
  const list = Array.isArray(raw) ? raw : (raw as Record<string, unknown> | null)?.['answers']
  if (!Array.isArray(list)) throw new InvalidContextFixtureError('probe must be an array or {answers: []}')
  return {
    answers: list.map((answer, index) => {
      if (typeof answer !== 'string') {
        throw new InvalidContextFixtureError(`answers[${index}] must be a string`)
      }
      return answer
    }),
  }
}

/**
 * Score a probe transcript against a pre-compaction snapshot.
 *
 * All answers are concatenated before matching: the harness measures whether the information
 * survived compaction at all, not which question recovered it.
 */
export function scoreRecall(snapshot: ContextSnapshot, probe: ProbeTranscript): RecallScore {
  const normalizedProbe = normalizeForMatch(probe.answers.join('\n'))
  const byKind: Record<RecallItemKind, { total: number; recalled: number }> = {
    fact: { total: 0, recalled: 0 },
    decision: { total: 0, recalled: 0 },
    file: { total: 0, recalled: 0 },
  }
  const lostItems: LostItem[] = []
  let recalled = 0

  for (const item of snapshot.items) {
    const tally = byKind[item.kind]
    tally.total += 1
    if (isRecalled(item, normalizedProbe)) {
      tally.recalled += 1
      recalled += 1
    } else {
      lostItems.push({ id: item.id, kind: item.kind, text: item.text })
    }
  }

  const total = snapshot.items.length
  return {
    case_id: snapshot.caseId,
    items_total: total,
    items_recalled: recalled,
    recall_rate: total === 0 ? 0 : Math.round((recalled / total) * 10000) / 10000,
    lost_items: lostItems,
    by_kind: byKind,
  }
}
