// `node dist/resume/status-cli.js` — render the resume plan for every thread in the state
// root as readable markdown. This is what the `/deerflow:status` skill runs.
//
// It is the port's stand-in for the original's thread/run inspection surface (`GET
// /api/threads/{id}` + the runs table + the LangGraph state snapshot, all of which a web UI
// consumed). The port has no server and no UI, so the same facts are printed. The CLI is
// READ-ONLY: it never writes a state file, never terminalizes a run and never resumes
// anything — recovery is the SessionStart hook's job, resuming is the user's.
//
// Usage:
//   node dist/resume/status-cli.js [--thread <id>] [--json] [--state-root <path>]
// Exit codes: 0 when the report rendered (including "no state found"), 1 on a usage error.
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { resolveProjectRoot, stateRoot as defaultStateRoot } from '../state/paths.js'
import { listStateThreads } from './recovery.js'
import { readGitHead } from './git-head.js'
import { buildResumePlan, renderResumeReport, type ResumeReport } from './resume-plan.js'

interface CliOptions {
  threadId: string | null
  stateRoot: string | null
  json: boolean
}

/** Parse argv (without `node` and the script path). Throws on an unknown flag. */
export function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
  const options: CliOptions = {
    threadId: env['DEERFLOW_THREAD_ID'] ?? null,
    stateRoot: null,
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
      case '--state-root':
        options.stateRoot = next()
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

export interface StatusRenderOptions {
  readonly stateRoot: string
  readonly threadIds: readonly string[]
  readonly currentCommitSha: string | null
  readonly currentBranch: string | null
}

/** Build every report the CLI will print. */
export function collectReports(options: StatusRenderOptions): ResumeReport[] {
  return options.threadIds.map((threadId) =>
    buildResumePlan({
      threadId,
      stateDir: join(options.stateRoot, threadId),
      currentCommitSha: options.currentCommitSha,
      currentBranch: options.currentBranch,
    }),
  )
}

/** Full markdown document: header, one section per thread, and the action key. */
export function renderStatusDocument(reports: readonly ResumeReport[], options: StatusRenderOptions): string {
  if (reports.length === 0) {
    return [
      '# DeerFlow status',
      '',
      `No DeerFlow state found under \`${options.stateRoot}\`.`,
      '',
      'Nothing to resume. Start work with `/deerflow:run <objective>`.',
      '',
    ].join('\n')
  }

  const head = options.currentCommitSha === null ? 'unknown' : options.currentCommitSha.slice(0, 7)
  const branch = options.currentBranch === null ? 'detached or unknown' : options.currentBranch
  const lines: string[] = [
    '# DeerFlow status',
    '',
    `- **State root:** \`${options.stateRoot}\``,
    `- **Current HEAD:** ${head} (${branch})`,
    `- **Threads:** ${reports.length}`,
    '',
  ]
  for (const report of reports) lines.push(renderResumeReport(report))
  lines.push(
    '---',
    '',
    '**Action key:** `continue` — state is bound to this commit, resume where it stopped. ',
    '`restart_stale` — HEAD moved (or cannot be proven), so cached delegation results are not ',
    'reused and their stages re-run. `nothing_to_resume` — no live run, no goal, no open todos.',
    '',
  )
  return lines.join('\n')
}

function main(): number {
  let options: CliOptions
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }

  const root = options.stateRoot ?? defaultStateRoot()
  const threadIds = options.threadId === null ? listStateThreads(root) : [options.threadId]
  const head = readGitHead(resolveProjectRoot())
  const renderOptions: StatusRenderOptions = {
    stateRoot: root,
    threadIds,
    currentCommitSha: head.commitSha,
    currentBranch: head.branch,
  }

  let reports: ResumeReport[]
  try {
    reports = collectReports(renderOptions)
  } catch (error) {
    process.stderr.write(`Failed to read state: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ state_root: root, head, reports }, null, 2)}\n`)
  } else {
    process.stdout.write(renderStatusDocument(reports, renderOptions))
  }
  return 0
}

// Only run when invoked as a program: the unit tests import the render helpers, and an import
// must never shell out to git or print a report.
const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = main()
}
