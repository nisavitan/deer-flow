// M10 resume plan — the structured report `/deerflow:status` renders and a resumed session
// consumes.
//
// WHAT IT PORTS. DeerFlow's cross-session resume is a checkpoint lookup: `configurable
// .checkpoint_id`/`checkpoint_map` anchors the run and LangGraph materializes every channel at
// that point [notes/runtime-and-persistence.md §6]. The port has no such anchor — cross-session
// `resumeFromRunId` is same-session only [claude-code-capabilities.md §4] — so its resume is
// **state-file keyed** (state-checkpoint-resume.md §3.2): read the thread's state files,
// re-verify what is cached, re-run what is not. This module is the read half of that: it
// assembles one report from the channel files and decides what the caller should do with it.
//
// WHAT IT DOES NOT DO. It writes nothing and it re-runs nothing. It reads six channel files,
// applies the commit-binding half of the re-verification predicate, and returns a verdict.
// The artifact half (file exists, `result_sha256` matches) belongs to whoever owns those files
// and is deliberately not guessed at here.
//
// Every timestamp and the current HEAD are caller-injected, so the whole report is a pure
// function of a fixture directory.
import { join } from 'node:path';
import { ARTIFACTS_FILE } from '../state/artifacts.js';
import { DELEGATIONS_FILE, TERMINAL_DELEGATION_STATUSES, } from '../state/delegations.js';
import { GOAL_FILE } from '../state/goal.js';
import { RUN_META_FILE, isTerminalRunStatus } from '../state/run-meta.js';
import { TODOS_FILE } from '../state/todos.js';
import { checkSchemaGate, evaluateStaleness, partitionByCommitBinding } from './staleness.js';
/** File name of the durable summary channel. Read defensively; owned by the summary module. */
export const SUMMARY_FILE = 'summary.json';
/** How many ledger entries the report carries (most recent first). The ledger itself holds 50. */
export const RESUME_MAX_DELEGATIONS = 10;
/** Bound on listed open todos, so one report stays readable. */
export const RESUME_MAX_TODOS = 20;
/** Character cap on the summary digest carried in the report. */
export const RESUME_SUMMARY_CHARS = 600;
/** Per-entry description cap in the delegation summary. */
const DESCRIPTION_CAP = 120;
/** Todo statuses that count as still open — the same set the summary digest uses. */
const OPEN_TODO_STATUSES = new Set(['pending', 'in_progress']);
/** Collapse whitespace and hard-cap, appending an ellipsis when text was dropped. */
function bound(text, cap) {
    const collapsed = text.replace(/\s+/g, ' ').trim();
    return collapsed.length <= cap ? collapsed : `${collapsed.slice(0, Math.max(0, cap - 1)).trimEnd()}…`;
}
function asString(value) {
    return typeof value === 'string' && value.length > 0 ? value : null;
}
/** Read one channel file, recording an uninterpretable one instead of throwing. */
function readChannel(stateDir, fileName, unreadable) {
    try {
        const gate = checkSchemaGate(join(stateDir, fileName));
        if (gate.status === 'unreadable') {
            unreadable.push(fileName);
            return null;
        }
        return gate.envelope?.payload ?? null;
    }
    catch {
        unreadable.push(fileName);
        return null;
    }
}
/** Project the goal channel down to the fields a resume decision needs. */
function summarizeGoal(goal) {
    if (goal === null || typeof goal !== 'object')
        return null;
    const objective = asString(goal.objective);
    if (objective === null)
        return null;
    const evaluation = goal.last_evaluation;
    return {
        objective,
        status: typeof goal.status === 'string' ? goal.status : 'active',
        continuation_count: typeof goal.continuation_count === 'number' ? goal.continuation_count : 0,
        max_continuations: typeof goal.max_continuations === 'number' ? goal.max_continuations : 0,
        no_progress_count: typeof goal.no_progress_count === 'number' ? goal.no_progress_count : 0,
        max_no_progress_continuations: typeof goal.max_no_progress_continuations === 'number' ? goal.max_no_progress_continuations : 0,
        blocker: evaluation === undefined ? null : (asString(evaluation.blocker) ?? null),
        satisfied: evaluation === undefined || typeof evaluation.satisfied !== 'boolean' ? null : evaluation.satisfied,
    };
}
/**
 * Counts by status plus the capped tail of the ledger, with the stage-skip verdict per entry.
 *
 * The skip predicate has TWO halves (§3.2) and both are applied here: the entry's status must
 * be terminal (`TERMINAL_DELEGATION_STATUSES` — an `in_progress` entry describes a stage that
 * never finished, whatever tree it started on) AND its `commit_sha` must match current HEAD.
 * Everything else counts as invalidated and re-runs.
 */
