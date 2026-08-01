// Ported from backend/packages/harness/deerflow/agents/memory/backends/deermem/deermem/core/prompt.py
// @ 0950924 (format_memory_for_injection, _format_fact_line, _escape_summary, _select_fact_lines,
// _char_based_token_estimate) — structural translation.
//
// Preserved exactly:
//   * section order and wording: "User Context:" (Work / Personal / Current Focus), "History:"
//     (Recent / Earlier / Background), "Facts:" with `- [category | 0.95] content (avoid: ...)`;
//   * the 2000-token injection budget and the 500-token guaranteed sub-budget for `correction`
//     facts, which are selected first and placed at the FRONT so regular facts cannot evict them;
//   * strictly rank-ordered greedy selection — the loop STOPS at the first fact that would
//     exceed the budget, so a shorter lower-ranked fact never slips past a skipped higher-ranked
//     one (prompt.py:_select_fact_lines);
//   * the HTML-escape breakout defense (#4097): a stored fact containing `</memory>` must not be
//     able to close the trust zone. `quote=False` semantics — only `&`, `<`, `>` are escaped,
//     because these values land in element-text position, never in attribute values.
//
// Changed: token counting is ALWAYS the network-free CJK-aware character estimate
// (`memory.token_counting: char`). tiktoken is a Python BPE download that the port has no
// counterpart for, and upstream already treats the char estimate as a first-class mode whose
// only cost is a slightly conservative budget (config.py:87-105; AGENTS.md "Token counting").
import { HISTORY_SLOTS, USER_SLOTS } from './store.js';
/** `max_injection_tokens` (config.py:87-105; range 100-8000). */
export const DEFAULT_MAX_INJECTION_TOKENS = 2000;
/** `guaranteed_token_budget` (config.py:96-115; range 50-2000). */
export const DEFAULT_GUARANTEED_TOKEN_BUDGET = 500;
/** `guaranteed_categories` default (config.py:96-115). */
export const DEFAULT_GUARANTEED_CATEGORIES = ['correction'];
const FACTS_HEADER = 'Facts:\n';
/**
 * CJK-aware, network-free token estimate — ported from `prompt.py:_char_based_token_estimate`:
 *
 * ```python
 * cjk = sum(1 for ch in text
 *           if "一" <= ch <= "鿿"    # CJK Unified Ideographs
 *           or "぀" <= ch <= "ヿ"    # Hiragana + Katakana
 *           or "가" <= ch <= "힣")   # Hangul syllables
 * return (len(text) - cjk) // 4 + cjk // 2
 * ```
 *
 * Two details matter for byte-parity with the original:
 *   * `len(text)` in Python counts *code points*, not UTF-16 code units, so the port iterates
 *     with `for...of` (code points) rather than `.length`;
 *   * `//` is floor division. Both operands are non-negative here, so `Math.floor` is exact.
 */
export function estimateTokens(text) {
    let total = 0;
    let cjk = 0;
    for (const character of text) {
        total += 1;
        const code = character.codePointAt(0) ?? 0;
        if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3040 && code <= 0x30ff) || (code >= 0xac00 && code <= 0xd7a3))
            cjk += 1;
    }
    return Math.floor((total - cjk) / 4) + Math.floor(cjk / 2);
}
/**
 * `html.escape(value, quote=False)` — the exact three replacements, in the exact order
 * (`&` first, or the ampersands introduced by `<`/`>` would be double-escaped).
 */
