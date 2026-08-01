// Tests for the context-loss scoring entry point. The SCORING is already covered by
// context-loss.test.ts (16 vectors); what is tested here is only the CLI's own surface — argument
// parsing, the flags-beat-stdin resolution, and the failure modes — plus one end-to-end check that
// the two shipped fixtures parse and score, so a malformed fixture cannot reach a live run.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseArgs, score } from './context-loss-cli.js'
import { parseContextSnapshot } from './context-loss.js'

const CASE_01 = fileURLToPath(new URL('../../parity/fixtures/context-loss/case-01.json', import.meta.url))
const CASE_02 = fileURLToPath(new URL('../../parity/fixtures/context-loss/case-02.json', import.meta.url))

const NO_FLAGS = { fixturePath: null, answersPath: null, failUnder: null, pretty: false } as const

interface FixtureProbe {
  readonly id: string
  readonly question: string
  readonly expects: readonly string[]
}

function readFixture(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

describe('parseArgs', () => {
  it('defaults every option to off', () => {
    expect(parseArgs([])).toEqual(NO_FLAGS)
  })

  it('reads --fixture, --answers, --fail-under and --pretty', () => {
    expect(parseArgs(['--fixture', 'a.json', '--answers', 'b.json', '--fail-under', '0.75', '--pretty'])).toEqual({
      fixturePath: 'a.json',
      answersPath: 'b.json',
      failUnder: 0.75,
      pretty: true,
    })
  })

  it('rejects an unknown flag', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/Unknown argument: --nope/u)
  })

  it('rejects a flag with no value', () => {
    expect(() => parseArgs(['--fixture'])).toThrow(/Missing value for --fixture/u)
  })

  it.each([['nope'], ['-0.1'], ['1.5'], ['']])('rejects --fail-under %j', (value) => {
    expect(() => parseArgs(['--fail-under', value])).toThrow(/--fail-under must be a rate between 0 and 1/u)
  })

  it('accepts the boundary rates 0 and 1', () => {
    expect(parseArgs(['--fail-under', '0']).failUnder).toBe(0)
    expect(parseArgs(['--fail-under', '1']).failUnder).toBe(1)
  })
})

describe('score — input resolution', () => {
  const fixture = { case_id: 'tiny', facts: [{ id: 'f1', text: 'fly.io' }] }

  it('takes both fixture and answers from stdin', () => {
    const result = score(NO_FLAGS, JSON.stringify({ fixture, answers: ['we deploy to fly.io'] }))
    expect(result).toMatchObject({ case_id: 'tiny', items_total: 1, items_recalled: 1, recall_rate: 1 })
  })

  it('accepts the probe-transcript envelope for answers', () => {
    const result = score(NO_FLAGS, JSON.stringify({ fixture, answers: { answers: ['fly.io'] } }))
    expect(result.items_recalled).toBe(1)
  })

  it('lets --fixture override a fixture sent on stdin', () => {
    const result = score(
      { ...NO_FLAGS, fixturePath: CASE_01 },
      JSON.stringify({ fixture, answers: ['fly.io'] }),
    )
    expect(result.case_id).toBe('resume-recall-12')
  })

  it('reports a total loss as a score, not as an error', () => {
    const result = score(NO_FLAGS, JSON.stringify({ fixture, answers: ['I do not remember.'] }))
    expect(result).toMatchObject({ items_recalled: 0, recall_rate: 0 })
    expect(result.lost_items).toEqual([{ id: 'f1', kind: 'fact', text: 'fly.io' }])
  })

  it('fails when no fixture is supplied', () => {
    expect(() => score(NO_FLAGS, JSON.stringify({ answers: ['x'] }))).toThrow(/No fixture/u)
  })

  it('fails when no answers are supplied', () => {
    expect(() => score(NO_FLAGS, JSON.stringify({ fixture }))).toThrow(/No answers/u)
  })

  it('fails on non-JSON stdin', () => {
    expect(() => score(NO_FLAGS, 'not json')).toThrow(/stdin is not valid JSON/u)
  })

  it('fails on a JSON array on stdin', () => {
    expect(() => score(NO_FLAGS, '[1,2]')).toThrow(/stdin must be a JSON object/u)
  })

  it('fails on an unreadable fixture path', () => {
    expect(() => score({ ...NO_FLAGS, fixturePath: '/nope/missing.json' }, '{"answers":["x"]}')).toThrow(
      /Cannot read fixture/u,
    )
  })

  it('propagates InvalidContextFixtureError from the scorer', () => {
    expect(() => score(NO_FLAGS, JSON.stringify({ fixture: { facts: [] }, answers: ['x'] }))).toThrow(
      /case_id must be a non-empty string/u,
    )
  })
})

