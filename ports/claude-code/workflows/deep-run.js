// DeerFlow deep-run orchestration core — M6.
//
// Structural translation of, all @ bytedance/deer-flow 0950924:
//   backend/packages/harness/deerflow/subagents/executor.py       (_aexecute, SubagentResult)
//   backend/packages/harness/deerflow/tools/builtins/task_tool.py (dispatch + result plumbing)
//   backend/packages/harness/deerflow/agents/middlewares/
//     subagent_limit_middleware.py                                (per-run delegation caps)
//   backend/packages/harness/deerflow/subagents/status_contract.py(result formatting)
//
// ---------------------------------------------------------------------------
// WHY THERE ARE NO IMPORTS
// ---------------------------------------------------------------------------
// Workflow scripts run in a sandbox with no module system and no filesystem: the runtime
// injects agent/parallel/pipeline/phase/log/args/budget and standard JS built-ins, nothing
// else. Every piece of logic below therefore has a TESTED TypeScript twin under
// ports/claude-code/src/deeprun/, and each inlined block names its twin. Change one, change
// the other — `npm run check` guards the TS side, and the smoke run in
// docs/claude-code-port/ guards this side.
//
//   caps arithmetic + batching  -> src/deeprun/batching.ts   (+ src/policy/caps.ts)
//   result message formatting   -> src/deeprun/result-format.ts
//   stop-reason vocabulary      -> src/policy/stop-reason.ts
//   result schema               -> src/deeprun/task-schema.ts
//   ledger entry shape          -> src/deeprun/ledger-io.ts
//
// ---------------------------------------------------------------------------
// VERIFIED RUNTIME CONSTRAINTS (probed headlessly, Claude Code 2.1.220)
// ---------------------------------------------------------------------------
// Available: log, phase, console, budget, setTimeout, clearTimeout, Date (constructor only),
// agent, parallel, pipeline, workflow, args + standard JS built-ins.
//   * setTimeout/clearTimeout ARE available and real (a 30 ms timer fired in the probe), so
//     the original's per-task wall-clock timeout IS enforced here, via Promise.race.
//   * Date.now() / argless new Date() THROW (they would break workflow resume). Nothing below
//     reads the clock; every timestamp is stamped by the caller after this workflow returns.
//   * Math.random() throws for the same reason — delegation ids are derived from the run id
//     plus the task index instead.
//   * No filesystem and no Node API, so this workflow CANNOT write the delegation ledger or
//     run-meta. It returns ledger-shaped entries and the lead session persists them through
//     src/deeprun/ledger-io.ts. See parity/DISCREPANCIES.md ("deep-run ledger capture").
//
// ---------------------------------------------------------------------------
// DELIBERATE DIVERGENCES FROM THE ORIGINAL (all recorded in parity/DISCREPANCIES.md)
// ---------------------------------------------------------------------------
//  1. Cancellation on timeout is one-way. The original sets `cancel_event` and cancels the
//     future; a timed-out agent() here keeps running to completion in the background because
//     the workflow runtime exposes no cancel handle. The result is discarded either way, so
//     the model-visible contract is identical; only the wasted work differs.
//  2. `max_turns` (150 general-purpose / 60 bash) and the token budget have no Claude Code
//     analogue, so `turn_capped` / `token_capped` can only ever arrive SELF-REPORTED by the
//     subagent, never observed by the dispatcher. `loop_capped` likewise.
//  3. Step events (task_started / task_running / task_completed) are not re-emitted: the
//     workflow progress tree plus the delegation ledger cover the same ground.
export const meta = {
  name: 'deep-run',
  description: 'DeerFlow deterministic delegation engine: plan, batch under the run caps, delegate, synthesize',
  phases: [
    { title: 'Plan', detail: 'decompose the objective into bounded delegable tasks' },
    { title: 'Delegate', detail: 'batched subagent dispatch under the 3-concurrent / 6-per-run caps' },
    { title: 'Synthesize', detail: 'deterministic assembly — no model call' },
  ],
}

// The region between the two PORTED-LOGIC markers is pure: it touches no runtime global, so
// src/deeprun/workflow-sync.test.ts extracts it verbatim, evaluates it, and runs the SAME
// parity vectors through it as through the TypeScript twins. That is what actually enforces
// the "keep in sync" comments above — do not move logic out of the region, and do not put a
// runtime global (agent/log/phase/args/parallel) inside it.
// <<<PORTED-LOGIC-BEGIN>>>

