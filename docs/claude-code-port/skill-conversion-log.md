# Skill conversion log — M4 (public skills port)

- **Source:** `skills/public/**` @ `095092418ccf072aa866c0a663c4056c206091e5` (`0950924`)
- **Targets:** `ports/claude-code/skills/<name>/` (loaded by the plugin) and
  `ports/claude-code/skills-optional/<name>/` (not loaded; see
  `ports/claude-code/skills-optional/README.md`)
- **Plan of record:** `prompts-and-skills-map.md` Part 2 (per-skill dispositions)
- **Date:** 2026-08-01

All 23 public skill packages are ported: **16 regular + 7 optional modules**. Nothing was
dropped.

---

## Decision record — hold-backs became optional modules

`prompts-and-skills-map.md` §2.1 ends with: *"4 hold-backs on the external-provider
constraint (image/music/podcast/video generation), 2 hold-backs on missing mechanism
(bootstrap, skill-reviewer), 1 conditional (ppt-generation)."*

The M4 user decision overrides the **hold-back disposition itself**: those skills are not
dropped, they become optional modules under `skills-optional/`, disabled by default, each
with a capability gate prepended. The set is therefore exactly the map's 6 hold-backs plus
the 1 conditional = **7 optional modules**. `bootstrap` and `skill-reviewer` are not
API-key-dependent; their missing capability is a DeerFlow harness *tool* (`setup_agent`,
`review_skill_package`), and their gates check for tool presence rather than an env var —
the same gate mechanism the decision prescribes ("the required tool/env/service").

Two skills that touch external services stayed **regular**, matching the map: `vercel-deploy`
(claimable deploy, explicitly no auth) and `claude-to-deerflow` (talks to a DeerFlow instance
the user runs, no provider secret).

Verified during the port, closing the map's open question: `ppt-generation` **is**
provider-dependent — every slide is rendered by `image-generation/scripts/generate.py`
(`SKILL.md` steps 3/4 and the worked example), so it inherits `GEMINI_API_KEY` /
`MINIMAX_API_KEY`. Its gate additionally checks that the `image-generation` module is
installed next to it.

---

## Substitution categories

| Category | What it covers |
|---|---|
| **paths** | `/mnt/skills/public/<n>/…` → `${CLAUDE_PLUGIN_ROOT}/skills/<n>/…` (plugin skills) or `"$SKILL_DIR"/…` (optional modules); `/mnt/user-data/outputs` → `outputs/`; `/mnt/user-data/workspace` → `workspace/`; `/mnt/user-data/uploads/x` → `./x` + "files provided by the user" phrasing; `/path/to/skill/scripts/…` → resolved plugin path |
| **tool-names** | `web_search`→`WebSearch`, `web_fetch`→`WebFetch`, `read_file`→`Read`, `write_file`→`Write`, `str_replace`→`Edit`, `present_files`→ "list the path(s) in your final message" (the `outputs/` delivery contract, `recommended-architecture.md` §5) |
| **platform-tags** | DeerFlow prompt tags with no CC equivalent: `<available_skills>`, `<current_date>` |
| **frontmatter** | `allowed-tools` YAML list → comma-string; `license`/`version`/`compatibility`/`metadata` dropped from frontmatter and preserved in the `<!-- deerflow-origin: … -->` comment immediately after it |
| **gate-added** | `## Requirements & capability check (optional module - run this FIRST)` prepended (optional modules only) |
| **script-consts** | path constants inside a bundled script adapted (logic untouched) |
| **none** | body byte-identical below the frontmatter/origin comment |

Every ported `SKILL.md` carries an origin comment right after the frontmatter:

```
<!-- deerflow-origin: ported from skills/public/<dir>/ @ 0950924
     dropped-frontmatter (preserved here, not understood by Claude Code): …
     port: <one-line note> -->
```

---

## Per-skill table

