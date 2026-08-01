// M10: the one impure input the staleness predicate needs — current HEAD.
//
// Kept in its own module so `staleness.ts`, `resume-plan.ts` and `recovery.ts` stay pure
// functions of caller-supplied values (the whole verdict matrix is then testable without a
// git repository). DeerFlow has no counterpart: commit binding is a port-side obligation,
// because the platform provides no changed-commit detection for sessions or workflow caches
// [experiment-results.md E3 item 3; state-checkpoint-resume.md §4].
//
// FAIL-SOFT: every failure (no git, not a repository, empty repository, timeout) yields
// `null`, and a `null` HEAD makes `evaluateStaleness` return `stale_commit` — the binding
// cannot be proven, so nothing cached is reused. Absence of evidence degrades to "re-run",
// never to "reuse".
import { execFileSync } from 'node:child_process';
/** Wall-clock budget for each git call. A hook must not block the session on a slow repo. */
export const GIT_TIMEOUT_MS = 2000;
/** `git rev-parse --abbrev-ref HEAD` prints the literal `HEAD` when detached. */
export function interpretBranch(raw) {
    if (raw === null)
        return null;
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed === 'HEAD')
        return null;
    return trimmed;
}
function git(args, cwd) {
    try {
        const out = execFileSync('git', [...args], {
            cwd,
            encoding: 'utf8',
            timeout: GIT_TIMEOUT_MS,
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        const trimmed = out.trim();
        return trimmed.length === 0 ? null : trimmed;
    }
    catch {
        return null;
    }
}
/** Read HEAD for `cwd`. Never throws. */
export function readGitHead(cwd) {
    return {
        commitSha: git(['rev-parse', 'HEAD'], cwd),
        branch: interpretBranch(git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)),
    };
}
