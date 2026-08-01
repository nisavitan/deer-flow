---
name: plan
description: Enter DeerFlow plan mode for a multi-step objective - structured todo tracking (TaskCreate/TaskUpdate) plus the DeerFlow lead-agent policy. Use when the user invokes /deerflow:plan, or before starting work that needs 3 or more tracked steps.
---

<!-- Ported from backend/packages/harness/deerflow/agents/factory.py:_TODO_SYSTEM_PROMPT@0950924
     (and its longer sibling in agents/lead_agent/agent.py:148-260, gated on
     configurable.is_plan_mode). `write_todos` maps to the native TaskCreate /
     TaskUpdate tools. The block below is emitted verbatim by
     src/prompts/lead.ts (TODO_LIST_SYSTEM_SECTION) and pinned against it by
     src/prompts/skills.test.ts. -->

# DeerFlow plan mode

Objective: $ARGUMENTS

In DeerFlow, todo tracking exists **only** in plan mode
(`configurable.is_plan_mode`); this skill is that gate. Entering plan mode does
not change any other policy - the DeerFlow lead-agent policy in
`/deerflow:run` (identity, benefit-based delegation and its caps, the
`outputs/` delivery contract, response style and terminal-response discipline)
applies unchanged. Read and follow the `run` skill for that policy; this file
adds only the tracking discipline.

## Todo discipline (generated from src/prompts/lead.ts)

<todo_list_system>
You have access to the `TaskCreate` and `TaskUpdate` tools to help you manage and track complex multi-step objectives.

**CRITICAL RULES:**
- Mark todos as completed IMMEDIATELY after finishing each step - do NOT batch completions
- Keep EXACTLY ONE task as `in_progress` at any time (unless tasks can run in parallel)
- Update the todo list in REAL-TIME as you work - this gives users visibility into your progress
- DO NOT use this tool for simple tasks (< 3 steps) - just complete them directly
</todo_list_system>

## Planning sequence

1. Clarify first. Resolve anything unclear, missing, or ambiguous before
   creating a single todo - a plan built on a guess is worse than no plan.
2. Break the objective into concrete, verifiable steps. Fewer than 3 steps means
   no todo list: just do the work.
3. Create the list with TaskCreate, then mark the first step `in_progress`
   immediately so the user sees the plan is live.
4. Execute one step at a time, marking each completed with TaskUpdate the moment
   it is done.
5. Finish with a visible response that states what was produced and where.
