// Ported from backend/packages/harness/deerflow/agents/middlewares/tool_result_meta.py @ 0950924
//   — mechanical TypeScript translation of `_ERROR_RULES` (43-82), `_UNKNOWN_ERROR` (84-88),
//   `_PARTIAL_MARKERS` (21-31), `_ERROR_SHELL_PHRASES` / `_STATUS_TITLE_FILLER` (105-135),
//   `_extract_json_error_text` (141-163), `_match_keyword` (166-171), `_classify_error_text`
//   (174-179), `_classify_error_shell` (182-215), `_as_status_line` (218-229), `_make_meta`
//   (232-240), `stamp_exception_meta` (243-255) and `normalize_tool_message` (258-304).
//   Behavioural spec: docs/claude-code-port/notes/middlewares.md §2.13.
//   Parity vectors: parity/baseline/tool_meta.json (38 normalize cases + 4 exception cases).
//
// SCOPE. This is the taxonomy only — the classifier that produced `deerflow_tool_meta`. The rest of
// ToolErrorHandlingMiddleware is either native or lives elsewhere:
//   - exception -> error-result conversion is Claude Code's own loop behaviour (a failing tool comes
//     back as a result, it never crashes the session), so the port never synthesizes the
//     `"Error: Tool '<name>' failed with ..."` string; `stampExceptionMeta` still exists because the
//     baseline froze four vectors for it and because a caller with an exception string in hand
//     (the deep-run wrapper) can reach the same classification;
//   - `skill_context_entry` stamping on skill-file reads is the skill-context lane's, not M7's.
//
// The keyword tables are model-visible policy in effect (they decide what guidance the model is
// told to follow next), so every string here is verbatim and the ORDER of `ERROR_RULES` is
// load-bearing: first match wins, which is why `permission` sits above `no_results`/`not_found` and
// why `no results` cannot be reclassified as `not_found`.

/** `TOOL_META_KEY` — the additional_kwargs key the original stamped. */
export const TOOL_META_KEY = 'deerflow_tool_meta'

/** `_ERROR_PREFIX` — the tool-return convention for a model-visible error. */
export const ERROR_PREFIX = 'Error:'

export type ToolResultStatus = 'success' | 'error' | 'partial_success'
export type RecommendedNextAction = 'continue' | 'rewrite_query' | 'try_alternative' | 'summarize' | 'stop'
export type MetaSource = 'exception' | 'tool_return' | 'content_analysis' | 'progress_middleware'

/** Verbatim `ToolResultMeta`, serialized as the original stamped it. */
export interface ToolResultMeta {
  readonly status: ToolResultStatus
  readonly error_type: string | null
  readonly recoverable_by_model: boolean
  readonly recommended_next_action: RecommendedNextAction
  readonly source: MetaSource
}

/** The classified half of a meta: what `_ERROR_RULES` entries carry. */
interface ErrorAttributes {
  readonly error_type: string
  readonly recoverable_by_model: boolean
  readonly recommended_next_action: RecommendedNextAction
}

/** `_PARTIAL_MARKERS`, verbatim and in order (order is cosmetic — the check is `any`). */
export const PARTIAL_MARKERS = [
  'partial results',
  'limited results',
  'truncated',
  'results may be incomplete',
  // Tools returning status="success" with a no-results body must still be caught, so the model is
  // prompted to try a different query rather than treating emptiness as an answer.
  'no results found',
  'no content found',
  'no images found',
] as const

/** `_ERROR_RULES`, verbatim. FIRST MATCH WINS — the order is part of the contract. */
export const ERROR_RULES: readonly (readonly [readonly string[], ErrorAttributes])[] = [
  [
    ['401', '403', 'unauthorized', 'authentication', 'invalid api key'],
    { error_type: 'auth', recoverable_by_model: false, recommended_next_action: 'stop' },
  ],
  [
    ['rate limit', 'rate limited', 'rate_limit'],
    { error_type: 'rate_limited', recoverable_by_model: false, recommended_next_action: 'summarize' },
  ],
  [
    ['timeout', 'timed out', 'connection', 'network error', 'temporarily unavailable'],
    { error_type: 'transient', recoverable_by_model: false, recommended_next_action: 'try_alternative' },
  ],
  [
    ['not configured', 'not installed', 'missing required', 'disabled', 'no api key'],
    { error_type: 'config', recoverable_by_model: false, recommended_next_action: 'stop' },
  ],
  [
    ['permission denied', 'access denied', 'path traversal', 'forbidden'],
    { error_type: 'permission', recoverable_by_model: true, recommended_next_action: 'try_alternative' },
  ],
  [
    ['no results found', 'no content found', 'no images found', 'no results'],
    { error_type: 'no_results', recoverable_by_model: true, recommended_next_action: 'rewrite_query' },
  ],
  [
    ['not found', 'no such file', 'does not exist', '404'],
    { error_type: 'not_found', recoverable_by_model: true, recommended_next_action: 'rewrite_query' },
  ],
  [
    ['unexpected error', 'internal error', '500'],
    { error_type: 'internal', recoverable_by_model: false, recommended_next_action: 'stop' },
  ],
]

