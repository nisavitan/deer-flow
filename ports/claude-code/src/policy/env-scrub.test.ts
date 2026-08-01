// Table-driven parity tests for the env scrub policy.
// Source of truth: backend/packages/harness/deerflow/sandbox/env_policy.py @ 0950924.
// Every positive/negative name below is taken from that file's own text — either from
// the pattern comments (which enumerate the intended hits and the intended misses) or
// from the denylist itself — so the table stays anchored to the original rather than to
// this port's imagination.
import { describe, expect, it } from 'vitest'
import {
  BENIGN_PRESERVED,
  EXACT_DENYLIST,
  MIN_EXPOSURE_VALUE_LENGTH,
  SECRET_NAME_PATTERNS,
  detectSecretExposure,
  isSecretLikeName,
  matchesSecretNamePattern,
  scrubEnv,
} from './env-scrub.js'

/**
 * FROZEN SOURCE OF TRUTH — copied verbatim from
 * backend/packages/harness/deerflow/sandbox/env_policy.py:_BLOCKED_EXACT_NAMES (66-88)
 * at commit 0950924. This literal is the test's independent copy: if the ported
 * constant drifts in either direction, the completeness test below fails.
 */
const EXPECTED_EXACT_DENYLIST = [
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
]

/**
 * FROZEN SOURCE OF TRUTH — copied verbatim from
 * env_policy.py:_SECRET_NAME_PATTERNS (24-46) at commit 0950924.
 */
const EXPECTED_SECRET_NAME_PATTERNS = ['*KEY*', '*SECRET*', '*TOKEN*', '*PASS*', '*CREDENTIAL*', '*DSN*']

interface PatternCase {
  /** The pattern this row exercises, as written in the original. */
  pattern: string
  /** Names the original intends this pattern to catch. */
  positives: string[]
  /** Names the original explicitly intends NOT to catch via this pattern. */
  negatives: string[]
}

/**
 * Positives/negatives sourced from env_policy.py:
 * - `OPENAI_API_KEY` — module docstring (5-6).
 * - `PASSWORD`/`PASSWD`, `DB_PASS`/`SMTP_PASS`/`MYSQL_PASS`, `PGPASSFILE`,
 *   `GIT_ASKPASS`/`SSH_ASKPASS`/`SUDO_ASKPASS`, `COMPASS_*`/`BYPASS_*`,
 *   `PGPASSWORD`/`MYSQL_PASSWORD` — the `*PASS*` comment block (27-42, 63-65).
 * - `PWD`/`OLDPWD` — the same block's explicit non-match note (42) and the
 *   denylist rationale (62-63).
 * - `*DSN*` — "data source name ... connection string with a password" (45).
 */
