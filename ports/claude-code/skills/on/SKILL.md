---
name: on
description: Switch this session into DeerFlow mode. Use when the user invokes /deerflow:on — from that point on, every task in the session runs under the full DeerFlow lead-agent policy without needing any prefix.
disable-model-invocation: true
---

# DeerFlow mode: ON

From this point until the end of the session (or until the user invokes `/deerflow:off`):

1. **Load the policy now**: invoke the `deerflow:run` skill immediately to load the full lead-agent policy into context. If an objective was passed with this command (`$ARGUMENTS` is non-empty), treat it as the first task and execute it under the policy right away.
2. **Every subsequent user request that is a task** (research, code change, audit, analysis, multi-step work) is handled exactly as if it had been invoked with `/deerflow:run <request>`: clarify-before-acting, benefit-based delegation under the hard caps (max 3 Agent calls per response, 6 per run; heavy multi-agent work through the `deerflow:deep-run` workflow), the `outputs/` delivery contract, todo discipline for multi-step work, and honest terminal-response reporting.
3. **Plain conversational messages** (questions about state, chit-chat, clarification replies) are answered normally — the policy governs task execution, not conversation.
4. If `.deerflow/state/` exists in the project, check `/deerflow:status` (run `node ${CLAUDE_PLUGIN_ROOT}/dist/resume/status-cli.js`) before the first task and surface anything resumable.

Confirm activation to the user in one short line: DeerFlow mode is on for this session; they can turn it off with `/deerflow:off`.
