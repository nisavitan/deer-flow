// Vector-driven parity tests for the artifacts channel.
// Source of truth: parity/baseline/state_reducers.json -> merge_artifacts (extracted by
// executing deerflow.agents.thread_state:merge_artifacts at commit 0950924).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { mergeArtifacts } from './artifacts.js'

interface ArtifactVector {
  name: string
  description: string
  existing: string[] | null
  new: string[] | null
  merged: string[]
}

const vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../parity/baseline/state_reducers.json', import.meta.url)), 'utf8'),
) as { merge_artifacts: ArtifactVector[] }

describe('merge_artifacts parity vectors', () => {
  it.each(vectors.merge_artifacts.map((vector) => [vector.name, vector] as const))('vector %s', (_name, vector) => {
    expect(mergeArtifacts(vector.existing, vector.new)).toEqual(vector.merged)
  })

  it('consumed every recorded artifacts vector', () => {
    expect(vectors.merge_artifacts).toHaveLength(4)
  })
})

describe('merge_artifacts edge cases', () => {
  it('never mutates its inputs', () => {
    const existing = ['a']
    const incoming = ['b']
    mergeArtifacts(existing, incoming)
    expect(existing).toEqual(['a'])
    expect(incoming).toEqual(['b'])
  })

  it('returns an empty list when both sides are empty', () => {
    expect(mergeArtifacts(null, null)).toEqual([])
  })
})
