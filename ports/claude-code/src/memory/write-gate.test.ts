// Acceptance-matrix tests for the deterministic extraction gate.
//
// Expected values are DERIVED FROM THE CITED DEFAULTS, not from observing this implementation:
//   fact_confidence_threshold          0.7    (config.py:87-105)
//   max_facts                          100    (config.py:87-105)
//   staleness_age_days                 90     (config.py:116-175)
//   staleness_max_lifetime_multiplier  20.0   (config.py:116-175)  -> ceiling 1800 days
// and from the behavior contract in notes/skills-and-memory.md §4:
//   "only scope=user + durability=durable + authority=descriptive facts and wholly user-scoped
//    descriptive summaries are accepted; labels are evaluated but not persisted; task/project
//    removals fail closed".
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EXPECTED_VALID_DAYS_CEILING,
  DEFAULT_FACT_CONFIDENCE_THRESHOLD,
  DEFAULT_MAX_FACTS,
  DEFAULT_STALENESS_AGE_DAYS,
  DEFAULT_STALENESS_MAX_LIFETIME_MULTIPLIER,
  MALFORMED_CONFIDENCE_DEFAULT,
  applyWriteGate,
  clampExpectedValidDays,
  coerceConfidence,
  dedupeKey,
  type ProposedFact,
  type ProposedUpdates,
} from './write-gate.js'

/** A fact carrying every label the gate requires, at a confidence safely above threshold. */
function eligibleFact(overrides: Partial<ProposedFact> = {}): ProposedFact {
  return {
    content: 'Prefers TypeScript over JavaScript for new services',
    category: 'preference',
    confidence: 0.9,
    scope: 'user',
    durability: 'durable',
    authority: 'descriptive',
    ...overrides,
  }
}

function reasonsFor(result: ReturnType<typeof applyWriteGate>, locator: string): string[] {
  return result.rejections.filter((rejection) => rejection.locator === locator).map((rejection) => rejection.reason)
}

describe('cited defaults', () => {
  it('pins the four values every expectation below is derived from', () => {
    expect(DEFAULT_FACT_CONFIDENCE_THRESHOLD).toBe(0.7)
    expect(DEFAULT_MAX_FACTS).toBe(100)
    expect(DEFAULT_STALENESS_AGE_DAYS).toBe(90)
    expect(DEFAULT_STALENESS_MAX_LIFETIME_MULTIPLIER).toBe(20)
    // The creation clamp is the product, per config.py:116-175.
    expect(DEFAULT_EXPECTED_VALID_DAYS_CEILING).toBe(1800)
  })
})

describe('scope/durability/authority acceptance matrix', () => {
  // The gate accepts exactly one of the 3 x 2 x 2 = 12 label combinations.
  const scopes = ['user', 'thread', 'project'] as const
  const durabilities = ['durable', 'temporary'] as const
  const authorities = ['descriptive', 'transactional'] as const

  for (const scope of scopes) {
    for (const durability of durabilities) {
      for (const authority of authorities) {
        const shouldAccept = scope === 'user' && durability === 'durable' && authority === 'descriptive'
        it(`${shouldAccept ? 'accepts' : 'rejects'} scope=${scope} durability=${durability} authority=${authority}`, () => {
          const result = applyWriteGate({ newFacts: [eligibleFact({ scope, durability, authority })] })
          expect(result.acceptedFacts).toHaveLength(shouldAccept ? 1 : 0)
        })
      }
    }
  }

  it('accepts exactly one of the twelve combinations', () => {
    let accepted = 0
    for (const scope of scopes) {
      for (const durability of durabilities) {
        for (const authority of authorities) {
          accepted += applyWriteGate({ newFacts: [eligibleFact({ scope, durability, authority })] }).acceptedFacts.length
        }
      }
    }
    expect(accepted).toBe(1)
  })
})

