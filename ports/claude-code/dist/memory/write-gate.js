// Ported from backend/packages/harness/deerflow/agents/memory/backends/deermem/deermem/core/updater.py:_apply_updates
// @ 0950924 — structural translation of the *deterministic extraction gate*, the piece
// notes/skills-and-memory.md §4 calls out as policy rather than infrastructure:
//
//   "middleware-extracted writes pass a deterministic scope gate — only scope=user +
//    durability=durable + authority=descriptive facts and wholly user-scoped descriptive
//    summaries are accepted; labels are evaluated but not persisted; task/project removals
//    fail closed; an un-migrated custom prompt makes the fail-closed gate reject every write"
//
// This module is pure: no filesystem, no clock, no randomness. It takes the extractor's
// proposed-updates JSON plus the current fact inventory and returns exactly what may be
// persisted, so the LLM never writes to memory directly (see skills/memory/SKILL.md).
//
// Defaults are the cited DeerMemConfig values (config.py:87-175, mirrored in
// notes/skills-and-memory.md §"Key injection defaults" / §"Staleness review & consolidation"):
//   fact_confidence_threshold        0.7
//   max_facts                        100
//   staleness_age_days               90
//   staleness_max_lifetime_multiplier 20.0   -> creation clamp 90 x 20 = 1800 days
import { CORE_CATEGORIES, normalizeCategory } from './store.js';
/** `fact_confidence_threshold` (config.py:87-105). Facts below this are never stored. */
export const DEFAULT_FACT_CONFIDENCE_THRESHOLD = 0.7;
/** `max_facts` (config.py:87-105). Over the cap, lowest-confidence facts are trimmed. */
export const DEFAULT_MAX_FACTS = 100;
/** `staleness_age_days` (config.py:116-175). */
export const DEFAULT_STALENESS_AGE_DAYS = 90;
/** `staleness_max_lifetime_multiplier` (config.py:116-175). */
export const DEFAULT_STALENESS_MAX_LIFETIME_MULTIPLIER = 20;
/** Creation-time ceiling on `expected_valid_days`: 90 x 20 = 1800 days (~5 years). */
export const DEFAULT_EXPECTED_VALID_DAYS_CEILING = DEFAULT_STALENESS_AGE_DAYS * DEFAULT_STALENESS_MAX_LIFETIME_MULTIPLIER;
/** Confidence assigned when the model emitted a malformed value (updater.py:34-88). */
export const MALFORMED_CONFIDENCE_DEFAULT = 0.5;
/**
 * Coerce a model-supplied confidence into [0, 1].
 *
 * Ported from `prompt.py:_coerce_confidence` / `updater.py`: non-finite, non-numeric, and
 * boolean values fall back to *default*; everything else is clamped rather than rejected.
 */
export function coerceConfidence(value, fallback = MALFORMED_CONFIDENCE_DEFAULT) {
    if (typeof value === 'boolean' || typeof value !== 'number' || !Number.isFinite(value)) {
        return Math.max(0, Math.min(1, fallback));
    }
    return Math.max(0, Math.min(1, value));
}
/**
 * Creation-time clamp on `expected_valid_days`.
 *
 * Upstream (`_apply_updates`): "The LLM assigns expected_valid_days when creating a fact; it
 * is clamped at write time to staleness_age_days x staleness_max_lifetime_multiplier."
 * A non-integer or non-positive value is *dropped*, matching the prompt's "omit when uncertain".
 */
export function clampExpectedValidDays(value, ceiling = DEFAULT_EXPECTED_VALID_DAYS_CEILING) {
    if (typeof value === 'boolean' || typeof value !== 'number' || !Number.isFinite(value))
        return undefined;
    const truncated = Math.trunc(value);
    if (truncated < 1)
        return undefined;
    return Math.min(truncated, ceiling);
}
/** Case-folded, whitespace-normalized dedup key (updater.py fact deduplication). */
export function dedupeKey(content) {
    return content.trim().replace(/\s+/g, ' ').toLowerCase();
}
function isLabelled(value, allowed) {
    return typeof value === 'string' && allowed.includes(value);
}
/**
 * The scope gate itself: a fact is eligible only when it is *simultaneously* user-scoped,
 * durable, and descriptive. Any missing label rejects that item — and only that item —
 * which is what makes an un-migrated prompt reject every write instead of writing unlabelled
 * data (notes/skills-and-memory.md §4).
 */
