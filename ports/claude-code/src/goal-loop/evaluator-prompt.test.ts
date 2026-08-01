// Frozen-copy + parser-matrix tests for the goal evaluator prompt.
//
// The frozen-copy tests do not compare against a hand-copied fixture: they re-parse the Python
// string literals straight out of `runtime/goal.py` (the `system_instruction` block at
// goal.py:299-308 and the `user_content` f-string at goal.py:309) and assert byte equality with
// the port's constants. If the original rubric ever changes, this suite fails instead of the port
// silently judging goals by an outdated standard.
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  GOAL_EVALUATOR_SYSTEM_INSTRUCTION,
  GoalEvaluationParseError,
  MAX_GOAL_CONVERSATION_CHARS,
  MAX_GOAL_CONVERSATION_MESSAGES,
  MAX_GOAL_EVIDENCE_CHARS,
  MAX_GOAL_REASON_CHARS,
  NO_VISIBLE_EVIDENCE_EVALUATION,
  evidenceSignatureOf,
  formatVisibleConversation,
  hasVisibleAssistantEvidence,
  latestVisibleAssistantSignature,
  normalizeEvaluationText,
  normalizeGoalBlocker,
  parseGoalEvaluationResponse,
  parseGoalVerdict,
  renderGoalEvaluatorRequest,
  renderGoalEvaluatorUserContent,
  stripMarkdownCodeFence,
  stripThinkBlocks,
  type VisibleMessage,
} from './evaluator-prompt.js'

const GOAL_PY = fileURLToPath(new URL('../../../../backend/packages/harness/deerflow/runtime/goal.py', import.meta.url))
const goalSource = readFileSync(GOAL_PY, 'utf8').split('\n')

/** Parse ONE leading Python string literal off a source line, resolving its escapes. */
function pythonLiteral(line: string): string | null {
  const trimmed = line.trim()
  const quote = trimmed[0]
  if (quote !== '"' && quote !== "'") return null
  let out = ''
  for (let index = 1; index < trimmed.length; index++) {
    const char = trimmed[index]
    if (char === '\\') {
      const next = trimmed[index + 1]
      index += 1
      if (next === 'n') out += '\n'
      else if (next === 't') out += '\t'
      else if (next === undefined) break
      else out += next
      continue
    }
    if (char === quote) return out
    out += char ?? ''
  }
  return null
}

/** Concatenate the implicit-adjacent literals of the `system_instruction = ( … )` block. */
function extractSystemInstruction(): string {
  const start = goalSource.findIndex((line) => /^\s*system_instruction = \($/.test(line))
  expect(start).toBeGreaterThan(-1)
  const parts: string[] = []
  for (let index = start + 1; index < goalSource.length; index++) {
    const line = goalSource[index]
    if (line === undefined || /^\s*\)\s*$/.test(line)) break
    const literal = pythonLiteral(line)
    expect(literal, `unparsed literal at goal.py:${index + 1}`).not.toBeNull()
    parts.push(literal ?? '')
  }
  expect(parts.length).toBeGreaterThan(0)
  return parts.join('')
}

