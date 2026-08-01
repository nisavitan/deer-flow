// Ported from backend/packages/harness/deerflow/runtime/runs/worker.py:_DELIVERY_INCOMPLETE_ERROR,_build_delivery_content,_persist_delivery_receipt @ 0950924 — structural translation
// Ported from backend/packages/harness/deerflow/workspace_changes/diff.py:get_changed_output_paths @ 0950924 — the produced-paths input, implemented in ./snapshot.ts
// Ported from backend/packages/harness/deerflow/tools/builtins/present_file_tool.py:present_files @ 0950924 — the presented-paths side
//
// WHAT THIS RESTORES. DeerFlow's run worker enforces delivery: every regular file created or
// modified under `/mnt/user-data/outputs` during a run must be covered by a path the journal
// attributes to `present_files`, or the run is terminalized `error` with
// `_DELIVERY_INCOMPLETE_ERROR`; the receipt (`run.delivery`, category `outputs`) is persisted
// BEFORE the terminal status so a terminal run can never outlive its receipt
// [worker.py:934-986, 1044-1113; notes/runtime-and-persistence.md steps 16 + 19].
//
// M5 could not carry that and said so: `docs/sandbox-contract.md` §3 recorded the enforcement as
// "the port relies on prompt policy — a genuine weakening". M13 restores it at the port's own
// layer. The two halves of the original contract map like this:
//
//   original                                  port
//   ----------------------------------------  ------------------------------------------------
//   `present_files(paths)` tool call           the file's path appearing in the final message
//   `artifacts` state channel                  `presented_paths` extracted from that message
//   worker delivery verdict -> run error       Stop hook block (src/hooks/delivery-gate.ts)
//   `run.delivery` put_if_absent receipt       the `delivery` field of run-meta.json, put-if-absent
//
// THE ONE STRUCTURAL LIBERTY, STATED. `src/state/run-meta.ts` types the receipt as
// `{presented_paths, receipt_at}` and is owned by another lane, so this module does not edit it.
// It writes a STRUCTURAL WIDENING instead — {@link DeliveryReceiptFields} adds `produced_paths`,
// `matched_paths` and `satisfied`, and is passed through the existing `applyRunTransition` API,
// which serializes the whole object. Every existing reader of `DeliveryReceipt` keeps working
// (the two original fields are present and mean what they always meant); the extra fields are the
// evidence the original's receipt content carried [worker.py:176-205].
import { basename } from 'node:path';
import { applyRunTransition, readStateFile } from '../state/index.js';
/**
 * `worker.py:_DELIVERY_INCOMPLETE_ERROR` (163-165), verbatim.
 *
 * Model-facing text: do not reword. It heads the Stop-hook block reason for the same reason it
 * headed the original's run error — it names the contract that was broken, not the symptom.
 */
export const DELIVERY_INCOMPLETE_ERROR = 'Artifact delivery incomplete: no produced output artifact was presented';
/**
 * One escape hatch for BOTH halves of the feature — the pre-turn snapshot and the Stop gate.
 *
 * It lives here rather than in either hook for the reason `DISABLE_READ_GATE_ENV_VAR` lives in
 * `src/middleware/read-marks.ts`: a flag two entry points must agree on is not owned by either of
 * them. Setting it makes the snapshot hook write nothing, so the gate finds no baseline and stands
 * down — the feature disappears rather than half-runs.
 */
export const DISABLE_DELIVERY_GATE_ENV_VAR = 'DEERFLOW_DISABLE_DELIVERY_GATE';
/**
 * The user-facing half of the contract, verbatim from `docs/sandbox-contract.md` §3.
 *
 * The same sentence is already in the lead prompt and in every converted skill; repeating it in
 * the block reason means the model is corrected with the rule it was given, not a new one.
 */
export const OUTPUTS_DELIVERY_POLICY = 'Files produced for the user land in ./outputs/, and every file placed there MUST be listed in the final response.';
/**
 * Extension shape a bare filename must have before a token counts as a path reference.
 *
 * Two to eight characters, at least one of them a letter. This is what keeps prose out of the
 * receipt: `e.g` (one char) and `v1.20` (no letter) are rejected, `report.md`, `data.csv` and
 * `bundle.7z` are kept.
 */
