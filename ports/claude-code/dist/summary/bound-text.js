// Ported from backend/packages/harness/deerflow/agents/middlewares/summarization_middleware.py:_bound_text
//   (lines 342-355) @ 0950924 — mechanical TypeScript translation.
//
// The original carries three byte-identical copies of this helper
// (summarization_middleware.py:342-355, durable_context_middleware.py:48-60,
// delegation_ledger.py:33-46). The port keeps ONE, because three copies of the same
// truncation rule is exactly how a rule drifts. Every consumer imports from here.
//
// "Deterministic head/tail truncation. This is not an LLM summary." — the original's own
// docstring, and the property the port depends on for reproducible digests.
/**
 * Truncate `text` to at most `cap` characters, keeping two thirds of the head and the
 * remainder of the tail around a `\n...\n` marker.
 *
 * Degrades to a plain head slice when the cap cannot hold the marker plus a tail character.
 */
export function boundText(text, cap) {
    if (text.length <= cap)
        return text;
    if (cap <= 0)
        return '';
    const head = Math.floor((cap * 2) / 3);
    const omittedMarker = '\n...\n';
    if (cap <= omittedMarker.length)
        return text.slice(0, cap);
    const tail = Math.max(0, cap - head - omittedMarker.length);
    if (tail === 0)
        return text.slice(0, cap);
    return `${text.slice(0, head)}${omittedMarker}${text.slice(text.length - tail)}`;
}