/** Extract the `user_content = f"…"` template and substitute its two placeholders. */
function extractUserContentTemplate(): string {
  const line = goalSource.find((candidate) => /^\s*user_content = f"/.test(candidate))
  expect(line, 'user_content f-string not found in goal.py').toBeDefined()
  const literal = pythonLiteral((line ?? '').slice((line ?? '').indexOf('= f') + 3))
  expect(literal).not.toBeNull()
  return literal ?? ''
}

describe('frozen copy vs runtime/goal.py', () => {
  it('system instruction matches goal.py:299-308 byte for byte', () => {
    expect(GOAL_EVALUATOR_SYSTEM_INSTRUCTION).toBe(extractSystemInstruction())
  })

  it('system instruction still carries every clause the loop depends on', () => {
    // A guard on the guard: proves the extraction above read a real rubric, not an empty block.
    expect(GOAL_EVALUATOR_SYSTEM_INSTRUCTION).toContain('strict completion evaluator')
    expect(GOAL_EVALUATOR_SYSTEM_INSTRUCTION).toContain('ONLY the visible conversation evidence')
    expect(GOAL_EVALUATOR_SYSTEM_INSTRUCTION).toContain('fail closed with blocker missing_evidence')
    expect(GOAL_EVALUATOR_SYSTEM_INSTRUCTION).toContain(
      'Output exactly one JSON object: {"satisfied": boolean, "blocker": string, "reason": string, "evidence_summary": string}.',
    )
  })

  it('user content matches the goal.py:309 f-string with both placeholders substituted', () => {
    const expected = extractUserContentTemplate()
      .replace("{goal['objective']}", 'finish the audit')
      .replace('{conversation}', 'User: go\n\nAssistant: done')
    expect(renderGoalEvaluatorUserContent({ objective: 'finish the audit', conversation: 'User: go\n\nAssistant: done' })).toBe(
      expected,
    )
  })

  it('renderGoalEvaluatorRequest pairs the frozen system text with the rendered user content', () => {
    const request = renderGoalEvaluatorRequest({ objective: 'o', conversation: 'c' })
    expect(request.system).toBe(GOAL_EVALUATOR_SYSTEM_INSTRUCTION)
    expect(request.user).toBe(renderGoalEvaluatorUserContent({ objective: 'o', conversation: 'c' }))
  })

  it('caps match goal.py:38-41', () => {
    const capOf = (name: string): number => {
      const line = goalSource.find((candidate) => candidate.startsWith(`${name} = `))
      return Number((line ?? '').split('=')[1]?.trim())
    }
    expect(MAX_GOAL_REASON_CHARS).toBe(capOf('MAX_GOAL_REASON_CHARS'))
    expect(MAX_GOAL_EVIDENCE_CHARS).toBe(capOf('MAX_GOAL_EVIDENCE_CHARS'))
    expect(MAX_GOAL_CONVERSATION_CHARS).toBe(capOf('MAX_GOAL_CONVERSATION_CHARS'))
    expect(MAX_GOAL_CONVERSATION_MESSAGES).toBe(capOf('MAX_GOAL_CONVERSATION_MESSAGES'))
  })

  it('the no-visible-evidence short circuit matches goal.py:292-297', () => {
    expect(NO_VISIBLE_EVIDENCE_EVALUATION).toEqual({
      satisfied: false,
      blocker: 'missing_evidence',
      reason: 'No visible assistant evidence is available yet.',
      evidence_summary: '',
    })
  })
})

describe('pre-parse helpers (llm_text.py)', () => {
  it('removes complete think blocks', () => {
    expect(stripThinkBlocks('<think>hidden</think>{"satisfied": true}')).toBe('{"satisfied": true}')
  })

  it('truncates at a dangling open think tag', () => {
    expect(stripThinkBlocks('answer <think>cut off here')).toBe('answer')
  })

  it('keeps a dangling open tag when truncate_unclosed is false', () => {
    expect(stripThinkBlocks('answer <think>kept', false)).toBe('answer <think>kept')
  })

  it('unwraps a single markdown fence and leaves unfenced text alone', () => {
    expect(stripMarkdownCodeFence('```json\n{"satisfied": true}\n```')).toBe('{"satisfied": true}')
    expect(stripMarkdownCodeFence('  {"satisfied": true}  ')).toBe('{"satisfied": true}')
    expect(stripMarkdownCodeFence('```only one line```')).toBe('```only one line```')
  })

  it('normalizes evaluation text: collapse whitespace, clamp, non-strings become empty', () => {
    expect(normalizeEvaluationText('  a\n\n b \t c ', 100)).toBe('a b c')
    expect(normalizeEvaluationText('x'.repeat(2000), MAX_GOAL_REASON_CHARS)).toHaveLength(MAX_GOAL_REASON_CHARS)
    expect(normalizeEvaluationText(42, 100)).toBe('')
    expect(normalizeEvaluationText(undefined, 100)).toBe('')
  })

  it('normalizes blockers exactly like goal.py:174-179', () => {
    expect(normalizeGoalBlocker('goal_not_met_yet', true)).toBe('none')
    expect(normalizeGoalBlocker('none', false)).toBe('missing_evidence')
    expect(normalizeGoalBlocker('made_up', false)).toBe('missing_evidence')
    expect(normalizeGoalBlocker(undefined, false)).toBe('missing_evidence')
    expect(normalizeGoalBlocker('external_wait', false)).toBe('external_wait')
  })
})

describe('verdict parser matrix', () => {
  const cases: ReadonlyArray<{
    name: string
    input: string
    expected: { satisfied: boolean; blocker: string; reason: string; evidence_summary: string }
  }> = [
    {
      name: 'plain json object',
      input: '{"satisfied": true, "blocker": "none", "reason": "all tests pass", "evidence_summary": "pytest 12/12"}',
      expected: { satisfied: true, blocker: 'none', reason: 'all tests pass', evidence_summary: 'pytest 12/12' },
    },
    {
      name: 'fenced json',
      input: '```json\n{"satisfied": false, "blocker": "goal_not_met_yet", "reason": "more to do", "evidence_summary": "e"}\n```',
      expected: { satisfied: false, blocker: 'goal_not_met_yet', reason: 'more to do', evidence_summary: 'e' },
    },
    {
      name: 'think block then json',
      input: '<think>weighing evidence</think>\n{"satisfied": false, "blocker": "run_failed", "reason": "boom", "evidence_summary": ""}',
      expected: { satisfied: false, blocker: 'run_failed', reason: 'boom', evidence_summary: '' },
    },
    {
      name: 'prose around the object',
      input: 'Here is my verdict: {"satisfied": false, "blocker": "external_wait", "reason": "waiting", "evidence_summary": "e"} — done.',
      expected: { satisfied: false, blocker: 'external_wait', reason: 'waiting', evidence_summary: 'e' },
    },
    {
      name: 'satisfied forces blocker none',
      input: '{"satisfied": true, "blocker": "goal_not_met_yet", "reason": "r", "evidence_summary": "e"}',
      expected: { satisfied: true, blocker: 'none', reason: 'r', evidence_summary: 'e' },
    },
    {
      name: 'unsatisfied with blocker none falls closed to missing_evidence',
      input: '{"satisfied": false, "blocker": "none", "reason": "r", "evidence_summary": "e"}',
      expected: { satisfied: false, blocker: 'missing_evidence', reason: 'r', evidence_summary: 'e' },
    },
    {
      name: 'unknown blocker falls closed to missing_evidence',
      input: '{"satisfied": false, "blocker": "hallucinated", "reason": "r", "evidence_summary": "e"}',
      expected: { satisfied: false, blocker: 'missing_evidence', reason: 'r', evidence_summary: 'e' },
    },
    {
      name: 'missing optional fields become empty strings',
      input: '{"satisfied": false, "blocker": "needs_user_input"}',
      expected: { satisfied: false, blocker: 'needs_user_input', reason: '', evidence_summary: '' },
    },
    {
      name: 'non-string reason and evidence are dropped',
      input: '{"satisfied": false, "blocker": "needs_user_input", "reason": 7, "evidence_summary": {"a": 1}}',
      expected: { satisfied: false, blocker: 'needs_user_input', reason: '', evidence_summary: '' },
    },
    {
      name: 'whitespace in reason is collapsed',
      input: '{"satisfied": false, "blocker": "goal_not_met_yet", "reason": "  two   words\\n", "evidence_summary": "e"}',
      expected: { satisfied: false, blocker: 'goal_not_met_yet', reason: 'two words', evidence_summary: 'e' },
    },
    {
      // Parity quirk, deliberately preserved: goal.py slices from the FIRST '{' to the LAST '}',
      // so an object wrapped in an array is unwrapped rather than rejected. The port matches it
      // instead of being stricter than the engine it ports.
      name: 'object wrapped in an array is unwrapped (first { .. last })',
      input: '[{"satisfied": true, "blocker": "none", "reason": "done", "evidence_summary": "e"}]',
      expected: { satisfied: true, blocker: 'none', reason: 'done', evidence_summary: 'e' },
    },
  ]

  for (const testCase of cases) {
    it(`parses: ${testCase.name}`, () => {
      expect(parseGoalEvaluationResponse(testCase.input)).toEqual(testCase.expected)
      const tolerant = parseGoalVerdict(testCase.input)
      expect(tolerant.ok).toBe(true)
      expect(tolerant.evaluation).toEqual(testCase.expected)
    })
  }

  const malformed: ReadonlyArray<{ name: string; input: string }> = [
    { name: 'empty response', input: '' },
    { name: 'no json object', input: 'the goal looks done to me' },
    { name: 'unparseable json', input: '{"satisfied": tru' },
    { name: 'empty object', input: '{}' },
    { name: 'missing satisfied', input: '{"blocker": "goal_not_met_yet", "reason": "r"}' },
    { name: 'satisfied is a string', input: '{"satisfied": "yes", "blocker": "none"}' },
    { name: 'json swallowed by an unclosed think tag', input: '<think>{"satisfied": true}' },
  ]

  for (const testCase of malformed) {
    it(`fails closed: ${testCase.name}`, () => {
      expect(() => parseGoalEvaluationResponse(testCase.input)).toThrow(GoalEvaluationParseError)
      const tolerant = parseGoalVerdict(testCase.input)
      expect(tolerant.ok).toBe(false)
      if (tolerant.ok) throw new Error('unreachable')
      expect(tolerant.standDownReason).toBe('evaluation_failed')
      // Fail-safe direction: unsatisfied + a NON-continuable blocker, so the loop cannot continue
      // on an unreadable verdict.
      expect(tolerant.evaluation.satisfied).toBe(false)
      expect(tolerant.evaluation.blocker).toBe('missing_evidence')
      expect(tolerant.evaluation.reason).toContain('could not be parsed')
    })
  }
})

describe('visible evidence rendering', () => {
  const message = (role: 'user' | 'assistant', text: string): VisibleMessage => ({ role, text })

  it('labels roles and joins with a blank line, skipping empty text', () => {
    expect(
      formatVisibleConversation([message('user', ' go '), message('assistant', '  '), message('assistant', 'done')]),
    ).toBe('User: go\n\nAssistant: done')
  })

  it('keeps only the last 30 visible messages', () => {
    const many = Array.from({ length: 40 }, (_, index) => message('assistant', `m${index}`))
    const rendered = formatVisibleConversation(many)
    expect(rendered).not.toContain('Assistant: m9\n')
    expect(rendered.split('\n\n')).toHaveLength(MAX_GOAL_CONVERSATION_MESSAGES)
    expect(rendered.startsWith('Assistant: m10')).toBe(true)
    expect(rendered.endsWith('Assistant: m39')).toBe(true)
  })

  it('keeps only the trailing 12000 characters', () => {
    const rendered = formatVisibleConversation([message('assistant', 'a'.repeat(20000))])
    expect(rendered).toHaveLength(MAX_GOAL_CONVERSATION_CHARS)
    expect(rendered.endsWith('a')).toBe(true)
    expect(rendered.startsWith('Assistant:')).toBe(false)
  })

  it('detects visible assistant evidence', () => {
    expect(hasVisibleAssistantEvidence([message('user', 'go')])).toBe(false)
    expect(hasVisibleAssistantEvidence([message('assistant', '   ')])).toBe(false)
    expect(hasVisibleAssistantEvidence([message('assistant', 'done')])).toBe(true)
  })

  it('signs the LATEST visible assistant text with sha256', () => {
    const expected = createHash('sha256').update('second', 'utf8').digest('hex')
    expect(latestVisibleAssistantSignature([message('assistant', 'first'), message('assistant', ' second ')])).toBe(expected)
    expect(latestVisibleAssistantSignature([message('assistant', 'first'), message('user', 'later')])).toBe(
      evidenceSignatureOf('first'),
    )
    expect(latestVisibleAssistantSignature([message('user', 'only user')])).toBe('')
    expect(evidenceSignatureOf('   ')).toBe('')
  })
})
