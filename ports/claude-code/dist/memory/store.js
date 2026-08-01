// Ported from backend/packages/harness/deerflow/agents/memory/backends/deermem/deermem/core/{storage.py,paths.py} @ 0950924
// — structural translation (traceability-matrix.md §"deermem core/storage.py + core/paths.py").
//
// What is preserved exactly:
//   * the DeerMem v2 split — ONE summary JSON holding only the six summary slots (it never
//     stores facts or a fact index, storage.py:84-101) plus ONE Markdown file per fact;
//   * the shard prefix: `facts/{sha256(fact_id)[:2]}/{fact_id}.md` (paths.py:105-116) — the
//     digest is over the *fact id*, not the content;
//   * the fact-id charset `[A-Za-z0-9_-]+` (paths.py:112, storage.py:190) and the nine core
//     categories (storage.py:39);
//   * never-torn writes: temp file in the same directory -> fsync -> rename(2) -> parent-dir
//     fsync (storage.py:_atomic_write / _fsync_parent_directory).
//
// What is deliberately dropped (Claude Code sessions are effectively single-writer —
// notes/skills-and-memory.md §6 "What to drop"): the per-scope advisory file lock, the
// shared-manifest + per-fact optimistic revision pair, the recovery journal, and the
// v1->v2 migration. The port keeps `revision` as a monotonic counter on the summary file
// (it is part of the documented on-disk shape) but does not use it as a CAS token — the
// state library's own `rev` envelope already provides compare-and-set (src/state/atomic-io.ts).
//
// Deviation from upstream's `_render_fact_markdown`: the port omits the `# {title}` heading
// line, so the Markdown body IS the atomic fact text and read/write round-trips byte-exactly.
// Upstream derived that heading from the first content line purely for human browsing.
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { readStateFile, updateStateFile } from '../state/atomic-io.js';
import { resolveProjectRoot } from '../state/paths.js';
/** Directory (relative to the project root) that holds the port's memory tree. */
export const MEMORY_DIR_SEGMENTS = ['.deerflow', 'memory'];
/** Summary-document filename — DeerMem's `manifest_filename` default (config.py:57-70). */
export const MEMORY_MANIFEST_FILENAME = 'memory.json';
/** Fact-tree root name below the memory root (paths.py:105-116). */
export const FACTS_DIR_NAME = 'facts';
/** DeerMem schema v2 document version (storage.py:38). */
export const DOCUMENT_VERSION = '2.0';
/** The nine core fact categories (storage.py:39). Anything else normalizes to `other`. */
export const CORE_CATEGORIES = ['preference', 'correction', 'context', 'goal', 'behavior', 'identity', 'constraint', 'decision', 'other'];
/** Fact ids must be filesystem-safe in every backend (paths.py:112). */
export const FACT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
/** The three `user` summary slots, in render order (storage.py:84-101). */
export const USER_SLOTS = ['workContext', 'personalContext', 'topOfMind'];
/** The three `history` summary slots, in render order (storage.py:84-101). */
export const HISTORY_SLOTS = ['recentMonths', 'earlierContext', 'longTermBackground'];
/** Raised when a fact id would escape the shard tree or break the path contract. */
export class InvalidFactIdError extends Error {
    factId;
    name = 'InvalidFactIdError';
    constructor(factId) {
        super(`Invalid fact id ${JSON.stringify(factId)}: expected one or more of [A-Za-z0-9_-]`);
        this.factId = factId;
    }
}
/** Raised when a stored fact file cannot be interpreted — upstream `MemoryStorageCorruption`. */
export class FactCorruptError extends Error {
    filePath;
    detail;
    name = 'FactCorruptError';
    constructor(filePath, detail) {
        super(`Failed to parse canonical fact ${filePath}: ${detail}`);
        this.filePath = filePath;
        this.detail = detail;
    }
}
/** `<project-root>/.deerflow/memory`. */
export function memoryRoot(env) {
    return join(resolveProjectRoot(env), ...MEMORY_DIR_SEGMENTS);
}
/** `<memory-root>/memory.json`. */
export function memoryManifestPath(root) {
    return join(root, MEMORY_MANIFEST_FILENAME);
}
/** `<memory-root>/facts`. */
export function factsRoot(root) {
    return join(root, FACTS_DIR_NAME);
}
/** Validate a fact id against the path contract, or throw. */
export function validateFactId(factId) {
    if (typeof factId !== 'string' || !FACT_ID_PATTERN.test(factId))
        throw new InvalidFactIdError(factId);
    return factId;
}
/**
 * Shard prefix for one fact id: the first two hex characters of `sha256(fact_id)`.
 *
 * Ported verbatim from `paths.py:fact_file_path` — the digest is over the id string's
 * UTF-8 bytes, and only the first two hex characters are used.
 */
