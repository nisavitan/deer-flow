// Memory store CLI: `node dist/memory/store-cli.js <command>`.
//
// Persists only what `gate-cli.js` accepted, and renders what is already stored. It never
// evaluates eligibility itself — that belongs to write-gate.ts — so the two stages cannot drift
// into a path where model output reaches disk ungated.
//
// Commands (all read JSON on stdin where noted, all write JSON on stdout):
//   render                 — summaries + fact counts by category, plus the `<memory>` block.
//   list                   — every stored fact (id, category, confidence, content).
//   apply                  — stdin: a gate result `{acceptedFacts, acceptedSummaries,
//                            acceptedRemovals, trimmedExistingIds}`; writes facts, merges
//                            summaries, deletes removals/trims/consolidation sources.
//   queue-read             — the queued conversation batches awaiting extraction.
//   queue-clear            — truncate the queue (run only after `apply` succeeded).
import { randomBytes } from 'node:crypto';
import { buildMemoryBlock } from './injection.js';
import { listFacts, deleteFact, memoryRoot, readMemoryDocument, updateMemoryDocument, writeFact, HISTORY_SLOTS, USER_SLOTS, } from './store.js';
import { clearQueue, queuePath, readQueue } from './queue.js';
function readStdin() {
    return new Promise((resolve, reject) => {
        const chunks = [];
        process.stdin.on('data', (chunk) => chunks.push(chunk));
        process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        process.stdin.on('error', reject);
    });
}
function fail(message) {
    process.stderr.write(`${message}\n`);
    process.exit(2);
}
/** Fresh fact id — upstream's `fact_{uuid4().hex}` shape, inside the `[A-Za-z0-9_-]` charset. */
export function newFactId() {
    return `fact_${randomBytes(16).toString('hex')}`;
}
const command = process.argv[2] ?? 'render';
const root = memoryRoot();
const now = new Date().toISOString();
if (command === 'render') {
    const document = readMemoryDocument(root, now);
    const { facts, skipped } = listFacts(root);
    const byCategory = {};
    for (const stored of facts)
        byCategory[stored.fact.category] = (byCategory[stored.fact.category] ?? 0) + 1;
    const block = buildMemoryBlock({
        user: Object.fromEntries(USER_SLOTS.map((slot) => [slot, { summary: document.user[slot].summary }])),
        history: Object.fromEntries(HISTORY_SLOTS.map((slot) => [slot, { summary: document.history[slot].summary }])),
        facts: facts.map((stored) => stored.fact),
    });
    process.stdout.write(`${JSON.stringify({ root, version: document.version, revision: document.revision, lastUpdated: document.lastUpdated, user: document.user, history: document.history, factCount: facts.length, factsByCategory: byCategory, unreadableFactFiles: skipped, memoryBlock: block }, null, 2)}\n`);
    process.exitCode = 0;
}
else if (command === 'list') {
    const { facts, skipped } = listFacts(root);
    process.stdout.write(`${JSON.stringify({ facts: facts.map((stored) => stored.fact), unreadableFactFiles: skipped }, null, 2)}\n`);
    process.exitCode = 0;
}
else if (command === 'queue-read') {
    process.stdout.write(`${JSON.stringify({ path: queuePath(), entries: readQueue() }, null, 2)}\n`);
    process.exitCode = 0;
}
else if (command === 'queue-clear') {
    clearQueue();
    process.stdout.write(`${JSON.stringify({ cleared: true, path: queuePath() }, null, 2)}\n`);
    process.exitCode = 0;
}
else if (command === 'apply') {
    const raw = await readStdin();
    let payload;
    try {
        payload = JSON.parse(raw);
    }
    catch (error) {
        fail(`store-cli apply: stdin is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    const written = [];
    const deleted = [];
    for (const accepted of payload.acceptedFacts ?? []) {
        const fact = {
            id: newFactId(),
            category: accepted.category,
            confidence: accepted.confidence,
            createdAt: now,
            source: { type: accepted.origin === 'factsToConsolidate' ? 'consolidation' : 'conversation', threadId: payload.sourceThreadId ?? null },
            content: accepted.content,
            ...(accepted.expectedValidDays === undefined ? {} : { expectedValidDays: accepted.expectedValidDays }),
            ...(accepted.sourceError === undefined ? {} : { sourceError: accepted.sourceError }),
        };
        writeFact(root, fact);
        written.push(fact.id);
        // A consolidated fact replaces its sources only after it is durably on disk.
        for (const sourceId of accepted.consolidatedFrom ?? [])
            if (deleteFact(root, sourceId))
                deleted.push(sourceId);
    }
    for (const removal of payload.acceptedRemovals ?? [])
        if (deleteFact(root, removal.id))
            deleted.push(removal.id);
    for (const trimmed of payload.trimmedExistingIds ?? [])
        if (deleteFact(root, trimmed))
            deleted.push(trimmed);
    const user = {};
    const history = {};
    for (const summary of payload.acceptedSummaries ?? []) {
        if (summary.section === 'user' && USER_SLOTS.includes(summary.slot))
            user[summary.slot] = summary.summary;
        if (summary.section === 'history' && HISTORY_SLOTS.includes(summary.slot))
            history[summary.slot] = summary.summary;
    }
    const document = Object.keys(user).length > 0 || Object.keys(history).length > 0 ? updateMemoryDocument(root, { user, history }, now) : readMemoryDocument(root, now);
    process.stdout.write(`${JSON.stringify({ writtenFactIds: written, deletedFactIds: deleted, revision: document.revision }, null, 2)}\n`);
    process.exitCode = 0;
}
else {
    fail(`store-cli: unknown command ${JSON.stringify(command)} (expected render|list|apply|queue-read|queue-clear)`);
}