// ===========================================================================
// Constants — ports of config/subagents_config.py and status_contract.py
// ===========================================================================

// config/subagents_config.py:11-25 — clamp bounds and defaults.
const MIN_CONCURRENT_SUBAGENT_CALLS = 1
const MAX_CONCURRENT_SUBAGENT_CALLS = 4
const MIN_TOTAL_SUBAGENTS_PER_RUN = 1
const MAX_TOTAL_SUBAGENTS_PER_RUN = 50
const DEFAULT_MAX_CONCURRENT_SUBAGENT_CALLS = 3 // executor.py:1164 MAX_CONCURRENT_SUBAGENTS
const DEFAULT_MAX_TOTAL_SUBAGENTS_PER_RUN = 6 // DEFAULT_MAX_TOTAL_SUBAGENTS_PER_RUN

// config/subagents_config.py:126-130 — SubagentsAppConfig.timeout_seconds = 1800 (30 min),
// the global default the registry layers onto both built-in subagents.
const DEFAULT_SUBAGENT_TIMEOUT_MS = 1800 * 1000

// subagent_limit_middleware.py — model-visible note, verbatim. Mirrors SUBAGENT_LIMIT_NOTE
// in src/policy/caps.ts and the `limit_note_appended` rows of parity/baseline/caps_clamping.json.
const SUBAGENT_LIMIT_NOTE =
  '[SUBAGENT LIMIT REACHED] The subagent delegation limit for this run has been reached. ' +
  'Continue using the subagent results already collected, execute remaining simple work ' +
  'directly, or summarize the remaining work instead of launching more subagents.'
const SUBAGENT_LIMIT_STOP_REASON = 'subagent_limit_capped'

// status_contract.py:82-86 — _STOP_REASON_LABELS.
const STOP_REASON_LABELS = {
  token_capped: 'token budget',
  turn_capped: 'turn budget',
  loop_capped: 'repeated tool-call loop',
}
const STOP_REASON_VALUES = ['token_capped', 'turn_capped', 'loop_capped']

// executor.py:161-201 — _extract_final_result's sentinel when nothing usable came back.
const NO_RESPONSE_SENTINEL = 'No response generated'

// executor.py:76-158 — SubagentResult's terminal statuses, minus `polling_timed_out`
// (task_tool's polling loop has no port analogue: agent() blocks until the subagent returns).
const TASK_RESULT_STATUS_VALUES = ['completed', 'failed', 'timed_out', 'cancelled']

const AGENT_TYPES = ['deerflow-general-purpose', 'deerflow-bash']
const DEFAULT_AGENT_TYPE = 'deerflow-general-purpose'
// Plugin namespace agents are registered under — the `name` field of plugin.json.
const PLUGIN_AGENT_NAMESPACE = 'deerflow'

// Twin: src/deeprun/task-schema.ts DEEP_RUN_TASK_RESULT_SCHEMA.
const TASK_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: {
      type: 'string',
      enum: TASK_RESULT_STATUS_VALUES,
      description:
        'Terminal outcome of this delegated task. "completed" even when a guardrail cap ended the run early but usable work survived (report the cap on stop_reason).',
    },
    result: {
      type: 'string',
      description:
        'The full result text for the lead agent: summary of what was accomplished, key findings, file paths, issues. This IS the return value, not a message to a human.',
    },
    stop_reason: {
      type: ['string', 'null'],
      enum: STOP_REASON_VALUES.concat([null]),
      description:
        'Why a guardrail cap ended the run early, or null when none did. token_capped = ran out of token budget; turn_capped = ran out of turns; loop_capped = repeated the same tool call.',
    },
    files_produced: {
      type: 'array',
      items: { type: 'string' },
      description: 'Paths of deliverables written under outputs/. Empty when the task produced no files.',
    },
  },
  required: ['status', 'result'],
  additionalProperties: false,
}

