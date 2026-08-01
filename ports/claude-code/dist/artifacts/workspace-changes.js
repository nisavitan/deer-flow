// Ported from backend/packages/harness/deerflow/workspace_changes/recorder.py:record_workspace_changes @ 0950924 — structural translation
// Ported from backend/packages/harness/deerflow/workspace_changes/api.py:get_workspace_changes_response @ 0950924 — the read side
//
// WHAT THE ORIGINAL DID. After every run the recorder compared the pre/post snapshots and, when
// anything changed, wrote exactly ONE event: `put(event_type="workspace_changes",
// category="workspace", content="N files changed +A -D", metadata={workspace_changes: payload})`
// [recorder.py:126-160]. The Gateway read the last such event back and rendered it in the UI.
//
// WHAT THE PORT DOES. There is no event store and no UI, so the event becomes an append to one
// state channel, `.deerflow/state/<thread>/workspace-changes.json`, through the same atomic-write +
// `rev`-CAS library every other channel uses. The behavioural essence — "one record per turn saying
// what changed, latest readable" — is preserved; the unified diffs are not (parity/DISCREPANCIES.md
// §M13 entry 1).
//
// TWO BOUNDS THE ORIGINAL DID NOT NEED. An event store grows without limit by design and the
// original wrote one event per RUN; this channel is one JSON file written once per TURN, so it
// needs its own history bound ({@link MAX_HISTORY_ENTRIES}) and its own per-entry path bound
// ({@link MAX_PATHS_PER_ENTRY}). Both truncate oldest/overflow-first and record that they did.
import { threadStateFile } from '../state/index.js';
import { updateStateFile } from '../state/atomic-io.js';
import { changedOutputPaths, summarizeDiff } from './snapshot.js';
/** File name of the workspace-changes history channel. */
export const WORKSPACE_CHANGES_FILE = 'workspace-changes.json';
/** Turns of history kept. Oldest entries are dropped first. */
export const MAX_HISTORY_ENTRIES = 20;
/**
 * Paths listed per entry, per bucket.
 *
 * The diff itself is already capped at `max_files = 200` changes (types.py:19), which is a fine
 * bound for a payload the UI renders and a poor one for a file re-read on every turn. 50 keeps the
 * channel small; `truncated` on the summary still says the record is partial.
 */
export const MAX_PATHS_PER_ENTRY = 50;
function capPaths(paths) {
    if (paths.length <= MAX_PATHS_PER_ENTRY)
        return { paths: [...paths], truncated: false };
    return { paths: paths.slice(0, MAX_PATHS_PER_ENTRY), truncated: true };
}
/**
 * `recorder.py:record_workspace_changes`'s event content (152-154), minus the line counters.
 *
 * The original read `"N file(s) changed +A -D"`; with no unified diffs there are no additions or
 * deletions to count, so the port names the three buckets instead — strictly more information
 * about *what* changed, strictly less about *how much*.
 */
export function renderChangeContent(summary) {
    const total = summary.created + summary.modified + summary.deleted;
    const noun = total === 1 ? 'file' : 'files';
    const detail = `+${summary.created} ~${summary.modified} -${summary.deleted}`;
    return `${total} ${noun} changed ${detail}${summary.truncated ? ' (truncated)' : ''}`;
}
/** Build one history entry from a diff. Pure: the clock is injected. */
export function buildChangesEntry(diff, now) {
    const summary = summarizeDiff(diff);
    const created = capPaths(diff.created.map((change) => change.path));
    const modified = capPaths(diff.modified.map((change) => change.path));
    const deleted = capPaths(diff.deleted.map((change) => change.path));
    return {
        recorded_at: now,
        content: renderChangeContent(summary),
        summary,
        created: created.paths,
        modified: modified.paths,
        deleted: deleted.paths,
        outputs_changed: changedOutputPaths(diff),
        paths_truncated: created.truncated || modified.truncated || deleted.truncated,
    };
}
function samePathList(a, b) {
    return a.length === b.length && a.every((value, index) => value === b[index]);
}
/**
 * Whether two entries describe the same delta (everything but `recorded_at`).
 *
 * Exported because the property it guards is not obvious: a blocked Stop re-evaluates the SAME
 * pre-turn baseline on the continuation turn, so without this the identical delta would be appended
 * twice — once for the block and once for the turn that fixed it.
 */
export function describesSameDelta(a, b) {
    return (samePathList(a.created, b.created) &&
        samePathList(a.modified, b.modified) &&
        samePathList(a.deleted, b.deleted) &&
        a.summary.truncated === b.summary.truncated);
}
/**
 * Reducer: append one entry, keeping at most {@link MAX_HISTORY_ENTRIES} newest.
 *
 * Re-appending a delta identical to the newest recorded one is a no-op (see
 * {@link describesSameDelta}). Separated from the write so both bounds are testable without a
 * filesystem, the same shape every other state channel in this port uses.
 */
export function appendChangesEntry(existing, entry) {
    const current = existing ?? [];
    const latest = current.length > 0 ? current[current.length - 1] : undefined;
    if (latest !== undefined && describesSameDelta(latest, entry))
        return [...current];
    const next = [...current, entry];
    return next.length <= MAX_HISTORY_ENTRIES ? next : next.slice(next.length - MAX_HISTORY_ENTRIES);
}
/** Absolute path of a thread's `workspace-changes.json`. */
export function workspaceChangesPath(threadId, env) {
    return threadStateFile(threadId, WORKSPACE_CHANGES_FILE, env);
}
/** Append one entry under atomic-write + `rev` CAS. */
export function applyWorkspaceChanges(filePath, entry, options) {
    return updateStateFile(filePath, (current) => ({
        entries: appendChangesEntry(Array.isArray(current?.entries) ? current.entries : null, entry),
    }), options);
}
/** The newest recorded entry, or `null` — the port's `get_workspace_changes_response`. */
export function latestChangesEntry(payload) {
    if (payload === null || !Array.isArray(payload.entries) || payload.entries.length === 0)
        return null;
    return payload.entries[payload.entries.length - 1] ?? null;
}