describe('fail-closed on missing labels (un-migrated prompt)', () => {
  it.each([
    ['scope', 'missing_or_invalid_scope'],
    ['durability', 'missing_or_invalid_durability'],
    ['authority', 'missing_or_invalid_authority'],
  ])('rejects a fact with no %s label', (label, reason) => {
    const fact = eligibleFact()
    const stripped: Record<string, unknown> = { ...fact }
    delete stripped[label]
    const result = applyWriteGate({ newFacts: [stripped] })
    expect(result.acceptedFacts).toEqual([])
    expect(reasonsFor(result, 'newFacts[0]')).toEqual([reason])
  })

  it('rejects EVERY write when the template dropped all classification fields', () => {
    // This is the observable signature of an un-migrated custom prompt: 100% rejection.
    const unlabelled = { content: 'user is based in Tel Aviv', category: 'context', confidence: 0.95 }
    const result = applyWriteGate({
      newFacts: [unlabelled, { ...unlabelled, content: 'user speaks Hebrew' }],
      user: { workContext: { summary: 'staff engineer', shouldUpdate: true } },
    })
    expect(result.acceptedFacts).toEqual([])
    expect(result.acceptedSummaries).toEqual([])
    expect(result.rejectionRate).toBe(1)
  })

  it('rejects one bad item without aborting its siblings', () => {
    const result = applyWriteGate({
      newFacts: [eligibleFact({ content: 'good one' }), eligibleFact({ content: 'bad one', authority: 'transactional' }), eligibleFact({ content: 'another good one' })],
    })
    expect(result.acceptedFacts.map((fact) => fact.content)).toEqual(['good one', 'another good one'])
    expect(result.rejectionRate).toBeCloseTo(1 / 3, 10)
  })
})

describe('confidence threshold (0.7)', () => {
  it.each([
    [0.69, false],
    [0.7, true],
    [0.71, true],
    [0.5, false],
    [1, true],
    [0, false],
  ])('confidence %s -> accepted=%s', (confidence, accepted) => {
    const result = applyWriteGate({ newFacts: [eligibleFact({ confidence })] })
    expect(result.acceptedFacts.length === 1).toBe(accepted)
  })

  it('coerces a malformed confidence to 0.5, which then falls below the 0.7 threshold', () => {
    expect(coerceConfidence('very sure')).toBe(MALFORMED_CONFIDENCE_DEFAULT)
    expect(coerceConfidence(Number.NaN)).toBe(MALFORMED_CONFIDENCE_DEFAULT)
    expect(coerceConfidence(true)).toBe(MALFORMED_CONFIDENCE_DEFAULT)
    const result = applyWriteGate({ newFacts: [eligibleFact({ confidence: 'very sure' })] })
    expect(reasonsFor(result, 'newFacts[0]')).toEqual(['below_confidence_threshold'])
  })

  it('clamps an out-of-range confidence rather than rejecting it outright', () => {
    expect(coerceConfidence(1.4)).toBe(1)
    expect(coerceConfidence(-3)).toBe(0)
    expect(applyWriteGate({ newFacts: [eligibleFact({ confidence: 1.4 })] }).acceptedFacts[0]?.confidence).toBe(1)
  })

  it('honours an explicit threshold override', () => {
    const result = applyWriteGate({ newFacts: [eligibleFact({ confidence: 0.6 })] }, { confidenceThreshold: 0.5 })
    expect(result.acceptedFacts).toHaveLength(1)
  })
})

describe('expected_valid_days creation clamp (90 x 20 = 1800)', () => {
  it.each([
    [14, 14],
    [90, 90],
    [1799, 1799],
    [1800, 1800],
    [1801, 1800],
    [36500, 1800],
  ])('clamps %s -> %s', (input, expected) => {
    expect(clampExpectedValidDays(input)).toBe(expected)
    expect(applyWriteGate({ newFacts: [eligibleFact({ expected_valid_days: input })] }).acceptedFacts[0]?.expectedValidDays).toBe(expected)
  })

  it.each([[0], [-5], ['365'], [Number.NaN], [true], [null]])('drops an unusable value %p (prompt says "omit when uncertain")', (input) => {
    expect(clampExpectedValidDays(input)).toBeUndefined()
    expect(applyWriteGate({ newFacts: [eligibleFact({ expected_valid_days: input })] }).acceptedFacts[0]?.expectedValidDays).toBeUndefined()
  })

  it('truncates a fractional value before clamping', () => {
    expect(clampExpectedValidDays(90.9)).toBe(90)
    expect(clampExpectedValidDays(1800.9)).toBe(1800)
  })
})

