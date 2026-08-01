// Storage tests for the DeerMem-shaped memory tree.
//
// The sharding assertions are checked against an INDEPENDENT sha256 computation (node:crypto,
// same as the module but computed inline in the test from the fact id) plus hard-coded digests
// so a regression in `factShard` cannot be masked by both sides drifting together.
// Upstream contract: `paths.py:fact_file_path` -> `facts/{sha256(fact_id).hexdigest()[:2]}/{id}.md`.
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CORE_CATEGORIES,
  DOCUMENT_VERSION,
  FactCorruptError,
  HISTORY_SLOTS,
  InvalidFactIdError,
  MEMORY_MANIFEST_FILENAME,
  USER_SLOTS,
  createEmptyMemoryDocument,
  deleteFact,
  factFilePath,
  factShard,
  factsRoot,
  listFacts,
  memoryManifestPath,
  memoryRoot,
  normalizeCategory,
  parseFactMarkdown,
  readFact,
  readMemoryDocument,
  renderFactMarkdown,
  updateMemoryDocument,
  validateFactId,
  writeFact,
  type MemoryFact,
} from './store.js'

const NOW = '2026-08-01T12:00:00.000Z'
let root: string

function fact(overrides: Partial<MemoryFact> = {}): MemoryFact {
  return {
    id: 'fact_abc123',
    category: 'preference',
    confidence: 0.9,
    createdAt: NOW,
    source: { type: 'conversation', threadId: 'thread-1' },
    content: 'Prefers pnpm over npm',
    ...overrides,
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'deerflow-memory-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('layout', () => {
  it('resolves the memory root under the project dir', () => {
    expect(memoryRoot({ CLAUDE_PROJECT_DIR: '/proj' })).toBe(join('/proj', '.deerflow', 'memory'))
  })

  it('names the summary document memory.json', () => {
    expect(MEMORY_MANIFEST_FILENAME).toBe('memory.json')
    expect(memoryManifestPath('/m')).toBe(join('/m', 'memory.json'))
  })

  it('exposes the nine core categories from storage.py:39', () => {
    expect([...CORE_CATEGORIES]).toEqual(['preference', 'correction', 'context', 'goal', 'behavior', 'identity', 'constraint', 'decision', 'other'])
  })

  it('exposes the six summary slots in render order', () => {
    expect([...USER_SLOTS]).toEqual(['workContext', 'personalContext', 'topOfMind'])
    expect([...HISTORY_SLOTS]).toEqual(['recentMonths', 'earlierContext', 'longTermBackground'])
  })
})

describe('sharding', () => {
  it.each(['fact_abc123', 'fact_0', 'a', 'A-Z_0-9', 'fact_deadbeefdeadbeefdeadbeefdeadbeef'])('shard(%s) is the first two hex chars of sha256(id)', (id) => {
    const expected = createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 2)
    expect(factShard(id)).toBe(expected)
    expect(expected).toHaveLength(2)
  })

  it('matches hard-coded digests (guards against both sides drifting together)', () => {
    // Independently verifiable: `printf 'a' | shasum -a 256` -> ca978112...
    expect(createHash('sha256').update('a', 'utf8').digest('hex').startsWith('ca9781')).toBe(true)
    expect(factShard('a')).toBe('ca')
    // `printf 'fact_abc123' | shasum -a 256`
    const digest = createHash('sha256').update('fact_abc123', 'utf8').digest('hex')
    expect(factShard('fact_abc123')).toBe(digest.slice(0, 2))
  })

  it('hashes the ID, never the content', () => {
    const first = writeFact(root, fact({ id: 'fact_same', content: 'one' }))
    const second = writeFact(root, fact({ id: 'fact_same', content: 'a completely different body' }))
    expect(dirname(first)).toBe(dirname(second))
  })

  it('builds the full sharded path', () => {
    expect(factFilePath('/m', 'fact_abc123')).toBe(join('/m', 'facts', factShard('fact_abc123'), 'fact_abc123.md'))
  })

  it('writes into a two-hex-character directory below facts/', () => {
    writeFact(root, fact())
    const shards = readdirSync(factsRoot(root))
    expect(shards).toHaveLength(1)
    expect(shards[0]).toMatch(/^[0-9a-f]{2}$/)
    expect(shards[0]).toBe(factShard('fact_abc123'))
    expect(readdirSync(join(factsRoot(root), shards[0] ?? ''))).toEqual(['fact_abc123.md'])
  })

  it('distributes distinct ids across more than one shard', () => {
    for (let index = 0; index < 40; index += 1) writeFact(root, fact({ id: `fact_${index}`, content: `content ${index}` }))
    expect(readdirSync(factsRoot(root)).length).toBeGreaterThan(1)
  })

  it.each([[''], ['fact id!'], ['fact/id'], ['../escape'], ['a b'], ['fact.id'], [null], [42], [undefined]])('rejects the unsafe fact id %p', (id) => {
    expect(() => validateFactId(id)).toThrow(InvalidFactIdError)
  })
})

