// Ported from backend/packages/harness/deerflow/agents/goal_state.py:GoalState,GoalEvaluation,GoalBlocker @ 0950924 — mechanical TypeScript translation
// Ported from backend/packages/harness/deerflow/agents/thread_state.py:merge_goal @ 0950924 — mechanical TypeScript translation
// Ported from backend/packages/harness/deerflow/runtime/goal.py:build_goal_state,should_continue_goal,compute_goal_progress_key,compute_no_progress_count,attach_goal_evaluation @ 0950924 — mechanical TypeScript translation
// Ported from backend/packages/harness/deerflow/runtime/runs/worker.py:_stand_down_reason @ 0950924 — mechanical TypeScript translation
// Parity vectors: parity/baseline/goal_counters.json, parity/baseline/state_reducers.json -> merge_goal.
// Every timestamp is injected by the caller: the original calls now_iso() inside
// attach_goal_evaluation, which would make this logic untestable against pinned vectors.
import { threadStateFile } from './paths.js';
import { updateStateFile } from './atomic-io.js';
/** File name of the goal channel inside a thread's state directory. */
export const GOAL_FILE = 'goal.json';
export const DEFAULT_MAX_GOAL_CONTINUATIONS = 8;
export const DEFAULT_MAX_NO_PROGRESS_CONTINUATIONS = 2;
export const MAX_GOAL_OBJECTIVE_CHARS = 4000;
export const GOAL_BLOCKERS = new Set([
    'none',
    'missing_evidence',
    'needs_user_input',
    'run_failed',
    'external_wait',
    'goal_not_met_yet',
]);
/** Only `goal_not_met_yet` licenses another hidden continuation turn. */
export const CONTINUABLE_GOAL_BLOCKERS = new Set(['goal_not_met_yet']);
/** Raised when a caller tries to install an empty or over-long objective. */
export class InvalidGoalObjectiveError extends Error {
    name = 'InvalidGoalObjectiveError';
}
/** Normalize and validate user-provided goal text. */
export function normalizeGoalObjective(objective) {
    const normalized = objective.trim().split(/\s+/).filter((part) => part.length > 0).join(' ');
    if (normalized.length === 0)
        throw new InvalidGoalObjectiveError('Goal objective must not be empty.');
    if (normalized.length > MAX_GOAL_OBJECTIVE_CHARS) {
        throw new InvalidGoalObjectiveError(`Goal objective must be at most ${MAX_GOAL_OBJECTIVE_CHARS} characters.`);
    }
    return normalized;
}
/**
 * Create a fresh active goal state for a thread.
 *
 * `max_continuations` is clamped to `max(0, min(requested, 8))` and
 * `max_no_progress_continuations` to `max(0, requested)` — the caps are engine policy, not
 * caller preference.
 */
export function buildGoalState(objective, options) {
    const requestedMax = options.maxContinuations ?? DEFAULT_MAX_GOAL_CONTINUATIONS;
    const requestedNoProgress = options.maxNoProgressContinuations ?? DEFAULT_MAX_NO_PROGRESS_CONTINUATIONS;
    return {
        objective: normalizeGoalObjective(objective),
        status: 'active',
        created_at: options.now,
        updated_at: options.now,
        continuation_count: 0,
        max_continuations: clampMaxContinuations(requestedMax),
        no_progress_count: 0,
        max_no_progress_continuations: Math.max(0, Math.trunc(requestedNoProgress)),
    };
}
/** `max(0, min(requested, 8))` — the continuation cap clamp. */
export function clampMaxContinuations(requested) {
    return Math.max(0, Math.min(Math.trunc(requested), DEFAULT_MAX_GOAL_CONTINUATIONS));
}
/** Reducer for the goal channel: preserve existing when a node does not touch it. */
export function mergeGoal(existing, incoming) {
    if (incoming === null || incoming === undefined)
        return existing;
    return incoming;
}
/**
 * JSON encoding compatible with Python's `json.dumps(..., ensure_ascii=False, sort_keys=True)`.
 * The progress key is compared byte-for-byte across turns, so the `", "` / `": "` separators
 * and sorted keys are part of the contract, not formatting taste.
 */
