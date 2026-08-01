// Ported from backend/packages/harness/deerflow/agents/middlewares/subagent_limit_middleware.py:_truncate_task_calls @ 0950924 — structural translation
// Ported from backend/packages/harness/deerflow/config/subagents_config.py:SubagentsAppConfig.timeout_seconds @ 0950924 — mechanical TypeScript translation
// Parity vectors: parity/baseline/caps_clamping.json -> `allowed_this_response`.
//
// The arithmetic itself lives in src/policy/caps.ts (already vector-tested); this module is
// only the multi-batch planner built on top of it, plus the timeout policy the original kept
// in config rather than in the limit middleware.
//
// Structural, not mechanical: the original enforces the cap ONCE PER MODEL RESPONSE, inside an
// after_model hook that rewrites the AIMessage's tool_calls, and the model is free to ask
// again on its next turn. The workflow has no model turns to hook — it owns the whole
// dispatch loop — so the port replays the same per-response decision once per batch, feeding
// each batch's launches back in as `priorDelegations`. That composition is exact rather than
// approximate: `allowed = min(maxConcurrent, max(0, maxTotal - prior))` with `maxConcurrent >= 1`
// means `allowed == 0` if and only if `remainingTotal == 0`, so the loop stops exactly when
// the per-run budget is exhausted and the `[SUBAGENT LIMIT REACHED]` note the original appends
// in that same condition rides out on the final decision. Tasks are therefore never dropped
// silently, and never dropped while budget remains.
import {
  SUBAGENT_LIMIT_NOTE,
  SUBAGENT_LIMIT_STOP_REASON,
  allowedThisResponse,
  createSubagentLimits,
  type DispatchDecision,
  type SubagentLimits,
} from '../policy/caps.js'
import type { DeepRunAgentType } from './task-schema.js'

/**
 * Per-task wall-clock timeout, milliseconds.
 *
 * Port of `SubagentsAppConfig.timeout_seconds = 1800` (30 min), the global default the
 * registry layers onto both built-in subagents. The dataclass default of 900s applies only to
 * custom agents, which the port does not yet have.
 */
export const DEFAULT_SUBAGENT_TIMEOUT_MS = 1_800_000

export interface DeepRunTask {
  readonly description: string
  readonly prompt: string
  readonly subagent_type: string
}

export interface PlannedTask {
  /** Position in the caller's original task list — stable across batching. */
  readonly index: number
  readonly description: string
  readonly prompt: string
  /** Resolved Claude Code agent type, passed as `agent(..., { agentType })`. */
  readonly agentType: DeepRunAgentType
  readonly timeoutMs: number
}

export interface BatchPlanOptions {
  readonly tasks: readonly DeepRunTask[]
  /** Delegations already launched in this run — see `priorDelegationsForRun`. */
  readonly priorDelegations?: number
  readonly limits?: SubagentLimits
  readonly timeoutMs?: number
  /** Visible summary text the limit note is appended to, mirroring the original's message. */
  readonly messageContent?: string | null
}

export interface BatchPlan {
  /** Batches to run in order; every batch is a single `parallel()` barrier. */
  readonly batches: readonly (readonly PlannedTask[])[]
  /** Flattened accepted tasks, in original order. */
  readonly accepted: readonly PlannedTask[]
  /** Tasks beyond the per-run budget. Reported, never silently discarded. */
  readonly dropped: readonly DeepRunTask[]
  /** The per-batch decisions, in order — the parity surface against `allowed_this_response`. */
  readonly decisions: readonly DispatchDecision[]
  /** Verbatim `[SUBAGENT LIMIT REACHED]` note when tasks were dropped, else `null`. */
  readonly limitNote: string | null
  /** `subagent_limit_capped` when tasks were dropped, else `null`. */
  readonly stopReason: string | null
  /** Summary text with the limit note appended, when one was appended. */
  readonly messageContent: string | null
  readonly limits: SubagentLimits
  readonly timeoutMs: number
}

const DEFAULT_AGENT_TYPE: DeepRunAgentType = 'deerflow-general-purpose'

/**
 * Resolve a requested subagent type onto a registered agent.
 *
 * The original fails the whole call for an unknown `subagent_type`, listing the available
 * names. The port cannot fail a batch the same way without losing the other tasks in it, so
 * an unrecognized type falls back to general-purpose — the same choice the original's own
 * `model="inherit"` resolution makes for an unresolvable model. Bare `general-purpose` /
 * `bash` (the original's names) are accepted as aliases.
 */
export function resolveAgentType(subagentType: string | null | undefined): DeepRunAgentType {
  const bare = typeof subagentType === 'string' ? subagentType.replace(/^deerflow:/, '') : subagentType
  if (bare === 'deerflow-bash' || bare === 'bash') return 'deerflow-bash'
  return DEFAULT_AGENT_TYPE
}

/**
 * Plugin namespace agents are registered under — the `name` field of
 * .claude-plugin/plugin.json.
 */
export const PLUGIN_AGENT_NAMESPACE = 'deerflow'

/**
 * Plugin-qualified id to pass as `agent(..., { agentType })`.
 *
 * Verified live (M6 smoke, Claude Code 2.1.220): a plugin agent resolves ONLY under
 * `<plugin>:<agent-name>`. Calling the bare name fails the agent with
 * `agent type 'deerflow-general-purpose' not found. Available agents: ...,
 * deerflow:deerflow-bash, deerflow:deerflow-general-purpose, ...`.
 *
 * The bare name stays on the plan and in the ledger's `subagent_type` (it is the agent's own
 * frontmatter `name`); only the dispatch call site is qualified.
 */
export function qualifyAgentType(agentType: string): string {
  return agentType.startsWith(`${PLUGIN_AGENT_NAMESPACE}:`) ? agentType : `${PLUGIN_AGENT_NAMESPACE}:${agentType}`
}

/**
 * Plan the batches for a deep run.
 *
 * Replays the per-response cap decision once per batch, accumulating launches into `prior`.
 * Stops as soon as a decision allows zero launches; everything left is `dropped` and carries
 * the verbatim limit note.
 */
export function planBatches(options: BatchPlanOptions): BatchPlan {
  const limits = options.limits ?? createSubagentLimits()
  const timeoutMs = options.timeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS
  const tasks = options.tasks
  const messageContent = options.messageContent ?? null

  const batches: PlannedTask[][] = []
  const accepted: PlannedTask[] = []
  const decisions: DispatchDecision[] = []

  let prior = options.priorDelegations ?? 0
  let cursor = 0
  let lastDecision: DispatchDecision | null = null

  while (cursor < tasks.length) {
    const decision = allowedThisResponse({
      limits,
      requestedTaskCalls: tasks.length - cursor,
      priorDelegations: prior,
      messageContent,
    })
    decisions.push(decision)
    lastDecision = decision
    if (decision.allowedTaskCalls === 0) break

    const batch: PlannedTask[] = []
    for (let offset = 0; offset < decision.allowedTaskCalls; offset += 1) {
      const index = cursor + offset
      const task = tasks[index]
      if (task === undefined) break
      const planned: PlannedTask = {
        index,
        description: task.description,
        prompt: task.prompt,
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
    messageContent: noteApplies ? (lastDecision?.messageContent ?? SUBAGENT_LIMIT_NOTE) : null,
    limits,
    timeoutMs,
  }
}