describe('fact markdown round-trip', () => {
  it('round-trips every field', () => {
    const original = fact({ expectedValidDays: 365, category: 'correction', sourceError: 'assumed npm' })
    writeFact(root, original)
    expect(readFact(root, original.id)).toEqual(original)
  })

  it('round-trips a fact with no optional fields', () => {
    const original = fact({ source: { type: 'manual', threadId: null } })
    writeFact(root, original)
    expect(readFact(root, original.id)).toEqual(original)
  })

  it('round-trips multi-line, unicode and CJK bodies', () => {
    const original = fact({ content: 'line one\nline two — em dash\n用户偏好使用 pnpm' })
    writeFact(root, original)
    expect(readFact(root, original.id)?.content).toBe(original.content)
  })

  it('emits YAML front matter delimited by --- with the body below it', () => {
    const rendered = renderFactMarkdown(fact({ expectedValidDays: 90 }))
    expect(rendered.startsWith('---\n')).toBe(true)
    expect(rendered).toContain('\nid: fact_abc123\n')
    expect(rendered).toContain('\ncategory: preference\n')
    expect(rendered).toContain('\nconfidence: 0.9\n')
    expect(rendered).toContain('\nexpected_valid_days: 90\n')
    expect(rendered).toContain('\nsource: conversation\n')
    expect(rendered.trimEnd().endsWith('Prefers pnpm over npm')).toBe(true)
  })

  it('omits expected_valid_days entirely when the extractor was unsure', () => {
    expect(renderFactMarkdown(fact())).not.toContain('expected_valid_days')
  })

  it('returns null for a fact that does not exist', () => {
    expect(readFact(root, 'fact_missing')).toBeNull()
  })

  it.each([
    ['no front matter', 'just a body'],
    ['unterminated front matter', '---\nid: fact_x\ncategory: context\n'],
    ['missing id', '---\ncategory: context\nconfidence: 0.9\n---\n\nbody'],
    ['out-of-range confidence', '---\nid: fact_x\ncategory: context\nconfidence: 4\n---\n\nbody'],
    ['non-numeric confidence', '---\nid: fact_x\ncategory: context\nconfidence: high\n---\n\nbody'],
    ['empty body', '---\nid: fact_x\ncategory: context\nconfidence: 0.9\n---\n\n   '],
  ])('raises FactCorruptError on %s', (_label, text) => {
    expect(() => parseFactMarkdown(text, '/tmp/x.md')).toThrow(FactCorruptError)
  })

  it('normalizes an unknown category to "other" rather than failing', () => {
    expect(normalizeCategory('knowledge')).toBe('other')
    expect(normalizeCategory('')).toBe('context')
    expect(normalizeCategory(undefined)).toBe('context')
    expect(normalizeCategory('correction')).toBe('correction')
  })
})

describe('atomicity', () => {
  it('leaves no temp files behind after a successful write', () => {
    writeFact(root, fact())
    const shardDir = dirname(factFilePath(root, 'fact_abc123'))
    expect(readdirSync(shardDir).filter((name) => name.includes('.tmp'))).toEqual([])
  })

  it('keeps the previous complete version readable when a stale temp file is present', () => {
    const path = writeFact(root, fact({ content: 'first' }))
    // Simulate a writer killed between open() and rename(): a half-written temp file in the
    // same directory must never be visible as the fact.
    writeFileSync(join(dirname(path), `.${basename(path)}.999-0.tmp`), '---\nid: fact_ab', 'utf8')
    expect(readFact(root, 'fact_abc123')?.content).toBe('first')
  })

  it('replaces an existing fact in place, never appending', () => {
    writeFact(root, fact({ content: 'first' }))
    const path = writeFact(root, fact({ content: 'second' }))
    expect(readFileSync(path, 'utf8').includes('first')).toBe(false)
    expect(readFact(root, 'fact_abc123')?.content).toBe('second')
  })

  it('creates missing shard directories on demand', () => {
    expect(existsSync(factsRoot(root))).toBe(false)
    writeFact(root, fact())
    expect(existsSync(factFilePath(root, 'fact_abc123'))).toBe(true)
  })
})

