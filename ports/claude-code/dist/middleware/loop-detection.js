// Ported from backend/packages/harness/deerflow/agents/middlewares/loop_detection_middleware.py
//   @ 0950924 — mechanical TypeScript translation of `_normalize_tool_call_args` (86-109),
//   `_stable_tool_key` (112-152), `_hash_tool_calls` (155-173), the four message templates
//   (176-184) and `LoopDetectionMiddleware._track_and_check` (408-542).
//   Thresholds from config/loop_detection_config.py (defaults 3 / 5 / 20 / 30 / 50, enabled=True).
//   Behavioural spec: docs/claude-code-port/notes/middlewares.md §2.28.
//   Parity vectors: parity/baseline/loop_detection.json (6 scenarios / 99 steps, 9 hash relations).
//
// WHAT IS AND IS NOT HERE. This module is the detector only: a pure, serializable state machine.
// Everything the original did *with* a detection — queueing a warning for the next model call,
// rewriting the last AIMessage, stripping `tool_calls`, `consume_stop_reason` — belongs to the
// enforcement point, which in the port is a PreToolUse hook (src/hooks/loop-guard.ts). Keeping the
// split means the algorithm is testable against the baseline vectors with no I/O at all.
//
// DELIBERATE OMISSIONS from the original class, each with its reason:
//   - `threading.Lock`: a hook is a single-threaded short-lived process; the state file's `rev`
//     compare-and-set in src/state/atomic-io.ts is the concurrency control instead.
//   - LRU eviction over `max_tracked_threads` (100) and the pending-warning key cap: the original
//     holds every thread's window in one long-lived process. The port stores one window per thread
//     in that thread's own state directory, so there is no shared map to bound.
//   - The pending-warning queue (`_MAX_PENDING_WARNINGS_PER_RUN`, drain-at-next-model-call): it
//     exists purely to dodge the OpenAI/Anthropic message-pairing rules described in the original's
//     module docstring. A hook injects `additionalContext` at the call itself, so there is nothing
//     to defer and nothing to pair.
// The per-tool `tool_freq_overrides` map IS carried (the config field exists) even though the
// original ships it empty and the baseline explicitly skipped extracting override vectors.
import { createHash } from 'node:crypto';
import { pythonInt, pythonJsonDumps } from './python-json.js';
/** `_DEFAULT_WARN_THRESHOLD` — identical call sets before a warning. */
export const DEFAULT_WARN_THRESHOLD = 3;
/** `_DEFAULT_HARD_LIMIT` — identical call sets before the forced stop. */
export const DEFAULT_HARD_LIMIT = 5;
/** `_DEFAULT_WINDOW_SIZE` — sliding window of recent call-set hashes. */
export const DEFAULT_WINDOW_SIZE = 20;
/** `_DEFAULT_TOOL_FREQ_WARN` — same-tool-type calls in the frequency window before a warning. */
export const DEFAULT_TOOL_FREQ_WARN = 30;
/** `_DEFAULT_TOOL_FREQ_HARD_LIMIT` — same-tool-type calls before the forced stop. */
export const DEFAULT_TOOL_FREQ_HARD_LIMIT = 50;
/** `bucket_size` in `_stable_tool_key`: ranged reads inside one 200-line bucket collapse. */
export const READ_FILE_BUCKET_SIZE = 200;
/** Salient argument fields, in the original's order (`sort_keys` makes the order cosmetic). */
export const SALIENT_ARG_FIELDS = ['path', 'url', 'query', 'command', 'pattern', 'glob', 'cmd'];
/** Verbatim `_WARNING_MSG`. Model-facing text — do not reword. */
export const LOOP_WARNING_MESSAGE = '[LOOP DETECTED] You are repeating the same tool calls. Stop calling tools and produce your final answer now. If you cannot complete the task, summarize what you accomplished so far.';
/** Verbatim `_HARD_STOP_MSG`. */
export const LOOP_HARD_STOP_MESSAGE = '[FORCED STOP] Repeated tool calls exceeded the safety limit. Producing final answer with results collected so far.';
/** Verbatim `_TOOL_FREQ_WARNING_MSG.format(...)`. */
export function toolFrequencyWarningMessage(toolName, count) {
    return `[LOOP DETECTED] You have called ${toolName} ${count} times without producing a final answer. Stop calling tools and produce your final answer now. If you cannot complete the task, summarize what you accomplished so far.`;
}
/** Verbatim `_TOOL_FREQ_HARD_STOP_MSG.format(...)`. */
export function toolFrequencyHardStopMessage(toolName, count) {
    return `[FORCED STOP] Tool ${toolName} called ${count} times — exceeded the per-tool safety limit. Producing final answer with results collected so far.`;
}
/**
 * The two newlines `_append_text` puts between the AIMessage's existing content and the hard-stop
 * text. The baseline records `injected_message` for a hard stop as the *rewritten message content*,
 * and the original content in those runs was empty — hence the leading `"\n\n"` in the vectors.
 * Exported so the parity test asserts the relation instead of hard-coding it.
 */