const PATTERN_CASES: PatternCase[] = [
  {
    pattern: '*KEY*',
    positives: ['KEY', 'API_KEY', 'OPENAI_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'SSH_PRIVATE_KEY'],
    negatives: ['PATH', 'PWD'],
  },
  {
    pattern: '*SECRET*',
    positives: ['SECRET', 'CLIENT_SECRET', 'FEISHU_APP_SECRET', 'AWS_SECRET_ACCESS_KEY'],
    negatives: ['HOME', 'LANG'],
  },
  {
    pattern: '*TOKEN*',
    positives: ['TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'SLACK_APP_TOKEN'],
    negatives: ['TMPDIR', 'SHELL'],
  },
  {
    pattern: '*PASS*',
    positives: [
      'PASSWORD',
      'PASSWD',
      'DB_PASS',
      'SMTP_PASS',
      'MYSQL_PASS',
      'PGPASSWORD',
      'MYSQL_PASSWORD',
      'PGPASSFILE',
      'GIT_ASKPASS',
      'SSH_ASKPASS',
      'SUDO_ASKPASS',
      'COMPASS_HOME',
      'BYPASS_CACHE',
    ],
    negatives: ['PWD', 'OLDPWD'],
  },
  {
    pattern: '*CREDENTIAL*',
    positives: ['CREDENTIAL', 'GOOGLE_APPLICATION_CREDENTIALS', 'AZURE_CREDENTIALS'],
    negatives: ['VIRTUAL_ENV', 'PYTHONPATH'],
  },
  {
    pattern: '*DSN*',
    positives: ['DSN', 'SENTRY_DSN', 'ODBC_DSN_NAME'],
    negatives: ['PATH', 'HOME'],
  },
]

describe('wildcard pattern list', () => {
  it('matches env_policy.py:_SECRET_NAME_PATTERNS exactly and in order', () => {
    expect([...SECRET_NAME_PATTERNS]).toEqual(EXPECTED_SECRET_NAME_PATTERNS)
  })

  it('covers every shipped pattern with a test row', () => {
    expect(PATTERN_CASES.map((row) => row.pattern)).toEqual(EXPECTED_SECRET_NAME_PATTERNS)
  })
})

describe.each(PATTERN_CASES)('pattern $pattern', ({ positives, negatives }) => {
  it.each(positives)('blocks %s', (name) => {
    expect(matchesSecretNamePattern(name)).toBe(true)
    expect(isSecretLikeName(name)).toBe(true)
  })

  it.each(negatives)('does not match any wildcard pattern for %s', (name) => {
    expect(matchesSecretNamePattern(name)).toBe(false)
  })
})

describe('exact denylist', () => {
  it('matches env_policy.py:_BLOCKED_EXACT_NAMES exactly (no additions, no omissions)', () => {
    expect([...EXACT_DENYLIST].sort()).toEqual([...EXPECTED_EXACT_DENYLIST].sort())
  })

  it.each(EXPECTED_EXACT_DENYLIST)('blocks %s', (name) => {
    expect(isSecretLikeName(name)).toBe(true)
  })

  it('is the only reason the URL/AUTH/PWD/SERVICEFILE names are blocked', () => {
    // env_policy.py:62-65 — these need exact entries precisely because no wildcard
    // covers them; a blanket *URL*/*PWD* block would strip benign names.
    const patternOnlyMisses = ['DATABASE_URL', 'REDIS_URL', 'GH_PAT', 'MYSQL_PWD', 'REDISCLI_AUTH', 'PGSERVICEFILE']
    for (const name of patternOnlyMisses) {
      expect(matchesSecretNamePattern(name)).toBe(false)
      expect(isSecretLikeName(name)).toBe(true)
    }
  })
})

describe('benign preserved names', () => {
  it.each(BENIGN_PRESERVED)('preserves %s', (name) => {
    expect(isSecretLikeName(name)).toBe(false)
  })
})

describe('case handling', () => {
  // env_policy.py:94 upper-cases before matching, so lower/mixed case must behave identically.
  it.each(['openai_api_key', 'Database_Url', 'gh_pat', 'db_pass'])('blocks lower/mixed case %s', (name) => {
    expect(isSecretLikeName(name)).toBe(true)
  })

  it.each(['path', 'Pwd', 'oldpwd'])('preserves lower/mixed case %s', (name) => {
    expect(isSecretLikeName(name)).toBe(false)
  })
})

describe('scrubEnv', () => {
  it('drops secret-looking names and keeps benign ones', () => {
    const result = scrubEnv({
      PATH: '/usr/bin',
      HOME: '/home/deer',
      OPENAI_API_KEY: 'sk-live-123',
      DATABASE_URL: 'postgresql://u:p@h/db',
      PWD: '/work',
    })
    expect(result).toEqual({ PATH: '/usr/bin', HOME: '/home/deer', PWD: '/work' })
  })

  it('lets an injected secret win over the block (env_policy.py:100-112)', () => {
    const result = scrubEnv({ ERP_TOKEN: 'host-value' }, { ERP_TOKEN: 'request-value' })
    expect(result['ERP_TOKEN']).toBe('request-value')
  })

  it('skips undefined values without emitting the key', () => {
    expect(scrubEnv({ PATH: undefined, HOME: '/home/deer' })).toEqual({ HOME: '/home/deer' })
  })
})

describe('detectSecretExposure', () => {
  const env = {
    OPENAI_API_KEY: 'sk-live-abcdef123456',
    DATABASE_URL: 'postgresql://u:pw@h/db',
    SHORT_TOKEN: 'abc',
    PATH: '/usr/bin:/bin',
    HOME: '/home/deer',
  }

  it('reports a secret-like variable whose value is embedded verbatim', () => {
    expect(detectSecretExposure('echo sk-live-abcdef123456', env)).toEqual(['OPENAI_API_KEY'])
  })

  it('reports a denylisted connection string by value', () => {
    expect(detectSecretExposure('psql postgresql://u:pw@h/db', env)).toEqual(['DATABASE_URL'])
  })

  it('reports every match, sorted, for a deterministic message', () => {
    expect(detectSecretExposure('echo sk-live-abcdef123456 postgresql://u:pw@h/db', env)).toEqual([
      'DATABASE_URL',
      'OPENAI_API_KEY',
    ])
  })

  it('ignores values shorter than the mask floor (tools.py:_MIN_MASK_LENGTH)', () => {
    expect(MIN_EXPOSURE_VALUE_LENGTH).toBe(8)
    expect(detectSecretExposure('echo abc', env)).toEqual([])
  })

  it('ignores benign variables whose values appear in ordinary commands', () => {
    expect(detectSecretExposure('ls /usr/bin:/bin /home/deer', env)).toEqual([])
  })

  it('does not fire on an unrelated command', () => {
    expect(detectSecretExposure('echo test-value-ok', env)).toEqual([])
  })

  it('returns nothing for an empty command', () => {
    expect(detectSecretExposure('', env)).toEqual([])
  })
})