describe('delete + list', () => {
  it('deletes a fact and reports whether a file was removed', () => {
    writeFact(root, fact())
    expect(deleteFact(root, 'fact_abc123')).toBe(true)
    expect(deleteFact(root, 'fact_abc123')).toBe(false)
    expect(readFact(root, 'fact_abc123')).toBeNull()
  })

  it('returns an empty inventory before anything is written', () => {
    expect(listFacts(root)).toEqual({ facts: [], skipped: [] })
  })

  it('walks every shard and sorts by id', () => {
    for (const id of ['fact_c', 'fact_a', 'fact_b']) writeFact(root, fact({ id, content: `content ${id}` }))
    expect(listFacts(root).facts.map((stored) => stored.fact.id)).toEqual(['fact_a', 'fact_b', 'fact_c'])
  })

  it('skips a corrupt file without discarding its siblings', () => {
    writeFact(root, fact({ id: 'fact_good', content: 'fine' }))
    const badDir = join(factsRoot(root), factShard('fact_bad'))
    mkdirSync(badDir, { recursive: true })
    writeFileSync(join(badDir, 'fact_bad.md'), 'not a fact at all', 'utf8')
    const inventory = listFacts(root)
    expect(inventory.facts.map((stored) => stored.fact.id)).toEqual(['fact_good'])
    expect(inventory.skipped).toHaveLength(1)
  })

  it('ignores non-shard directories and non-markdown files', () => {
    writeFact(root, fact({ id: 'fact_good' }))
    mkdirSync(join(factsRoot(root), 'notashard'), { recursive: true })
    writeFileSync(join(factsRoot(root), factShard('fact_good'), 'README.txt'), 'x', 'utf8')
    expect(listFacts(root).facts).toHaveLength(1)
  })
})

describe('memory.json summary document', () => {
  it('materializes the empty document for an absent file', () => {
    const document = readMemoryDocument(root, NOW)
    expect(document).toEqual(createEmptyMemoryDocument(NOW))
    expect(document.version).toBe(DOCUMENT_VERSION)
    expect(document.revision).toBe(0)
  })

  it('never stores facts or a fact index in memory.json', () => {
    writeFact(root, fact())
    updateMemoryDocument(root, { user: { workContext: 'staff engineer' } }, NOW)
    const raw = JSON.parse(readFileSync(memoryManifestPath(root), 'utf8')) as Record<string, unknown>
    expect(Object.keys(raw).sort()).toEqual(['history', 'lastUpdated', 'rev', 'revision', 'schema_version', 'updated_at', 'user', 'version'])
    expect(raw['facts']).toBeUndefined()
  })

  it('merges a supplied slot and bumps revision + lastUpdated', () => {
    const first = updateMemoryDocument(root, { user: { workContext: 'staff engineer' } }, NOW)
    expect(first.revision).toBe(1)
    expect(first.user.workContext).toEqual({ summary: 'staff engineer', updatedAt: NOW })

    const later = '2026-08-02T09:00:00.000Z'
    const second = updateMemoryDocument(root, { history: { recentMonths: 'shipped the port' } }, later)
    expect(second.revision).toBe(2)
    expect(second.lastUpdated).toBe(later)
    // Untouched slots keep their prior prose AND their prior timestamp.
    expect(second.user.workContext).toEqual({ summary: 'staff engineer', updatedAt: NOW })
    expect(second.history.recentMonths).toEqual({ summary: 'shipped the port', updatedAt: later })
  })

  it('round-trips through disk', () => {
    updateMemoryDocument(root, { user: { topOfMind: 'M9 memory lane' }, history: { longTermBackground: 'systems engineer' } }, NOW)
    const reread = readMemoryDocument(root, NOW)
    expect(reread.user.topOfMind.summary).toBe('M9 memory lane')
    expect(reread.history.longTermBackground.summary).toBe('systems engineer')
    expect(reread.user.personalContext.summary).toBe('')
  })
})
