// `node dist/summary/digest-cli.js` — rebuild the deterministic digest into summary.json.
//
// This is the manual counterpart of the PreCompact hook, and the port's stand-in for
// `POST /api/threads/{id}/compact` (runtime/context_compaction.py:compact_thread_context
// @ 0950924). The DIFFERENCE is declared, not hidden: the original route generates an LLM
// summary and rewrites the checkpoint's `messages` channel (RemoveMessage(REMOVE_ALL) +
// preserved tail) inside one mutation-graph write. This CLI does neither — it cannot touch
// the conversation (Claude Code owns the transcript) and it calls no model. It refreshes the
// durable digest only; native `/compact` is what actually shrinks the context, and it is
// user-invoked because slash commands are not model-invocable.
// See docs/claude-code-port/summarization-delta.md, row "manual compaction".
//
// Usage:
//   node dist/summary/digest-cli.js [--thread <id>] [--trigger auto|manual] [--transcript <path>] [--json]
// Defaults: --thread from $DEERFLOW_THREAD_ID, --trigger manual.
// Exit codes: 0 on success, 1 on a usage/state error (unlike the hook, a CLI may fail loudly).
import { pathToFileURL } from 'node:url'
import { buildSummaryDigest, renderDigestText } from './digest.js'
import { applySummary, summaryPath, type CompactionTrigger } from './summary-state.js'
import { threadStateDir } from '../state/paths.js'

interface CliOptions {
  threadId: string | null
  trigger: CompactionTrigger
  transcriptPath: string | null
  json: boolean
}

/** Parse argv (without `node` and the script path). Throws on an unknown flag. */
export function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
  const options: CliOptions = {
    threadId: env['DEERFLOW_THREAD_ID'] ?? null,
    trigger: 'manual',
    transcriptPath: null,
    json: false,
  }
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    const next = (): string => {
      const value = argv[++index]
      if (value === undefined) throw new Error(`Missing value for ${String(flag)}`)
      return value
    }
    switch (flag) {
      case '--thread':
        options.threadId = next()
        break
      case '--trigger': {
        const value = next()
        if (value !== 'auto' && value !== 'manual') throw new Error(`--trigger must be auto or manual, got ${value}`)
        options.trigger = value
        break
      }
      case '--transcript':
        options.transcriptPath = next()
        break
      case '--json':
        options.json = true
        break
      default:
        throw new Error(`Unknown argument: ${String(flag)}`)
    }
  }
  return options
}

function main(): number {
  let options: CliOptions
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }

  if (options.threadId === null) {
    process.stderr.write('No thread id: pass --thread <id> or set DEERFLOW_THREAD_ID.\n')
    return 1
  }

  let stateDir: string
  let filePath: string
  try {
    stateDir = threadStateDir(options.threadId)
    filePath = summaryPath(options.threadId)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }

  const now = new Date().toISOString()
  const digest = buildSummaryDigest({
    stateDir,
    now,
    trigger: options.trigger,
    transcriptPath: options.transcriptPath,
  })

  try {
    const envelope = applySummary(
      filePath,
      {
        summaryText: renderDigestText(digest),
        updatedBy: 'manual',
        digest,
        compaction: { at: now, trigger: options.trigger, updated_by: 'manual' },
      },
      { now },
    )
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ path: filePath, rev: envelope.rev, digest }, null, 2)}\n`)
    } else {
      process.stdout.write(
        [
          `Wrote ${filePath} (rev ${envelope.rev}).`,
          `Preserved: ${digest.objectives.length} objective(s), ${digest.open_todos.length} open todo(s), ` +
            `${digest.delegations.total} delegation(s), ${digest.artifacts.length} artifact(s).`,
          '',
          renderDigestText(digest),
          '',
        ].join('\n'),
      )
    }
  } catch (error) {
    process.stderr.write(`Failed to write ${filePath}: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
  return 0
}

// Only run when invoked as a program. Importing the module (tests import `parseArgs`) must
// never write a state file as a side effect.
const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = main()
}