// Twin: src/deeprun/task-schema.ts DEEP_RUN_PLAN_SCHEMA.
const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'A short (3-5 word) description of the task for logging/display.' },
          prompt: {
            type: 'string',
            description: 'The task description for the subagent. Be specific and clear about what needs to be done.',
          },
          subagent_type: { type: 'string', enum: AGENT_TYPES, description: 'The type of subagent to use.' },
        },
        required: ['description', 'prompt', 'subagent_type'],
        additionalProperties: false,
      },
    },
  },
  required: ['tasks'],
  additionalProperties: false,
}

// Twin: src/deeprun/task-schema.ts DEEP_RUN_DELEGATION_POLICY (ported from task_tool's
// docstring; golden parity/baseline/prompt_renders/task_tool_description.txt).
const DELEGATION_POLICY = `Delegate a bounded task to a specialized subagent in its own context. Delegate only when expected benefit clearly exceeds delegation overhead.
Useful benefits are:
- Material wall-clock savings from independent parallel work
- Specialist tools, skills, models, or domain instructions
- Context isolation for a bounded, unusually context-heavy investigation

Built-in subagent types:
- **deerflow-general-purpose**: A capable agent for bounded exploration and action. Use
  when the assignment has clear specialist or context-isolation benefit, or is
  one of several independent, non-overlapping tasks that can actually run in
  parallel.
- **deerflow-bash**: Command execution specialist for running bash commands. Use it only for
  a bounded shell workflow with clear context-isolation or independent-parallel benefit.
  Routine git, build, test, or deploy operations are not sufficient reason to delegate.

Additional custom subagent types may be defined as markdown files in the plugin's agents/
directory. Each custom type can have its own system prompt and tools.

When to use this tool:
- Independent tasks that materially reduce wall-clock time when run in parallel
- A specialist subagent provides capability unavailable on the direct path
- Bounded exploration that would otherwise displace important parent context

When NOT to use this tool:
- Merely because a task is complex, multi-step, verbose, or touches a large repo
- Splitting dependent steps across parallel subagents; keep the chain together
  and delegate it as one bounded task only when specialist or context-isolation
  benefit clearly wins
- Parallel work with overlapping files, shared mutable state, or external side effects
- Tasks requiring user interaction or clarification

Costs to include in the delegation decision:
- Repeating the same repository discovery in multiple contexts
- Coordination, verification, and synthesis of returned results
- Any task the parent can complete more cheaply with direct tools`

// ===========================================================================
// Caps — inline port of config/subagents_config.py clamps and
// subagent_limit_middleware.py:_truncate_task_calls.
// Twin: src/policy/caps.ts (vector-tested against parity/baseline/caps_clamping.json).
// ===========================================================================

/** clamp_subagent_concurrency: max(1, min(4, value)). Non-integers fall back to the default. */
function clampConcurrency(value) {
  if (typeof value !== 'number' || !Number.isInteger(value)) return DEFAULT_MAX_CONCURRENT_SUBAGENT_CALLS
  return Math.max(MIN_CONCURRENT_SUBAGENT_CALLS, Math.min(MAX_CONCURRENT_SUBAGENT_CALLS, value))
}

/** clamp_total_subagents_per_run: max(1, min(50, value)). */
function clampTotal(value) {
  if (typeof value !== 'number' || !Number.isInteger(value)) return DEFAULT_MAX_TOTAL_SUBAGENTS_PER_RUN
  return Math.max(MIN_TOTAL_SUBAGENTS_PER_RUN, Math.min(MAX_TOTAL_SUBAGENTS_PER_RUN, value))
}

/**
 * allowed = min(max_concurrent, max(0, max_total - prior)).
 *
 * Because max_concurrent >= 1, `allowed === 0` if and only if the per-run budget is exhausted
 * — which is exactly the condition under which the original appends the limit note. So
 * replaying this once per batch drops tasks only when the budget is truly gone, never while
 * budget remains. Twin: src/deeprun/batching.ts planBatches.
 */
function allowedThisResponse(limits, requested, prior) {
  const remainingTotal = Math.max(0, limits.maxTotal - prior)
  const allowed = Math.min(limits.maxConcurrent, remainingTotal)
  if (requested <= allowed) {
    return { allowedTaskCalls: requested, remainingTotal, truncated: false, limitNoteAppended: false }
  }
  return {
    allowedTaskCalls: allowed,
    remainingTotal,
    truncated: true,
    limitNoteAppended: remainingTotal === 0,
  }
}

