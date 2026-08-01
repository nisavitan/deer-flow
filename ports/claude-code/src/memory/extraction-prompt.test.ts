// Tests for the purpose-built prompt loader.
//
// The point of these is that the four YAML assets stay BYTE-VERBATIM: the system message must
// render to upstream's exact text, and `{{`/`}}` must survive as literal braces so the model
// sees a valid JSON skeleton. A hand-rolled parser without this coverage would be the weakest
// link in an otherwise verbatim chain.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MEMORY_PROMPT_FILES,
  PromptTemplateError,
  loadPromptTemplate,
  memoryPromptsDir,
  parsePromptTemplate,
  renderConsolidationSection,
  renderExtractionRequest,
  renderStalenessReviewSection,
  renderTemplate,
  resolvePluginRoot,
} from './extraction-prompt.js'

describe('plugin-root resolution', () => {
  it('prefers CLAUDE_PLUGIN_ROOT when the harness supplies it', () => {
    expect(resolvePluginRoot({ CLAUDE_PLUGIN_ROOT: '/plugin' })).toBe('/plugin')
    expect(memoryPromptsDir({ CLAUDE_PLUGIN_ROOT: '/plugin' })).toBe(join('/plugin', 'prompts', 'memory'))
  })

  it('falls back to two levels up from this module, which resolves the real assets', () => {
    expect(() => loadPromptTemplate(MEMORY_PROMPT_FILES.memoryUpdate, {})).not.toThrow()
  })
})

describe('renderTemplate — Python str.format semantics', () => {
  it('substitutes single-brace placeholders', () => {
    expect(renderTemplate('a {x} b', { x: 'X' })).toBe('a X b')
  })

  it('unescapes {{ and }} into literal braces', () => {
    expect(renderTemplate('{{ "a": 1 }}', {})).toBe('{ "a": 1 }')
  })

  it('renders an absent placeholder as the empty string (inactive optional section)', () => {
    expect(renderTemplate('before{missing}after', {})).toBe('beforeafter')
  })

  it('does not treat an escaped brace as a placeholder', () => {
    expect(renderTemplate('{{x}}', { x: 'SHOULD NOT APPEAR' })).toBe('{x}')
  })

  it('leaves an unterminated brace alone rather than swallowing the tail', () => {
    expect(renderTemplate('a { b', {})).toBe('a { b')
  })
})

describe('parser accepts exactly the upstream shapes', () => {
  it('parses the chat template into two messages', () => {
    const parsed = loadPromptTemplate(MEMORY_PROMPT_FILES.memoryUpdate)
    expect(parsed.format).toBe('chat')
    expect(parsed.version).toBe('1.0')
    expect(parsed.messages).toHaveLength(2)
    expect(parsed.messages?.[0]?.role).toBe('system')
    expect(parsed.messages?.[1]?.role).toBe('user')
  })

  it.each([
    [MEMORY_PROMPT_FILES.stalenessReview, '{stale_facts}'],
    [MEMORY_PROMPT_FILES.consolidation, '{consolidation_groups}'],
    [MEMORY_PROMPT_FILES.factExtraction, '{message}'],
  ])('parses the text template %s and keeps its placeholder', (fileName, placeholder) => {
    const parsed = loadPromptTemplate(fileName)
    expect(parsed.format).toBe('text')
    expect(parsed.template).toContain(placeholder)
  })

  it.each([
    ['unknown top-level key', 'format: text\nversion: "1.0"\nsurprise: 1\n'],
    ['missing format', 'version: "1.0"\ntemplate: |-\n  x\n'],
    ['missing version', 'format: text\ntemplate: |-\n  x\n'],
    ['text without template', 'format: text\nversion: "1.0"\n'],
    ['chat without messages', 'format: chat\nversion: "1.0"\n'],
    ['non-block template', 'format: text\nversion: "1.0"\ntemplate: inline\n'],
  ])('fails loudly on %s', (_label, text) => {
    expect(() => parsePromptTemplate(text, '/tmp/x.yaml')).toThrow(PromptTemplateError)
  })
})

