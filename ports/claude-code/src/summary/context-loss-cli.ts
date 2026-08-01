// `node dist/summary/context-loss-cli.js` — score a recall probe against a context-loss fixture.
//
// WHY IT EXISTS. `src/summary/context-loss.ts` (M8) is the pure scorer: it turns "what did the
// model still know after compaction/resume" into a number, deterministically and with no model in
// the loop. It has no entry point, so M14's live measurement had no way to invoke it from a shell
// script. This file is that entry point and nothing more — every scoring decision stays in
// context-loss.ts so the number cannot drift between the unit tests and the live run.
//
// CONTRACT. Reads ONE JSON object from stdin:
//
//   { "fixture": <snapshot fixture object, or a path when --fixture is used>,
//     "answers": ["...", "..."] }
//
// `answers` also accepts the probe-transcript envelope `{ "answers": [...] }` — both forms are
// what `parseProbeTranscript` already takes. Writes the `RecallScore` object to stdout as JSON.
//
// Usage:
//   echo '{"fixture": {...}, "answers": ["..."]}' | node dist/summary/context-loss-cli.js
//   echo '{"answers": ["..."]}' | node dist/summary/context-loss-cli.js --fixture parity/fixtures/context-loss/case-01.json
//   node dist/summary/context-loss-cli.js --fixture <path> --answers <path>
//
// Exit codes: 0 = scored (INCLUDING a recall rate of 0 — a total loss is a valid measurement, not
// an error); 1 = usage error, unreadable input, or an invalid fixture. `--fail-under <rate>` turns
// a score below the threshold into exit 2, for a CI gate that wants one; without it the CLI never
// judges the number it prints.
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { parseContextSnapshot, parseProbeTranscript, scoreRecall, type RecallScore } from './context-loss.js'

export interface CliOptions {
  /** Path to the fixture JSON; when null the fixture must arrive on stdin under `fixture`. */
  readonly fixturePath: string | null
  /** Path to the answers JSON; when null the answers must arrive on stdin under `answers`. */
  readonly answersPath: string | null
  /** Exit 2 when `recall_rate` is below this. Null disables the gate. */
  readonly failUnder: number | null
  /** Pretty-print the score instead of emitting one JSON line. */
  readonly pretty: boolean
}

/** Parse argv (without `node` and the script path). Throws on an unknown or malformed flag. */
export function parseArgs(argv: readonly string[]): CliOptions {
  let fixturePath: string | null = null
  let answersPath: string | null = null
  let failUnder: number | null = null
  let pretty = false

  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    const next = (): string => {
      const value = argv[++index]
      if (value === undefined) throw new Error(`Missing value for ${String(flag)}`)
      return value
    }
    switch (flag) {
      case '--fixture':
        fixturePath = next()
        break
      case '--answers':
        answersPath = next()
        break
      case '--fail-under': {
        const raw = next()
        // `Number('')` and `Number('  ')` are 0, which would silently install a zero-threshold
        // gate instead of rejecting the typo. Require an actual number to have been typed.
        const value = raw.trim().length === 0 ? Number.NaN : Number(raw)
        if (!Number.isFinite(value) || value < 0 || value > 1) {
          throw new Error(`--fail-under must be a rate between 0 and 1, got ${raw}`)
        }
        failUnder = value
        break
      }
      case '--pretty':
        pretty = true
        break
      default:
        throw new Error(`Unknown argument: ${String(flag)}`)
    }
  }
  return { fixturePath, answersPath, failUnder, pretty }
}

/** Read the whole of stdin. Resolves with `''` when nothing is piped in. */
export function readStdin(stream: NodeJS.ReadableStream = process.stdin): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    stream.on('data', (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)))
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    stream.on('error', reject)
  })
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function readJsonFile(path: string, label: string): unknown {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(`Cannot read ${label} ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return parseJson(text, `${label} ${path}`)
}

/**
 * Resolve the fixture and the answers from the flags plus whatever arrived on stdin, then score.
 *
 * Flags win over stdin, so a runbook can pin the fixture on the command line and pipe only the
 * answers — the shape the live measurement actually uses.
 */
export function score(options: CliOptions, stdinText: string): RecallScore {
  const payload =
    stdinText.trim().length > 0 ? (parseJson(stdinText, 'stdin') as Record<string, unknown> | null) : null
  if (payload !== null && (typeof payload !== 'object' || Array.isArray(payload))) {
    throw new Error('stdin must be a JSON object: {"fixture": {...}, "answers": [...]}')
  }

  const rawFixture =
    options.fixturePath !== null ? readJsonFile(options.fixturePath, 'fixture') : (payload?.['fixture'] ?? null)
  if (rawFixture === null || rawFixture === undefined) {
    throw new Error('No fixture: pass --fixture <path> or send {"fixture": {...}} on stdin.')
  }

  const rawAnswers =
    options.answersPath !== null ? readJsonFile(options.answersPath, 'answers') : (payload?.['answers'] ?? null)
  if (rawAnswers === null || rawAnswers === undefined) {
    throw new Error('No answers: pass --answers <path> or send {"answers": [...]} on stdin.')
  }

  return scoreRecall(parseContextSnapshot(rawFixture), parseProbeTranscript(rawAnswers))
}

async function main(): Promise<number> {
  let options: CliOptions
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }

  // Only wait on stdin when something still has to come from it; otherwise `--fixture X
  // --answers Y` would hang on an interactive terminal.
  const needsStdin = options.fixturePath === null || options.answersPath === null

  let result: RecallScore
  try {
    result = score(options, needsStdin ? await readStdin() : '')
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }

  process.stdout.write(`${JSON.stringify(result, null, options.pretty ? 2 : 0)}\n`)
  if (options.failUnder !== null && result.recall_rate < options.failUnder) {
    process.stderr.write(
      `recall_rate ${result.recall_rate} is below --fail-under ${options.failUnder} ` +
        `(${result.items_recalled}/${result.items_total} recalled)\n`,
    )
    return 2
  }
  return 0
}

// Only run when invoked as a program: importing the module (the tests import `score`) must never
// read stdin or write to stdout.
const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  void main().then((code) => {
    process.exitCode = code
  })
}
