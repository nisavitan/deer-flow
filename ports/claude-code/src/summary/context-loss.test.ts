// Scoring vectors for the context-loss measurement harness.
// No original equivalent: this is the measurement the user decision requires ("parity tests
// must MEASURE context loss after compaction/resume, not just assert survival",
// docs/claude-code-port/PROGRESS.md). These tests pin the scoring so the number M14 reports
// is reproducible and cannot silently become more generous.
import { describe, expect, it } from 'vitest'
import {
  InvalidContextFixtureError,
  isRecalled,
  matchTargets,
  normalizeForMatch,
  parseContextSnapshot,
  parseProbeTranscript,
  scoreRecall,
  type ContextSnapshot,
} from './context-loss.js'

const FIXTURE = {
  schema_version: 1,
  case_id: 'deep-run-3-agent',
  facts: [
    { id: 'f1', text: 'the API key lives in .env.local' },
    { id: 'f2', text: 'the staging database is read-only', aliases: ['staging db is read only'] },
  ],
  decisions: [{ id: 'd1', text: 'chose vitest over jest', aliases: ['vitest'] }],
  files: [{ id: 'p1', text: 'src/summary/wrapper.ts' }],
}

function snapshot(): ContextSnapshot {
  return parseContextSnapshot(FIXTURE)
}

describe('fixture parsing', () => {
  it('flattens the three arrays into kinded items, preserving order', () => {
    const parsed = snapshot()
    expect(parsed.caseId).toBe('deep-run-3-agent')
    expect(parsed.items.map((item) => [item.id, item.kind])).toEqual([
      ['f1', 'fact'],
      ['f2', 'fact'],
      ['d1', 'decision'],
      ['p1', 'file'],
    ])
  })

  it('tolerates missing arrays', () => {
    expect(parseContextSnapshot({ case_id: 'empty' }).items).toEqual([])
  })

  it('rejects a malformed fixture loudly instead of scoring it', () => {
    expect(() => parseContextSnapshot(null)).toThrow(InvalidContextFixtureError)
    expect(() => parseContextSnapshot({})).toThrow(InvalidContextFixtureError)
    expect(() => parseContextSnapshot({ case_id: 'c', facts: {} })).toThrow(InvalidContextFixtureError)
    expect(() => parseContextSnapshot({ case_id: 'c', facts: [{ id: 'a' }] })).toThrow(InvalidContextFixtureError)
    expect(() => parseContextSnapshot({ case_id: 'c', facts: [{ id: 'a', text: 't', aliases: 'x' }] })).toThrow(
      InvalidContextFixtureError,
    )
  })

  it('rejects duplicate ids, which would double-count an item', () => {
    expect(() =>
      parseContextSnapshot({ case_id: 'c', facts: [{ id: 'a', text: '1' }], decisions: [{ id: 'a', text: '2' }] }),
    ).toThrow(InvalidContextFixtureError)
  })

  it('accepts both probe shapes', () => {
    expect(parseProbeTranscript(['a', 'b']).answers).toEqual(['a', 'b'])
    expect(parseProbeTranscript({ answers: ['a'] }).answers).toEqual(['a'])
    expect(() => parseProbeTranscript({ answers: [1] })).toThrow(InvalidContextFixtureError)
  })
})

describe('matching rules', () => {
  it('is case- and whitespace-insensitive', () => {
    expect(normalizeForMatch('  The   API\nKey ')).toBe('the api key')
    expect(
      isRecalled({ id: 'f', kind: 'fact', text: 'the API key' }, normalizeForMatch('THE   api\tkey is set')),
    ).toBe(true)
  })

  it('counts any alias as recall', () => {
    const item = { id: 'd', kind: 'decision' as const, text: 'chose vitest over jest', aliases: ['vitest'] }
    expect(isRecalled(item, normalizeForMatch('we use vitest'))).toBe(true)
  })

  it('counts a file basename as recall of its path', () => {
    const item = { id: 'p', kind: 'file' as const, text: 'src/summary/wrapper.ts' }
    expect(matchTargets(item)).toContain('wrapper.ts')
    expect(isRecalled(item, normalizeForMatch('I edited wrapper.ts'))).toBe(true)
  })

  it('does not apply the basename rule to facts or decisions', () => {
    const item = { id: 'f', kind: 'fact' as const, text: 'a/b/c' }
    expect(isRecalled(item, normalizeForMatch('c'))).toBe(false)
  })
})

describe('scoreRecall', () => {
  it('reports a perfect recall with no lost items', () => {
    const probe = parseProbeTranscript([
      'The API key lives in .env.local and the staging db is read only.',
      'We chose vitest over jest; the wrapper lives at src/summary/wrapper.ts.',
    ])
    const score = scoreRecall(snapshot(), probe)
    expect(score).toEqual({
      case_id: 'deep-run-3-agent',
      items_total: 4,
      items_recalled: 4,
      recall_rate: 1,
      lost_items: [],
      by_kind: {
        fact: { total: 2, recalled: 2 },
        decision: { total: 1, recalled: 1 },
        file: { total: 1, recalled: 1 },
      },
    })
  })

  it('names exactly what was lost and attributes it by kind', () => {
    const probe = parseProbeTranscript(['We used vitest. I think there was a file called wrapper.ts.'])
    const score = scoreRecall(snapshot(), probe)
    expect(score.items_total).toBe(4)
    expect(score.items_recalled).toBe(2)
    expect(score.recall_rate).toBe(0.5)
    expect(score.lost_items).toEqual([
      { id: 'f1', kind: 'fact', text: 'the API key lives in .env.local' },
      { id: 'f2', kind: 'fact', text: 'the staging database is read-only' },
    ])
    expect(score.by_kind.fact).toEqual({ total: 2, recalled: 0 })
    expect(score.by_kind.decision).toEqual({ total: 1, recalled: 1 })
  })

  it('reports total loss when the probe is empty', () => {
    const score = scoreRecall(snapshot(), { answers: [] })
    expect(score.items_recalled).toBe(0)
    expect(score.recall_rate).toBe(0)
    expect(score.lost_items).toHaveLength(4)
  })

  it('scores an empty snapshot as 0 rather than dividing by zero', () => {
    const score = scoreRecall({ caseId: 'empty', items: [] }, { answers: ['anything'] })
    expect(score).toMatchObject({ items_total: 0, items_recalled: 0, recall_rate: 0, lost_items: [] })
  })

  it('rounds the rate to four decimals so runs are byte-comparable', () => {
    const three = parseContextSnapshot({
      case_id: 'thirds',
      facts: [
        { id: 'a', text: 'alpha' },
        { id: 'b', text: 'bravo' },
        { id: 'c', text: 'charlie' },
      ],
    })
    expect(scoreRecall(three, { answers: ['alpha'] }).recall_rate).toBe(0.3333)
  })

  it('concatenates answers: an item recalled in any answer counts once', () => {
    const score = scoreRecall(snapshot(), { answers: ['vitest', 'vitest again', 'wrapper.ts'] })
    expect(score.items_recalled).toBe(2)
  })

  it('is pessimistic by design: a paraphrase without an alias scores as lost', () => {
    // Documented limit — literal matching can under-report recall, never over-report it.
    const score = scoreRecall(snapshot(), { answers: ['the credentials are in a local dotenv file'] })
    expect(score.lost_items.map((item) => item.id)).toContain('f1')
  })
})