function gateLabels(item) {
    if (!isLabelled(item.scope, ['user', 'thread', 'project']))
        return 'missing_or_invalid_scope';
    if (!isLabelled(item.durability, ['durable', 'temporary']))
        return 'missing_or_invalid_durability';
    if (!isLabelled(item.authority, ['descriptive', 'transactional']))
        return 'missing_or_invalid_authority';
    if (item.scope !== 'user')
        return 'scope_not_user';
    if (item.durability !== 'durable')
        return 'durability_not_durable';
    if (item.authority !== 'descriptive')
        return 'authority_not_descriptive';
    return null;
}
function gateFact(raw, origin, index, locator, threshold, ceiling, rejections, consolidatedFrom) {
    const reject = (reason, detail) => {
        rejections.push({ kind: origin === 'factsToConsolidate' ? 'consolidation' : 'fact', locator, reason, detail });
        return null;
    };
    if (typeof raw !== 'object' || raw === null)
        return reject('not_an_object', 'proposed fact is not an object');
    if (typeof raw.content !== 'string' || raw.content.trim() === '')
        return reject('empty_content', 'fact.content must be a non-empty string');
    const labelFailure = gateLabels(raw);
    if (labelFailure !== null) {
        return reject(labelFailure, `scope=${String(raw.scope)} durability=${String(raw.durability)} authority=${String(raw.authority)}`);
    }
    const confidence = coerceConfidence(raw.confidence);
    if (confidence < threshold)
        return reject('below_confidence_threshold', `confidence ${confidence} < ${threshold}`);
    const category = normalizeCategory(raw.category);
    const expectedValidDays = clampExpectedValidDays(raw.expected_valid_days, ceiling);
    const sourceError = category === 'correction' && typeof raw.sourceError === 'string' && raw.sourceError.trim() !== '' ? raw.sourceError.trim() : undefined;
    const content = raw.content.trim();
    const accepted = {
        index,
        origin,
        content,
        category,
        confidence,
        ...(expectedValidDays === undefined ? {} : { expectedValidDays }),
        ...(sourceError === undefined ? {} : { sourceError }),
        ...(consolidatedFrom === undefined ? {} : { consolidatedFrom }),
    };
    return { accepted, key: dedupeKey(content) };
}
/**
 * Apply the deterministic extraction gate to one proposed-updates document.
 *
 * Order of operations mirrors `_apply_updates`:
 *   1. summaries  — wholly user-scoped + descriptive prose only;
 *   2. facts      — scope/durability/authority gate, then the confidence threshold;
 *   3. dedup      — case-folded against existing facts and within the batch;
 *   4. trim       — `max_facts` cap, keeping the highest confidence;
 *   5. removals   — object entries with id/scope/reason; non-user scope fails closed, and a
 *                   paired removal survives only when its `replacementFactIndex` names a new
 *                   fact that itself survived steps 2-4.
 */
