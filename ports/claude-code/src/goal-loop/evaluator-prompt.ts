// Ported from backend/packages/harness/deerflow/runtime/goal.py:evaluate_goal_completion (prompt text,
// goal.py:299-309), parse_goal_evaluation_response (goal.py:141-179), format_visible_conversation
// (goal.py:226-239), has_visible_assistant_evidence (goal.py:206-208) and
// latest_visible_assistant_signature (goal.py:343-359) @ 0950924 — mechanical TypeScript translation.
// The `<think>` / code-fence pre-parse helpers are ported from
// backend/packages/harness/deerflow/utils/llm_text.py:strip_think_blocks,strip_markdown_code_fence.
//
// WHAT THIS FILE IS. The original hands the system instruction + user content below to a small
// non-thinking chat model and parses its JSON verdict. A Claude Code hook cannot call a model
// (no credentials, no budget, short-lived subprocess), so the port keeps this module as a pure
// renderer + parser: `src/hooks/stop-goal-evaluator.ts` puts the rendered rubric into the Stop
// hook's block reason and the *session model* produces the verdict. The rubric text itself is
// frozen byte-for-byte against goal.py (see evaluator-prompt.test.ts), so the judging standard
// is unchanged even though the judge is not independent. Recorded in parity/DISCREPANCIES.md.
import { createHash } from 'node:crypto'
import { GOAL_BLOCKERS, type GoalBlocker, type GoalEvaluation } from '../state/goal.js'

/** goal.py:38 — evaluator `reason` is clamped to this many characters. */
export const MAX_GOAL_REASON_CHARS = 1000
/** goal.py:39 — evaluator `evidence_summary` is clamped to this many characters. */
export const MAX_GOAL_EVIDENCE_CHARS = 1000
/** goal.py:40 — the rendered conversation keeps only its trailing 12000 characters. */
export const MAX_GOAL_CONVERSATION_CHARS = 12000
/** goal.py:41 — only the last 30 visible messages are rendered as evidence. */
export const MAX_GOAL_CONVERSATION_MESSAGES = 30

/**
 * goal.py:299-308, verbatim. Concatenation of the original's implicit-adjacent string literals,
 * including the trailing-space joins on the `Use blocker …` sentence.
 *
 * Frozen-copy: `evaluator-prompt.test.ts` re-parses the Python literal out of goal.py and
 * asserts byte equality, so a drift upstream fails the port's suite rather than passing silently.
 */
export const GOAL_EVALUATOR_SYSTEM_INSTRUCTION =
  'You are a strict completion evaluator for an AI coding assistant.\n' +
  'Decide whether the active goal is fully satisfied using ONLY the visible conversation evidence.\n' +
  'Do not assume files, commands, tests, or external state changed unless the conversation explicitly shows it.\n' +
  'If the visible evidence is too weak to prove progress, fail closed with blocker missing_evidence.\n' +
  'Use blocker needs_user_input when the assistant is waiting on the user, run_failed when the turn failed, ' +
  'external_wait when work is waiting on an outside system, goal_not_met_yet when useful autonomous work can continue, ' +
  'and none only when satisfied is true.\n' +
  'Output exactly one JSON object: {"satisfied": boolean, "blocker": string, "reason": string, "evidence_summary": string}.'

export interface EvaluatorUserContentInput {
  /** The active goal's normalized objective. */
  readonly objective: string
  /** Rendered visible conversation evidence — see {@link formatVisibleConversation}. */
  readonly conversation: string
}

/** goal.py:309, verbatim f-string with both placeholders substituted. */
export function renderGoalEvaluatorUserContent(input: EvaluatorUserContentInput): string {
  return `Active goal:\n${input.objective}\n\nVisible conversation evidence:\n${input.conversation}\n\nIs the active goal fully satisfied?`
}

export interface GoalEvaluatorRequest {
  readonly system: string
  readonly user: string
}

/** The complete evaluator request the original sends as `[SystemMessage, HumanMessage]`. */
export function renderGoalEvaluatorRequest(input: EvaluatorUserContentInput): GoalEvaluatorRequest {
  return { system: GOAL_EVALUATOR_SYSTEM_INSTRUCTION, user: renderGoalEvaluatorUserContent(input) }
}