function resolveAgentType(subagentType) {
  const bare = typeof subagentType === 'string' ? subagentType.replace(/^deerflow:/, '') : subagentType
  if (bare === 'deerflow-bash' || bare === 'bash') return 'deerflow-bash'
  return DEFAULT_AGENT_TYPE
}

/**
 * Plugin-qualified id for agent({ agentType }). Twin: src/deeprun/batching.ts qualifyAgentType.
 *
 * Verified live (M6 smoke, Claude Code 2.1.220): a plugin agent resolves ONLY under
 * `<plugin>:<agent-name>`. The bare name fails with "agent type '...' not found. Available
 * agents: ..., deerflow:deerflow-bash, deerflow:deerflow-general-purpose, ...". The bare name
 * stays on the plan and the ledger; only the dispatch call site is qualified.
 */
function qualifyAgentType(agentType) {
  return agentType.indexOf(`${PLUGIN_AGENT_NAMESPACE}:`) === 0 ? agentType : `${PLUGIN_AGENT_NAMESPACE}:${agentType}`
}

/** Twin: src/deeprun/batching.ts planBatches. */
function planBatches(tasks, limits, priorDelegations, timeoutMs) {
  const batches = []
  const accepted = []
  const decisions = []
  let prior = priorDelegations
  let cursor = 0
  let lastDecision = null

  while (cursor < tasks.length) {
    const decision = allowedThisResponse(limits, tasks.length - cursor, prior)
    decisions.push(decision)
    lastDecision = decision
    if (decision.allowedTaskCalls === 0) break

    const batch = []
    for (let offset = 0; offset < decision.allowedTaskCalls; offset += 1) {
      const index = cursor + offset
      const task = tasks[index]
      if (!task) break
      const planned = {
        index,
        description: String(task.description || `task ${index}`),
        prompt: String(task.prompt || ''),
        agentType: resolveAgentType(task.subagent_type),
        timeoutMs,
      }
      batch.push(planned)
      accepted.push(planned)
    }
    batches.push(batch)
    cursor += batch.length
    prior += batch.length
  }

  const dropped = tasks.slice(cursor)
  const noteApplies = dropped.length > 0 && lastDecision !== null && lastDecision.limitNoteAppended
  return {
    batches,
    accepted,
    dropped,
    decisions,
    limitNote: noteApplies ? SUBAGENT_LIMIT_NOTE : null,
    stopReason: noteApplies ? SUBAGENT_LIMIT_STOP_REASON : null,
  }
}

// ===========================================================================
// Result formatting — inline port of status_contract.py.
// Twin: src/deeprun/result-format.ts, byte-tested against all 60 golden renders in
// parity/baseline/subagent_status_contract.json. KEEP BYTE-IDENTICAL.
// ===========================================================================

function stopReasonLabel(stopReason) {
  if (!stopReason) return null
  return STOP_REASON_LABELS[stopReason] || null
}

/** format_subagent_result_message -> { modelVisibleContent, metadataError }. */
function formatSubagentResultMessage(status, result, error, stopReason) {
  const resultText = result === null || result === undefined ? '' : String(result)
  const detailText = typeof error === 'string' ? error.trim() : ''
  const capped = stopReasonLabel(stopReason)

  if (status === 'completed') {
    const head = capped === null ? 'Task Succeeded.' : `Task Succeeded (capped: ${capped}).`
    return { modelVisibleContent: `${head} Result: ${resultText}`, metadataError: null }
  }

  if (status === 'cancelled') {
    const base = 'Task cancelled by user.'
    const detail = detailText || base
    if (detail === base) return { modelVisibleContent: detail, metadataError: detail }
    return { modelVisibleContent: `Task cancelled by user. Error: ${detail}`, metadataError: detail }
  }

  if (status === 'timed_out') {
    const base = 'Task timed out.'
    const detail = detailText || base
    if (detail === base) return { modelVisibleContent: detail, metadataError: detail }
    return { modelVisibleContent: `Task timed out. Error: ${detail}`, metadataError: detail }
  }

  if (status === 'polling_timed_out') {
    const detail = detailText || 'Task polling timed out.'
    return { modelVisibleContent: detail, metadataError: detail }
  }

  const base = 'Task failed.'
  const detail = detailText || base
  if (capped !== null) {
    if (detail === base) return { modelVisibleContent: `Task failed (capped: ${capped}).`, metadataError: detail }
    return { modelVisibleContent: `Task failed (capped: ${capped}). Error: ${detail}`, metadataError: detail }
  }
  if (detail === base) return { modelVisibleContent: detail, metadataError: detail }
  return { modelVisibleContent: `Task failed. Error: ${detail}`, metadataError: detail }
}

