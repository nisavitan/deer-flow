# DeerFlow for Claude Code — installation & usage

A faithful source port of [bytedance/deer-flow](https://github.com/bytedance/deer-flow) (commit `0950924`) running natively on Claude Code. No servers, no API keys, no external model providers — everything executes through your Claude Code session on your subscription.

## Requirements

- Claude Code **≥ 2.1.154** (Dynamic Workflows GA; developed and verified on 2.1.220)
- Node.js **≥ 20** (hook scripts and CLIs run with your `node`)
- A paid Claude plan (workflows run on your subscription)

## Install (fork / local — the supported channel for now)

Per the project decision, there is no public marketplace release before the parity suite and a clean-environment install are complete. Install from the fork:

```bash
git clone https://github.com/nisavitan/deer-flow.git
cd deer-flow && git checkout port/claude-code-architecture
```

Then either load per-session:

```bash
cd /path/to/your/project
claude --plugin-dir /path/to/deer-flow/ports/claude-code
```

or install persistently (auto-loads in every session):

```bash
cp -R /path/to/deer-flow/ports/claude-code ~/.claude/skills/deerflow
```

`dist/` ships prebuilt — no npm install needed for use. (For development: `cd ports/claude-code && npm install && npm run check`.)

## First-run permissions

- The deep-run engine uses the **Workflow** tool — approve it when prompted (headless: `--allowedTools "Workflow" "Agent"`).
- Recommended hardening: merge `config/permissions-preset.json` into your project `.claude/settings.json` (23 deny rules protecting secret files; documented per-rule in `config/permissions-preset.md`).

## Usage

```
/deerflow:run <objective>     main entry — lead-agent policy, delegation via deep-run
/deerflow:plan <objective>    plan-mode entry (todo discipline)
/deerflow:goal set|clear|status   goal-continuation loop (cap 8, no-progress breaker 2)
/deerflow:status              resume report: runs, ledger, goal, staleness
/deerflow:compact             durable digest rebuild (+ native /compact guidance)
/deerflow:memory [update]     DeerMem memory view / gated extraction
/deerflow:<skill>             any of the 16 ported public skills
```

Optional modules (provider-dependent skills — image/music/podcast/video/ppt generation, bootstrap, skill-reviewer) live in `skills-optional/`, disabled by default; see `skills-optional/README.md` for capability requirements and enabling.

## What gets written to your project

- `.deerflow/state/<thread>/` — delegation ledger, goal, run-meta, summaries, read-marks (atomic JSON; safe to delete when idle)
- `.deerflow/memory/` — DeerMem-layout memory (6-slot summaries + sharded fact files)
- `outputs/` — files produced for you; every file placed there is listed in the final response (enforced by the delivery gate)

Escape hatches: `DEERFLOW_DISABLE_READ_GATE=1`, `DEERFLOW_DISABLE_DELIVERY_GATE=1`.

## Provenance

Ported from upstream commit `095092418ccf072aa866c0a663c4056c206091e5`; per-file mapping in `docs/claude-code-port/traceability-matrix.md`; every deliberate behavioral difference in `parity/DISCREPANCIES.md` and `docs/claude-code-port/summarization-delta.md`. Upstream license and attribution: see `ATTRIBUTION.md`.