function summarizeDelegations(entries, currentCommitSha, cap) {
    const byStatus = {};
    for (const entry of entries) {
        const status = typeof entry.status === 'string' ? entry.status : 'unknown';
        byStatus[status] = (byStatus[status] ?? 0) + 1;
    }
    const sorted = {};
    for (const key of Object.keys(byStatus).sort())
        sorted[key] = byStatus[key] ?? 0;
    const terminal = entries.filter((entry) => TERMINAL_DELEGATION_STATUSES.has(String(entry.status)));
    const { reusable } = partitionByCommitBinding(terminal, currentCommitSha);
    const reusableIds = new Set(reusable.map((entry) => entry.id));
    const invalidated = entries.length - reusable.length;
    const recent = entries.slice(-Math.max(0, cap)).map((entry) => ({
        id: entry.id,
        description: bound(typeof entry.description === 'string' ? entry.description : '', DESCRIPTION_CAP),
        subagent_type: typeof entry.subagent_type === 'string' ? entry.subagent_type : 'unknown',
        status: typeof entry.status === 'string' ? entry.status : 'unknown',
        commit_sha: asString(entry.commit_sha),
        reusable: reusableIds.has(entry.id),
    }));
    return { total: entries.length, by_status: sorted, reusable: reusable.length, invalidated, recent };
}
/**
 * Assemble the resume report for one thread.
 *
 * `recommended_action`:
 * - `nothing_to_resume` — no live run, no goal, no open todos. A finished ledger is history,
 *   not work: cached results alone are never a reason to resume.
 * - `restart_stale` — there IS work AND commit-bound state (a recorded run, or ledger entries
 *   now excluded from the stage-skip predicate), but HEAD moved or cannot be proven, so
 *   nothing cached may be reused and the resumed run re-verifies from the top (§4).
 * - `continue` — work is pending and the tree binding holds.
 */