const FILE_EXTENSION_RE = /^\.(?=[A-Za-z0-9]{2,8}$)[A-Za-z0-9]*[A-Za-z][A-Za-z0-9]*$/;
/** Characters a path token may contain. Markdown wrappers (backticks, brackets, quotes) are not among them. */
const PATH_TOKEN_RE = /[A-Za-z0-9_@~.+\-/\\]+/g;
/** Trailing sentence punctuation to peel off a token. */
const TRAILING_PUNCTUATION_RE = /[.,:;!?)\]}>'"]+$/;
function extensionOf(token) {
    const base = basename(token);
    const dot = base.lastIndexOf('.');
    if (dot <= 0)
        return '';
    return base.slice(dot);
}
/** Normalize one candidate: Windows separators to POSIX, `./` prefix and trailing `/` removed. */
function normalizePathToken(token) {
    let normalized = token.split('\\').join('/');
    while (normalized.startsWith('./'))
        normalized = normalized.slice(2);
    while (normalized.length > 1 && normalized.endsWith('/'))
        normalized = normalized.slice(0, -1);
    return normalized;
}
/**
 * Path-like tokens mentioned in a message, deduplicated and sorted.
 *
 * The port's stand-in for the original's `artifacts` state channel: DeerFlow knew what was
 * presented because `present_files` appended it, and the port has no such interception point
 * (`sandbox-contract.md` §3, consequence 3), so it reads the model's own final message.
 *
 * A token qualifies when it contains a `/` (any relative or absolute path) or when it is a bare
 * filename with a plausible extension. Deliberately permissive: a false positive here can only
 * ever *credit* a delivery, and the alternative — a false negative — blocks a turn that did the
 * right thing, which is the failure mode that would make this gate intolerable.
 */
export function extractPresentedPaths(text) {
    if (typeof text !== 'string' || text.length === 0)
        return [];
    const found = new Set();
    for (const raw of text.match(PATH_TOKEN_RE) ?? []) {
        const trimmed = raw.replace(TRAILING_PUNCTUATION_RE, '');
        if (trimmed.length === 0)
            continue;
        const normalized = normalizePathToken(trimmed);
        if (normalized.length === 0 || normalized === '/' || normalized === '.')
            continue;
        const qualifies = normalized.includes('/') || FILE_EXTENSION_RE.test(extensionOf(normalized));
        if (!qualifies)
            continue;
        found.add(normalized);
    }
    return [...found].sort();
}
/**
 * Whether one presented token covers one produced path.
 *
 * Both directions of suffix containment are accepted, because a model legitimately writes the same
 * file three ways: `outputs/report.md` (the produced path), `report.md` (its basename), or
 * `/abs/project/outputs/report.md` (an absolute path). Suffix matching on a `/` boundary accepts
 * all three and still refuses `other-report.md`.
 */
export function coversProducedPath(presented, produced) {
    if (presented === produced)
        return true;
    if (produced.endsWith(`/${presented}`))
        return true;
    if (presented.endsWith(`/${produced}`))
        return true;
    return false;
}
/**
 * The delivery verdict — the port of `worker.py`'s "were the produced outputs presented" check
 * (951-967).
 *
 * An empty `producedPaths` is satisfied by construction: the original only failed a run that
 * produced outputs and presented none of them, and a turn that wrote nothing to `outputs/` owes
 * the user nothing.
 */
export function evaluateDelivery(input) {
    const produced = [...new Set(input.producedPaths)].sort();
    const presented = extractPresentedPaths(input.finalMessageText);
    const matched = produced.filter((path) => presented.some((token) => coversProducedPath(token, path)));
    const missing = produced.filter((path) => !matched.includes(path));
    return {
        satisfied: missing.length === 0,
        produced_paths: produced,
        presented_paths: presented,
        matched_paths: matched,
        missing,
    };
}
/** Build the receipt for one verdict. Pure: the clock is injected. */
export function buildDeliveryReceipt(verdict, now) {
    return {
        presented_paths: [...verdict.matched_paths],
        matched_paths: [...verdict.matched_paths],
        produced_paths: [...verdict.produced_paths],
        satisfied: verdict.satisfied,
        receipt_at: now,
    };
}
/**
 * Write the receipt into `run-meta.json` through the existing state API.
 *
 * Three properties are inherited rather than reimplemented, which is the whole reason this goes
 * through `applyRunTransition` instead of writing the file directly:
 *   1. **put-if-absent** — `transitionRunMeta` keeps `current.delivery` when one exists, so a
 *      receipt written by an earlier finalize (or by the orphan backfill) is never overwritten.
 *      This is the port's form of `event_store.put_if_absent` [worker.py:1061-1113].
 *   2. **atomic rename + `rev` CAS** — the receipt and the run status land in one file write, so
 *      the original's receipt-before-status ordering window does not exist here at all (run-meta.ts
 *      header, guarantee G6).
 *   3. **terminal guard** — the transition re-asserts the run's CURRENT status, so this call can
 *      never terminalize a live run nor downgrade a terminal one. A Stop hook fires at the end of a
 *      TURN, which is not necessarily the end of the run (the M11 goal loop may continue it).
 */