/** _bound_metadata_text, code-point sliced. Twin: src/deeprun/result-format.ts. */
function boundMetadataText(text, cap) {
  const limit = cap || 2000
  const cleaned = String(text).trim()
  const points = Array.from(cleaned)
  if (points.length <= limit) return cleaned
  const marker = '\n...\n'
  if (limit <= marker.length) return points.slice(0, limit).join('')
  const head = Math.floor((limit * 2) / 3)
  const tail = limit - head - marker.length
  if (tail <= 0) return points.slice(0, limit).join('')
  return points.slice(0, head).join('') + marker + points.slice(points.length - tail).join('')
}

/**
 * Coerce the Workflow tool's `args` input into an options object.
 * Twin: src/deeprun/task-schema.ts coerceWorkflowArgs.
 *
 * The tool documents that `args` must be a real JSON value and warns that a JSON-ENCODED
 * STRING "reaches the script as one string". Observed live during the M6 smoke: the lead sent
 * a stringified object on every attempt, which made this workflow fall through to the planner
 * with an empty objective — a run that looks successful but did nothing. Parse it instead.
 */
function coerceWorkflowArgs(value) {
  let candidate = value
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate)
    } catch (error) {
      return {}
    }
  }
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return {}
  return candidate
}

/** Twin: src/deeprun/task-schema.ts normalizeTaskResult. */
function normalizeTaskResult(raw) {
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    return { status: 'failed', result: NO_RESPONSE_SENTINEL, stop_reason: null, files_produced: [] }
  }
  const status = TASK_RESULT_STATUS_VALUES.indexOf(raw.status) !== -1 ? raw.status : 'failed'
  const result = typeof raw.result === 'string' ? raw.result : ''
  const stopReason = STOP_REASON_VALUES.indexOf(raw.stop_reason) !== -1 ? raw.stop_reason : null
  const files = Array.isArray(raw.files_produced) ? raw.files_produced.filter((entry) => typeof entry === 'string') : []
  return {
    status,
    result: result === '' && status === 'failed' ? NO_RESPONSE_SENTINEL : result,
    stop_reason: stopReason,
    files_produced: files,
  }
}

// <<<PORTED-LOGIC-END>>>

// ===========================================================================
// Dispatch — structural translation of executor.py:_aexecute + execute_async's
// FuturesTimeoutError branch (executor.py:1100-1161).
// ===========================================================================

const TIMEOUT_MARKER = { deerflowTimeout: true }

/**
 * Race a promise against a real timer.
 *
 * The timer is ALWAYS cleared, on both settle paths: a pending 30-minute timer would
 * otherwise keep the workflow runtime's event loop busy after this script returns.
 */
function withTimeout(promise, timeoutMs) {
  let timer = null
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT_MARKER), timeoutMs)
  })
  const clear = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }
  return Promise.race([promise, timeout]).then(
    (value) => {
      clear()
      return value
    },
    (error) => {
      clear()
      throw error
    },
  )
}

/**
 * Run one delegated task and always resolve to a terminal result.
 *
 * Failure mapping, mirroring the executor:
 *   agent() resolves null  -> failed + `No response generated`  (_extract_final_result sentinel;
 *                             agent() yields null when the user skips the agent or the subagent
 *                             dies on a terminal API error after retries)
 *   agent() throws         -> failed + str(e)                    (executor.py:1010-1016 catch-all)
 *   timer wins the race    -> timed_out + "Execution timed out after N seconds", stop_reason
 *                             stays null (execute_async's FuturesTimeoutError branch sets
 *                             TIMED_OUT and never a cap reason)
 */