export function buildResumePlan(options) {
    const unreadable = [];
    const stateDir = options.stateDir;
    const currentCommitSha = options.currentCommitSha;
    const maxDelegations = options.maxDelegations ?? RESUME_MAX_DELEGATIONS;
    const maxTodos = options.maxTodos ?? RESUME_MAX_TODOS;
    const runPayload = readChannel(stateDir, RUN_META_FILE, unreadable);
    const run = runPayload?.run ?? null;
    const runActive = run !== null && typeof run.status === 'string' && !isTerminalRunStatus(run.status);
    const goalPayload = readChannel(stateDir, GOAL_FILE, unreadable);
    const goal = summarizeGoal(goalPayload?.goal ?? null);
    const todosPayload = readChannel(stateDir, TODOS_FILE, unreadable);
    const rawTodos = Array.isArray(todosPayload?.todos) ? todosPayload.todos : [];
    const openTodos = [];
    for (const item of rawTodos) {
        if (typeof item !== 'object' || item === null)
            continue;
        const record = item;
        const status = typeof record['status'] === 'string' ? record['status'] : 'pending';
        if (!OPEN_TODO_STATUSES.has(status))
            continue;
        const content = asString(record['content']) ?? asString(record['title']) ?? '';
        if (content.length === 0)
            continue;
        openTodos.push({ content: bound(content, DESCRIPTION_CAP), status });
    }
    const delegationsPayload = readChannel(stateDir, DELEGATIONS_FILE, unreadable);
    const entries = Array.isArray(delegationsPayload?.entries) ? delegationsPayload.entries : [];
    const delegations = summarizeDelegations(entries, currentCommitSha, maxDelegations);
    const artifactsPayload = readChannel(stateDir, ARTIFACTS_FILE, unreadable);
    const artifacts = Array.isArray(artifactsPayload?.artifacts)
        ? artifactsPayload.artifacts.filter((path) => typeof path === 'string')
        : [];
    const summaryPayload = readChannel(stateDir, SUMMARY_FILE, unreadable);
    const summaryRaw = asString(summaryPayload?.['summary_text']);
    const summaryText = summaryRaw === null ? null : bound(summaryRaw, RESUME_SUMMARY_CHARS);
    const staleness = evaluateStaleness({
        stateCommitSha: run?.commit_sha ?? null,
        currentCommitSha,
        stateBranch: run?.branch ?? null,
        currentBranch: options.currentBranch ?? null,
    });
    // A commit move only matters when there is commit-BOUND state to invalidate: the recorded
    // run (whose stage progress was made against that tree) or ledger entries excluded from the
    // stage-skip predicate. goal.json and todos.json carry no `commit_sha` by design — user
    // intent is not code-derived and survives a tree change (§4) — so a thread holding only a
    // goal is `continue`, not `restart_stale`, even though its (absent) binding cannot be proven.
    const hasWork = runActive || goal !== null || openTodos.length > 0;
    const hasStaleCache = staleness.invalidatesCachedResults && (run !== null || delegations.invalidated > 0);
    const recommendedAction = !hasWork
        ? 'nothing_to_resume'
        : hasStaleCache
            ? 'restart_stale'
            : 'continue';
    return {
        thread_id: options.threadId,
        state_dir: stateDir,
        run,
        run_active: runActive,
        goal,
        open_todos: openTodos.slice(0, Math.max(0, maxTodos)),
        open_todo_count: openTodos.length,
        delegations,
        artifacts,
        summary_text: summaryText,
        staleness,
        recommended_action: recommendedAction,
        unreadable,
    };
}
/** Report for every thread under a state root, thread-id order. */
export function buildResumePlans(threadIds, stateRoot, options) {
    return threadIds.map((threadId) => buildResumePlan({ ...options, threadId, stateDir: join(stateRoot, threadId) }));
}
/** One-line digest for the SessionStart additionalContext block. */
export function renderResumeLine(report) {
    const parts = [`thread ${report.thread_id}`];
    if (report.run !== null) {
        const status = report.run.status;
        parts.push(`run ${report.run.run_id} ${status}${report.run.stop_reason ? ` (${report.run.stop_reason})` : ''}`);
    }
    if (report.goal !== null) {
        parts.push(`goal "${bound(report.goal.objective, 80)}" ` +
            `(${report.goal.continuation_count}/${report.goal.max_continuations} continuations)`);
    }
    if (report.open_todo_count > 0)
        parts.push(`${report.open_todo_count} open todo(s)`);
    if (report.delegations.total > 0) {
        parts.push(`${report.delegations.total} delegation(s), ${report.delegations.reusable} reusable`);
    }
    parts.push(report.staleness.reason);
    parts.push(`action: ${report.recommended_action}`);
    return parts.join('; ');
}
/** Markdown rendering of one report — what `/deerflow:status` shows the user. */
export function renderResumeReport(report) {
    const lines = [`## Thread \`${report.thread_id}\``, ''];
    if (report.run === null) {
        lines.push('- **Run:** none recorded');
    }
    else {
        const run = report.run;
        lines.push(`- **Run:** \`${run.run_id}\` — ${run.status}` +
            `${run.stop_reason ? ` (stop_reason: ${run.stop_reason})` : ''}` +
            `${run.error ? ` — error: ${bound(run.error, 120)}` : ''}`, `- **Started:** ${run.started_at} · **Updated:** ${run.updated_at}${run.ended_at ? ` · **Ended:** ${run.ended_at}` : ''}`, `- **Recorded commit:** ${run.commit_sha || 'none'}${run.branch ? ` (${run.branch})` : ''}`);
        if (run.delivery !== undefined) {
            const presented = run.delivery.presented_paths.length;
            lines.push(`- **Delivery receipt:** ${presented} path(s) at ${run.delivery.receipt_at}`);
        }
    }
    lines.push(`- **Staleness:** ${report.staleness.verdict} — ${report.staleness.reason}`);
    if (report.goal === null) {
        lines.push('- **Goal:** none set');
    }
    else {
        lines.push(`- **Goal:** ${report.goal.objective}`, `  - continuations ${report.goal.continuation_count}/${report.goal.max_continuations}` +
            `, no-progress ${report.goal.no_progress_count}/${report.goal.max_no_progress_continuations}` +
            `${report.goal.blocker === null ? '' : `, blocker: ${report.goal.blocker}`}`);
    }
    if (report.open_todo_count === 0) {
        lines.push('- **Open todos:** none');
    }
    else {
        lines.push(`- **Open todos (${report.open_todo_count}):**`);
        for (const todo of report.open_todos)
            lines.push(`  - [${todo.status}] ${todo.content}`);
        if (report.open_todo_count > report.open_todos.length) {
            lines.push(`  - …and ${report.open_todo_count - report.open_todos.length} more`);
        }
    }
    const statusPairs = Object.entries(report.delegations.by_status)
        .map(([status, count]) => `${status}: ${count}`)
        .join(', ');
    lines.push(`- **Delegations:** ${report.delegations.total} total` +
        `${statusPairs.length > 0 ? ` (${statusPairs})` : ''}` +
        ` — ${report.delegations.reusable} reusable at this commit, ${report.delegations.invalidated} to re-run`);
    for (const entry of report.delegations.recent) {
        lines.push(`  - \`${entry.id}\` [${entry.status}] ${entry.subagent_type}: ${entry.description}` +
            ` — ${entry.reusable ? 'reusable' : 're-run'}`);
    }
    if (report.artifacts.length > 0) {
        lines.push(`- **Artifacts:** ${report.artifacts.join(', ')}`);
    }
    if (report.summary_text !== null) {
        lines.push('- **Summary digest:**', `  > ${report.summary_text}`);
    }
    if (report.unreadable.length > 0) {
        lines.push(`- **Unreadable channels (read as empty):** ${report.unreadable.join(', ')}`);
    }
    lines.push('', `**Recommended action:** ${report.recommended_action}`, '');
    return lines.join('\n');
}
