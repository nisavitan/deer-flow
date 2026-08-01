// Deterministic write-gate CLI: `node dist/memory/gate-cli.js`.
//
// This is the enforcement boundary that keeps the port's architecture honest. The model may
// PROPOSE memory writes (by following the verbatim extraction prompt), but only this process
// decides what is eligible — exactly as upstream, where the LLM's output passes through
// `_apply_updates`' deterministic scope gate before touching storage.
//
// Contract:
//   stdin  — JSON `{ "proposal": <extractor output>, "existingFacts": [{id, content, confidence}],
//                    "options": { confidenceThreshold?, maxFacts?, expectedValidDaysCeiling? } }`
//            `existingFacts` may be omitted; when absent it is read from the store on disk.
//   stdout — JSON `WriteGateResult` (accepted*, rejections, trimmedExistingIds, rejectionRate).
//   exit   — 0 on a decision (even an all-reject one), 2 on unusable input.
//
// Rejecting everything is a valid, successful decision: an un-migrated prompt that drops the
// scope/durability/authority labels makes the fail-closed gate reject every write, which
// upstream surfaces through `rejected_by_scope_gate` and a >60% rejection-rate warning.
import { listFacts, memoryRoot } from './store.js';
import { applyWriteGate } from './write-gate.js';
/** Rejection rate above which upstream logs a warning (manager.py:681-741). */
export const REJECTION_RATE_WARNING_THRESHOLD = 0.6;
function readStdin() {
    return new Promise((resolve, reject) => {
        const chunks = [];
        process.stdin.on('data', (chunk) => chunks.push(chunk));
        process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        process.stdin.on('error', reject);
    });
}
function coerceExistingFacts(value) {
    if (!Array.isArray(value))
        return null;
    const facts = [];
    for (const entry of value) {
        if (typeof entry !== 'object' || entry === null)
            continue;
        const record = entry;
        if (typeof record['id'] !== 'string' || typeof record['content'] !== 'string')
            continue;
        facts.push({
            id: record['id'],
            content: record['content'],
            confidence: typeof record['confidence'] === 'number' ? record['confidence'] : 0.5,
        });
    }
    return facts;
}
function fail(message) {
    process.stderr.write(`${message}\n`);
    process.exit(2);
}
const raw = await readStdin();
let input;
try {
    input = JSON.parse(raw);
}
catch (error) {
    fail(`gate-cli: stdin is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
}
if (typeof input.proposal !== 'object' || input.proposal === null) {
    fail('gate-cli: expected {"proposal": { ... }} on stdin');
}
const supplied = coerceExistingFacts(input.existingFacts);
const existingFacts = supplied ??
    listFacts(memoryRoot()).facts.map((stored) => ({
        id: stored.fact.id,
        content: stored.fact.content,
        confidence: stored.fact.confidence,
    }));
const result = applyWriteGate(input.proposal, { ...(input.options ?? {}), existingFacts });
process.stdout.write(`${JSON.stringify({ ...result, warnHighRejectionRate: result.rejectionRate > REJECTION_RATE_WARNING_THRESHOLD }, null, 2)}\n`);
process.exitCode = 0;
