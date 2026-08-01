// Ported from backend/packages/harness/deerflow/subagents/executor.py:SubagentResult, SubagentStatus @ 0950924 — structural translation
// Ported from backend/packages/harness/deerflow/tools/builtins/task_tool.py:task_tool (model-facing args) @ 0950924 — structural translation
// Contract fixture: contracts/subagent_status_contract.json (v2).
// Parity vectors: parity/baseline/subagent_status_contract.json
//   (`status_values`, `stop_reason_values`) and
//   parity/baseline/prompt_renders/task_tool_description.txt.
//
// Structural, not mechanical: the original's `SubagentResult` is an in-process dataclass the
// executor mutates and the tool reads. The port has no shared process — the subagent runs
// behind Claude Code's Agent tool and can only communicate through its returned text. So the
// dataclass becomes a JSON Schema handed to `agent(prompt, {schema})`, which forces the
// subagent through a StructuredOutput tool call and validates the result at the tool layer.
// Consequence: the subagent now SELF-REPORTS its status, where the original derived it from
// the executor's own control flow. Fields the executor owned and a subagent cannot know about
// itself (task_id, trace_id, started_at/completed_at, ai_messages, token_usage_records,
// usage_reported, cancel_event) are therefore NOT in the schema; deep-run.js stamps the ones
// it owns (timeout, dispatch failure) over whatever the agent returned.
import { SUBAGENT_STOP_REASON_VALUES, type SubagentStopReason } from '../policy/stop-reason.js'

/**
 * Statuses a subagent may report about itself — `SubagentStatus`'s terminal members
 * (COMPLETED / FAILED / CANCELLED / TIMED_OUT).
 *
 * `polling_timed_out` is deliberately absent even though it IS a contract status value: it is
 * produced only by `task_tool`'s 5-second polling loop, which the port does not have (the
 * Agent tool blocks until the subagent returns). PENDING/RUNNING are absent because they are
 * non-terminal and a returned result is by definition terminal.
 */
export const TASK_RESULT_STATUS_VALUES = ['completed', 'failed', 'timed_out', 'cancelled'] as const

export type TaskResultStatus = (typeof TASK_RESULT_STATUS_VALUES)[number]

/**
 * Stop reasons a subagent may report — the contract's three guardrail caps, verbatim.
 *
 * DELIBERATE OMISSION: `subagent_limit_capped` (src/policy/caps.ts) is NOT here. It is a
 * run-level reason the DISPATCHER stamps when the per-run delegation budget truncates a batch;
 * a subagent can never observe it about itself, and `format_subagent_result_message` has no
 * label for it, so accepting it here would let an agent emit a cap the formatter silently
 * renders as "no cap". The batch planner (src/deeprun/batching.ts) carries it on the plan.
 */
export const TASK_RESULT_STOP_REASON_VALUES = SUBAGENT_STOP_REASON_VALUES

export type TaskResultStopReason = SubagentStopReason

export interface DeepRunTaskResult {
  status: TaskResultStatus
  result: string
  stop_reason?: TaskResultStopReason | null
  files_produced?: string[]
}

/**
 * The JSON Schema `workflows/deep-run.js` passes as `agent(prompt, { schema })`.
 *
 * Frozen and exported as data so the workflow's inline copy can be diffed against it: the
 * workflow cannot import this module, so `task-schema.test.ts` pins the value and deep-run.js
 * names this file as its source of truth.
 */
export const DEEP_RUN_TASK_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: {
      type: 'string',
      enum: [...TASK_RESULT_STATUS_VALUES],
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
      enum: [...TASK_RESULT_STOP_REASON_VALUES, null],
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
} as const

