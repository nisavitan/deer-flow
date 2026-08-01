// Vector-driven parity tests for the delegation ledger.
// Source of truth: parity/baseline/delegations_ledger.json (extracted by executing
// deerflow.agents.thread_state:merge_delegations at commit 0950924).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  DELEGATION_LEDGER_MAX_ENTRIES,
  countRunDelegations,
  mergeDelegations,
  type DelegationEntry,
} from './delegations.js'

interface OperationVector {
  name: string
  description: string
  existing?: DelegationEntry[] | null
  new?: DelegationEntry[] | null
  merged?: DelegationEntry[]
  existing_ids?: string[]
  new_ids?: string[]
  merged_ids?: string[]
  merged_length?: number
}

interface SequenceStep {
  step: string
  update: DelegationEntry[]
  ledger: DelegationEntry[]
}

const vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../parity/baseline/delegations_ledger.json', import.meta.url)), 'utf8'),
) as {
  ledger_max_entries: number
  operations: OperationVector[]
  sequence: SequenceStep[]
}

function entryFor(id: string): DelegationEntry {
  return {
    id,
    description: `task ${id}`,
    subagent_type: 'general-purpose',
    status: 'in_progress',
    created_at: '1970-01-01T00:00:00+00:00',
  }
}

describe('merge_delegations parity vectors', () => {
  it('pins the ledger cap constant', () => {
    expect(DELEGATION_LEDGER_MAX_ENTRIES).toBe(vectors.ledger_max_entries)
  })

  it.each(vectors.operations.map((vector) => [vector.name, vector] as const))('operation %s', (_name, vector) => {
    if (vector.existing_ids !== undefined) {
      const merged = mergeDelegations(
        vector.existing_ids.map(entryFor),
        (vector.new_ids ?? []).map(entryFor),
      )
      expect(merged.map((entry) => entry.id)).toEqual(vector.merged_ids)
      expect(merged).toHaveLength(vector.merged_length as number)
      return
    }
    expect(mergeDelegations(vector.existing ?? null, vector.new ?? null)).toEqual(vector.merged)
  })

  it('replays the recorded dispatch sequence', () => {
    let ledger: DelegationEntry[] | null = null
    for (const step of vectors.sequence) {
      ledger = mergeDelegations(ledger, step.update)
      expect(ledger, `after step ${step.step}`).toEqual(step.ledger)
    }
    expect(vectors.sequence).toHaveLength(5)
  })
})

describe('merge_delegations edge cases', () => {
  it('keeps first-seen order when an entry is updated in place', () => {
    const merged = mergeDelegations(
      [entryFor('a'), entryFor('b')],
      [{ ...entryFor('a'), status: 'completed' }],
    )
    expect(merged.map((entry) => entry.id)).toEqual(['a', 'b'])
    expect(merged[0]?.status).toBe('completed')
  })

  it('treats every recorded terminal status as non-downgradable', () => {
    for (const status of ['completed', 'failed', 'cancelled', 'timed_out', 'polling_timed_out']) {
      const merged = mergeDelegations([{ ...entryFor('a'), status }], [entryFor('a')])
      expect(merged[0]?.status, status).toBe(status)
    }
  })

  it('does not treat in_progress as terminal', () => {
    const merged = mergeDelegations([entryFor('a')], [{ ...entryFor('a'), status: 'in_progress', description: 'newer' }])
    expect(merged[0]?.description).toBe('newer')
  })

  it('counts only the current run when a run id is supplied, and everything without one', () => {
    const entries = [
      { ...entryFor('a'), run_id: 'run-1' },
      { ...entryFor('b'), run_id: 'run-1' },
      { ...entryFor('c'), run_id: 'run-OLD' },
    ]
    expect(countRunDelegations(entries, 'run-1')).toBe(2)
    expect(countRunDelegations(entries, null)).toBe(3)
  })
})