/**
 * goal.py:292-297 — the short circuit taken when there is no visible assistant evidence at all.
 * The original returns this *without* a model call; the port returns it without a block.
 */
export const NO_VISIBLE_EVIDENCE_EVALUATION: GoalEvaluation = Object.freeze({
  satisfied: false,
  blocker: 'missing_evidence',
  reason: 'No visible assistant evidence is available yet.',
  evidence_summary: '',
})

// ---------------------------------------------------------------------------------------------
// Response pre-parse helpers (llm_text.py)
// ---------------------------------------------------------------------------------------------

const THINK_BLOCK_RE = /<think\b[^>]*>[\s\S]*?<\/think\s*>/gi
const OPEN_THINK_RE = /<think\b[^>]*>/i

/**
 * llm_text.py:13-30. Complete `<think>…</think>` blocks are removed; a dangling open tag
 * truncates the rest (the JSON-parsing callers' default, which `goal.py` uses).
 */
export function stripThinkBlocks(text: string, truncateUnclosed = true): string {
  let out = text.replace(THINK_BLOCK_RE, '')
  if (truncateUnclosed) {
    const open = OPEN_THINK_RE.exec(out)
    if (open !== null) out = out.slice(0, open.index)
  }
  return out.trim()
}

/** llm_text.py:33-41. Removes a single wrapping markdown code fence when present. */
export function stripMarkdownCodeFence(text: string): string {
  const stripped = text.trim()
  if (!stripped.startsWith('```')) return stripped
  const lines = stripped.split(/\r\n|\r|\n/)
  const first = lines[0]
  const last = lines[lines.length - 1]
  if (lines.length >= 3 && first !== undefined && last !== undefined && first.startsWith('```') && last.startsWith('```')) {
    return lines.slice(1, -1).join('\n').trim()
  }
  return stripped
}

/** goal.py:168-171 — collapse whitespace, then clamp. Non-strings become `''`. */
export function normalizeEvaluationText(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') return ''
  return value
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .join(' ')
    .slice(0, maxChars)
}

/** goal.py:174-179 — satisfied ⇒ `none`; unknown or `none` while unsatisfied ⇒ `missing_evidence`. */
export function normalizeGoalBlocker(value: unknown, satisfied: boolean): GoalBlocker {
  if (satisfied) return 'none'
  if (typeof value === 'string' && GOAL_BLOCKERS.has(value) && value !== 'none') return value as GoalBlocker
  return 'missing_evidence'
}

/** Raised by {@link parseGoalEvaluationResponse}; the original raises `ValueError` with these texts. */
export class GoalEvaluationParseError extends Error {
  override readonly name = 'GoalEvaluationParseError'
}

/**
 * goal.py:141-165 — strict parse of the evaluator's JSON object response.
 *
 * Tolerant only about *where* the object sits (think blocks, code fences and prose around it are
 * stripped, then the first `{` … last `}` slice is taken). It is not tolerant about shape: a
 * missing or non-boolean `satisfied` is a hard failure, exactly like the original.
 */
export function parseGoalEvaluationResponse(text: string): GoalEvaluation {
  const candidate = stripMarkdownCodeFence(stripThinkBlocks(text))
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) {
    throw new GoalEvaluationParseError('Goal evaluator response did not contain a JSON object.')
  }
  let payload: unknown
  try {
    payload = JSON.parse(candidate.slice(start, end + 1))
  } catch {
    throw new GoalEvaluationParseError('Goal evaluator response was not valid JSON.')
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new GoalEvaluationParseError('Goal evaluator JSON must be an object.')
  }
  const record = payload as Record<string, unknown>
  const satisfied = record['satisfied']
  if (typeof satisfied !== 'boolean') {
    throw new GoalEvaluationParseError("Goal evaluator JSON must include boolean 'satisfied'.")
  }
  return {
    satisfied,
    blocker: normalizeGoalBlocker(record['blocker'], satisfied),
    reason: normalizeEvaluationText(record['reason'], MAX_GOAL_REASON_CHARS),
    evidence_summary: normalizeEvaluationText(record['evidence_summary'], MAX_GOAL_EVIDENCE_CHARS),
  }
}

