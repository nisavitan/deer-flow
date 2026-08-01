// Vector-driven parity tests for the deferred-tool promotion channel.
// Source of truth: parity/baseline/state_reducers.json -> merge_promoted (extracted by
// executing deerflow.agents.thread_state:merge_promoted at commit 0950924).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { mergePromoted, type PromotedTools } from './promoted.js'

interface PromotedVector {
  name: string
  description: string
  existing: PromotedTools | null
  new: Partial<PromotedTools> | null
  merged: PromotedTools | null
}

const vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../parity/baseline/state_reducers.json', import.meta.url)), 'utf8'),
) as { merge_promoted: PromotedVector[] }

describe('merge_promoted parity vectors', () => {
  it.each(vectors.merge_promoted.map((vector) => [vector.name, vector] as const))('vector %s', (_name, vector) => {
    expect(mergePromoted(vector.existing, vector.new)).toEqual(vector.merged)
  })

  it('consumed every recorded promoted vector', () => {
    expect(vectors.merge_promoted).toHaveLength(5)
  })
})

describe('merge_promoted edge cases', () => {
  it('drops stale names on catalog drift rather than carrying a bare name across', () => {
    const merged = mergePromoted({ catalog_hash: 'h1', names: ['old_tool'] }, { catalog_hash: 'h2', names: [] })
    expect(merged).toEqual({ catalog_hash: 'h2', names: [] })
  })

  it('returns null when there is nothing on either side', () => {
    expect(mergePromoted(null, null)).toBeNull()
  })
})