export function factShard(factId) {
    validateFactId(factId);
    return createHash('sha256').update(factId, 'utf8').digest('hex').slice(0, 2);
}
/** `<memory-root>/facts/{2hex}/{fact-id}.md`. */
export function factFilePath(root, factId) {
    return join(factsRoot(root), factShard(factId), `${factId}.md`);
}
function emptySlot() {
    return { summary: '', updatedAt: '' };
}
/** The empty summary document — DeerMem's `create_empty_memory` minus the `facts` key. */
export function createEmptyMemoryDocument(now) {
    return {
        version: DOCUMENT_VERSION,
        revision: 0,
        lastUpdated: now,
        user: { workContext: emptySlot(), personalContext: emptySlot(), topOfMind: emptySlot() },
        history: { recentMonths: emptySlot(), earlierContext: emptySlot(), longTermBackground: emptySlot() },
    };
}
function coerceSlot(value) {
    if (typeof value !== 'object' || value === null)
        return emptySlot();
    const record = value;
    return {
        summary: typeof record['summary'] === 'string' ? record['summary'] : '',
        updatedAt: typeof record['updatedAt'] === 'string' ? record['updatedAt'] : '',
    };
}
function coerceDocument(payload, now) {
    if (payload === null)
        return createEmptyMemoryDocument(now);
    const userRaw = (payload['user'] ?? {});
    const historyRaw = (payload['history'] ?? {});
    const user = {};
    for (const slot of USER_SLOTS)
        user[slot] = coerceSlot(userRaw[slot]);
    const history = {};
    for (const slot of HISTORY_SLOTS)
        history[slot] = coerceSlot(historyRaw[slot]);
    const revision = payload['revision'];
    return {
        version: typeof payload['version'] === 'string' ? payload['version'] : DOCUMENT_VERSION,
        revision: typeof revision === 'number' && Number.isInteger(revision) && revision >= 0 ? revision : 0,
        lastUpdated: typeof payload['lastUpdated'] === 'string' ? payload['lastUpdated'] : now,
        user,
        history,
    };
}
/**
 * Read `memory.json`.
 *
 * An absent document is empty, never an error — matching upstream, where the first read of
 * a fresh user bucket materializes `create_empty_memory()`.
 */
export function readMemoryDocument(root, now) {
    const envelope = readStateFile(memoryManifestPath(root));
    return coerceDocument(envelope?.payload ?? null, now);
}
/**
 * Merge summary prose into `memory.json`, bumping `revision` and `lastUpdated`.
 *
 * Supplied child keys merge over their persisted section (upstream: "Supplied summary child
 * keys merge over their persisted section"); untouched slots keep their prior `updatedAt`.
 */
export function updateMemoryDocument(root, update, now) {
    const envelope = updateStateFile(memoryManifestPath(root), (current) => {
        const document = coerceDocument(current, now);
        const user = { ...document.user };
        for (const slot of USER_SLOTS) {
            const next = update.user?.[slot];
            if (typeof next === 'string')
                user[slot] = { summary: next, updatedAt: now };
        }
        const history = { ...document.history };
        for (const slot of HISTORY_SLOTS) {
            const next = update.history?.[slot];
            if (typeof next === 'string')
                history[slot] = { summary: next, updatedAt: now };
        }
        return {
            version: DOCUMENT_VERSION,
            revision: document.revision + 1,
            lastUpdated: now,
            user,
            history,
        };
    }, { now });
    return coerceDocument(envelope.payload, now);
}
// ── Fact Markdown -------------------------------------------------------------------------
/**
 * Emit one scalar as YAML. Only the shapes the front matter can hold are supported
 * (string / finite number / null), which keeps the writer dependency-free and deterministic.
 */
