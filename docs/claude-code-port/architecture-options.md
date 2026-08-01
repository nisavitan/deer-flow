# Architecture options comparison

Basis: source analysis at commit `095092418ccf072aa866c0a663c4056c206091e5`, verified Claude Code capabilities (`claude-code-capabilities.md`), and executed experiments (`experiment-results.md`). Date: 2026-08-01.

## The five candidates

### Option A — pure Dynamic Workflow port
Everything (lead loop included) becomes one code-defined workflow; `/deerflow:run` triggers it.
- Strength: maximal determinism; closest structural analog to LangGraph graph execution.
- Weakness: the *lead agent* in DeerFlow is interactive (clarification interrupts, plan mode, multi-turn threads). Workflow agents are non-interactive workers; putting the lead inside a workflow forfeits native conversation, `ask_clarification` UX, session resume, and /rewind. Workflow resume is same-session only [Verified from official documentation], so long-horizon threads lose cross-session continuity that DeerFlow's checkpointer provides.
- Verdict: right substrate for the *delegation/deep-run engine*, wrong substrate for the *lead thread*.

### Option B — plugin as packaging + workflows as orchestration core
Plugin distributes commands/skills/agents/hooks; workflows are the orchestration core for delegated work; the lead runs as the interactive session shaped by the ported lead prompt.
- All capabilities verified experimentally: plugin-packaged workflow invocation (E1-c), deterministic staging (E2-a), resume (E3-b), deny hooks (E4-b), plugin agents (E1-b).
- This is the only option that keeps both determinism (where DeerFlow is deterministic: middleware, caps, staging) and interactivity (where DeerFlow is interactive: lead thread, clarification).

### Option C — Agent SDK source port
Translate the harness onto the official Agent SDK (closest to a mechanical Python→Python port; even DeerFlow's own `claude_provider.py` shows the shape).
- **Disqualified by constraint**: SDK authentication is API-key-only; official docs explicitly disallow claude.ai-subscription login for SDK-built agents [Verified from official documentation, agent-sdk/overview.md]. The project constraints forbid API keys and OAuth-token reuse. DeerFlow's existing `claude_provider.py` (reads `~/.claude/.credentials.json`, re-uses the OAuth token as an API bearer) is exactly the forbidden pattern and is excluded from the port [Verified from source: backend/packages/harness/deerflow/models/claude_provider.py].
- Kept in the comparison table for completeness only.

### Option D — mixed native architecture (workflows + hooks + sessions + agents + state files)
Same ingredients as B minus the plugin packaging (files dropped into `.claude/` per project).
- Functionally identical to B at runtime; loses one-command installation, namespacing, versioned distribution, and upstream update flow. No technical advantage over B.

### Option E — native reimplementation (baseline)
Fresh prompts/agents/scripts that only resemble DeerFlow.
- Explicitly not the goal ("faithful source port"); baseline only. Fails traceability by definition: no source mapping, no parity tests against original behavior.

### Forbidden fallback (rejected without scoring)
Plugin that launches the DeerFlow Python runtime and feeds it Claude OAuth. Violates: no external process, no OAuth handling, no unofficial API-key use. Also technically identified in source: `claude_provider.py` + `credential_loader.py` implement it today — they are marked **exclude** in the traceability matrix.

## Comparison table

| Criterion | A: Workflow-only | B: Plugin+Workflows ★ | C: Agent SDK | D: Mixed, unpackaged | E: Reimplementation |
|---|---|---|---|---|---|
| Original behavior preserved (est.) | ~60% (loses interactive lead) | **~70–75%** | ~85% technically, 0% usable (auth-blocked) | ~70–75% | ~30–40% (themes only) |
| Original files reused verbatim | prompts, skills | **prompts, skills, configs (~150+ files)** | most Python | prompts, skills | none |
| Original files translated | orchestration → JS | **middleware/executor/worker semantics → JS + hooks** | few | same as B | none |
| Runtime architecture | workflow runtime | interactive session + workflow engine + hooks | external SDK process | same as B | session only |
| Model invocation path | official (workflow agents) | **official (session/agents/workflow agents)** | SDK → API key ✗ | official | official |
| Max subscription compatible | yes (verified) | **yes (verified)** | **no** (docs) | yes | yes |
| API key required | no | **no** | **yes** | no | no |
| OAuth handling by port | none | **none** | violation risk | none | none |
| External process/server | none | **none** | SDK process | none | none |
| Determinism (state transitions, caps, gates) | high | **high where DeerFlow is deterministic** | high | high | low (prompt-driven) |
| Subagent behavior parity | good (schema results) | **good; caps/timeouts enforced in workflow code** | good | good | weak |
| State/checkpoint/resume | journal only (session-scoped) | **sessions + journal + port state files (designed in state-checkpoint-resume.md)** | SDK sessions | same as B | none |
| Middleware parity | wrapper code only | **hooks (tool boundary, deterministic) + wrapper code + platform-native** | near-full | same as B | none |
| Security | good | **good (hooks deny, permission rules, env scrub portable)** | n/a | good | weak |
| Distribution | .claude/workflows copy | **plugin: marketplace/git/zip, versioned, namespaced** | pip | file copy | file copy |
| Install experience | manual | **`claude plugin install` → `/deerflow:run`** | pip + key setup ✗ | manual | manual |
| Maintenance cost | medium | **medium** | high (parallel stack) | medium-high (drift) | low |
| Upstream merge difficulty | high | **medium (prompts/skills sync mechanically; logic diffs reviewed)** | low | medium | n/a |
| Performance | good | **good (parallelism up to 16 in workflows vs DeerFlow's 3)** | good | good | good |
| Usage consumption | per-agent sessions | same | API billing | same | lowest |
| Known blockers | interactive lead UX | **none (all gates passed)** | auth policy | none technical; distribution gap | fails the mission |
| Proof status | E2/E3 verified | **E1–E7 verified** | doc-verified blocker | E2–E4 verified | n/a |

★ = recommended (Option B, which subsumes D's runtime design; detailed in `recommended-architecture.md`).

## Why B over A and D (decision rationale)

1. DeerFlow's own architecture separates an interactive lead (clarification interrupts, thread persistence, plan mode) from deterministic machinery (middleware chain, subagent executor, run worker). Claude Code's native split — interactive session vs code-defined workflow vs hooks — maps 1:1 onto that separation. Option B is the only candidate using each native primitive for the layer DeerFlow uses the equivalent mechanism for.
2. Gate evidence: every load-bearing assumption of B was executed, not inferred (plugin-packaged workflow, subagent fan-out/fan-in on Max, journal resume, deterministic deny). See `experiment-results.md`.
3. D is B without packaging; since plugin packaging is verified and costless at runtime, B strictly dominates D.
4. The two disqualifications are principled, not preferences: A breaks the lead-thread interactivity contract (clarification + cross-session threads); C breaks the subscription/auth constraint stated by official documentation.
