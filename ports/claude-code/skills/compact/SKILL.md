---
name: compact
description: Refresh the DeerFlow durable checkpoint digest (summary.json) and report exactly what survives compaction. Use when the user invokes /deerflow:compact, before a long context is compacted, or when asked what will be preserved if the conversation is compacted.
---

<!-- Ported from backend/packages/harness/deerflow/runtime/context_compaction.py:compact_thread_context
     @ 0950924 and its route POST /api/threads/{id}/compact. The DIFFERENCE from that route is
     declared in the "What this is not" section below and in
     docs/claude-code-port/summarization-delta.md, row "manual compaction".
     Implementation: src/summary/digest-cli.ts (digest rebuild),
     src/summary/summary-state.ts (summary.json channel),
     src/hooks/precompact-summary.ts (the automatic counterpart). -->

# DeerFlow manual compaction

DeerFlow's manual compaction endpoint summarizes older context into the durable
`summary_text` channel and keeps the recent message window. In Claude Code the
two halves of that job have different owners, so this skill does the half the
port owns and tells you how to trigger the other half.

## What this is not

**This skill does not compact the conversation.** Compaction of the message
history is owned by Claude Code, and the native `/compact` command is not
model-invocable — a skill cannot run it for you. This skill therefore:

1. rebuilds the durable digest (what survives compaction), and
2. asks you to run `/compact` yourself if you want the context shrunk now.

The original route also rewrote the checkpoint's message channel
(`RemoveMessage(REMOVE_ALL_MESSAGES)` + the preserved tail) and generated an LLM
summary. Neither happens here: the port cannot touch the transcript, and the
digest is deterministic, never model-generated.

## Steps

1. **Rebuild the digest.** Run:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/summary/digest-cli.js" --trigger manual
   ```

   Pass `--thread <id>` if `DEERFLOW_THREAD_ID` is not set in the environment.
   The command reads the thread's `.deerflow/state/<thread>/` directory
   (`todos.json`, `delegations.json`, `artifacts.json`) and writes
   `summary.json` atomically with `updated_by: manual`. It calls no model.

2. **Report what is preserved.** Show the user, in plain language:
   - the recent objectives, open todos, delegation counts, and artifacts the
     command printed;
   - that these are re-injected into the next turn from `summary.json`;
   - that anything not in that list — intermediate tool output, exploratory
     reasoning, file contents read earlier — is **not** preserved by DeerFlow
     and survives only inside Claude Code's own compaction summary, which
     DeerFlow does not control.

3. **Hand compaction back to the user.** State explicitly:

   > The durable digest is refreshed. To actually compact the context now, run
   > `/compact` yourself — I cannot invoke it.

   Do not claim the context was compacted. It was not.

## When it happens automatically

The `PreCompact` hook (`dist/hooks/precompact-summary.js`) writes the same
digest with `updated_by: precompact` immediately before Claude Code compacts,
whether the compaction was automatic or user-triggered. Running this skill is
only needed when you want the digest refreshed at a moment of your choosing —
for example right before ending a session, or before a deliberate `/compact`.

## Trigger difference from DeerFlow

DeerFlow compacts when its own configured threshold fires
(`summarization.trigger`, keep policy `("messages", 20)`). Claude Code compacts
at roughly 85% of the context window and exposes no equivalent knob, so the
port has no threshold to honour and no keep policy to enforce. Do not tell the
user a trigger was configured; there is none. Full comparison:
`docs/claude-code-port/summarization-delta.md`.
