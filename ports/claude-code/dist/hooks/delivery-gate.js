// M13 Stop hook: the port of DeerFlow's post-run workspace record AND its delivery enforcement.
//
// WHAT IT PORTS, IN TWO HALVES.
//   (a) `workspace_changes/recorder.py:record_workspace_changes` — post-run scan, diff against the
//       pre-run baseline, and one durable record of what changed [recorder.py:126-160]. Here that
//       record is an append to `.deerflow/state/<thread>/workspace-changes.json`.
//   (b) `runtime/runs/worker.py:934-986` — the delivery verdict. Every regular file created or
//       modified under the outputs root must be covered by a presented path, or the run is
//       terminalized `error` with `_DELIVERY_INCOMPLETE_ERROR`.
//
// (b) IS A RESTORATION, NOT A NEW FEATURE. `docs/sandbox-contract.md` §3 recorded at M5 that the
// port had weakened enforcement to prompt policy — "there is no receipt, no verification stage, and
// no run-level error for an unlisted file". A Stop hook is the port's verification stage: it sees
// the same two facts the worker saw (what the turn wrote under `outputs/`, and what the final
// message said), and it has the same lever the worker had (refuse to let the turn end).
//
// HARD RULES FOR THIS FILE:
//   1. NEVER BLOCK WHEN NOTHING WAS PRODUCED. A turn that wrote nothing under `outputs/` owes the
//      user nothing; the original failed only runs that produced outputs and presented none.
//   2. NEVER DOUBLE-BLOCK. `stop_hook_active` true means a hook already extended this turn, so this
//      one stands down unconditionally. One block per stop chain, by construction — a Stop hook
//      that can block twice can wedge a session.
//   3. NO BASELINE, NO VERDICT. A missing or unreadable `workspace-pre.json` means every file on
//      disk would read as `created`; the hook stands down instead of blocking on the project tree.
//   4. EXIT 0 ALWAYS, and on any internal fault emit NO decision.
//   5. THIN SHELL. The whole decision is `decideDeliveryGate`, a pure function of two snapshots,
//      the final message and `stop_hook_active`.
//
// ORDERING: this hook must be registered AFTER `stop-goal-evaluator.js` in the `Stop` array —
// goal continuation decides whether the turn is really over; the delivery check belongs on the
// turn that really ends. Registration is requested in hooks/REGISTRATION-REQUESTS.md; hooks.json
// has a single owner and is not edited here.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { DISABLE_DELIVERY_GATE_ENV_VAR, evaluateDelivery, extractFinalAssistantText, recordDeliveryReceipt, renderDeliveryBlockReason, } from '../artifacts/delivery.js';
import { changedOutputPaths, defaultScanRoots, diffSnapshots, hasChanges, readPreSnapshot, scanWorkspace, workspacePrePath, } from '../artifacts/snapshot.js';
import { applyWorkspaceChanges, buildChangesEntry, workspaceChangesPath, } from '../artifacts/workspace-changes.js';
import { appendHookLog } from '../middleware/hook-runtime.js';
import { runMetaPath } from '../state/run-meta.js';
import { resolveProjectRoot, THREAD_ID_PATTERN } from '../state/paths.js';
/** Milliseconds to wait for the hook payload before giving up. Mirrors stop-goal-evaluator.ts. */
const STDIN_TIMEOUT_MS = 2000;
/** Escape hatch. Shared with `turn-snapshot.ts`; one flag governs both halves. */
export const DISABLE_ENV_VAR = DISABLE_DELIVERY_GATE_ENV_VAR;
/**
 * Resolve the thread whose baseline this stop belongs to. Same contract as
 * `stop-goal-evaluator.ts` and `precompact-summary.ts`: `DEERFLOW_THREAD_ID` wins, else the session
 * id when it satisfies the thread-id pattern, else stand down.
 */
export function resolveThreadId(payload, env) {
    const configured = env['DEERFLOW_THREAD_ID'];
    if (typeof configured === 'string' && THREAD_ID_PATTERN.test(configured))
        return configured;
    const sessionId = payload.session_id;
    if (typeof sessionId === 'string' && THREAD_ID_PATTERN.test(sessionId))
        return sessionId;
    return null;
}
const STAND_DOWN = {
    entry: null,
    verdict: null,
    recordReceipt: false,
    block: false,
    blockReason: null,
};
/**
 * The whole decision, pure.
 *
 * Reading order matches the rules at the top of the file: no baseline → nothing; no change →
 * nothing; change → always record; `outputs/` change → verdict; unsatisfied verdict and not already
 * continuing → block.
 */