/** `_UNKNOWN_ERROR` — the fallback category. */
export const UNKNOWN_ERROR: ErrorAttributes = {
  error_type: 'unknown',
  recoverable_by_model: true,
  recommended_next_action: 'try_alternative',
}

/**
 * `_PAGE_CONTENT_TOOL_NAMES` — tools whose content is a *rendered remote page* rather than the
 * tool's own message. Name-based on purpose: a short "not found" line is legitimate output from
 * many other tools, so the error-shell rule must not apply to them.
 */
export const PAGE_CONTENT_TOOL_NAMES: ReadonlySet<string> = new Set(['web_fetch'])

/** `_ERROR_SHELL_PHRASES` — RFC 9110 reason phrases mapped onto the `_ERROR_RULES` category. */
export const ERROR_SHELL_PHRASES: Readonly<Record<string, string>> = {
  unauthorized: 'auth',
  'proxy authentication required': 'auth',
  forbidden: 'permission',
  'access denied': 'permission',
  'permission denied': 'permission',
  'not found': 'not_found',
  'too many requests': 'rate_limited',
  'internal server error': 'internal',
  'not implemented': 'internal',
  'bad gateway': 'transient',
  'service unavailable': 'transient',
  'service temporarily unavailable': 'transient',
  'gateway timeout': 'transient',
}

/** `_STATUS_TITLE_FILLER` — generic subject nouns servers prefix onto a reason phrase. */
export const STATUS_TITLE_FILLER: ReadonlySet<string> = new Set([
  'http',
  'error',
  'page',
  'the',
  'file',
  'or',
  'directory',
  'url',
  'resource',
])

/** `_SEMANTIC_ZERO_ERROR_STRINGS` — `{"error": "none"}` means success, not an error. */
export const SEMANTIC_ZERO_ERROR_STRINGS: ReadonlySet<string> = new Set([
  'none',
  'null',
  'false',
  'no',
  'ok',
  'success',
  'n/a',
  '',
])

/** `_ATTRS_BY_ERROR_TYPE` — derived, never duplicated, so a shell cannot drift from its category. */
const ATTRS_BY_ERROR_TYPE: Readonly<Record<string, ErrorAttributes>> = Object.fromEntries(
  ERROR_RULES.map(([, attributes]) => [attributes.error_type, attributes]),
)

import { pythonJsonDumps } from './python-json.js'

/**
 * `_match_keyword` — bare numeric codes are word-boundary anchored so `"took 500ms"` is not an
 * internal error and `"user_id: 4041"` is not a 404.
 */
function matchKeyword(keyword: string, lowered: string): boolean {
  if (/^\d+$/.test(keyword)) return new RegExp(`\\b${keyword}\\b`).test(lowered)
  return lowered.includes(keyword)
}

/** `_classify_error_text` — first matching rule wins, else `unknown`. */
export function classifyErrorText(text: string): ErrorAttributes {
  const lowered = text.toLowerCase()
  for (const [keywords, attributes] of ERROR_RULES) {
    if (keywords.some((keyword) => matchKeyword(keyword, lowered))) return attributes
  }
  return UNKNOWN_ERROR
}

