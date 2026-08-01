// M7 read-mark stamper: PostToolUse hook on Read. Records the sha256 of what the model was just
// shown, so the write gate can tell "read it" from "read an older version of it".
//
// Ports the mark-stamping half of
// backend/packages/harness/deerflow/agents/middlewares/read_before_write_middleware.py
// (`_attach_read_mark`, lines 240-258) @ 0950924. The store lives in src/middleware/read-marks.ts;
// src/hooks/write-gate.ts is the other half.
//
// TIMING IS THE POINT. The original stamps the mark AFTER the read handler returns, hashing the
// file's content at that instant, "so a mark always hashes the version the model was actually
// shown". PostToolUse is the same instant. Stamping before the read (PreToolUse) would let a file
// change between the hash and the read and hand the model a mark for content it never saw.
//
// The original's per-(scope, path) lock, which serialized the read with its stamping, has no
// counterpart: hooks are separate processes. The residual race — a file rewritten between Claude
// Code reading it and this hook hashing it — resolves in the SAFE direction: the mark then holds a
// hash the write gate will not match, so the next write is denied and asks for a fresh read.
import { pathToFileURL } from 'node:url';
import { DISABLE_READ_GATE_ENV_VAR, applyReadMark, hashFileIfReadable, normalizeMarkPath, readMarksPath, } from '../middleware/read-marks.js';
import { READ_TOOL_NAME } from '../middleware/tool-adapter.js';
import { appendHookLog, parseHookPayload, readStdin, resolveThreadId, } from '../middleware/hook-runtime.js';
/**
 * Stamp a read mark for one PostToolUse event.
 *
 * @returns the normalized path that was marked, or `null` when nothing was stamped (not a Read, no
 *          resolvable thread, gate disabled, or an unreadable/absent file). Never throws.
 */
export function stampReadFromPayload(payload, options) {
    const env = options.env ?? process.env;
    // Honours the same toggle as the gate: `read_before_write.enabled` governed BOTH halves in the
    // original, and a store that keeps filling while the gate is off would only mislead.
    if (env[DISABLE_READ_GATE_ENV_VAR] === '1')
        return null;
    if (payload.tool_name !== READ_TOOL_NAME)
        return null;
    const toolInput = payload.tool_input;
    if (typeof toolInput !== 'object' || toolInput === null)
        return null;
    const filePath = toolInput['file_path'];
    if (typeof filePath !== 'string' || filePath === '')
        return null;
    const threadId = resolveThreadId(payload, env);
    if (threadId === null)
        return null;
    // `null` means the file vanished or cannot be read as text (binary, permissions, a directory).
    // The original skips the mark in exactly those cases rather than inventing one.
    const hash = hashFileIfReadable(filePath);
    if (hash === null)
        return null;
    const normalized = normalizeMarkPath(filePath);
    try {
        applyReadMark(readMarksPath(threadId, env), { path: normalized, hash, at: options.now }, { now: options.now });
    }
    catch {
        return null;
    }
    return normalized;
}
async function main() {
    const payload = parseHookPayload(await readStdin());
    if (payload === null)
        return;
    // No stdout protocol: PostToolUse on Read has no decision to make and nothing to tell the model.
    const marked = stampReadFromPayload(payload, { now: new Date().toISOString() });
    // O3: always `silent` — this hook never speaks. The line records WHICH path got a mark, which is
    // the fact a write-gate scenario needs to correlate a later deny against.
    appendHookLog({
        hook: 'read-mark',
        event: 'PostToolUse',
        thread: resolveThreadId(payload, process.env),
        decision: 'silent',
        summary: `marked=${marked ?? 'none'}`,
    });
}
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
    try {
        await main();
    }
    catch {
        // A missing mark costs one extra read; a crashing hook costs the session.
    }
    process.stdin.destroy();
    process.exitCode = 0;
}