describe.each([
  ['case-01', CASE_01, 'resume-recall-12', 12, { fact: 4, decision: 5, file: 3 }],
  ['case-02', CASE_02, 'resume-recall-08-paraphrase', 8, { fact: 3, decision: 4, file: 1 }],
])('shipped fixture %s', (_name, path, caseId, itemCount, byKind) => {
  it('parses and reports the declared item counts', () => {
    const snapshot = parseContextSnapshot(readFixture(path))
    expect(snapshot.caseId).toBe(caseId)
    expect(snapshot.items).toHaveLength(itemCount)
    for (const [kind, count] of Object.entries(byKind)) {
      expect(snapshot.items.filter((item) => item.kind === kind)).toHaveLength(count)
    }
  })

  it('scores 100% when every canonical surface form is echoed back', () => {
    const snapshot = parseContextSnapshot(readFixture(path))
    const result = score(
      { ...NO_FLAGS, fixturePath: path },
      JSON.stringify({ answers: snapshot.items.map((item) => item.text) }),
    )
    expect(result).toMatchObject({ case_id: caseId, items_total: itemCount, items_recalled: itemCount })
    expect(result.recall_rate).toBe(1)
    expect(result.lost_items).toEqual([])
  })

  it('scores 0% against an empty answer, naming every item as lost', () => {
    const result = score({ ...NO_FLAGS, fixturePath: path }, JSON.stringify({ answers: [''] }))
    expect(result.items_recalled).toBe(0)
    expect(result.lost_items).toHaveLength(itemCount)
  })

  it('gives every item a seed sentence that contains its match key verbatim', () => {
    // The RUNBOOK builds the seed prompt from `seed`, but the scorer matches on `text`. If a seed
    // sentence ever stops containing its own key, the measurement silently becomes unwinnable:
    // the session is briefed on one string and graded on another.
    const raw = readFixture(path)
    for (const field of ['facts', 'decisions', 'files'] as const) {
      for (const item of (raw[field] ?? []) as readonly Record<string, string>[]) {
        const seed = item['seed']
        const text = item['text'] as string
        expect(seed, `${item['id'] ?? '?'} has no seed sentence`).toBeTypeOf('string')
        expect(
          (seed as string).toLowerCase(),
          `${item['id'] ?? '?'}: seed does not contain its match key ${JSON.stringify(text)}`,
        ).toContain(text.toLowerCase())
      }
    }
  })

  it('has a probe for every item, and every probe targets a real item', () => {
    const raw = readFixture(path)
    const ids = new Set(parseContextSnapshot(raw).items.map((item) => item.id))
    const probes = raw['probes'] as readonly FixtureProbe[]
    expect(Array.isArray(probes)).toBe(true)

    const covered = new Set<string>()
    for (const probe of probes) {
      expect(probe.question.length).toBeGreaterThan(0)
      expect(probe.expects.length).toBeGreaterThan(0)
      for (const id of probe.expects) {
        expect(ids, `probe ${probe.id} expects unknown item ${id}`).toContain(id)
        covered.add(id)
      }
    }
    expect([...ids].filter((id) => !covered.has(id)), 'items with no probe').toEqual([])
  })
})

describe('case-02 alias tolerance', () => {
  it('recalls an item from a short paraphrase alone, which case-01 keys would miss', () => {
    const result = score(
      { ...NO_FLAGS, fixturePath: CASE_02 },
      JSON.stringify({
        answers: ['We warn at 3 and hard stop at 5, the ledger cap is 50 entries, and hooks fail open.'],
      }),
    )
    expect(result.items_recalled).toBe(3)
    expect(result.lost_items.map((item) => item.id).sort()).toEqual(['d1', 'd3', 'd4', 'f3', 'p1'])
  })
})