export const HARD_STOP_CONTENT_SEPARATOR = '\n\n';
/** Stop reason the original records for the run that tripped the hard stop. */
export const LOOP_STOP_REASON = 'loop_capped';
/** `LoopDetectionConfig()` field defaults, verbatim. */
export const DEFAULT_LOOP_DETECTION_CONFIG = {
    warnThreshold: DEFAULT_WARN_THRESHOLD,
    hardLimit: DEFAULT_HARD_LIMIT,
    windowSize: DEFAULT_WINDOW_SIZE,
    toolFreqWarn: DEFAULT_TOOL_FREQ_WARN,
    toolFreqHardLimit: DEFAULT_TOOL_FREQ_HARD_LIMIT,
    toolFreqOverrides: {},
};
/**
 * `_tool_freq_window` — `max(window_size, tool_freq_hard_limit, *override hard limits)`.
 *
 * The original's comment is load-bearing: a windowed count can never exceed the deque length, so
 * sizing the deque below the largest hard limit would make the hard-stop branch dead code. Warn
 * thresholds are deliberately excluded from the max.
 */
export function toolFrequencyWindowSize(config) {
    let size = Math.max(config.windowSize, config.toolFreqHardLimit);
    for (const override of Object.values(config.toolFreqOverrides)) {
        if (override[1] > size)
            size = override[1];
    }
    return size;
}
/** A thread the detector has never seen. */
export const EMPTY_LOOP_DETECTION_STATE = {
    hashWindow: [],
    warnedHashes: [],
    toolNameWindow: [],
    toolFreqWarned: [],
};
/**
 * `_normalize_tool_call_args` — coerce provider-shaped args to `(dict, fallback_key | null)`.
 *
 * A JSON string that parses to a dict IS the dict (so a provider that stringifies its arguments
 * hashes identically to one that does not — the `stringified_dict_args_match_dict_args` relation).
 */
export function normalizeToolCallArgs(raw) {
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
        return [raw, null];
    }
    if (typeof raw === 'string') {
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch {
            return [{}, raw];
        }
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            return [parsed, null];
        }
        return [{}, pythonJsonDumps(parsed)];
    }
    if (raw === null || raw === undefined)
        return [{}, null];
    return [{}, pythonJsonDumps(raw)];
}
/** Python truthiness for the `args.get("path") or ""` guard: `0`, `""`, `false` all fall through. */
function pythonTruthyString(value) {
    if (value === undefined || value === null || value === false || value === 0 || value === '')
        return '';
    return typeof value === 'string' ? value : String(value);
}
/**
 * `_stable_tool_key` — a key from salient args, not raw args, so incidental noise cannot hide a loop
 * and iteration on real content cannot fake one.
 *
 *   - `read_file`: `path:{bucket_start}-{bucket_end}` over 200-line buckets, ranges sorted first, so
 *     re-reading lines 1-100 and 100-1 of the same file is one call, and lines 1-100 vs 900-1000
 *     are two.
 *   - `write_file` / `str_replace`: the FULL args, because the same path written with different
 *     content is legitimate iteration.
 *   - everything else: only `path/url/query/command/pattern/glob/cmd`, falling back to full args.
 */
