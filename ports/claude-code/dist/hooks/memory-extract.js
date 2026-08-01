// M9 memory capture: Stop hook. Appends the turn's last user message and last assistant
// response to `.deerflow/memory/queue.jsonl`.
//
// Ports backend/packages/harness/deerflow/agents/middlewares/memory_middleware.py:MemoryMiddleware
// (lead slot 23) @ 0950924 — structural translation. Upstream's `aafter_agent` filters the
// conversation to user inputs plus the final AI response and enqueues it for a debounced
// background extraction pass; this hook is the port's equivalent capture point.
//
// DECLARED APPROXIMATION — batch-on-next-turn. Claude Code has no long-lived server process to
// host a timer thread, and a hook must not block the turn on an LLM call, so the 30-second
// debounce becomes "extract on the next turn". Recorded in parity/DISCREPANCIES.md
// §M9 entry 1; the queue mechanics live in src/memory/queue.ts.
//
// This file is EXECUTABLE: its top level runs on import. Keep it a thin wrapper — every piece of
// reusable logic belongs in src/memory/queue.ts, so a library consumer never accidentally runs
// the hook (and never has its stdin consumed by it).
//
// Never blocks. Every path exits 0 with no stdout: a Stop hook that emits output or a non-zero
// status can interrupt the session, and memory capture is strictly best-effort — upstream drops a
// `QueueFull` update and re-feeds it next turn because the watermark does not advance.
import { readFileSync } from 'node:fs';
import { appendQueueEntry, extractTurn } from '../memory/queue.js';
/** Milliseconds to wait for the hook payload before giving up. */
const STDIN_TIMEOUT_MS = 2000;
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
        return;
    }
    const transcriptPath = payload.transcript_path;
    if (typeof transcriptPath !== 'string' || transcriptPath === '')
        return;
    let transcript;
    try {
        transcript = readFileSync(transcriptPath, 'utf8');
    }
    catch {
        return;
    }
    const turn = extractTurn(transcript);
    if (turn === null)
        return;
    appendQueueEntry({
        capturedAt: new Date().toISOString(),
        sessionId: typeof payload.session_id === 'string' ? payload.session_id : null,
        user: turn.user,
        assistant: turn.assistant,
    });
}
try {
    await main();
}
catch {
    // Best effort: memory capture must never interrupt the session.
}
process.stdin.destroy();
process.exitCode = 0;