export function applyWriteGate(proposal, options = {}) {
    const threshold = options.confidenceThreshold ?? DEFAULT_FACT_CONFIDENCE_THRESHOLD;
    const maxFacts = options.maxFacts ?? DEFAULT_MAX_FACTS;
    const ceiling = options.expectedValidDaysCeiling ?? DEFAULT_EXPECTED_VALID_DAYS_CEILING;
    const existingFacts = options.existingFacts ?? [];
    const rejections = [];
    let proposedCount = 0;
    // ── 1. Summaries ─────────────────────────────────────────────────────────────────────
    const acceptedSummaries = [];
    for (const section of ['user', 'history']) {
        const slots = proposal[section];
        if (typeof slots !== 'object' || slots === null)
            continue;
        for (const [slot, raw] of Object.entries(slots)) {
            if (typeof raw !== 'object' || raw === null)
                continue;
            if (raw.shouldUpdate !== true)
                continue;
            proposedCount += 1;
            const locator = `${section}.${slot}`;
            if (typeof raw.summary !== 'string' || raw.summary.trim() === '') {
                rejections.push({ kind: 'summary', locator, reason: 'empty_summary', detail: 'summary must be a non-empty string' });
                continue;
            }
            // Summaries carry no durability label upstream — only scope + authority.
            if (!isLabelled(raw.scope, ['user', 'thread', 'project'])) {
                rejections.push({ kind: 'summary', locator, reason: 'missing_or_invalid_scope', detail: `scope=${String(raw.scope)}` });
                continue;
            }
            if (!isLabelled(raw.authority, ['descriptive', 'transactional'])) {
                rejections.push({ kind: 'summary', locator, reason: 'missing_or_invalid_authority', detail: `authority=${String(raw.authority)}` });
                continue;
            }
            if (raw.scope !== 'user') {
                rejections.push({ kind: 'summary', locator, reason: 'scope_not_user', detail: `scope=${raw.scope}` });
                continue;
            }
            if (raw.authority !== 'descriptive') {
                rejections.push({ kind: 'summary', locator, reason: 'authority_not_descriptive', detail: `authority=${raw.authority}` });
                continue;
            }
            acceptedSummaries.push({ section, slot, summary: raw.summary.trim() });
        }
    }
    // ── 2. Facts (new + consolidated) ────────────────────────────────────────────────────
    const candidates = [];
    const newFacts = Array.isArray(proposal.newFacts) ? proposal.newFacts : [];
    newFacts.forEach((raw, index) => {
        proposedCount += 1;
        const candidate = gateFact(raw, 'newFacts', index, `newFacts[${index}]`, threshold, ceiling, rejections);
        if (candidate !== null)
            candidates.push(candidate);
    });
    const groups = Array.isArray(proposal.factsToConsolidate) ? proposal.factsToConsolidate : [];
    groups.forEach((rawGroup, index) => {
        proposedCount += 1;
        const locator = `factsToConsolidate[${index}]`;
        const group = rawGroup;
        if (typeof group !== 'object' || group === null) {
            rejections.push({ kind: 'consolidation', locator, reason: 'not_an_object', detail: 'consolidation group is not an object' });
            return;
        }
        const sourceIds = Array.isArray(group.sourceIds) ? group.sourceIds.filter((id) => typeof id === 'string' && id !== '') : [];
        if (sourceIds.length < 2) {
            rejections.push({ kind: 'consolidation', locator, reason: 'insufficient_source_ids', detail: 'a consolidation group needs at least two source ids' });
            return;
        }
        const known = new Set(existingFacts.map((fact) => fact.id));
        const unknownIds = sourceIds.filter((id) => !known.has(id));
        if (existingFacts.length > 0 && unknownIds.length > 0) {
            rejections.push({ kind: 'consolidation', locator, reason: 'unknown_source_id', detail: `unknown source ids: ${unknownIds.join(', ')}` });
            return;
        }
        const candidate = gateFact(group.consolidated ?? {}, 'factsToConsolidate', index, locator, threshold, ceiling, rejections, sourceIds);
        if (candidate === null)
            return;
        // Upstream: "the merged fact's confidence cannot exceed the source maximum".
        const sourceMax = Math.max(...existingFacts.filter((fact) => sourceIds.includes(fact.id)).map((fact) => fact.confidence), 0);
        if (existingFacts.length > 0 && candidate.accepted.confidence > sourceMax) {
            rejections.push({ kind: 'consolidation', locator, reason: 'confidence_exceeds_sources', detail: `confidence ${candidate.accepted.confidence} > source max ${sourceMax}` });
            return;
        }
        candidates.push(candidate);
    });
    // ── 3. Dedup (case-folded, whitespace-normalized) ────────────────────────────────────
    const seen = new Set(existingFacts.map((fact) => dedupeKey(fact.content)));
    const deduped = [];
    for (const candidate of candidates) {
        if (seen.has(candidate.key)) {
            rejections.push({
                kind: candidate.accepted.origin === 'factsToConsolidate' ? 'consolidation' : 'fact',
                locator: `${candidate.accepted.origin}[${candidate.accepted.index}]`,
                reason: 'duplicate_content',
                detail: 'case-folded content already present',
            });
            continue;
        }
        seen.add(candidate.key);
        deduped.push(candidate);
    }
    // ── 4. max_facts trim, keeping the highest confidence ────────────────────────────────
    // Consolidation groups replace their sources, so those sources do not occupy the budget.
    const consumedSourceIds = new Set(deduped.flatMap((candidate) => candidate.accepted.consolidatedFrom ?? []));
    const survivingExisting = existingFacts.filter((fact) => !consumedSourceIds.has(fact.id));
    const slots = [
        ...survivingExisting.map((fact) => ({ confidence: coerceConfidence(fact.confidence), existingId: fact.id })),
        ...deduped.map((candidate) => ({ confidence: candidate.accepted.confidence, candidate })),
    ];
    // Stable sort by confidence descending; ties keep existing facts (listed first) ahead of
    // new ones, so an equal-confidence newcomer never evicts an incumbent.
    const ranked = slots.map((slot, order) => ({ slot, order })).sort((left, right) => right.slot.confidence - left.slot.confidence || left.order - right.order);
    const kept = ranked.slice(0, Math.max(0, maxFacts));
    const evicted = ranked.slice(Math.max(0, maxFacts));
    const trimmedExistingIds = [];
    const keptCandidates = new Set();
    for (const entry of kept)
        if (entry.slot.candidate !== undefined)
            keptCandidates.add(entry.slot.candidate);
    for (const entry of evicted) {
        if (entry.slot.existingId !== undefined) {
            trimmedExistingIds.push(entry.slot.existingId);
            continue;
        }
        const candidate = entry.slot.candidate;
        if (candidate === undefined)
            continue;
        rejections.push({
            kind: candidate.accepted.origin === 'factsToConsolidate' ? 'consolidation' : 'fact',
            locator: `${candidate.accepted.origin}[${candidate.accepted.index}]`,
            reason: 'max_facts_trim',
            detail: `max_facts=${maxFacts} reached; lowest-confidence entries evicted`,
        });
    }
    const acceptedFacts = deduped.filter((candidate) => keptCandidates.has(candidate)).map((candidate) => candidate.accepted);
    // ── 5. Removals ──────────────────────────────────────────────────────────────────────
    const survivingNewFactIndices = new Set(acceptedFacts.filter((fact) => fact.origin === 'newFacts').map((fact) => fact.index));
    const acceptedRemovals = [];
    const removals = Array.isArray(proposal.factsToRemove) ? proposal.factsToRemove : [];
    removals.forEach((rawRemoval, index) => {
        proposedCount += 1;
        const locator = `factsToRemove[${index}]`;
        const reject = (reason, detail) => {
            rejections.push({ kind: 'removal', locator, reason, detail });
        };
        // Fail closed on the legacy bare-string form: it carries no scope, so it cannot be proven
        // to be a user-level retraction (upstream: "Contradiction removals use object entries").
        if (typeof rawRemoval !== 'object' || rawRemoval === null || Array.isArray(rawRemoval)) {
            reject('not_an_object', 'removal must be an object with id, scope and reason');
            return;
        }
        const removal = rawRemoval;
        if (typeof removal.id !== 'string' || removal.id === '') {
            reject('missing_id', 'removal.id must be a non-empty string');
            return;
        }
        if (typeof removal.reason !== 'string' || removal.reason.trim() === '') {
            reject('missing_reason', 'removal.reason must be a non-empty string');
            return;
        }
        if (!isLabelled(removal.scope, ['user', 'thread', 'project'])) {
            reject('missing_or_invalid_scope', `scope=${String(removal.scope)}`);
            return;
        }
        if (removal.scope !== 'user') {
            // "task/project removals fail closed" — a thread/project-local exception does not
            // contradict a user-level fact.
            reject('scope_not_user', `scope=${removal.scope}`);
            return;
        }
        if (removal.replacementFactIndex !== undefined) {
            const replacement = removal.replacementFactIndex;
            if (typeof replacement !== 'number' || !Number.isInteger(replacement) || replacement < 0) {
                reject('invalid_replacement_index', `replacementFactIndex=${String(replacement)}`);
                return;
            }
            if (!survivingNewFactIndices.has(replacement)) {
                reject('replacement_did_not_survive', `newFacts[${replacement}] did not survive the gate, dedup or trim`);
                return;
            }
            acceptedRemovals.push({ id: removal.id, reason: removal.reason.trim(), replacementFactIndex: replacement });
            return;
        }
        acceptedRemovals.push({ id: removal.id, reason: removal.reason.trim() });
    });
    return {
        acceptedFacts,
        acceptedSummaries,
        acceptedRemovals,
        rejections,
        trimmedExistingIds,
        rejectionRate: proposedCount === 0 ? 0 : rejections.length / proposedCount,
    };
}
/** Re-exported so callers can validate a category without importing the store. */
export { CORE_CATEGORIES };