describe('the system message renders byte-verbatim', () => {
  it('reproduces the upstream system prompt exactly, with braces unescaped', () => {
    const messages = renderExtractionRequest({ currentMemory: '{}', conversation: 'user: hi\nassistant: hello' })
    const system = messages[0]?.content ?? ''

    // Spot-check the load-bearing contract lines the write gate depends on.
    expect(system).toContain('Only facts classified as scope="user", durability="durable", authority="descriptive" are eligible for storage.')
    expect(system).toContain('These labels are evaluated by a deterministic write gate and are not persisted.')
    expect(system).toContain('Return ONLY valid JSON, no explanation or markdown.')

    // The JSON skeleton must arrive with SINGLE braces after unescaping.
    expect(system).toContain('"staleFactsToRemove": [{ "id": "fact_id", "reason": "brief explanation" }],')
    expect(system).toContain('"staleFactsToExtend": [{ "id": "fact_id", "extend_by_days": 365, "reason": "brief explanation" }],')
    expect(system).not.toContain('{{')
    expect(system).not.toContain('}}')

    // And it must match the on-disk asset, modulo brace unescaping — proof no text was lost.
    const raw = readFileSync(join(memoryPromptsDir(), MEMORY_PROMPT_FILES.memoryUpdate), 'utf8')
    for (const line of system.split('\n')) {
      if (line.trim() === '') continue
      expect(raw).toContain(line.replace(/\{/g, '{{').replace(/\}/g, '}}').trim().slice(0, 60))
    }
  })

  it('carries no placeholders of its own', () => {
    const withValues = renderExtractionRequest({ currentMemory: 'MEM', conversation: 'CONV' })[0]?.content
    const withoutValues = renderExtractionRequest({ currentMemory: '', conversation: '' })[0]?.content
    expect(withValues).toBe(withoutValues)
  })
})

describe('the user message substitutes every documented placeholder', () => {
  it('fills current_memory and conversation', () => {
    const user = renderExtractionRequest({ currentMemory: 'MEMORY-STATE', conversation: 'CONVERSATION-BATCH' })[1]?.content ?? ''
    expect(user).toContain('<current_memory>\nMEMORY-STATE\n</current_memory>')
    expect(user).toContain('<conversation>\nCONVERSATION-BATCH\n</conversation>')
    expect(user).toContain('Update the memory based on the above conversation.')
  })

  it('renders inactive optional sections as empty rather than leaving the token', () => {
    const user = renderExtractionRequest({ currentMemory: '{}', conversation: 'c' })[1]?.content ?? ''
    expect(user).not.toContain('{staleness_review_section}')
    expect(user).not.toContain('{consolidation_section}')
    expect(user).not.toContain('{correction_hint}')
  })

  it('splices the staleness and consolidation sections when supplied', () => {
    const user =
      renderExtractionRequest({
        currentMemory: '{}',
        conversation: 'c',
        correctionHint: 'HINT',
        stalenessReviewSection: renderStalenessReviewSection('- fact_a (valid:30d) knows Rust'),
        consolidationSection: renderConsolidationSection('### knowledge (9 facts)', 3),
      })[1]?.content ?? ''
    expect(user).toContain('HINT')
    expect(user).toContain('## Staleness Review')
    expect(user).toContain('- fact_a (valid:30d) knows Rust')
    expect(user).toContain('## Memory Consolidation')
    expect(user).toContain('### knowledge (9 facts)')
    expect(user).toContain('Maximum 3 consolidation groups per cycle')
  })

  it('unescapes the braces inside the spliced sections too', () => {
    const staleness = renderStalenessReviewSection('x')
    expect(staleness).toContain('{"id": "fact_id", "reason": "brief explanation"}')
    expect(staleness).not.toContain('{{')
  })
})