/** Python `json.loads` on a content string, returning `undefined` when it is not JSON at all. */
function parseJson(content: string): unknown {
  try {
    return JSON.parse(content)
  } catch {
    return undefined
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * `_extract_json_error_text` — the error string from a JSON-wrapped error, or `null`.
 *
 * Returns `null` for a falsy `error` and for the sentinel strings that conventionally mean "no
 * error", so a tool returning `{"error": "none", "results": [...]}` on success is not misclassified.
 * A non-string value is JSON-dumped (`{"error": 404}` -> `"404"`) so the classifier sees a
 * predictable format instead of a language-specific repr.
 */
export function extractJsonErrorText(content: string): string | null {
  const data = parseJson(content)
  if (data === undefined) return null
  const error = isJsonObject(data) ? data['error'] : null
  // Python truthiness: None, "", 0, False, [], {} are all "no error".
  if (error === null || error === undefined || error === false || error === 0 || error === '') return null
  if (Array.isArray(error) && error.length === 0) return null
  if (isJsonObject(error) && Object.keys(error).length === 0) return null
  if (typeof error === 'string') {
    return SEMANTIC_ZERO_ERROR_STRINGS.has(error.toLowerCase().trim()) ? null : error
  }
  return pythonJsonDumps(error)
}

/**
 * `_as_status_line` — reduce a page title to its bare reason phrase, or `null` if it carries content.
 *
 * "404 Not Found" -> "not found"; "404 - File or directory not found." -> "not found";
 * "404 Ways to Cook Rice" -> "ways to cook rice" (words survive, so it is a document, not a shell).
 */
export function asStatusLine(title: string): string | null {
  let words = title
    .toLowerCase()
    .replace(/[^0-9a-z]+/g, ' ')
    .split(' ')
    .filter((word) => word !== '')

  while (words.length > 0) {
    const head = words[0] as string
    const isStatusCode = head.length === 3 && /^\d{3}$/.test(head) && Number(head) >= 400 && Number(head) <= 599
    if (!STATUS_TITLE_FILLER.has(head) && !isStatusCode) break
    words = words.slice(1)
  }
  const phrase = words.join(' ')
  return phrase === '' ? null : phrase
}

/**
 * `_classify_error_shell` — category attributes when a fetched page IS an HTTP error page.
 *
 * The signal is the extracted title, matched by EQUALITY after normalization, never substring: a
 * document merely *about* a status keeps its other words and is rejected. Content length plays no
 * part (measured against real error pages it does not separate).
 */
export function classifyErrorShell(toolName: string, content: string): ErrorAttributes | null {
  if (!PAGE_CONTENT_TOOL_NAMES.has(toolName)) return null
  const title = content.split('\n').find((line) => line.trim() !== '') ?? ''
  const phrase = asStatusLine(title.replace(/^#+/, '').trim())
  const errorType = phrase === null ? undefined : ERROR_SHELL_PHRASES[phrase]
  if (errorType === undefined) return null
  return ATTRS_BY_ERROR_TYPE[errorType] ?? null
}

/** `_make_meta`. */
function makeMeta(
  status: ToolResultStatus,
  source: MetaSource,
  attributes: Partial<ErrorAttributes> & { recommended_next_action?: RecommendedNextAction } = {},
): ToolResultMeta {
  return {
    status,
    error_type: attributes.error_type ?? null,
    recoverable_by_model: attributes.recoverable_by_model ?? true,
    recommended_next_action: attributes.recommended_next_action ?? 'continue',
    source,
  }
}

/** One tool result as the classifier sees it — the ToolMessage fields it actually read. */
export interface ToolResultInput {
  /** `msg.name`. Only `web_fetch` unlocks the error-shell rule. */
  readonly toolName: string
  /** `msg.content`; a non-string content classified as `""`, exactly as the original did. */
  readonly content: unknown
  /** `msg.status`. */
  readonly status: 'success' | 'error'
  /** An already-stamped `deerflow_tool_meta`, which the original always preserves. */
  readonly preExistingMeta?: ToolResultMeta | null
}

/**
 * `normalize_tool_message` — attach `deerflow_tool_meta` to a tool result.
 *
 * The branch ORDER is the contract (see notes/middlewares.md §2.13):
 *   0. a pre-existing stamp is authoritative and returned untouched;
 *   1. `status=="error"` without the `"Error:"` prefix — JSON `error` field first, so keywords in
 *      unrelated fields (a `query` reading "unauthorized") cannot classify the result; content that
 *      IS a JSON object with no `error` key is deliberately NOT keyword-classified, because
 *      `{"user_id": 401}` would otherwise hard-block the tool as an auth failure;
 *   2. `"Error:"`-prefixed content, classified on the text after the prefix;
 *   3. a JSON `error` field inside a success-status result;
 *   4. the `web_fetch` error-shell rule;
 *   5. partial-success markers;
 *   6. success.
 */
export function normalizeToolResult(input: ToolResultInput): ToolResultMeta {
  if (input.preExistingMeta !== null && input.preExistingMeta !== undefined) return input.preExistingMeta

  const content = typeof input.content === 'string' ? input.content : ''
  const contentLower = content.toLowerCase()

  if (input.status === 'error' && !content.startsWith(ERROR_PREFIX)) {
    const jsonError = extractJsonErrorText(content)
    if (jsonError !== null) return makeMeta('error', 'tool_return', classifyErrorText(jsonError))
    const isJsonDict = isJsonObject(parseJson(content))
    return makeMeta('error', 'tool_return', isJsonDict ? UNKNOWN_ERROR : classifyErrorText(content))
  }

  if (content.startsWith(ERROR_PREFIX)) {
    return makeMeta('error', 'tool_return', classifyErrorText(content.slice(ERROR_PREFIX.length)))
  }

  const jsonError = extractJsonErrorText(content)
  if (jsonError !== null) return makeMeta('error', 'tool_return', classifyErrorText(jsonError))

  const shellAttributes = classifyErrorShell(input.toolName, content)
  if (shellAttributes !== null) return makeMeta('error', 'content_analysis', shellAttributes)

  if (PARTIAL_MARKERS.some((marker) => contentLower.includes(marker))) {
    return makeMeta('partial_success', 'content_analysis', { recommended_next_action: 'rewrite_query' })
  }

  return makeMeta('success', 'content_analysis')
}

/**
 * `stamp_exception_meta` — classification from an exception string.
 *
 * Unlike `normalize_tool_message` this ALWAYS overwrites a pre-existing stamp: exception-derived
 * classification is more authoritative than a tool's own return-time stamp.
 */
export function stampExceptionMeta(excInfo: string): ToolResultMeta {
  return makeMeta('error', 'exception', classifyErrorText(excInfo))
}

/** Whether a meta describes a result the model should be told something about. */
export function isProblemMeta(meta: ToolResultMeta): boolean {
  return meta.status === 'error' || meta.status === 'partial_success'
}
