// Canonical serializer reproducing CPython's `json.dumps(value, sort_keys=True, default=str)`
// byte-for-byte, plus `posixpath.normpath`.
//
// WHY THIS EXISTS. Two ported middlewares hash or key on a *serialized* value:
//   - loop_detection_middleware.py `_hash_tool_calls` md5s `json.dumps(normalized, sort_keys=True)`
//     [lines 155-173] and `_stable_tool_key` json-dumps the salient-arg dict [lines 112-152];
//   - tool_result_meta.py `_extract_json_error_text` json-dumps a non-string `error` value before
//     classifying it [lines 145-152].
// `JSON.stringify` is NOT a drop-in: it emits `{"a":1,"b":2}` where Python emits `{"a": 1, "b": 2}`
// (default separators `', '` / `': '`) and it emits raw non-ASCII where Python's default
// `ensure_ascii=True` emits `\uXXXX`. A one-byte difference changes the md5 and every recorded hash
// vector would have to be re-derived. Reproducing the exact bytes instead lets the port assert the
// Python md5 LITERALS in `parity/baseline/loop_detection.json`, not merely the equal/not_equal
// relations the baseline README settles for — 117/117 recorded hashes match.
//
// KNOWN LIMITS (none reachable from the ported call sites, all recorded honestly):
//   1. Non-integer numbers use JS `Number.prototype.toString`; Python uses `repr(float)`. They agree
//      on every value with a short round-trip decimal form but not on all (e.g. Python writes `1.0`
//      where JS writes `1`). Tool-call arguments in the vectors are strings and integers only.
//   2. Key sorting uses JS UTF-16 code-unit order; Python sorts by code point. These differ only
//      when a key contains an astral-plane character.
//   3. `json.loads` accepts `NaN`/`Infinity` literals; `JSON.parse` rejects them. The callers treat
//      a parse failure as "not JSON", which is the same branch Python would reach for real payloads.

/** Escape one string exactly as `json.dumps(..., ensure_ascii=True)` does. */
function pythonJsonString(value: string): string {
  let out = '"'
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] as string
    const code = value.charCodeAt(index)
    if (char === '"') out += '\\"'
    else if (char === '\\') out += '\\\\'
    else if (char === '\n') out += '\\n'
    else if (char === '\r') out += '\\r'
    else if (char === '\t') out += '\\t'
    else if (char === '\b') out += '\\b'
    else if (char === '\f') out += '\\f'
    else if (code < 0x20 || code > 0x7e) out += `\\u${code.toString(16).padStart(4, '0')}`
    else out += char
  }
  return `${out}"`
}

/**
 * Serialize `value` the way `json.dumps(value, sort_keys=True, default=str)` would.
 *
 * `default=str` is reproduced for the shapes the callers can actually receive: `undefined` and
 * functions become `null` (Python would never see them), everything else follows JSON.
 */
export function pythonJsonDumps(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null'
  if (typeof value === 'string') return pythonJsonString(value)
  if (Array.isArray(value)) return `[${value.map(pythonJsonDumps).join(', ')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    return `{${keys.map((key) => `${pythonJsonString(key)}: ${pythonJsonDumps(record[key])}`).join(', ')}}`
  }
  return pythonJsonString(String(value))
}

/**
 * `int(value)` with Python's failure modes surfaced as `null`.
 *
 * `_stable_tool_key` wraps its coercions in `except (TypeError, ValueError)`, so the caller needs to
 * distinguish "coerced" from "raised" — a bare `Number()` would silently turn `"abc"` into `NaN`
 * and `null` into `0`, both of which Python rejects.
 */
export function pythonInt(value: unknown): number | null {
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return /^[+-]?\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : null
  }
  return null
}

/**
 * `posixpath.normpath` — a pure lexical normalization, symlink-unaware, exactly like the original.
 *
 * Node's `path.posix.normalize` is NOT equivalent (it keeps a trailing slash), and the read-mark
 * store keys on this value, so a mismatch would silently make every mark unfindable.
 */
export function posixNormpath(path: string): string {
  if (path === '') return '.'
  let initialSlashes = path.startsWith('/') ? 1 : 0
  // POSIX leaves exactly two leading slashes alone; three or more collapse to one.
  if (initialSlashes === 1 && path.startsWith('//') && !path.startsWith('///')) initialSlashes = 2

  const components: string[] = []
  for (const component of path.split('/')) {
    if (component === '' || component === '.') continue
    if (
      component !== '..' ||
      (initialSlashes === 0 && components.length === 0) ||
      (components.length > 0 && components[components.length - 1] === '..')
    ) {
      components.push(component)
    } else if (components.length > 0) {
      components.pop()
    }
  }

  const joined = '/'.repeat(initialSlashes) + components.join('/')
  return joined === '' ? '.' : joined
}