async function runTask(task) {
  const invocation = agent(task.prompt, {
    label: task.description,
    phase: 'Delegate',
    schema: TASK_RESULT_SCHEMA,
    agentType: qualifyAgentType(task.agentType),
  })

  let raced
  try {
    raced = await withTimeout(invocation, task.timeoutMs)
  } catch (error) {
    const message = error && error.message ? String(error.message) : String(error)
    return { index: task.index, status: 'failed', result: message, stop_reason: null, files_produced: [], error: message }
  }

  if (raced === TIMEOUT_MARKER) {
    const seconds = Math.round(task.timeoutMs / 1000)
    const message = `Execution timed out after ${seconds} seconds`
    log(`timeout: ${task.description} (after ${seconds}s)`)
    return {
      index: task.index,
      status: 'timed_out',
      result: '',
      stop_reason: null,
      files_produced: [],
      error: message,
    }
  }

  const normalized = normalizeTaskResult(raced)
  return {
    index: task.index,
    status: normalized.status,
    result: normalized.result,
    stop_reason: normalized.stop_reason,
    files_produced: normalized.files_produced,
    // Only `completed` suppresses the error blob; every other status carries the result text
    // as its error detail (status_contract.py:make_subagent_additional_kwargs).
    error: normalized.status === 'completed' ? null : normalized.result,
  }
}

// ===========================================================================
// Script body
// ===========================================================================

const input = coerceWorkflowArgs(args)
const objective = typeof input.objective === 'string' ? input.objective : ''
const runId = typeof input.run_id === 'string' && input.run_id ? input.run_id : 'deep-run'
const commitSha = typeof input.commit_sha === 'string' ? input.commit_sha : null
const priorDelegations = typeof input.prior_delegations === 'number' ? Math.max(0, input.prior_delegations) : 0
const timeoutMs = typeof input.timeout_ms === 'number' && input.timeout_ms > 0 ? input.timeout_ms : DEFAULT_SUBAGENT_TIMEOUT_MS

const limits = {
  maxConcurrent: clampConcurrency(input.max_concurrent),
  maxTotal: clampTotal(input.max_total),
}

// --- Phase: Plan ------------------------------------------------------------
let requestedTasks = Array.isArray(input.tasks) ? input.tasks : null
let planned_by = 'caller'

if (requestedTasks === null) {
  planned_by = 'planner-agent'
  phase('Plan')
  const plan = await agent(
    `${DELEGATION_POLICY}\n\n` +
      `Decompose the objective below into independent, non-overlapping delegable tasks, applying the ` +
      `delegation policy above. Emit at most ${limits.maxTotal} tasks and prefer fewer: a task that the ` +
      `lead can do more cheaply with direct tools must NOT be emitted. Each task's prompt must be ` +
      `self-contained — the subagent sees only that prompt, never this objective or the other tasks.\n\n` +
      `OBJECTIVE:\n${objective}`,
    { label: 'plan', phase: 'Plan', schema: PLAN_SCHEMA },
  )
  requestedTasks = plan && Array.isArray(plan.tasks) ? plan.tasks : []
  log(`planned ${requestedTasks.length} task(s)`)
}

const tasks = requestedTasks.filter((task) => task && typeof task === 'object')

// --- Phase: Delegate --------------------------------------------------------
phase('Delegate')
const plan = planBatches(tasks, limits, priorDelegations, timeoutMs)

if (plan.dropped.length > 0) {
  // Never silent: the drop is announced live AND carried in the returned summary.
  log(`${plan.dropped.length} task(s) dropped — per-run delegation budget exhausted`)
}
log(
  `delegating ${plan.accepted.length}/${tasks.length} task(s) in ${plan.batches.length} batch(es) ` +
    `(concurrent=${limits.maxConcurrent}, total=${limits.maxTotal}, prior=${priorDelegations})`,
)