function yamlScalar(value) {
    if (value === null)
        return 'null';
    if (typeof value === 'number')
        return String(value);
    // Quote whenever the value could be misread as another YAML type or contains structure.
    const needsQuote = value === '' || /^[\s]|[\s]$|[:#\-?,[\]{}&*!|>'"%@`]|^(?:true|false|null|~)$|^[-+]?[0-9.]/i.test(value);
    if (!needsQuote)
        return value;
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}
function parseYamlScalar(raw) {
    const trimmed = raw.trim();
    if (trimmed === 'null' || trimmed === '~' || trimmed === '')
        return null;
    if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
        return trimmed
            .slice(1, -1)
            .replace(/\\n/g, '\n')
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, '\\');
    }
    if (/^[-+]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][-+]?[0-9]+)?$/.test(trimmed)) {
        const numeric = Number(trimmed);
        if (Number.isFinite(numeric))
            return numeric;
    }
    return trimmed;
}
/** Normalize an arbitrary category string onto the core set (storage.py:_normalize_category). */
export function normalizeCategory(raw) {
    if (typeof raw !== 'string' || raw.trim() === '')
        return 'context';
    const category = raw.trim();
    return CORE_CATEGORIES.includes(category) ? category : 'other';
}
/** Render one fact as its canonical Markdown file body. */
export function renderFactMarkdown(fact) {
    const lines = ['---'];
    lines.push(`id: ${yamlScalar(fact.id)}`);
    lines.push(`category: ${yamlScalar(fact.category)}`);
    lines.push(`confidence: ${yamlScalar(fact.confidence)}`);
    lines.push(`createdAt: ${yamlScalar(fact.createdAt)}`);
    if (fact.expectedValidDays !== undefined)
        lines.push(`expected_valid_days: ${yamlScalar(fact.expectedValidDays)}`);
    lines.push(`source: ${yamlScalar(fact.source.type)}`);
    lines.push(`source_thread_id: ${yamlScalar(fact.source.threadId)}`);
    if (fact.sourceError !== undefined)
        lines.push(`sourceError: ${yamlScalar(fact.sourceError)}`);
    lines.push('---');
    lines.push('');
    return `${lines.join('\n')}\n${fact.content.replace(/\s+$/, '')}\n`;
}
/** Parse one canonical fact Markdown file body. Throws {@link FactCorruptError} on damage. */
export function parseFactMarkdown(text, filePath) {
    if (!text.startsWith('---\n'))
        throw new FactCorruptError(filePath, 'missing YAML front matter');
    const separator = text.indexOf('\n---\n', 3);
    if (separator === -1)
        throw new FactCorruptError(filePath, 'unterminated YAML front matter');
    const front = text.slice(4, separator + 1);
    const body = text.slice(separator + 5).replace(/^\n+/, '');
    const metadata = {};
    for (const line of front.split('\n')) {
        if (line.trim() === '')
            continue;
        const colon = line.indexOf(':');
        if (colon === -1)
            throw new FactCorruptError(filePath, `front matter line is not a mapping: ${JSON.stringify(line)}`);
        metadata[line.slice(0, colon).trim()] = parseYamlScalar(line.slice(colon + 1));
    }
    const id = metadata['id'];
    if (typeof id !== 'string' || !FACT_ID_PATTERN.test(id))
        throw new FactCorruptError(filePath, 'front matter is missing a valid id');
    const confidence = metadata['confidence'];
    if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
        throw new FactCorruptError(filePath, 'front matter confidence must be a number in [0, 1]');
    }
    const content = body.replace(/\s+$/, '');
    if (content === '')
        throw new FactCorruptError(filePath, 'fact body is empty');
    const expected = metadata['expected_valid_days'];
    const sourceType = metadata['source'];
    const sourceThreadId = metadata['source_thread_id'];
    const sourceError = metadata['sourceError'];
    const createdAt = metadata['createdAt'];
    const fact = {
        id,
        category: normalizeCategory(metadata['category']),
        confidence,
        createdAt: typeof createdAt === 'string' ? createdAt : '',
        source: {
            type: typeof sourceType === 'string' && sourceType !== '' ? sourceType : 'unknown',
            threadId: typeof sourceThreadId === 'string' && sourceThreadId !== '' ? sourceThreadId : null,
        },
        content,
        ...(typeof expected === 'number' && Number.isInteger(expected) && expected > 0 ? { expectedValidDays: expected } : {}),
        ...(typeof sourceError === 'string' && sourceError !== '' ? { sourceError } : {}),
    };
    return fact;
}
let tempCounter = 0;
/**
 * Never-torn text write: temp file in the same directory -> fsync -> rename(2) -> dir fsync.
 *
 * Mirrors `src/state/atomic-io.ts:writeStateFile`, which cannot be reused directly because
 * fact files are Markdown rather than the JSON `rev` envelope that library owns.
 */
