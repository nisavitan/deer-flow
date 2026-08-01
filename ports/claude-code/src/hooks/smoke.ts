// M1 smoke hook: proves the plugin's compiled-TS hook path works end to end.
// Reads the PreToolUse JSON payload from stdin and appends one line to the
// port's state directory. Replaced by pre-tool-guard in M7.
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

const raw = await readStdin()
let toolName = 'unknown'
try {
  const payload = JSON.parse(raw) as { tool_name?: string }
  toolName = payload.tool_name ?? 'unknown'
} catch {
  // Malformed payload: stay silent, never block the tool call from a smoke hook.
}
const dir = join(process.env['CLAUDE_PROJECT_DIR'] ?? process.cwd(), '.deerflow')
mkdirSync(dir, { recursive: true })
appendFileSync(join(dir, 'm1-smoke.log'), `PRE ${toolName}\n`)
process.exit(0)