export function decideDeliveryGate(input) {
    if (input.pre === null)
        return STAND_DOWN; // Rule 3.
    const diff = diffSnapshots(input.pre, input.post);
    if (!hasChanges(diff))
        return STAND_DOWN;
    const entry = buildChangesEntry(diff, input.now);
    const produced = changedOutputPaths(diff);
    if (produced.length === 0) {
        // Rule 1: the workspace changed but nothing was produced for the user. Record, never block.
        return { entry, verdict: null, recordReceipt: false, block: false, blockReason: null };
    }
    const verdict = evaluateDelivery({ producedPaths: produced, finalMessageText: input.finalMessageText });
    const block = !verdict.satisfied && !input.stopHookActive; // Rule 2.
    return {
        entry,
        verdict,
        recordReceipt: verdict.satisfied || input.stopHookActive,
        block,
        blockReason: block ? renderDeliveryBlockReason(verdict) : null,
    };
}
/** Read + parse a transcript file; an unreadable path yields no text, never an exception. */
export function readFinalMessage(transcriptPath) {
    if (transcriptPath === null || transcriptPath.length === 0)
        return '';
    try {
        return extractFinalAssistantText(readFileSync(transcriptPath, 'utf8'));
    }
    catch {
        return '';
    }
}
const SILENT_OUTCOME = {
    decision: STAND_DOWN,
    threadId: null,
    recorded: false,
    receipt: null,
};
/**
 * One Stop event, end to end: resolve thread → read baseline → scan → decide → persist → report.
 * Never throws (rule 4).
 *
 * The post-turn scan MUST use the same roots and the same depth cap as the pre-turn one, or the
 * depth difference alone fabricates creations and deletions — hence `defaultScanRoots` with its
 * default `FAST_WORKSPACE_MAX_DEPTH` on both sides.
 */
export function evaluateDeliveryGate(payload, options) {
    const env = options.env ?? process.env;
    if (env[DISABLE_ENV_VAR] === '1')
        return SILENT_OUTCOME;
    const threadId = resolveThreadId(payload, env);
    if (threadId === null)
        return SILENT_OUTCOME;
    try {
        const projectRoot = resolveProjectRoot(env);
        const pre = readPreSnapshot(workspacePrePath(threadId, env));
        const post = scanWorkspace(defaultScanRoots(projectRoot), projectRoot);
        const decision = decideDeliveryGate({
            pre,
            post,
            finalMessageText: readFinalMessage(typeof payload.transcript_path === 'string' ? payload.transcript_path : null),
            stopHookActive: payload.stop_hook_active === true,
            now: options.now,
        });
        let recorded = false;
        if (decision.entry !== null) {
            applyWorkspaceChanges(workspaceChangesPath(threadId, env), decision.entry, { now: options.now });
            recorded = true;
        }
        let receipt = null;
        if (decision.recordReceipt && decision.verdict !== null) {
            receipt = recordDeliveryReceipt(runMetaPath(threadId, env), decision.verdict, { now: options.now });
        }
        return { decision, threadId, recorded, receipt };
    }
    catch (error) {
        process.stderr.write(`deerflow delivery-gate: standing down (${error instanceof Error ? error.message : String(error)})\n`);
        return { decision: STAND_DOWN, threadId, recorded: false, receipt: null };
    }
}
/** The Stop hook's stdout protocol: a block decision, or nothing at all. */
export function renderHookOutput(outcome) {
    const decision = outcome.decision;
    if (!decision.block || decision.blockReason === null)
        return '';
    return `${JSON.stringify({ decision: 'block', reason: decision.blockReason })}\n`;
}
function readStdin() {
    return new Promise((resolve) => {
        const chunks = [];
        let settled = false;
        const finish = () => {
            if (settled)
                return;
            settled = true;
            resolve(Buffer.concat(chunks).toString('utf8'));
        };
        const timer = setTimeout(finish, STDIN_TIMEOUT_MS);
        timer.unref();
        process.stdin.on('data', (chunk) => chunks.push(chunk));
        process.stdin.on('end', () => {
            clearTimeout(timer);
            finish();
        });
        process.stdin.on('error', () => {
            clearTimeout(timer);
            finish();
        });
    });
}
async function main() {
    const raw = await readStdin();
    let payload;
    try {
        payload = JSON.parse(raw);
    }
    catch {
        return; // Malformed payload: stand down.
    }
    if (typeof payload !== 'object' || payload === null)
        return;
    const outcome = evaluateDeliveryGate(payload, { now: new Date().toISOString() });
    const output = renderHookOutput(outcome);
    // O3: the receipt in run-meta.json is put-if-absent and only written on the final word, so a
    // stand-down mid-chain has no other trace. This line records every stop the gate saw.
    const verdict = outcome.decision.verdict;
    appendHookLog({
        hook: 'delivery-gate',
        event: 'Stop',
        thread: outcome.threadId,
        decision: outcome.decision.block ? 'block' : 'silent',
        summary: `produced=${verdict?.produced_paths.length ?? 0} missing=${verdict?.missing.length ?? 0} ` +
            `recorded=${outcome.recorded} receipt=${outcome.receipt === null ? 'none' : 'written'}`,
    });
    if (output.length > 0)
        process.stdout.write(output);
}
// Only consume stdin when invoked as a program: the unit tests import the pure helpers above.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
    try {
        await main();
    }
    catch {
        // Rule 4: a hook fault must never wedge the turn.
    }
    process.stdin.destroy();
    process.exitCode = 0;
}
