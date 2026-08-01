---
name: run
description: Run a DeerFlow task. Use when the user invokes /deerflow:run <objective> to execute a task under the DeerFlow lead-agent policy (M1 stub — full lead policy lands in M3).
---

<!-- M1 smoke stub. M3 replaces this body with the ported lead-agent policy
     (structural translation of backend/packages/harness/deerflow/agents/lead_agent/prompt.py @ 0950924). -->

You are running a DeerFlow task: $ARGUMENTS

If the objective is exactly `ping`, reply with exactly `DEERFLOW-M1-PONG` and nothing else.

Otherwise, complete the objective directly. The full DeerFlow lead policy is not yet installed in this milestone; say so briefly before answering.