export function recordDeliveryReceipt(filePath, verdict, options) {
    const current = readStateFile(filePath)?.payload.run ?? null;
    if (current === null)
        return { kind: 'no-run' };
    if (current.delivery !== undefined)
        return { kind: 'preserved', receipt: current.delivery };
    const receipt = buildDeliveryReceipt(verdict, options.now);
    applyRunTransition(filePath, {
        status: current.status,
        now: options.now,
        delivery: receipt,
    }, { now: options.now, ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }) });
    return { kind: 'written', receipt };
}
/**
 * The Stop-hook block reason.
 *
 * Structure mirrors what the original told the operator: the verbatim contract error first, then
 * the evidence (which files), then the rule, then the two ways out. The last one matters —
 * `sandbox-contract.md` §3 consequence 1 says `outputs/` is for the user, not for the agent, so
 * "move it out" is a correct resolution and not an escape hatch.
 */
export function renderDeliveryBlockReason(verdict) {
    const single = verdict.missing.length === 1;
    const listed = verdict.missing.map((path) => `  - ${path}`).join('\n');
    return [
        `${DELIVERY_INCOMPLETE_ERROR}.`,
        '',
        single
            ? 'This turn created or modified a file under ./outputs/ that your final response does not name:'
            : 'This turn created or modified files under ./outputs/ that your final response does not name:',
        listed,
        '',
        OUTPUTS_DELIVERY_POLICY,
        '',
        `Present ${single ? 'it' : 'them'} to the user now: reply with each path above and one line saying what the file is. If one of them is scratch data rather than a deliverable, move it out of ./outputs/ instead — that directory is for the user, not for the agent.`,
    ].join('\n');
}
/** Flatten a transcript entry's `content` into plain text. Anything unrecognized contributes nothing. */
function textOfContent(content) {
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return '';
    const parts = [];
    for (const block of content) {
        if (typeof block === 'string') {
            parts.push(block);
            continue;
        }
        if (typeof block !== 'object' || block === null)
            continue;
        const record = block;
        if (record['type'] !== 'text')
            continue;
        const text = record['text'];
        if (typeof text === 'string')
            parts.push(text);
    }
    return parts.join('\n');
}
/**
 * The assistant text of the turn that is ending, read from a JSONL transcript.
 *
 * Defensive by contract: every line that is not a well-formed user/assistant entry is skipped
 * rather than aborting the read, exactly as `src/hooks/stop-goal-evaluator.ts` does.
 *
 * "The final message" is taken as every assistant text block AFTER the last `user` entry, not
 * literally the last entry. Claude Code writes tool results as `user` entries and may split one
 * response across several assistant entries, so this resolves to the final message when there is a
 * single one and stays correct when there is not. Reading wider than the last entry can only add
 * text, i.e. only ever credit a delivery — the safe direction for a gate that blocks.
 */
export function extractFinalAssistantText(raw) {
    const assistantTexts = [];
    for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length === 0)
            continue;
        let entry;
        try {
            entry = JSON.parse(trimmed);
        }
        catch {
            continue;
        }
        if (typeof entry !== 'object' || entry === null)
            continue;
        const record = entry;
        const type = record['type'];
        if (type !== 'user' && type !== 'assistant')
            continue;
        if (type === 'user') {
            assistantTexts.length = 0; // A new user boundary discards the previous turn's output.
            continue;
        }
        const message = record['message'];
        const content = typeof message === 'object' && message !== null ? message['content'] : record['content'];
        const text = textOfContent(content).trim();
        if (text.length > 0)
            assistantTexts.push(text);
    }
    return assistantTexts.join('\n');
}