export function escapeForMemoryBlock(value) {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function coerceConfidence(value) {
    if (typeof value === 'boolean' || typeof value !== 'number' || !Number.isFinite(value))
        return 0;
    return Math.max(0, Math.min(1, value));
}
/**
 * Render one fact line, or `null` when the fact is unusable.
 *
 * Ported from `prompt.py:_format_fact_line`, including the `(avoid: ...)` suffix that is
 * emitted only for `correction` facts carrying a non-empty `sourceError`.
 */
export function formatFactLine(fact) {
    if (typeof fact.content !== 'string')
        return null;
    const content = fact.content.trim();
    if (content === '')
        return null;
    const rawCategory = typeof fact.category === 'string' ? fact.category.trim() : '';
    const category = rawCategory === '' ? 'context' : rawCategory;
    const confidence = coerceConfidence(fact.confidence);
    const escapedContent = escapeForMemoryBlock(content);
    const escapedCategory = escapeForMemoryBlock(category);
    const prefix = `- [${escapedCategory} | ${confidence.toFixed(2)}] ${escapedContent}`;
    if (category === 'correction' && typeof fact.sourceError === 'string' && fact.sourceError.trim() !== '') {
        return `${prefix} (avoid: ${escapeForMemoryBlock(fact.sourceError.trim())})`;
    }
    return prefix;
}
/**
 * Greedy, strictly rank-ordered selection within a *line-only* budget.
 *
 * Header and inter-section separator costs are the caller's responsibility, exactly as in
 * `prompt.py:_select_fact_lines` — this helper is header-agnostic and stops at the first
 * over-budget fact rather than continuing to look for a smaller one.
 *
 * Accounting note (inherited from upstream's `token_counting: char` mode): the budget is
 * enforced against the SUM OF PER-LINE estimates, and the estimator floors twice per call, so
 * `estimateTokens(joined)` can sit slightly above that sum — bounded exactly by
 * `sum + 2 * (lines - 1)`, from `floor(x + y) <= floor(x) + floor(y) + 1` applied to both terms.
 * The overshoot is a couple of tokens on a 2000-token budget and is the price of the strict
 * rank-ordering guarantee; `injection.test.ts` pins both the invariant and the bound.
 */
function selectFactLines(ranked, tokenBudget) {
    const lines = [];
    let consumed = 0;
    for (const fact of ranked) {
        const formatted = formatFactLine(fact);
        if (formatted === null)
            continue;
        const lineText = lines.length > 0 ? `\n${formatted}` : formatted;
        const lineTokens = estimateTokens(lineText);
        if (consumed + lineTokens > tokenBudget)
            break;
        lines.push(formatted);
        consumed += lineTokens;
    }
    return { lines, consumed };
}
const USER_LABELS = {
    workContext: 'Work',
    personalContext: 'Personal',
    topOfMind: 'Current Focus',
};
const HISTORY_LABELS = {
    recentMonths: 'Recent',
    earlierContext: 'Earlier',
    longTermBackground: 'Background',
};
/**
 * Render the memory body injected into the `<memory>` trust zone.
 *
 * Returns `''` when there is nothing to inject (upstream returns `""`, and the caller then
 * emits no block at all rather than an empty one).
 */
export function formatMemoryForInjection(data, options = {}) {
    if (data === null || data === undefined)
        return '';
    const maxTokens = options.maxTokens ?? DEFAULT_MAX_INJECTION_TOKENS;
    const guaranteedTokenBudget = options.guaranteedTokenBudget ?? DEFAULT_GUARANTEED_TOKEN_BUDGET;
    const guaranteedCategories = new Set((options.guaranteedCategories ?? DEFAULT_GUARANTEED_CATEGORIES).map((category) => category.trim()).filter((category) => category !== ''));
    const sections = [];
    const userLines = [];
    for (const slot of USER_SLOTS) {
        const summary = data.user?.[slot]?.summary;
        if (typeof summary === 'string' && summary !== '')
            userLines.push(`${USER_LABELS[slot]}: ${escapeForMemoryBlock(summary)}`);
    }
    if (userLines.length > 0)
        sections.push(`User Context:\n${userLines.map((line) => `- ${line}`).join('\n')}`);
    const historyLines = [];
    for (const slot of HISTORY_SLOTS) {
        const summary = data.history?.[slot]?.summary;
        if (typeof summary === 'string' && summary !== '')
            historyLines.push(`${HISTORY_LABELS[slot]}: ${escapeForMemoryBlock(summary)}`);
    }
    if (historyLines.length > 0)
        sections.push(`History:\n${historyLines.map((line) => `- ${line}`).join('\n')}`);
    let guaranteedLineTokens = 0;
    let allFactLines = [];
    const facts = data.facts ?? [];
    if (facts.length > 0) {
        const baseText = sections.join('\n\n');
        const baseTokens = baseText === '' ? 0 : estimateTokens(baseText);
        const valid = facts.filter((fact) => typeof fact.content === 'string' && fact.content.trim() !== '');
        // Raw category, no `or "context"` default: a category-less legacy fact must never be
        // silently promoted into a guaranteed pool (prompt.py comment on `_category_match`).
        const matchesGuaranteed = (fact) => {
            if (guaranteedCategories.size === 0)
                return false;
            if (typeof fact.category !== 'string')
                return false;
            const category = fact.category.trim();
            return category !== '' && guaranteedCategories.has(category);
        };
        const byConfidenceDesc = (left, right) => coerceConfidence(right.confidence) - coerceConfidence(left.confidence);
        const guaranteed = guaranteedCategories.size === 0 ? [] : valid.filter(matchesGuaranteed).sort(byConfidenceDesc);
        const regular = (guaranteedCategories.size === 0 ? [...valid] : valid.filter((fact) => !matchesGuaranteed(fact))).sort(byConfidenceDesc);
        const headerCost = estimateTokens(FACTS_HEADER);
        let guaranteedLines = [];
        if (guaranteed.length > 0) {
            const selection = selectFactLines(guaranteed, guaranteedTokenBudget);
            guaranteedLines = selection.lines;
            guaranteedLineTokens = selection.consumed;
        }
        let regularLines = [];
        if (regular.length > 0) {
            const interGroupNewline = guaranteedLines.length > 0 ? estimateTokens('\n') : 0;
            const usedBeforeRegular = baseTokens + headerCost + guaranteedLineTokens + interGroupNewline;
            const regularBudget = maxTokens - usedBeforeRegular;
            if (regularBudget > 0)
                regularLines = selectFactLines(regular, regularBudget).lines;
        }
        allFactLines = [...guaranteedLines, ...regularLines];
        if (allFactLines.length > 0)
            sections.push(FACTS_HEADER + allFactLines.join('\n'));
    }
    if (sections.length === 0)
        return '';
    let result = sections.join('\n\n');
    // Structure-aware truncation: the Facts block is a PROTECTED SUFFIX, so guaranteed-category
    // facts can never be discarded by a prefix cut on overflow (prompt.py:~700-730).
    const effectiveLimit = maxTokens + guaranteedLineTokens;
    if (estimateTokens(result) > effectiveLimit) {
        const factsBlock = allFactLines.length > 0 ? FACTS_HEADER + allFactLines.join('\n') : '';
        const factsBlockTokens = factsBlock === '' ? 0 : estimateTokens(factsBlock);
        const separatorTokens = estimateTokens('\n\n');
        const budgetForNonFacts = Math.max(0, effectiveLimit - factsBlockTokens - (factsBlock === '' ? 0 : separatorTokens));
        const precedingSections = allFactLines.length > 0 ? sections.slice(0, -1) : sections;
        let preceding = precedingSections.join('\n\n');
        if (preceding !== '') {
            const precedingTokens = estimateTokens(preceding);
            if (precedingTokens > budgetForNonFacts) {
                const charsPerToken = preceding.length / Math.max(precedingTokens, 1);
                const targetChars = Math.trunc(budgetForNonFacts * charsPerToken * 0.95);
                preceding = `${preceding.slice(0, targetChars).replace(/\s+$/, '')}\n...`;
            }
            result = factsBlock === '' ? preceding : `${preceding}\n\n${factsBlock}`;
        }
        else {
            result = factsBlock;
        }
    }
    return result;
}
/**
 * Wrap the rendered body in the `<memory>` trust zone.
 *
 * Ported from `lead_agent/prompt.py:_get_memory_context`, which wraps the backend's text
 * verbatim in `<memory>\n…\n</memory>\n` and returns `''` when there is nothing to inject.
 */
export function buildMemoryBlock(data, options = {}) {
    const body = formatMemoryForInjection(data, options);
    if (body === '')
        return '';
    return `<memory>\n${body}\n</memory>\n`;
}