describe('max_facts trim (100), keeping the highest confidence', () => {
  it('leaves everything in place at exactly the cap', () => {
    const existing = Array.from({ length: 99 }, (_, index) => ({ id: `fact_${index}`, content: `existing ${index}`, confidence: 0.8 }))
    const result = applyWriteGate({ newFacts: [eligibleFact({ confidence: 0.75 })] }, { existingFacts: existing })
    expect(result.acceptedFacts).toHaveLength(1)
    expect(result.trimmedExistingIds).toEqual([])
  })

  it('evicts the single lowest-confidence incumbent when the cap is exceeded', () => {
    const existing = Array.from({ length: DEFAULT_MAX_FACTS }, (_, index) => ({
      id: `fact_${index}`,
      content: `existing ${index}`,
      // fact_0 is the weakest at 0.70; confidence rises with the index.
      confidence: 0.7 + index * 0.001,
    }))
    const result = applyWriteGate({ newFacts: [eligibleFact({ confidence: 0.99 })] }, { existingFacts: existing })
    expect(result.acceptedFacts).toHaveLength(1)
    expect(result.trimmedExistingIds).toEqual(['fact_0'])
  })

  it('rejects the NEW fact when it is itself the weakest entry', () => {
    const existing = Array.from({ length: DEFAULT_MAX_FACTS }, (_, index) => ({ id: `fact_${index}`, content: `existing ${index}`, confidence: 0.95 }))
    const result = applyWriteGate({ newFacts: [eligibleFact({ confidence: 0.71 })] }, { existingFacts: existing })
    expect(result.acceptedFacts).toEqual([])
    expect(result.trimmedExistingIds).toEqual([])
    expect(reasonsFor(result, 'newFacts[0]')).toEqual(['max_facts_trim'])
  })

  it('never lets an equal-confidence newcomer evict an incumbent', () => {
    const existing = Array.from({ length: DEFAULT_MAX_FACTS }, (_, index) => ({ id: `fact_${index}`, content: `existing ${index}`, confidence: 0.8 }))
    const result = applyWriteGate({ newFacts: [eligibleFact({ confidence: 0.8 })] }, { existingFacts: existing })
    expect(result.acceptedFacts).toEqual([])
    expect(result.trimmedExistingIds).toEqual([])
  })

  it('honours a lowered max_facts override', () => {
    const existing = [
      { id: 'a', content: 'a', confidence: 0.9 },
      { id: 'b', content: 'b', confidence: 0.72 },
    ]
    const result = applyWriteGate({ newFacts: [eligibleFact({ confidence: 0.95 })] }, { existingFacts: existing, maxFacts: 2 })
    expect(result.acceptedFacts).toHaveLength(1)
    expect(result.trimmedExistingIds).toEqual(['b'])
  })
})

describe('case-folded duplicate rejection', () => {
  it('normalizes case and whitespace', () => {
    expect(dedupeKey('  Prefers   TypeScript\n')).toBe('prefers typescript')
  })

  it('rejects a fact whose content already exists', () => {
    const result = applyWriteGate({ newFacts: [eligibleFact({ content: 'PREFERS   typescript' })] }, { existingFacts: [{ id: 'x', content: 'Prefers TypeScript', confidence: 0.9 }] })
    expect(reasonsFor(result, 'newFacts[0]')).toEqual(['duplicate_content'])
  })

  it('rejects the second of two identical facts within one batch', () => {
    const result = applyWriteGate({ newFacts: [eligibleFact({ content: 'lives in Tel Aviv' }), eligibleFact({ content: 'Lives In Tel Aviv' })] })
    expect(result.acceptedFacts).toHaveLength(1)
    expect(reasonsFor(result, 'newFacts[1]')).toEqual(['duplicate_content'])
  })
})

describe('summary gate (scope + authority only, no durability label upstream)', () => {
  it('accepts a wholly user-scoped descriptive summary', () => {
    const result = applyWriteGate({ user: { workContext: { summary: 'Staff engineer on a Node platform team', shouldUpdate: true, scope: 'user', authority: 'descriptive' } } })
    expect(result.acceptedSummaries).toEqual([{ section: 'user', slot: 'workContext', summary: 'Staff engineer on a Node platform team' }])
  })

  it.each([
    ['thread', 'descriptive', 'scope_not_user'],
    ['project', 'descriptive', 'scope_not_user'],
    ['user', 'transactional', 'authority_not_descriptive'],
  ])('rejects scope=%s authority=%s', (scope, authority, reason) => {
    const result = applyWriteGate({ history: { recentMonths: { summary: 'x', shouldUpdate: true, scope, authority } } })
    expect(result.acceptedSummaries).toEqual([])
    expect(reasonsFor(result, 'history.recentMonths')).toEqual([reason])
  })

  it('ignores a slot with shouldUpdate=false entirely (not counted as a proposal)', () => {
    const result = applyWriteGate({ user: { topOfMind: { summary: 'x', shouldUpdate: false, scope: 'user', authority: 'descriptive' } } })
    expect(result.acceptedSummaries).toEqual([])
    expect(result.rejections).toEqual([])
    expect(result.rejectionRate).toBe(0)
  })
})

