# Learnings: planning a faithful port of a LangGraph harness to Claude Code

## The problem, in one line

Decide — with evidence, not vibes — whether and how a 443-file Python LangGraph agent harness (DeerFlow) can run natively inside Claude Code on a Max subscription, with no API key, no servers, and per-file traceability to the original source.

## The approach

1. **Fork + pin first.** Fork, clone, branch from a recorded upstream SHA. Every later claim cites `path:lines@SHA`, so the pin must exist before any reading starts.
2. **Read the repo's own agent docs before fanning out.** DeerFlow's `AGENTS.md` files were a near-complete architecture spec; reading them first made every subagent prompt far more precise (exact middleware names, chain order, config keys to verify rather than discover).
3. **Fan out source-reading to 7 parallel agents, each writing a cited notes file to disk** — not returning content to the orchestrator. The orchestrator's context stays small; the notes become the durable evidence layer that later doc-writing agents cite instead of re-reading Python.
4. **Run capability experiments in parallel with the source reading, cheapest-first, on the real CLI.** Headless `claude -p` probes (haiku, `--no-session-persistence`) settled in minutes what documentation alone could not: plugin-packaged workflows work, hooks deny deterministically, workflow resume replays from cache in 14 ms with 0 tokens.
5. **Let one primary-source fact kill an entire architecture branch early.** The Agent SDK's API-key-only auth policy (official docs) disqualified Option C without building a spike — the constraint was policy, not capability, so no experiment could change it.
6. **Decide the architecture yourself; delegate the writing.** The options comparison and recommendation were written by the orchestrator (they are judgment); the mechanical deliverables (traceability matrix, middleware plan, parity plan) were delegated with prompts that named their exact input notes and required marking every claim Verified/Inference.
7. **Close with an adversarial verifier that recounts and re-cites.** It recounted the 195-row matrix arithmetic, spot-checked 24 of 535 citations against live source, and reproduced experiment outputs against the repo — catching 7 real minors (stale line range, overclaimed "verified", inconsistent slot-numbering schemes) that the writers could not see.

## The judgment calls

- **Did NOT put the lead agent inside a workflow** even though workflows are the most LangGraph-like primitive. DeerFlow's lead is interactive (clarification interrupts, multi-turn threads); workflow agents are non-interactive workers. Substrate choice followed *interaction contract*, not structural resemblance.
- **Did NOT treat "Claude Code can run Python" as a porting path.** The forbidden shape (plugin launches old Python runtime on borrowed OAuth) already exists in DeerFlow's own `claude_provider.py` — it was excluded with a planned CI guard, not reused.
- **Did NOT claim JSON files replace LangGraph checkpoints.** Instead the state design enumerates which guarantees hold (atomic per-file writes, stage-level resume, SHA staleness) and which are lost (per-superstep multi-channel transactions), each with a reason and a parity test.
- **Did NOT let agents summarize into the chat.** Every reader agent wrote its evidence to a repo file and returned only a 10-line pointer; the orchestrator never held more than pointers plus decisions.
- **Did NOT skip experiments where docs sufficed but execution was cheap** — and did skip the one spike (Agent SDK) where execution could not alter the decisive fact.

## The reusable rule

When porting a system to a new platform, map each original component to a platform primitive by its *contract* (interactive vs deterministic vs boundary-enforcement), prove each load-bearing mapping with a minimal executed experiment before designing on it, and keep orchestrator context to pointers by making every fan-out agent write its cited evidence to disk.