export function stableToolKey(name, args, fallbackKey) {
    if (name === 'read_file' && fallbackKey === null) {
        const path = pythonTruthyString(args['path']);
        const rawStart = args['start_line'];
        const rawEnd = args['end_line'];
        let startLine = rawStart === undefined || rawStart === null ? 1 : (pythonInt(rawStart) ?? 1);
        let endLine = rawEnd === undefined || rawEnd === null ? startLine : (pythonInt(rawEnd) ?? startLine);
        if (startLine > endLine)
            [startLine, endLine] = [endLine, startLine];
        const bucketStart = Math.floor((Math.max(startLine, 1) - 1) / READ_FILE_BUCKET_SIZE);
        const bucketEnd = Math.floor((Math.max(endLine, 1) - 1) / READ_FILE_BUCKET_SIZE);
        return `${path}:${bucketStart}-${bucketEnd}`;
    }
    if (name === 'write_file' || name === 'str_replace') {
        return fallbackKey !== null ? fallbackKey : pythonJsonDumps(args);
    }
    const stableArgs = {};
    let hasStable = false;
    for (const field of SALIENT_ARG_FIELDS) {
        const value = args[field];
        if (value !== undefined && value !== null) {
            stableArgs[field] = value;
            hasStable = true;
        }
    }
    if (hasStable)
        return pythonJsonDumps(stableArgs);
    if (fallbackKey !== null)
        return fallbackKey;
    return pythonJsonDumps(args);
}
/**
 * `_hash_tool_calls` — order-independent md5 of a call multiset, truncated to 12 hex chars.
 *
 * The sort is what makes it a multiset hash: two responses that issue the same calls in different
 * order accumulate on one counter (`order_independent` relation).
 */
export function hashToolCalls(toolCalls) {
    const normalized = [];
    for (const call of toolCalls) {
        const name = typeof call.name === 'string' ? call.name : '';
        const [args, fallbackKey] = normalizeToolCallArgs(call.args === undefined ? {} : call.args);
        normalized.push(`${name}:${stableToolKey(name, args, fallbackKey)}`);
    }
    normalized.sort();
    return createHash('md5').update(pythonJsonDumps(normalized), 'utf8').digest('hex').slice(0, 12);
}
function countOccurrences(values) {
    const counts = new Map();
    for (const value of values)
        counts.set(value, (counts.get(value) ?? 0) + 1);
    return counts;
}
function toCountsRecord(counts) {
    const record = {};
    for (const [key, value] of counts)
        record[key] = value;
    return record;
}
/**
 * One detection step: `_track_and_check` for a single AI response's tool calls.
 *
 * Layer ordering is behaviour, not style. Layer 1 returns *before* Layer 2 runs, so a step that
 * warns or hard-stops on the hash never increments the per-tool frequency counters — the baseline
 * records exactly that (`identical_calls_warn3_hard5` step 3 warns with `grep` still at 2).
 * A hash whose count is already at the warn threshold but was already warned about falls THROUGH to
 * Layer 2 rather than returning, which is how a long identical run keeps feeding the frequency layer.
 */