/** Stand-down reason recorded when the verdict itself could not be read. Port-only vocabulary. */
export const EVALUATION_FAILED_REASON = 'evaluation_failed'

export type GoalVerdictParse =
  | { readonly ok: true; readonly evaluation: GoalEvaluation }
  | {
      readonly ok: false
      readonly error: string
      /** Fail-closed substitute: unsatisfied + a non-continuable blocker ⇒ the loop stands down. */
      readonly evaluation: GoalEvaluation
      readonly standDownReason: typeof EVALUATION_FAILED_REASON
    }

/**
 * Tolerant wrapper around {@link parseGoalEvaluationResponse}.
 *
 * The original lets the `ValueError` escape into the worker, which logs it and continues without
 * an evaluation — i.e. the loop does not continue. The port makes that direction explicit: an
 * unreadable verdict becomes `missing_evidence` (not continuable, see `CONTINUABLE_GOAL_BLOCKERS`)
 * carrying the `evaluation_failed` stand-down reason, so a malformed model reply can never keep
 * the continuation loop alive.
 */
export function parseGoalVerdict(text: string): GoalVerdictParse {
  try {
    return { ok: true, evaluation: parseGoalEvaluationResponse(text) }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      error: detail,
      evaluation: {
        satisfied: false,
        blocker: 'missing_evidence',
        reason: normalizeEvaluationText(`Goal evaluator verdict could not be parsed: ${detail}`, MAX_GOAL_REASON_CHARS),
        evidence_summary: '',
      },
      standDownReason: EVALUATION_FAILED_REASON,
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Visible-evidence rendering (goal.py:200-239, 343-359)
// ---------------------------------------------------------------------------------------------

/** The port's message shape for evaluator evidence: only role + text are ever needed. */
export interface VisibleMessage {
  readonly role: 'user' | 'assistant'
  readonly text: string
}

/** goal.py:206-208 — true when at least one visible assistant reply carries text. */
export function hasVisibleAssistantEvidence(messages: readonly VisibleMessage[]): boolean {
  return messages.some((message) => message.role === 'assistant' && message.text.trim().length > 0)
}

/**
 * goal.py:226-239 — render the user-visible conversation evidence.
 *
 * Keeps the last {@link MAX_GOAL_CONVERSATION_MESSAGES} visible messages, drops empty ones, joins
 * with a blank line, then keeps only the trailing {@link MAX_GOAL_CONVERSATION_CHARS} characters.
 */
export function formatVisibleConversation(messages: readonly VisibleMessage[]): string {
  const lines: string[] = []
  for (const message of messages.slice(-MAX_GOAL_CONVERSATION_MESSAGES)) {
    const text = message.text.trim()
    if (text.length === 0) continue
    lines.push(`${message.role === 'user' ? 'User' : 'Assistant'}: ${text}`)
  }
  const conversation = lines.join('\n\n')
  return conversation.length > MAX_GOAL_CONVERSATION_CHARS ? conversation.slice(-MAX_GOAL_CONVERSATION_CHARS) : conversation
}

/**
 * goal.py:343-359 — SHA-256 of the latest visible assistant text, `''` when there is none.
 *
 * The no-progress breaker keys on this and NOT on the evaluator's free-text reason, which a model
 * rewords every turn and which therefore almost never repeats byte-for-byte.
 */
export function latestVisibleAssistantSignature(messages: readonly VisibleMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message === undefined || message.role !== 'assistant') continue
    const text = message.text.trim()
    if (text.length > 0) return evidenceSignatureOf(text)
  }
  return ''
}

/** SHA-256 hex of one piece of assistant evidence; empty text yields the empty signature. */
export function evidenceSignatureOf(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length === 0) return ''
  return createHash('sha256').update(trimmed, 'utf8').digest('hex')
}