describe('removal rules', () => {
  it('accepts a user-scoped removal carrying id + scope + reason', () => {
    const result = applyWriteGate({ factsToRemove: [{ id: 'fact_old', scope: 'user', reason: 'user explicitly retracted this' }] })
    expect(result.acceptedRemovals).toEqual([{ id: 'fact_old', reason: 'user explicitly retracted this' }])
  })

  it.each([['thread'], ['project']])('fails closed on a %s-scoped removal', (scope) => {
    const result = applyWriteGate({ factsToRemove: [{ id: 'fact_old', scope, reason: 'no longer applies to this task' }] })
    expect(result.acceptedRemovals).toEqual([])
    expect(reasonsFor(result, 'factsToRemove[0]')).toEqual(['scope_not_user'])
  })

  it('fails closed on the legacy bare-string form (it carries no scope to prove)', () => {
    const result = applyWriteGate({ factsToRemove: ['fact_old'] })
    expect(result.acceptedRemovals).toEqual([])
    expect(reasonsFor(result, 'factsToRemove[0]')).toEqual(['not_an_object'])
  })

  it.each([
    [{ scope: 'user', reason: 'r' }, 'missing_id'],
    [{ id: 'fact_old', scope: 'user' }, 'missing_reason'],
    [{ id: 'fact_old', reason: 'r' }, 'missing_or_invalid_scope'],
    [{ id: 'fact_old', scope: 'global', reason: 'r' }, 'missing_or_invalid_scope'],
  ])('rejects %p', (removal, reason) => {
    const result = applyWriteGate({ factsToRemove: [removal] })
    expect(reasonsFor(result, 'factsToRemove[0]')).toEqual([reason])
  })

  it('runs a paired removal only when the referenced replacement survives', () => {
    const proposal: ProposedUpdates = {
      newFacts: [eligibleFact({ content: 'now uses pnpm' })],
      factsToRemove: [{ id: 'fact_npm', scope: 'user', reason: 'superseded', replacementFactIndex: 0 }],
    }
    const result = applyWriteGate(proposal)
    expect(result.acceptedFacts).toHaveLength(1)
    expect(result.acceptedRemovals).toEqual([{ id: 'fact_npm', reason: 'superseded', replacementFactIndex: 0 }])
  })

  it('fails closed when the replacement was rejected by the scope gate', () => {
    const result = applyWriteGate({
      newFacts: [eligibleFact({ content: 'now uses pnpm', scope: 'project' })],
      factsToRemove: [{ id: 'fact_npm', scope: 'user', reason: 'superseded', replacementFactIndex: 0 }],
    })
    expect(result.acceptedRemovals).toEqual([])
    expect(reasonsFor(result, 'factsToRemove[0]')).toEqual(['replacement_did_not_survive'])
  })

  it('fails closed when the replacement was evicted by the max_facts trim', () => {
    const existing = Array.from({ length: DEFAULT_MAX_FACTS }, (_, index) => ({ id: `fact_${index}`, content: `existing ${index}`, confidence: 0.99 }))
    const result = applyWriteGate(
      { newFacts: [eligibleFact({ content: 'now uses pnpm', confidence: 0.72 })], factsToRemove: [{ id: 'fact_0', scope: 'user', reason: 'superseded', replacementFactIndex: 0 }] },
      { existingFacts: existing },
    )
    expect(result.acceptedFacts).toEqual([])
    expect(reasonsFor(result, 'factsToRemove[0]')).toEqual(['replacement_did_not_survive'])
  })

  it('fails closed on an out-of-range replacement index', () => {
    const result = applyWriteGate({ newFacts: [eligibleFact()], factsToRemove: [{ id: 'fact_x', scope: 'user', reason: 'r', replacementFactIndex: 7 }] })
    expect(reasonsFor(result, 'factsToRemove[0]')).toEqual(['replacement_did_not_survive'])
  })

  it.each([[-1], [1.5], ['0']])('rejects a malformed replacement index %p', (replacementFactIndex) => {
    const result = applyWriteGate({ newFacts: [eligibleFact()], factsToRemove: [{ id: 'fact_x', scope: 'user', reason: 'r', replacementFactIndex }] })
    expect(reasonsFor(result, 'factsToRemove[0]')).toEqual(['invalid_replacement_index'])
  })
})