export function step(state, toolCalls, config = DEFAULT_LOOP_DETECTION_CONFIG) {
    const unchanged = () => ({
        state,
        decision: 'none',
        message: null,
        stopReason: null,
        callHash: null,
        hashCount: 0,
        toolFrequencyCounts: toCountsRecord(countOccurrences(state.toolNameWindow)),
    });
    if (toolCalls.length === 0)
        return unchanged();
    const callHash = hashToolCalls(toolCalls);
    // --- window bookkeeping (runs before either layer, exactly as in the original) ---
    let hashWindow = [...state.hashWindow, callHash];
    if (hashWindow.length > config.windowSize)
        hashWindow = hashWindow.slice(-config.windowSize);
    // `warned_hashes.intersection_update(history)`: a hash that decayed out of the window may warn
    // again if the model returns to it.
    const inWindow = new Set(hashWindow);
    const warnedHashes = state.warnedHashes.filter((hash) => inWindow.has(hash));
    const hashCount = hashWindow.filter((hash) => hash === callHash).length;
    const toolNameWindow = [...state.toolNameWindow];
    const toolNameCounts = countOccurrences(toolNameWindow);
    const toolFreqWarned = new Set(state.toolFreqWarned);
    const settle = (decision, message, extra = {}) => ({
        state: {
            hashWindow,
            warnedHashes: extra.warned ?? warnedHashes,
            toolNameWindow,
            toolFreqWarned: [...(extra.freqWarned ?? toolFreqWarned)],
        },
        decision,
        message,
        stopReason: decision === 'hard_stop' ? LOOP_STOP_REASON : null,
        callHash,
        hashCount,
        toolFrequencyCounts: toCountsRecord(toolNameCounts),
    });
    // --- Layer 1: hash-based (identical call sets) ---
    if (hashCount >= config.hardLimit) {
        return settle('hard_stop', LOOP_HARD_STOP_MESSAGE);
    }
    if (hashCount >= config.warnThreshold && !warnedHashes.includes(callHash)) {
        return settle('warn', LOOP_WARNING_MESSAGE, { warned: [...warnedHashes, callHash] });
    }
    // --- Layer 2: per-tool-type frequency (windowed) ---
    const freqWindow = toolFrequencyWindowSize(config);
    for (const call of toolCalls) {
        const name = typeof call.name === 'string' ? call.name : '';
        if (name === '')
            continue;
        toolNameWindow.push(name);
        toolNameCounts.set(name, (toolNameCounts.get(name) ?? 0) + 1);
        while (toolNameWindow.length > freqWindow) {
            const evicted = toolNameWindow.shift();
            const remaining = (toolNameCounts.get(evicted) ?? 0) - 1;
            if (remaining <= 0)
                toolNameCounts.delete(evicted);
            else
                toolNameCounts.set(evicted, remaining);
        }
        const freqCount = toolNameCounts.get(name) ?? 0;
        const override = config.toolFreqOverrides[name];
        const effectiveWarn = override ? override[0] : config.toolFreqWarn;
        const effectiveHard = override ? override[1] : config.toolFreqHardLimit;
        if (freqCount >= effectiveHard) {
            return settle('hard_stop', toolFrequencyHardStopMessage(name, freqCount));
        }
        if (freqCount >= effectiveWarn) {
            if (!toolFreqWarned.has(name)) {
                toolFreqWarned.add(name);
                return settle('warn', toolFrequencyWarningMessage(name, freqCount));
            }
        }
        else {
            // The windowed count decayed below warn: allow a future burst to warn again.
            toolFreqWarned.delete(name);
        }
    }
    return settle('none', null);
}
/**
 * Rebuild a state from an untrusted JSON payload (a state file this build did not write, or a
 * truncated one). Anything unrecognized degrades to empty rather than throwing: a loop guard that
 * crashes on its own state file would wedge every tool call.
 */
export function parseLoopDetectionState(value) {
    if (typeof value !== 'object' || value === null)
        return EMPTY_LOOP_DETECTION_STATE;
    const record = value;
    const strings = (key) => {
        const raw = record[key];
        return Array.isArray(raw) ? raw.filter((item) => typeof item === 'string') : [];
    };
    return {
        hashWindow: strings('hashWindow'),
        warnedHashes: strings('warnedHashes'),
        toolNameWindow: strings('toolNameWindow'),
        toolFreqWarned: strings('toolFreqWarned'),
    };
}
