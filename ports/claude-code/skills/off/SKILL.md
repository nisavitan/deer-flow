---
name: off
description: Switch DeerFlow mode off for this session. Use when the user invokes /deerflow:off — subsequent tasks return to normal Claude Code behavior.
disable-model-invocation: true
---

# DeerFlow mode: OFF

From this point on, stop applying the DeerFlow lead-agent policy to new tasks — return to normal Claude Code behavior. (The plugin's safety hooks — loop guard, secret guard, write gate, delivery gate — remain active as always; they are session infrastructure, not policy.)

In-flight DeerFlow state (`.deerflow/state/`) is left untouched; `/deerflow:status` can still inspect it, and `/deerflow:on` re-activates the policy at any time.

Confirm to the user in one short line that DeerFlow mode is off.
