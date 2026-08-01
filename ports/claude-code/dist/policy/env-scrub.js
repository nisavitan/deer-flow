// Ported from backend/packages/harness/deerflow/sandbox/env_policy.py:_SECRET_NAME_PATTERNS,_BLOCKED_EXACT_NAMES,is_blocked_env_name,build_sandbox_env @ 0950924 — mechanical TypeScript translation
// Ported from backend/packages/harness/deerflow/sandbox/tools.py:_MIN_MASK_LENGTH,mask_secret_values @ 0950924 — the >=8-char value floor is reused by detectSecretExposure
//
// Both name lists below are transcribed VERBATIM from env_policy.py; the comment
// blocks explaining *why* each entry exists live in the original and are summarized
// here rather than duplicated. Do not add, remove, or reorder entries without a
// matching change in the original — src/policy/env-scrub.test.ts pins the exact set.
//
// Divergence from the original, stated once: DeerFlow scrubs the inherited
// environment before spawning a sandbox subprocess (`build_sandbox_env`). Claude
// Code owns process spawning for the Bash tool, so the port cannot rewrite the
// child environment. `scrubEnv` is kept as the faithful translation (used by any
// port code that does spawn a child), while the load-bearing protection at the
// Bash boundary is the PreToolUse guard built on `detectSecretExposure` +
// `isSecretLikeName` (src/hooks/env-guard.ts) plus the deny rules in
// config/permissions-preset.json. See ports/claude-code/docs/sandbox-contract.md.
/**
 * Case-insensitive wildcard patterns for secret-looking variable names, matched
 * against the upper-cased variable name.
 *
 * Verbatim from `env_policy.py:_SECRET_NAME_PATTERNS` (24-46). `*PASS*` deliberately
 * subsumes `PASSWORD`/`PASSWD`, the abbreviated `DB_PASS` form, `PGPASSFILE`, the
 * `*_ASKPASS` credential helpers, and incidental `COMPASS_*`/`BYPASS_*` names —
 * over-scrubbing is the fail-safe direction. `PWD`/`OLDPWD` carry no `PASS`
 * substring and are unaffected.
 */
export const SECRET_NAME_PATTERNS = Object.freeze([
    '*KEY*',
    '*SECRET*',
    '*TOKEN*',
    '*PASS*',
    '*CREDENTIAL*',
    '*DSN*',
]);
/**
 * Connection-string / no-flag-credential variable names that carry no
 * KEY/SECRET/TOKEN/DSN substring but routinely embed a password.
 *
 * Verbatim from `env_policy.py:_BLOCKED_EXACT_NAMES` (66-88). A blanket `*URL*`
 * block is intentionally avoided — it would strip benign service URLs.
 */
export const EXACT_DENYLIST = Object.freeze(new Set([
    'DATABASE_URL',
    'DATABASE_URI',
    'REDIS_URL',
    'MONGODB_URI',
    'MONGO_URL',
    'AMQP_URL',
    'RABBITMQ_URL',
    'POSTGRES_URL',
    'POSTGRESQL_URL',
    'MYSQL_URL',
    'CLICKHOUSE_URL',
    'CONNECTION_STRING',
    'CONN_STR',
    'GH_PAT',
    'GITHUB_PAT',
    'MYSQL_PWD',
    'REDISCLI_AUTH',
    'REDIS_AUTH',
    'PGSERVICEFILE',
]));
/**
 * Benign system variables the original documents as surviving the scrub.
 *
 * NOTE ON PROVENANCE: unlike the two lists above this is **not** a constant in
 * `env_policy.py` — the original preserves these implicitly (they contain none of
 * the pattern tokens) and names them in the comment at `env_policy.py:20-23` plus
 * `PWD`/`OLDPWD` at `env_policy.py:42`. The list is transcribed from those comments
 * and exists so the test suite can assert the claimed property rather than trust it.
 */
export const BENIGN_PRESERVED = Object.freeze([
    'PATH',
    'HOME',
    'SHELL',
    'LANG',
    'PWD',
    'OLDPWD',
    'TMPDIR',
    'VIRTUAL_ENV',
    'PYTHONPATH',
]);
/**
 * Minimum length of a secret VALUE before `detectSecretExposure` will look for it
 * in a command string. Verbatim from `sandbox/tools.py:_MIN_MASK_LENGTH = 8`, for
 * the reason the original gives: matching a 3-char value corrupts unrelated text
 * far more often than it protects a real secret.
 */