const outcomes = []
for (let batchIndex = 0; batchIndex < plan.batches.length; batchIndex += 1) {
  const batch = plan.batches[batchIndex]
  // parallel() is the barrier the per-response cap models: a batch IS one response's worth of
  // dispatch, and the next batch's allowance is only known once this one has landed.
  const settled = await parallel(batch.map((task) => () => runTask(task)))
  for (let slot = 0; slot < batch.length; slot += 1) {
    const task = batch[slot]
    const outcome = settled[slot]
    if (outcome) {
      outcomes.push(outcome)
      continue
    }
    // parallel() resolves a thrown thunk to null. runTask catches its own errors, so this is
    // the runtime-level failure path (agent skipped / killed).
    outcomes.push({
      index: task.index,
      status: 'failed',
      result: NO_RESPONSE_SENTINEL,
      stop_reason: null,
      files_produced: [],
      error: NO_RESPONSE_SENTINEL,
    })
  }
}

// --- Phase: Synthesize ------------------------------------------------------
// Deterministic assembly, NO model call. The LEAD session writes the narrative synthesis from
// this structured object; the workflow's job is to make that synthesis a pure function of what
// the subagents actually returned.
phase('Synthesize')

const results = []
const ledgerEntries = []
const filesProduced = []
const totals = { completed: 0, failed: 0, timed_out: 0, cancelled: 0 }

for (let position = 0; position < plan.accepted.length; position += 1) {
  const task = plan.accepted[position]
  const outcome = outcomes[position]
  if (!task || !outcome) continue

  const formatted = formatSubagentResultMessage(outcome.status, outcome.result, outcome.error, outcome.stop_reason)

  results.push({
    index: task.index,
    description: task.description,
    subagent_type: task.agentType,
    status: outcome.status,
    stop_reason: outcome.stop_reason,
    result: outcome.result,
    files_produced: outcome.files_produced,
    // The exact text the original put in front of the lead model.
    model_visible_content: formatted.modelVisibleContent,
    metadata_error: formatted.metadataError,
  })

  // Ledger-shaped entry. `created_at` and `result_sha256` are null here on purpose: the clock
  // and a hash function are both unavailable in this sandbox. src/deeprun/ledger-io.ts stamps
  // them when the lead session persists these entries.
  ledgerEntries.push({
    id: `${runId}:${task.index}`,
    run_id: runId,
    description: boundMetadataText(task.description, 200),
    subagent_type: task.agentType,
    status: outcome.status,
    stop_reason: outcome.stop_reason,
    result_brief: outcome.status === 'completed' && outcome.result ? boundMetadataText(outcome.result, 2000) : null,
    result_sha256: null,
    created_at: null,
    commit_sha: commitSha,
  })

  if (Object.prototype.hasOwnProperty.call(totals, outcome.status)) totals[outcome.status] += 1
  for (const path of outcome.files_produced) {
    if (filesProduced.indexOf(path) === -1) filesProduced.push(path)
  }
}

const droppedTasks = plan.dropped.map((task, offset) => ({
  index: plan.accepted.length + offset,
  description: typeof task.description === 'string' ? task.description : `task ${plan.accepted.length + offset}`,
  subagent_type: resolveAgentType(task.subagent_type),
  reason: SUBAGENT_LIMIT_STOP_REASON,
}))

log(
  `synthesized ${results.length} result(s): ${totals.completed} completed, ${totals.failed} failed, ` +
    `${totals.timed_out} timed out, ${totals.cancelled} cancelled` +
    (droppedTasks.length > 0 ? `, ${droppedTasks.length} dropped` : ''),
)

return {
  milestone: 'M6',
  objective,
  run_id: runId,
  commit_sha: commitSha,
  planned_by,
  caps: {
    max_concurrent: limits.maxConcurrent,
    max_total: limits.maxTotal,
    prior_delegations: priorDelegations,
    timeout_ms: timeoutMs,
    batch_sizes: plan.batches.map((batch) => batch.length),
  },
  totals: {
    requested: tasks.length,
    delegated: plan.accepted.length,
    dropped: droppedTasks.length,
    completed: totals.completed,
    failed: totals.failed,
    timed_out: totals.timed_out,
    cancelled: totals.cancelled,
  },
  results,
  files_produced: filesProduced,
  dropped_tasks: droppedTasks,
  // Verbatim [SUBAGENT LIMIT REACHED] note when the per-run budget truncated the plan.
  limit_note: plan.limitNote,
  stop_reason: plan.stopReason,
  // Persist through src/deeprun/ledger-io.ts (stamps created_at + result_sha256).
  ledger_entries: ledgerEntries,
}