/**
 * The model-facing delegation policy text, ported from `task_tool`'s docstring.
 *
 * Golden: parity/baseline/prompt_renders/task_tool_description.txt (sha256
 * d053edd6c702b168484fb9186f74b536b30fa7a7c87061112ac23c7be8f93491), verbatim except for the
 * substitutions listed below. `deep-run.js` inlines this text to instruct the planner agent,
 * which is where the original's per-call delegation judgement now lives: the port decides
 * up front which tasks are worth delegating instead of re-deciding at every `task` call.
 *
 * SUBSTITUTIONS
 *  T1 The two built-in type names `general-purpose` / `bash` become the port's registered
 *     agent types `deerflow-general-purpose` / `deerflow-bash`.
 *  T2 The `bash` availability sentence ("only available when host bash is explicitly allowed
 *     or when using an isolated shell sandbox such as `AioSandboxProvider`") is dropped:
 *     Claude Code gates Bash through the permission system, not a subagent-registry filter.
 *  T3 The `config.yaml -> subagents.custom_agents` paragraph becomes the plugin's `agents/`
 *     directory, which is where custom subagent types live in the port.
 *  T4 The `Args:` block is dropped — `agent()` takes the prompt positionally and the rest
 *     through the JSON Schema above, so the "ALWAYS PROVIDE THIS PARAMETER FIRST/SECOND/THIRD"
 *     ordering instructions (a DeerFlow streaming-display concern) have nothing to order.
 */
export const DEEP_RUN_DELEGATION_POLICY = `Delegate a bounded task to a specialized subagent in its own context. Delegate only when expected benefit clearly exceeds delegation overhead.
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

/** Registered agent types the planner may choose. */
export const DEEP_RUN_AGENT_TYPES = ['deerflow-general-purpose', 'deerflow-bash'] as const

export type DeepRunAgentType = (typeof DEEP_RUN_AGENT_TYPES)[number]

/** Schema for the planning phase's decomposition output. */
export const DEEP_RUN_PLAN_SCHEMA = {
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
          subagent_type: { type: 'string', enum: [...DEEP_RUN_AGENT_TYPES], description: 'The type of subagent to use.' },
        },
        required: ['description', 'prompt', 'subagent_type'],
        additionalProperties: false,
      },
    },
  },
  required: ['tasks'],
  additionalProperties: false,
} as const

/**
 * Coerce the Workflow tool's `args` input into an options object.
 *
 * The Workflow tool documents that `args` must be passed as a real JSON value, and warns that
 * a JSON-ENCODED STRING "reaches the script as one string". Observed live: a haiku lead sent
 * `args` as a stringified object on every attempt, which made deep-run silently fall through
 * to the planner with an empty objective — the worst failure mode available, because it looks
 * like a successful run that found nothing. So the string form is parsed rather than ignored.
 * A non-object (or unparseable) payload yields `{}`, which still runs, just with defaults.
 */
export function coerceWorkflowArgs(value: unknown): Record<string, unknown> {
  let candidate = value
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate) as unknown
    } catch {
      return {}
    }
  }
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return {}
  return candidate as Record<string, unknown>
}

export function isTaskResultStatus(value: unknown): value is TaskResultStatus {
  return typeof value === 'string' && (TASK_RESULT_STATUS_VALUES as readonly string[]).includes(value)
}

export function isTaskResultStopReason(value: unknown): value is TaskResultStopReason {
  return typeof value === 'string' && (TASK_RESULT_STOP_REASON_VALUES as readonly string[]).includes(value)
}

/**
 * Coerce whatever `agent()` returned into a well-formed result.
 *
 * `agent()` yields `null` when the user skips the agent mid-run or the subagent dies on a
 * terminal API error after retries. That maps onto the original's `_extract_final_result`
 * sentinel path: no usable output at all. An out-of-contract status or stop_reason is
 * normalized rather than thrown on — a malformed agent reply must not abort the whole run,
 * which is the same posture as the executor's catch-all `except Exception -> FAILED`.
 */
export function normalizeTaskResult(raw: unknown, sentinel: string): DeepRunTaskResult {
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    return { status: 'failed', result: sentinel, stop_reason: null }
  }
  const source = raw as Record<string, unknown>
  const status = isTaskResultStatus(source['status']) ? source['status'] : 'failed'
  const result = typeof source['result'] === 'string' ? source['result'] : ''
  const stopReason = isTaskResultStopReason(source['stop_reason']) ? source['stop_reason'] : null
  const files = Array.isArray(source['files_produced'])
    ? source['files_produced'].filter((entry): entry is string => typeof entry === 'string')
    : []
  return {
    status,
    result: result === '' && status === 'failed' ? sentinel : result,
    stop_reason: stopReason,
    files_produced: files,
  }
}