export const MIN_EXPOSURE_VALUE_LENGTH = 8;
/**
 * Translate one Python `fnmatch` pattern to an anchored RegExp.
 *
 * The original calls `fnmatch.fnmatchcase(upper, pattern)`. Every shipped pattern
 * is of the `*TOKEN*` shape, so a substring test would be observationally
 * equivalent today — the general translation is kept so that adding a `?` or a
 * `[seq]` pattern upstream ports mechanically instead of silently mis-matching.
 * Mirrors `fnmatch.translate`: `*` -> `.*`, `?` -> `.`, `[seq]`/`[!seq]` -> char
 * class, everything else escaped; dotAll so `.` spans newlines as Python's
 * `(?s:...)` does.
 */
function fnmatchToRegExp(pattern) {
    let out = '';
    let i = 0;
    while (i < pattern.length) {
        const ch = pattern[i];
        i += 1;
        if (ch === '*') {
            out += '.*';
        }
        else if (ch === '?') {
            out += '.';
        }
        else if (ch === '[') {
            let j = i;
            if (pattern[j] === '!')
                j += 1;
            if (pattern[j] === ']')
                j += 1;
            while (j < pattern.length && pattern[j] !== ']')
                j += 1;
            if (j >= pattern.length) {
                out += '\\[';
            }
            else {
                let inner = pattern.slice(i, j).replace(/\\/g, '\\\\');
                if (inner.startsWith('!'))
                    inner = `^${inner.slice(1)}`;
                out += `[${inner}]`;
                i = j + 1;
            }
        }
        else {
            out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }
    }
    return new RegExp(`^${out}$`, 's');
}
const COMPILED_SECRET_NAME_PATTERNS = SECRET_NAME_PATTERNS.map(fnmatchToRegExp);
/** True when `name` matches one of the wildcard patterns (the denylist is NOT consulted). */
export function matchesSecretNamePattern(name) {
    const upper = name.toUpperCase();
    return COMPILED_SECRET_NAME_PATTERNS.some((pattern) => pattern.test(upper));
}
/**
 * True when `name` looks like a credential that must not reach a child process.
 *
 * Mechanical port of `env_policy.py:is_blocked_env_name` (91-97): upper-case the
 * name, exact denylist first, then the wildcard patterns.
 */
export function isSecretLikeName(name) {
    const upper = name.toUpperCase();
    if (EXACT_DENYLIST.has(upper))
        return true;
    return COMPILED_SECRET_NAME_PATTERNS.some((pattern) => pattern.test(upper));
}
/**
 * Build a child-process environment: inherited env minus secret-looking names,
 * then explicitly injected request-scoped secrets layered on top.
 *
 * Mechanical port of `env_policy.py:build_sandbox_env` (100-112). An injected
 * secret wins even when its name is blocked, because injection is authorized
 * upstream (declared by the skill, supplied by the request, not read off the host).
 */
export function scrubEnv(inherited, injected) {
    const env = {};
    for (const [key, value] of Object.entries(inherited)) {
        if (value === undefined)
            continue;
        if (isSecretLikeName(key))
            continue;
        env[key] = value;
    }
    if (injected) {
        for (const [key, value] of Object.entries(injected)) {
            env[key] = value;
        }
    }
    return env;
}
/**
 * Names of secret-like environment variables whose VALUE appears verbatim inside
 * `command`.
 *
 * This is the port's inversion of `sandbox/tools.py:mask_secret_values`: the
 * original redacts a leaked value on the way OUT of a subprocess; the port has no
 * write access to Claude Code's tool output at spawn time, so it refuses the
 * command on the way IN. Only names that `isSecretLikeName` accepts are
 * considered, and only values of at least `MIN_EXPOSURE_VALUE_LENGTH` characters,
 * reusing the original's floor.
 *
 * @returns matching variable names, sorted, so the caller's message is deterministic.
 */
export function detectSecretExposure(command, env) {
    if (!command)
        return [];
    const hits = [];
    for (const [name, value] of Object.entries(env)) {
        if (value === undefined || value.length < MIN_EXPOSURE_VALUE_LENGTH)
            continue;
        if (!isSecretLikeName(name))
            continue;
        if (command.includes(value))
            hits.push(name);
    }
    return hits.sort();
}