describe('consolidation groups', () => {
  const existing = [
    { id: 'fact_a', content: 'knows Rust', confidence: 0.8 },
    { id: 'fact_b', content: 'knows Go', confidence: 0.9 },
  ]

  it('accepts a labelled merge whose confidence equals the source maximum', () => {
    const result = applyWriteGate(
      { factsToConsolidate: [{ sourceIds: ['fact_a', 'fact_b'], consolidated: eligibleFact({ content: 'knows Rust and Go', category: 'knowledge', confidence: 0.9 }) }] },
      { existingFacts: existing },
    )
    expect(result.acceptedFacts).toHaveLength(1)
    expect(result.acceptedFacts[0]?.consolidatedFrom).toEqual(['fact_a', 'fact_b'])
    // `knowledge` is outside the nine core categories, so it normalizes to `other`.
    expect(result.acceptedFacts[0]?.category).toBe('other')
  })

  it('rejects a merge whose confidence exceeds the source maximum', () => {
    const result = applyWriteGate(
      { factsToConsolidate: [{ sourceIds: ['fact_a', 'fact_b'], consolidated: eligibleFact({ content: 'knows Rust and Go', confidence: 0.95 }) }] },
      { existingFacts: existing },
    )
    expect(result.acceptedFacts).toEqual([])
    expect(reasonsFor(result, 'factsToConsolidate[0]')).toEqual(['confidence_exceeds_sources'])
  })

  it('rejects an unknown source id', () => {
    const result = applyWriteGate({ factsToConsolidate: [{ sourceIds: ['fact_a', 'fact_zzz'], consolidated: eligibleFact({ confidence: 0.8 }) }] }, { existingFacts: existing })
    expect(reasonsFor(result, 'factsToConsolidate[0]')).toEqual(['unknown_source_id'])
  })

  it('rejects a single-source "merge"', () => {
    const result = applyWriteGate({ factsToConsolidate: [{ sourceIds: ['fact_a'], consolidated: eligibleFact({ confidence: 0.8 }) }] }, { existingFacts: existing })
    expect(reasonsFor(result, 'factsToConsolidate[0]')).toEqual(['insufficient_source_ids'])
  })

  it('applies the same label gate to the merged fact', () => {
    const result = applyWriteGate(
      { factsToConsolidate: [{ sourceIds: ['fact_a', 'fact_b'], consolidated: eligibleFact({ confidence: 0.8, authority: 'transactional' }) }] },
      { existingFacts: existing },
    )
    expect(reasonsFor(result, 'factsToConsolidate[0]')).toEqual(['authority_not_descriptive'])
  })

  it('frees the sources it consumes from the max_facts budget', () => {
    const filler = Array.from({ length: DEFAULT_MAX_FACTS - 2 }, (_, index) => ({ id: `filler_${index}`, content: `filler ${index}`, confidence: 0.99 }))
    const result = applyWriteGate(
      { factsToConsolidate: [{ sourceIds: ['fact_a', 'fact_b'], consolidated: eligibleFact({ content: 'knows Rust and Go', confidence: 0.75 }) }] },
      { existingFacts: [...existing, ...filler] },
    )
    // Two sources leave, one merged fact arrives: 100 - 2 + 1 = 99, under the cap.
    expect(result.acceptedFacts).toHaveLength(1)
    expect(result.trimmedExistingIds).toEqual([])
  })
})

describe('malformed input never throws', () => {
  it.each([[{}], [{ newFacts: 'nope' }], [{ newFacts: [null, 42, 'text'] }], [{ factsToRemove: {} }], [{ user: null }], [{ factsToConsolidate: [null] }]])('survives %p', (proposal) => {
    expect(() => applyWriteGate(proposal as ProposedUpdates)).not.toThrow()
  })

  it('rejects a fact with empty content', () => {
    const result = applyWriteGate({ newFacts: [eligibleFact({ content: '   ' })] })
    expect(reasonsFor(result, 'newFacts[0]')).toEqual(['empty_content'])
  })

  it('reports a zero rejection rate for an empty proposal', () => {
    expect(applyWriteGate({}).rejectionRate).toBe(0)
  })
})

describe('sourceError is kept only for correction facts', () => {
  it('keeps it on a correction', () => {
    const result = applyWriteGate({ newFacts: [eligibleFact({ category: 'correction', confidence: 0.95, sourceError: 'assumed npm' })] })
    expect(result.acceptedFacts[0]?.sourceError).toBe('assumed npm')
  })

  it('drops it on any other category', () => {
    const result = applyWriteGate({ newFacts: [eligibleFact({ category: 'preference', sourceError: 'assumed npm' })] })
    expect(result.acceptedFacts[0]?.sourceError).toBeUndefined()
  })
})