function atomicWriteText(filePath, body) {
    const dir = dirname(filePath);
    mkdirSync(dir, { recursive: true });
    const tempPath = join(dir, `.${filePath.split(/[\\/]/).pop() ?? 'fact'}.${process.pid}-${tempCounter++}.tmp`);
    const fd = openSync(tempPath, 'w');
    try {
        writeSync(fd, body);
        fsyncSync(fd);
    }
    finally {
        closeSync(fd);
    }
    renameSync(tempPath, filePath);
    try {
        const dirFd = openSync(dir, 'r');
        try {
            fsyncSync(dirFd);
        }
        finally {
            closeSync(dirFd);
        }
    }
    catch {
        // Directory fsync is a durability nicety; the rename is already atomic.
    }
}
/** Persist one fact at its sharded path. Returns the absolute file path written. */
export function writeFact(root, fact) {
    validateFactId(fact.id);
    const path = factFilePath(root, fact.id);
    atomicWriteText(path, renderFactMarkdown(fact));
    return path;
}
/** Read one fact by id, or `null` when it does not exist. */
export function readFact(root, factId) {
    const path = factFilePath(root, factId);
    let raw;
    try {
        raw = readFileSync(path, 'utf8');
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        throw error;
    }
    return parseFactMarkdown(raw, path);
}
/** Delete one fact. Returns whether a file was removed. */
export function deleteFact(root, factId) {
    const path = factFilePath(root, factId);
    try {
        rmSync(path);
        return true;
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return false;
        throw error;
    }
}
/**
 * Walk every shard and return the canonical facts, sorted by id for determinism.
 *
 * Individual malformed files are skipped rather than aborting the walk — upstream:
 * "Individual malformed facts are logged and skipped without triggering repeated full scans".
 * The skipped paths are returned so a caller can surface them honestly.
 */
export function listFacts(root) {
    const factsDir = factsRoot(root);
    let shards;
    try {
        shards = readdirSync(factsDir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && /^[0-9a-f]{2}$/.test(entry.name))
            .map((entry) => entry.name);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return { facts: [], skipped: [] };
        throw error;
    }
    const facts = [];
    const skipped = [];
    for (const shard of shards.sort()) {
        const shardDir = join(factsDir, shard);
        const entries = readdirSync(shardDir, { withFileTypes: true })
            .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && !entry.name.startsWith('.'))
            .map((entry) => entry.name)
            .sort();
        for (const name of entries) {
            const path = join(shardDir, name);
            try {
                facts.push({ fact: parseFactMarkdown(readFileSync(path, 'utf8'), path), shard, path });
            }
            catch {
                skipped.push(path);
            }
        }
    }
    facts.sort((left, right) => (left.fact.id < right.fact.id ? -1 : left.fact.id > right.fact.id ? 1 : 0));
    return { facts, skipped };
}