function pythonJsonDumps(value) {
    const parts = Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => `${JSON.stringify(key)}: ${JSON.stringify(item)}`);
    return `{${parts.join(', ')}}`;
}
/**
 * Stable key used to detect repeated non-progress evaluations.
 *
 * Keyed on the typed `blocker` plus a signature of the *visible assistant evidence*, so a
 * stalled goal is detected even when the evaluator rewords its free-text reason.
 */
export function computeGoalProgressKey(evaluation, evidenceSignature = '') {
    return pythonJsonDumps({
        satisfied: evaluation.satisfied,
        blocker: evaluation.blocker,
        evidence_signature: evidenceSignature,
    });
}
/** Increment the repeated-progress count when visible evidence has not advanced. */
export function computeNoProgressCount(goal, evaluation, evidenceSignature = '') {
    if (evaluation.satisfied)
        return 0;
    const progressKey = computeGoalProgressKey(evaluation, evidenceSignature);
    const previous = goal.last_evaluation;
    if (previous !== undefined && previous.progress_key === progressKey) {
        return goal.no_progress_count + 1;
    }
    return 0;
}
/** Whether another hidden continuation turn should run. */
export function shouldContinueGoal(goal, evaluation, noProgressCount) {
    if (evaluation.satisfied)
        return false;
    if (!CONTINUABLE_GOAL_BLOCKERS.has(evaluation.blocker))
        return false;
    if (goal.continuation_count >= goal.max_continuations)
        return false;
    const currentNoProgress = noProgressCount === undefined ? goal.no_progress_count : noProgressCount;
    return currentNoProgress < goal.max_no_progress_continuations;
}
/**
 * The reason the run stands down instead of continuing, or `null` when it may continue.
 * Mirrors {@link shouldContinueGoal}'s gates so the two never disagree.
 */
export function standDownReason(goal, evaluation, noProgressCount) {
    if (evaluation.satisfied)
        return null;
    if (evaluation.blocker !== 'goal_not_met_yet')
        return `blocked:${evaluation.blocker}`;
    if (goal.continuation_count >= goal.max_continuations)
        return 'max_continuations_reached';
    if (noProgressCount >= goal.max_no_progress_continuations)
        return 'no_progress_detected';
    return null;
}
/** Return a goal copy with the latest evaluator result attached. */
export function attachGoalEvaluation(goal, evaluation, options) {
    const next = structuredClone(goal);
    if (options.continuationCount !== undefined)
        next.continuation_count = options.continuationCount;
    if (options.noProgressCount !== undefined)
        next.no_progress_count = options.noProgressCount;
    next.updated_at = options.now;
    const lastEvaluation = {
        satisfied: evaluation.satisfied,
        blocker: evaluation.blocker,
        reason: evaluation.reason,
        evidence_summary: evaluation.evidence_summary ?? '',
        run_id: options.runId,
        evaluated_at: next.updated_at,
        progress_key: computeGoalProgressKey(evaluation, options.evidenceSignature ?? ''),
    };
    // The original only records the field when a stand-down actually happened.
    if (options.standDownReason)
        lastEvaluation.stand_down_reason = options.standDownReason;
    next.last_evaluation = lastEvaluation;
    return next;
}
/** Absolute path of a thread's `goal.json`. */
export function goalPath(threadId, env) {
    return threadStateFile(threadId, GOAL_FILE, env);
}
/**
 * Apply a goal write under atomic-write + `rev` CAS — the port's `goal_thread_lock` +
 * `GoalWriteConflict`. A satisfied goal is written as `null` (cleared, never marked).
 */
export function applyGoal(filePath, incoming, options) {
    return updateStateFile(filePath, (current) => ({ goal: mergeGoal(current?.goal ?? null, incoming) }), options);
}