| # | Skill | Source disposition (map §2.1) | Target location | Substitutions applied | Faithful? | Notes |
|---|---|---|---|---|---|---|
| 1 | academic-paper-review | reuse-verbatim (post-sweep) | `skills/academic-paper-review/` | paths, tool-names, frontmatter (origin comment only) | adapted | `web_fetch`→`WebFetch`; output path → `outputs/`; `present_files` → final-message listing. The phrase "when working in sandbox" left as written (instructional text, not a path). |
| 2 | bootstrap | **hold-back** (mechanism) → optional module | `skills-optional/bootstrap/` | gate-added, frontmatter (origin comment only) | verbatim body + gate | `setup_agent` / SOUL.md references deliberately untouched; the gate states Claude Code has no equivalent and tells the model to stop. |
| 3 | chart-visualization | adapt-paths | `skills/chart-visualization/` | paths, frontmatter | adapted | `node ./scripts/generate.js` → `${CLAUDE_PLUGIN_ROOT}/skills/chart-visualization/scripts/generate.js`; `compatibility: {nodejs: ">=18.0.0"}` moved to the origin comment. 26 `references/*.md` copied unchanged and still referenced skill-relative. |
| 4 | claude-to-deerflow | reuse-verbatim | `skills/claude-to-deerflow/` | paths | adapted | Only the `chat.sh` invocation path changed. **`scripts/chat.sh` and `scripts/status.sh` are byte-identical to source on purpose**: their `present_files` / `/mnt/user-data/outputs` strings are the *remote* DeerFlow API contract, not local paths. |
| 5 | code-documentation | reuse-verbatim | `skills/code-documentation/` | paths, tool-names | adapted | `read_file`→`Read`; "sandbox tools" → "the file tools (Read, Grep, Glob, Bash)"; upload paths → `./project-dir/…`; output dir → `outputs/`; `present_files` → final-message listing. |
| 6 | consulting-analysis | adapt-paths | `skills/consulting-analysis/` | none (origin comment only) | **verbatim** | The map expected chart-output paths; the body contains no `/mnt` path and no DeerFlow tool name. Nothing to adapt. |
| 7 | data-analysis | adapt-paths | `skills/data-analysis/` | paths, tool-names | adapted | 9 `analyze.py` invocations → `${CLAUDE_PLUGIN_ROOT}/…`; upload examples → `./data.xlsx`; outputs → `outputs/`; `present_files` → final-message listing. One correction: the cache sentence claimed `/mnt/user-data/workspace/.data-analysis-cache/`, but `scripts/analyze.py:34` uses `tempfile.gettempdir()` — the ported line now states the real location. `scripts/analyze.py` unchanged. |
| 8 | deep-research | adapt-body | `skills/deep-research/` | tool-names, platform-tags | adapted | `web_fetch`/`web_search` → `WebFetch`/`WebSearch`; `<current_date>` → "today's date … in your context" (the port injects it via the `turn-context` hook / CC env block). |
| 9 | find-skills | adapt-body ("hold-back if the remap proves hollow") | `skills/find-skills/` | paths, script-consts | adapted | **Not hollow:** the discovery flow is `npx skills find` against skills.sh, which is platform-neutral. `scripts/install-skill.sh` path constants adapted: project-root marker `deer-flow.code-workspace` → `.claude/`/`.git/` (honoring `$CLAUDE_PROJECT_DIR`), install target `skills/custom` → `.claude/skills`; script logic unchanged (`bash -n` clean). Body line about the install target updated to match. |
| 10 | frontend-design | reuse-verbatim | `skills/frontend-design/` | frontmatter | **verbatim body** | `license: Complete terms in LICENSE.txt` moved to the origin comment; `LICENSE.txt` ships alongside. Collision note: a CC environment may already have a `frontend-design` skill — the plugin namespace (`/deerflow:frontend-design`) disambiguates. |
| 11 | github-deep-research | adapt-body | `skills/github-deep-research/` | paths, tool-names | adapted | `web_search`/`web_fetch` → `WebSearch`/`WebFetch`; `read_file()` → `Read()`; `/path/to/skill/scripts/github_api.py` → `${CLAUDE_PLUGIN_ROOT}/…`. `scripts/github_api.py` + `assets/report_template.md` unchanged. |
| 12 | image-generation | **hold-back** (external provider) → optional module | `skills-optional/image-generation/` | gate-added, paths, tool-names | adapted + gate | Gate: `GEMINI_API_KEY` or `MINIMAX_API_KEY`. Script path → `"$SKILL_DIR"/scripts/generate.py`; workspace/output paths; reference-image example paths; `present_files` → final-message listing. `scripts/generate.py` + `templates/doraemon.md` unchanged. |
| 13 | music-generation | **hold-back** (external provider) → optional module | `skills-optional/music-generation/` | gate-added, paths, tool-names | adapted + gate | Gate: `MINIMAX_API_KEY`. Same path/tool substitutions. `scripts/generate.py` unchanged. |
| 14 | newsletter-generation | adapt-body | `skills/newsletter-generation/` | paths, tool-names | adapted | `web_fetch`→`WebFetch`; output path → `outputs/`; `present_files` → final-message listing. |
| 15 | podcast-generation | **hold-back** (external provider) → optional module | `skills-optional/podcast-generation/` | gate-added, paths, tool-names | adapted + gate | Gate: Volcengine TTS pair **or** `MINIMAX_API_KEY` (matches `scripts/generate.py`'s provider auto-selection). `templates/tech-explainer.md` got the same path substitutions; `scripts/generate.py` unchanged. |
| 16 | ppt-generation | adapt-body (**conditional**) → optional module | `skills-optional/ppt-generation/` | gate-added, paths, tool-names | adapted + gate | Conditional resolved: provider-dependent (slides rendered by image-generation's `generate.py`). Gate checks provider key **+** sibling `image-generation` module **+** `python-pptx`. Cross-skill paths → `"$IMAGE_SKILL_DIR"/…`, own script → `"$SKILL_DIR"/…`. |
| 17 | skill-creator | adapt-body | `skills/skill-creator/` | body-section replacement, tool-names | adapted | The `## DeerFlow Environment (READ THIS FIRST)` section (46 lines: `skill_manage` table, per-thread-output rationale, `/mnt/skills/custom/` read rule, packaging skip) is replaced by an equivalent `## Claude Code Environment` section (skill directory scopes, `Write`/`Edit`/`Read` table, same 6 key rules re-expressed + a session-restart rule, same 7-step workflow) — using the file's own per-environment extension point (Claude.ai / Cowork sections are untouched). Packaging step re-gated on "user wants a distributable `.skill`" instead of `present_files` availability. All 15 bundled scripts/agents/references/assets unchanged. |
| 18 | skill-reviewer | **hold-back** (missing tool) → optional module | `skills-optional/skill-reviewer/` | gate-added, frontmatter | verbatim body + gate | `allowed-tools:` YAML list → comma-string (`allowed-tools: review_skill_package`), per the frontmatter rule; the tool has no CC equivalent, which is exactly what the gate reports. Body (incl. the "never `read_file`/`bash`" inspection rule) untouched. `evals/`, `references/` copied unchanged. |
| 19 | surprise-me | reuse-verbatim | `skills/surprise-me/` | platform-tags | adapted (1 line) | `Read all the skills listed in the <available_skills>.` → "Read all the skills available to you (Claude Code keeps every available skill's name and description in your context)." Map check performed: **no held-back/optional skill is named in the body**, so no dangling reference. |
| 20 | systematic-literature-review | adapt-body | `skills/systematic-literature-review/` | paths, tool-names | adapted | `arxiv_search.py` path → `${CLAUDE_PLUGIN_ROOT}/…`; report path → `outputs/`; `present_files` → final-message listing, **and the two matching `evals/evals.json` assertions updated** so the evals still describe the ported behavior. `templates/*`, `scripts/arxiv_search.py`, `trigger_eval_set.json` unchanged. |
| 21 | vercel-deploy-claimable | adapt-paths (rename only) | `skills/vercel-deploy/` (**dir renamed**) | paths, frontmatter | adapted | Directory renamed to match frontmatter `name: vercel-deploy` (CC requires dir == name). 4 `deploy.sh` invocations → `${CLAUDE_PLUGIN_ROOT}/skills/vercel-deploy/scripts/deploy.sh`; `metadata: {author: vercel, version: "1.0.0"}` → origin comment. `scripts/deploy.sh` unchanged. |
| 22 | video-generation | **hold-back** (external provider) → optional module | `skills-optional/video-generation/` | gate-added, paths, tool-names | adapted + gate | Gate: `GEMINI_API_KEY` (Veo) or `MINIMAX_API_KEY`. Same path/tool substitutions. `scripts/generate.py` unchanged. |
| 23 | web-design-guidelines | reuse-verbatim | `skills/web-design-guidelines/` | frontmatter | **verbatim body** | `metadata.argument-hint: <file-or-pattern>` promoted to top-level `argument-hint` frontmatter (per map); `metadata.author`/`version` → origin comment. Body already said "Use WebFetch". |

Counts: **16 regular** (rows 1, 3–11, 14, 17, 19–21, 23) + **7 optional**
(rows 2, 12, 13, 15, 16, 18, 22) = 23.

---

## Cross-cutting checks run

- `grep -rIn "/mnt/user-data\|/mnt/skills" ports/claude-code/skills ports/claude-code/skills-optional`
  → only `skills/claude-to-deerflow/scripts/chat.sh:185`, which describes the **remote**
  DeerFlow API's virtual path and must stay.
- `grep -rInE "\b(web_search|web_fetch|read_file|write_file|str_replace|present_files|skill_manage|describe_skill|view_image|setup_agent|update_agent|ask_clarification|tool_search|review_skill_package)\b"`
  → remaining hits are (a) `chat.sh` remote-API names, (b) the deliberately verbatim
  `bootstrap` / `skill-reviewer` bodies and their `evals`/`references`, (c) the
  skill-creator sentence that explains Claude Code has no `skill_manage`.
- No bundled script contained a hard-coded `/mnt/**` path (grep-verified); the only script
  needing adaptation was `find-skills/scripts/install-skill.sh` (project-root marker +
  install target).
- Frontmatter validation over all 24 plugin skills + 7 optional modules: every `name`
  equals its directory name, every description ≤ 1024 chars, and no frontmatter key
  outside `{name, description, allowed-tools, argument-hint}` survives.

---

## Verification — headless smoke on a ported skill

Run from `experiments/claude-code-port/exp7-headless`:

```bash
claude -p "/deerflow:academic-paper-review Do not review any paper and do not use any tools. Just list, in order, the section headings of the Review Output Template from your skill instructions." \
  --plugin-dir ../../../ports/claude-code --model haiku --output-format json --no-session-persistence
```

Result (`"subtype":"success"`, `"is_error":false`, `"permission_denials":[]`,
`"num_turns":1`, `duration_api_ms` 4229):

```
"result":"Here are the section headings from the Review Output Template, in order:\n\n1. Paper Metadata\n2. Executive Summary\n3. Summary of Contributions\n4. Strengths\n5. Weaknesses\n6. Methodology Assessment\n7. Questions for the Authors\n8. Minor Issues\n9. Literature Positioning\n10. Recommendations"
```

Re-run after the last edit of the tree: same ten headings, `is_error: False`,
`subtype: success`, `permission_denials: []`, `num_turns: 1`.

Those ten headings are exactly the `##` headings of the "Review Output Template" section in
`ports/claude-code/skills/academic-paper-review/SKILL.md` (lines 143–215), in order, and
they are not derivable from the skill name — so the **ported skill body was loaded into the
turn** through the plugin. The plugin also loaded without error while all 17 `skills/`
packages were present, which exercises the frontmatter adaptation for every regular skill.

Not smoke-tested (by design): the 7 optional modules are not on the plugin's skill path, so
they cannot be invoked as `/deerflow:<name>`; their gates are prompt-level instructions
verified by reading, not by execution.
