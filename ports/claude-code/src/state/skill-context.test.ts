// Vector-driven parity tests for the skill-context channel.
// Source of truth: parity/baseline/state_reducers.json -> merge_skill_context (extracted by
// executing deerflow.agents.thread_state:merge_skill_context at commit 0950924).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  MissingSkillPathError,
  SKILL_CONTEXT_MAX_ENTRIES,
  SKILL_DESCRIPTION_MAX_CHARS,
  mergeSkillContext,
  normalizeSkillEntry,
  type SkillEntry,
} from './skill-context.js'

interface SkillVector {
  name: string
  description: string
  existing?: Record<string, unknown>[] | null
  new?: Record<string, unknown>[] | null
  merged?: SkillEntry[]
  existing_paths?: string[]
  new_paths?: string[]
  merged_paths?: string[]
  merged_length?: number
}

const vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../parity/baseline/state_reducers.json', import.meta.url)), 'utf8'),
) as { merge_skill_context: SkillVector[] }

function entryFor(path: string, loadedAt: number): Record<string, unknown> {
  return { name: '', path, description: 'd', loaded_at: loadedAt }
}

describe('merge_skill_context parity vectors', () => {
  it.each(vectors.merge_skill_context.map((vector) => [vector.name, vector] as const))(
    'vector %s',
    (_name, vector) => {
      if (vector.existing_paths !== undefined) {
        const merged = mergeSkillContext(
          vector.existing_paths.map((path, index) => entryFor(path, index)),
          (vector.new_paths ?? []).map((path, index) => entryFor(path, 100 + index)),
        )
        expect(merged.map((entry) => entry.path)).toEqual(vector.merged_paths)
        expect(merged).toHaveLength(vector.merged_length as number)
        return
      }
      expect(mergeSkillContext(vector.existing ?? null, vector.new ?? null)).toEqual(vector.merged)
    },
  )

  it('consumed every recorded skill-context vector', () => {
    expect(vectors.merge_skill_context).toHaveLength(6)
  })
})

describe('merge_skill_context edge cases', () => {
  it('pins the recency and description caps', () => {
    expect(SKILL_CONTEXT_MAX_ENTRIES).toBe(8)
    expect(SKILL_DESCRIPTION_MAX_CHARS).toBe(500)
  })

  it('never stores a SKILL.md body', () => {
    const merged = mergeSkillContext(null, [
      { name: 'pdf', path: '/skills/pdf/SKILL.md', description: 'x', loaded_at: 1, body: 'FULL BODY', content: 'FULL BODY' },
    ])
    expect(merged[0]).toEqual({ name: 'pdf', path: '/skills/pdf/SKILL.md', description: 'x', loaded_at: 1 })
    expect(JSON.stringify(merged)).not.toContain('FULL BODY')
  })

  it('rejects an entry without a path', () => {
    expect(() => normalizeSkillEntry({ name: 'a', description: 'd' })).toThrow(MissingSkillPathError)
  })

  it('collapses interior whitespace and non-string descriptions', () => {
    expect(normalizeSkillEntry({ path: '/p', description: '\n a \t\t b \n' }).description).toBe('a b')
    expect(normalizeSkillEntry({ path: '/p', description: 42 }).description).toBe('')
    expect(normalizeSkillEntry({ path: '/p', loaded_at: 1.5 }).loaded_at).toBe(0)
  })
})
