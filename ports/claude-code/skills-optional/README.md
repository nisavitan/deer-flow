# Optional modules

These are ported DeerFlow public skills that **cannot run on stock Claude Code alone**.
They live outside `skills/`, so the `deerflow` plugin does **not** load them: nothing here
appears in your context, triggers a slash command, or costs tokens until you deliberately
install it.

Source: `skills/public/*` @ `0950924`. Each module keeps its original body — only paths,
tool names and a capability gate were changed. See
`docs/claude-code-port/skill-conversion-log.md` for the per-skill substitution record.

## Why they are disabled by default

Two different reasons, both recorded per module in `docs/claude-code-port/prompts-and-skills-map.md` §2.1:

| Module | Needs | Why the core port will not ship it enabled |
|---|---|---|
| `image-generation` | `GEMINI_API_KEY` or `MINIMAX_API_KEY` | external image provider |
| `video-generation` | `GEMINI_API_KEY` or `MINIMAX_API_KEY` | external video provider |
| `music-generation` | `MINIMAX_API_KEY` | external music provider |
| `podcast-generation` | `VOLCENGINE_TTS_APPID` + `VOLCENGINE_TTS_ACCESS_TOKEN`, or `MINIMAX_API_KEY` | external TTS provider |
| `ppt-generation` | the `image-generation` module + its provider key + `python-pptx` | every slide is rendered through `image-generation/scripts/generate.py`, so it inherits the provider dependency |
| `bootstrap` | the DeerFlow harness `setup_agent` tool + the SOUL.md identity mechanism | no Claude Code equivalent (identity lives in `CLAUDE.md` / `agents/*.md`; no `setup_agent` tool exists) |
| `skill-reviewer` | the DeerFlow harness `review_skill_package` tool | not shipped by Claude Code; the review core is backend Python plus `contracts/skill_review/` |

The DeerFlow Claude Code port is a **faithful port of the harness**, not a redistribution
of third-party API access. The core plugin therefore depends on nothing beyond Claude Code
itself. Instead of dropping these seven skills (the original plan's "hold-backs"), they are
kept verbatim here so that a user who *does* have the provider key or the backing tool can
enable them and get the upstream behavior unchanged.

## The capability gate

Every module has a `## Requirements & capability check (optional module - run this FIRST)`
section prepended to its `SKILL.md`, directly after the frontmatter and origin comment.
It tells the model to verify the requirement (an `test -n "$SOME_API_KEY"` shell check, or
the presence of the named tool) **before** doing anything else, and to STOP and explain
exactly what is missing and how to enable the module if the check fails. The original body
below the gate is unchanged.

The gate is prompt-level, not an enforcement boundary — it is the same class of guarantee
DeerFlow's own skill instructions provide.

## How to enable one

1. Copy the module into a directory Claude Code scans:

   ```bash
   # project scope (recommended)
   cp -R ports/claude-code/skills-optional/image-generation .claude/skills/image-generation

   # or personal scope, available in every project
   cp -R ports/claude-code/skills-optional/image-generation ~/.claude/skills/image-generation
   ```

   `ppt-generation` needs `image-generation` installed **next to it** in the same skills
   directory — its gate checks `../image-generation/scripts/generate.py`.

2. Provide the requirement listed in the module's gate, in the shell that launches Claude
   Code:

   ```bash
   export GEMINI_API_KEY=...          # or MINIMAX_API_KEY, VOLCENGINE_TTS_* , ...
   ```

   For the two tool-dependent modules (`bootstrap`, `skill-reviewer`) there is no env var:
   they only work against a host that exposes `setup_agent` / `review_skill_package`
   (for example an MCP server wrapping the DeerFlow backend).

3. Restart the Claude Code session so the new skill directory is picked up.

4. Install the Python dependency the module's script needs (`python-pptx` for
   `ppt-generation`; the generation scripts otherwise use the standard library plus
   `requests`-style HTTP through the provider SDK they document).

## How to disable one again

Delete the copied directory (`rm -rf .claude/skills/<name>`) and restart the session, or
turn the skill off in your Claude Code settings. There is no DeerFlow-style external
enabled-state file in the port: **the skills directory is the source of truth**
(`prompts-and-skills-map.md` §2.4).

## Path variables used inside these modules

Because an optional module can be installed anywhere, its shell examples use variables
instead of a fixed plugin path:

- `SKILL_DIR` — the absolute path of the directory containing that `SKILL.md`
- `IMAGE_SKILL_DIR` — (ppt-generation only) the absolute path of the installed
  `image-generation` module

Set them once when the capability check passes; the gate says so explicitly. Skills that
ship inside the plugin (`../skills/`) use `${CLAUDE_PLUGIN_ROOT}/skills/<name>/…` instead.
