# DeerFlow Skills & Memory — Source Analysis (Port Notes)

Repo: `deer-flow` @ commit 0950924. All paths relative to repo root unless absolute.

---

## 1. Skill format

### SKILL.md frontmatter schema

A skill is a directory containing `SKILL.md` (constant `SKILL_MD_FILE = "SKILL.md"`) [Verified from source: backend/packages/harness/deerflow/skills/types.py:7]. The frontmatter is YAML between `---` fences, parsed by a shared regex `^---\s*\n(.*?)\n---\s*\n?` [Verified from source: backend/packages/harness/deerflow/skills/frontmatter.py:28].

Allowed frontmatter properties (closed set — install-time validation rejects anything else):
`name`, `description`, `license`, `allowed-tools`, `required-secrets`, `secrets-autonomous`, `metadata`, `compatibility`, `version`, `author` [Verified from source: backend/packages/harness/deerflow/skills/frontmatter.py:15-26; unexpected-key rejection at backend/packages/harness/deerflow/skills/validation.py:36-38].

Fields the runtime parser (`parse_skill_file`) actually reads into the `Skill` dataclass:

| Field | Type / rule | Parsing behavior |
|---|---|---|
| `name` | required non-empty string | stripped; missing/non-string → skill dropped (returns `None`) [parser.py:151-164] |
| `description` | required non-empty string | same handling [parser.py:151-164] |
| `license` | optional string | coerced via `str().strip()` or `None` [parser.py:166-168] |
| `allowed-tools` | optional YAML list of strings | `None` = field omitted (allow-all); empty list = explicit no-tool skill; malformed → skill invalid [parser.py:41-61, 170-174] |
| `required-secrets` | optional list; items are strings or `{name, optional}` mappings | `name` must be a valid POSIX env-var name (`^[A-Za-z_][A-Za-z0-9_]*$`); malformed entries dropped with a warning (do not invalidate the skill); duplicates deduped [parser.py:64-98, 176-180] |
| `secrets-autonomous` | optional bool, default `true` | `true` lets declared secrets bind when the skill is in-context via autonomous model load; `false` restricts binding to explicit `/slash` activation; non-bool fails **closed** to `false` [parser.py:101-114, 182] |

[Verified from source: backend/packages/harness/deerflow/skills/parser.py:117-200]

The `Skill` dataclass adds: `skill_dir`, `skill_file`, `relative_path` (from category root), `category`, `enabled` (set from extensions config at load time, not frontmatter), plus container path helpers `get_container_path()` / `get_container_file_path()` producing `{container_base}/{category}/{relative_path}[/SKILL.md]` [Verified from source: backend/packages/harness/deerflow/skills/types.py:40-94].

Install-time validation adds stricter rules than the runtime parser: name must be hyphen-case `^[a-z0-9-]+$`, no leading/trailing/double hyphens, ≤64 chars; description ≤1024 chars and may not contain `<` or `>`; `required-secrets` must be a list and `secrets-autonomous` a bool at the type level [Verified from source: backend/packages/harness/deerflow/skills/validation.py:47-86].

### Skill categories

`SkillCategory` StrEnum: `PUBLIC` (bundled, read-only), `CUSTOM` (user-authored, editable), `INTEGRATION` ("integrations", managed third-party packs, read-only), `LEGACY` (pre-user-isolation global custom skills, visible read-only, mounted at `/mnt/skills/legacy/<name>/`) [Verified from source: backend/packages/harness/deerflow/skills/types.py:10-24].

Storage layout (two storage classes):

- `LocalSkillStorage` (global): `<root>/public/<name>/SKILL.md`, `<root>/custom/<name>/SKILL.md`, history at `<root>/custom/.history/<name>.jsonl` [Verified from source: backend/packages/harness/deerflow/skills/storage/local_skill_storage.py:30-38].
- `UserScopedSkillStorage` (per-user, subclass): public from global root; custom redirected to `{base_dir}/users/{user_id}/skills/custom/`; global integrations root; per-user enabled state in `{user_skills_root}/_skill_states.json`; global `skills/custom/` is surfaced as read-only `LEGACY` fallback with shadow-mount semantics (a user's first custom skill hides all legacy skills) [Verified from source: backend/packages/harness/deerflow/skills/storage/user_scoped_skill_storage.py:1-91].
- Storage class is configurable via `skills.use` (default `deerflow.skills.storage.local_skill_storage:LocalSkillStorage`) resolved by reflection; process-singleton for public reads, per-user LRU cache (64 entries) for user storage [Verified from source: backend/packages/harness/deerflow/config/skills_config.py:20-23; backend/packages/harness/deerflow/skills/storage/__init__.py:26-143].

Discovery walks each category root with `os.walk(followlinks=True)`; a directory containing `SKILL.md` is a **package boundary** — nested `SKILL.md` files are supporting resources, never independent runtime skills; dot-directories are skipped; namespace directories without SKILL.md still recurse [Verified from source: backend/packages/harness/deerflow/skills/storage/local_skill_storage.py:76-93].

### Enabled-state resolution

`load_skills()` template method: parses every SKILL.md, dedupes by name (later category wins in insertion order of `SkillCategory`), then re-reads `extensions_config.json` **on every call** and stamps `enabled = extensions_config.is_skill_enabled(name, category)`; CUSTOM skills default to enabled when no explicit entry exists; the list is name-sorted and optionally filtered `enabled_only` [Verified from source: backend/packages/harness/deerflow/skills/storage/skill_storage.py:251-288]. For non-public categories, visibility is the intersection of the per-user `_skill_states.json` and the global extensions default [Verified from source: backend/packages/harness/deerflow/skills/projection.py:264-275; user_scoped_skill_storage.py:24-28]. The `Skill.enabled` field set by the parser is a placeholder (`enabled=True` with comment "Actual state comes from the extensions config file") [Verified from source: backend/packages/harness/deerflow/skills/parser.py:193].

Only CUSTOM skills are editable; editing a PUBLIC name raises "create a new skill with the same name under skills/custom/" (shadowing), LEGACY is read-only [Verified from source: backend/packages/harness/deerflow/skills/storage/skill_storage.py:290-301].

### Installation and safety rails (context for a port)

`.skill` archives are ZIPs installed to `custom/`. `safe_extract_skill_archive` rejects absolute paths, `..` traversal, any `:` in member names (NTFS ADS smuggling), symlink members (skipped), executable binaries by magic bytes (ELF/PE/Mach-O), >4096 entries, >512 MiB uncompressed [Verified from source: backend/packages/harness/deerflow/skills/installer.py:64-193]. Install then runs the static SkillScan preflight + per-file LLM security scan before an atomic staged move; nested SKILL.md in an archive is an install error [Verified from source: backend/packages/harness/deerflow/skills/installer.py:278-339; local_skill_storage.py:124-219]. Installed trees are chmodded sandbox-readable/non-writable (dirs 0555, files 0444 baseline) [Verified from source: backend/packages/harness/deerflow/skills/permissions.py:7-22].

**skillscan/ (one paragraph):** `skills/skillscan/` is a native, deterministic, offline scanner for `.skill` archives and agent-managed skill writes. `scan_archive_preflight()` / `scan_skill_dir()` are pure synchronous functions; policy is a single constant — findings with severity `CRITICAL` block, everything else is a warning — applied by `enforce_static_scan()`, which honors the `skill_scan.enabled` kill switch. Rule specs (`RuleSpec(rule_id, severity, message, remediation)`) live in Python constants next to their analyzers (e.g. `package-path-traversal` CRITICAL); limits: 512 MiB archive, 64 MiB per file, 4096 members. Warning findings flow onward into the LLM content scanner [Verified from source: backend/packages/harness/deerflow/skills/skillscan/orchestrator.py:1-45; installer.py:295-339].

**review/ (one paragraph):** `skills/review/` is a deterministic, read-only skill-review core: package snapshot readers (`LocalDirectoryReader`, `build_inline_snapshot`), `analyze_skill_package` producing versioned facts/report schemas (`FACTS_SCHEMA_VERSION`, `REPORT_SCHEMA_VERSION`, `PACKAGE_SNAPSHOT_SCHEMA_VERSION`), resource-graph and eval-schema analysis, a Markdown renderer, and a CLI (`python -m deerflow.skills.review.cli`). It reuses the shared frontmatter helper and SkillScan, never executes target scripts or touches the network, and backs the `review_skill_package` built-in tool used by the public `skill-reviewer` skill; reviewing a target does **not** activate it, bind its secrets, or apply its allowed-tools [Verified from source: backend/packages/harness/deerflow/skills/review/__init__.py:1-24; skill-reviewer contract in skills/public/skill-reviewer/SKILL.md:36-40; backend/AGENTS.md "Skill Review Core"].

---

## 2. Skill discovery + injection

### Legacy full-metadata injection (default)

When `skills.deferred_discovery: false` (the default) [Verified from source: backend/packages/harness/deerflow/config/skills_config.py:32-35], the system prompt gets a `<skill_system>` block containing:

- a "Progressive Loading Pattern" instruction (read_file the SKILL.md at the given path, then load referenced resources on demand),
- an `<available_skills>` list where each enabled skill renders as `<skill><name>…</name><description>… [built-in|custom]</description><location>…container path…</location></skill>` (all values HTML-escaped as untrusted frontmatter),
- a `<disabled_skills>` section listing installed-but-disabled skills with an explicit MUST-NOT-read directive,
- slash-activation guidance ("The runtime injects the activated skill content … do not call read_file for that SKILL.md again").

[Verified from source: backend/packages/harness/deerflow/agents/lead_agent/prompt.py:760-807 (block assembly), 222-230 (`_render_available_skill`)]

The rendered section is LRU-cached (32 entries) on a signature of (skill tuples, disabled tuples, available-skills whitelist, container path, evolution section) [Verified from source: lead_agent/prompt.py:760-767].

### Deferred discovery (`skills.deferred_discovery: true`)

Prompt carries only a compact `<skill_system>` with a name-only `<skill_index>` (sorted, comma-joined, escaped) and a 4-step protocol: check index → `describe_skill(name)` → `read_file` the returned location → follow instructions [Verified from source: backend/packages/harness/deerflow/skills/describe.py:150-187].

- `SkillCatalog` (immutable frozen dataclass over `tuple[Skill,...]`) supports three query forms mirroring `tool_search`: `select:a,b` exact names (**no result cap**), `+prefix rest` required-substring-in-name ranked by regex hits (cap `MAX_RESULTS = 5`), and free-text case-insensitive regex over `name + description` (name match scores above description-only; cap 5). Invalid regex degrades to escaped literal [Verified from source: backend/packages/harness/deerflow/skills/catalog.py:23-102].
- `build_describe_skill_tool(catalog)` returns a `@tool` closure producing a `Command` with a `ToolMessage`; metadata rendering per skill: `## Skill: {name}` / `- Description: … [built-in|custom, editable]` / `- Allowed tools: …|(all)` / `- Location: {container SKILL.md path}` — all HTML-escaped [Verified from source: backend/packages/harness/deerflow/skills/describe.py:51-144].
- `build_skill_search_setup(skills, enabled=...)` returns `SkillSearchSetup(describe_skill_tool, skill_names)`; empty setup (tool `None`) when disabled or no skills → agent falls back to the legacy prompt [Verified from source: describe.py:102-124]. `get_skills_prompt_section(skill_names=...)` selects the deferred rendering when names are supplied [Verified from source: lead_agent/prompt.py:810-854].

### Slash activation (`/skill-name task`)

Grammar: strict `^/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\s+|$)` — leading whitespace or missing separator rejects. Reserved control commands that are never skill activations: `bootstrap`, `goal`, `help`, `memory`, `models`, `new`, `status` (`RESERVED_SLASH_SKILL_NAMES`, mirrored to the frontend via the `contracts/slash_skill_contract.json` contract tests) [Verified from source: backend/packages/harness/deerflow/skills/slash.py:9-49].

Resolution (`resolve_slash_skill`): parse → if a custom agent supplies an `available_skills` whitelist, name must be in it → find a skill with matching name **and** `enabled=True` → return `ResolvedSlashSkill(skill, remaining_text, container_file_path)`; any failure returns `None` (falls through as ordinary chat text) [Verified from source: slash.py:52-74].

`SkillActivationMiddleware` detects the syntax on the latest real user message, injects the SKILL.md body as hidden current-turn context, and recomputes per-model-call secret bindings (`_resolve_secret_bindings`) from two sources: the run's slash activation (stored as canonical container path, re-resolved against the live registry each call) union in-context `ThreadState.skill_context` entries; `secrets-autonomous: false` gates only the in-context path [Verified from source: backend/packages/harness/deerflow/agents/middlewares/skill_activation_middleware.py:83-91, 358-380, 464, 508-517; parser.py:101-114].

### Tool policy (`allowed-tools`) enforcement semantics

Pure policy helper (`skills/tool_policy.py`):

- `allowed_tool_names_for_skills(skills)` returns the **union** of explicit `allowed-tools` declarations across the given (active) skills. Returns `None` (= legacy allow-all) only when *no* skill in the list declares the field; once any skill declares it, undeclared skills contribute zero tools rather than disabling restriction [Verified from source: backend/packages/harness/deerflow/skills/tool_policy.py:28-51].
- `filter_tools_by_skill_allowed_tools(tools, skills, always_allowed_tool_names=…)` filters a tool list to that union plus framework built-ins [tool_policy.py:54-65].
- Framework tools that always survive a restrictive policy: `describe_skill`, `read_file`, `review_skill_package`, `tool_search` (`ALWAYS_AVAILABLE_BUILTIN_TOOL_NAMES`) — they support discovery/review workflows without extending a skill's business-tool authority; promotion through `tool_search` does not restore a tool removed by the policy [Verified from source: tool_policy.py:9-25].

Runtime semantics (enforced by `SkillToolPolicyMiddleware`, adjacent to `SkillActivationMiddleware`): the policy applies **only after real activation** — a slash activation or a skill captured into `ThreadState.skill_context` via a configured read-tool load; passive enabled skills never clamp the toolset. A slash activation is authoritative for its run and suppresses `skill_context` as a policy source (reading another skill cannot widen tools); without slash, captured skills use union semantics. The middleware filters model-visible schemas and blocks execution, re-resolving the live enabled registry on every model call; registry failures and all-invalid active sets fail closed to framework-safe tools. It is documented as best-effort behavioral scoping, not a hard security boundary (e.g. `bash cat` loads are not captured); `task` is not framework-exempt [Verified from source: backend/packages/harness/deerflow/agents/middlewares/skill_tool_policy_middleware.py (module present, ls verified); behavior contract per backend/AGENTS.md "Middleware Chain" item 16 and "Skills System → Tool policy"].

### Projection to sandbox paths

`skills/projection.py` materializes **enabled-only** copies of skill trees at stable roots that sandbox providers mount/upload, so a sandbox can never see disabled skills:

- Roots: `{base_dir}/skills_view/public` (global) and `{base_dir}/users/{uid}/skills_view/{custom,legacy,integrations}` (per-user) [Verified from source: backend/packages/harness/deerflow/skills/projection.py:39-66].
- Files are hardlinked when possible, copied across filesystems (`_link_or_copy`; hardlinks give no write isolation — read-only comes from the mount) [projection.py:97-106].
- Rebuild is guarded by a per-scope lock that is both in-process (`threading.RLock`) and cross-process (POSIX `fcntl.flock` on a `.{root}.projection.lock` file; msvcrt on Windows) [projection.py:75-94].
- Freshness: a `.projection-manifest.json` stores a `source_signature` — SHA-256 over directory metadata (inode/mode/size/mtime_ns per entry, contents not hashed) of the source trees plus the JSON-serialized enabled state (extensions config; for user scope also per-user `_skill_states.json`) [projection.py:215-279, 282-305]. `ensure_skill_projections` re-checks the manifest and rebuilds under lock when stale; rebuild retries up to 2 attempts if sources change mid-rebuild, and any failure clears the scope (fail closed) [projection.py:345-458].
- `_replace_category` stages a complete tree in a temp dir then reconciles per-file with atomic `replace`, so unrelated enabled skills remain continuously visible during rebuild; nested package boundaries are excluded from each staged skill [projection.py:109-197].
- Mutations (write/install/delete/toggle) wrap the source change in `skill_projection_mutation(...)`, which removes affected packages first and rebuilds after, clearing the scope on error [projection.py:461-525; local_skill_storage.py:100-122, 210-252]. Gateway boot ensures only the shared public view (`ensure_public_skill_projection`); user views repair lazily on first sandbox acquire [projection.py:528-552].

Container-side, skills mount at `skills.container_path` (default `DEFAULT_SKILLS_CONTAINER_PATH`, i.e. `/mnt/skills`) as `/mnt/skills/{public|custom|legacy|integrations}/<name>/` [Verified from source: types.py:65-91; skills_config.py:28-31, 66-77].

---

## 3. Complete public skills inventory

23 skills under `skills/public/` (ls verified). Frontmatter fields verified by extracting the YAML block of every SKILL.md; a repo-wide grep confirms **no public skill declares `required-secrets` or `secrets-autonomous`**, and only `skill-reviewer` declares `allowed-tools` [Verified from source: skills/public/*/SKILL.md frontmatter; grep for `required-secrets|secrets-autonomous|allowed-tools` over skills/public/*/SKILL.md]. Env-var notes below come from skill bodies, not frontmatter.

| Name | Description (abridged) | allowed-tools | required-secrets | Notes |
|---|---|---|---|---|
| academic-paper-review | Review/critique/summarize academic papers, preprints; structured peer reviews (methodology, contribution, literature) | — | — | 289-line body |
| bootstrap | Generate a personalized SOUL.md via onboarding conversation; create/update the agent's identity | — | — | Pairs with `setup_agent` bootstrap tool; `/bootstrap` is a reserved command (this skill triggers by description, not slash) |
| chart-visualization | Visualize data; selects among 26 chart types and generates a chart image via a JS script | — | — | `compatibility: nodejs >=18.0.0` |
| claude-to-deerflow | Interact with a DeerFlow instance over its HTTP API (send messages, threads, models/skills/memory, uploads, delegate research) | — | — | Base URLs configurable via env vars per body |
| code-documentation | Generate/improve docs: README, API reference, inline comments, architecture docs, changelogs, developer guides | — | — | |
| consulting-analysis | Consulting-grade analytical reports in two phases (framework + final report with charts) | — | — | 631-line body |
| data-analysis | Analyze uploaded Excel/CSV: statistics, pivots, SQL-style queries, joins, exports | — | — | |
| deep-research | Use instead of WebSearch for any question needing web research; systematic multi-angle methodology | — | — | Body read fully (see below) |
| find-skills | Discover and install agent skills when the user asks "how do I do X" / "is there a skill for…" | — | — | |
| frontend-design | Distinctive production-grade frontend interfaces; avoid generic AI aesthetics | — | — | `license: Complete terms in LICENSE.txt` |
| github-deep-research | Multi-round deep research on a GitHub repo; timelines, metrics, Mermaid reports | — | — | |
| image-generation | Generate/visualize images; structured prompts + reference images | — | — | Body: provider auto-select via `GEMINI_API_KEY` (default) / `MINIMAX_API_KEY` |
| music-generation | Generate music/songs from style prompt + optional lyrics via MiniMax music API | — | — | Body: `MINIMAX_API_KEY` (required) |
| newsletter-generation | Newsletters, email digests, weekly roundups; research + curation + formatting | — | — | |
| podcast-generation | Convert text into two-host conversational podcast audio | — | — | Body: TTS provider auto-selected from env vars (incl. `MINIMAX_API_KEY`) |
| ppt-generation | Generate presentations (PPT/PPTX); image-per-slide composition | — | — | 463-line body |
| skill-creator | Create new skills, improve existing ones, run evals/benchmarks, optimize descriptions | — | — | Body read fully (see below) |
| skill-reviewer | Reviews DeerFlow skill packages for readiness, triggers, safety, resources, evidence | `review_skill_package` | — | Only skill with a restrictive tool policy; body read fully (see below) |
| surprise-me | Create a "wow" experience by dynamically combining other enabled skills | — | — | 53-line body |
| systematic-literature-review | Systematic literature reviews/surveys across papers; arXiv search; APA/IEEE/BibTeX output | — | — | Explicitly routes single-paper tasks to academic-paper-review |
| vercel-deploy-claimable | `name: vercel-deploy` — deploy apps to Vercel; no auth required, returns preview + claimable link | — | — | `metadata: {author: vercel, version: "1.0.0"}`; directory name differs from frontmatter name |
| video-generation | Generate videos; structured prompts + reference image | — | — | Body: `GEMINI_API_KEY` (Veo, default) / `MINIMAX_API_KEY` |
| web-design-guidelines | Review UI code for Web Interface Guidelines compliance ("review my UI", "check accessibility") | — | — | `metadata: {author: vercel, version: "1.0.0", argument-hint: <file-or-pattern>}` |

### Representative bodies (read fully)

- **skill-creator** (534 lines): full skill-authoring loop — capture intent → interview → draft SKILL.md → 2-3 test prompts → parallel with-skill vs baseline subagent runs → grade with `agents/grader.md` → aggregate benchmark → browser eval viewer (`eval-viewer/generate_review.py`) → read `feedback.json` → iterate. Contains a prominent **"DeerFlow Environment (READ THIS FIRST)"** section: inside DeerFlow, all skill file operations must go through the `skill_manage` tool (create/edit/patch/delete/write_file/remove_file) because sandbox `write_file` lands in per-thread `/mnt/user-data/outputs/`; packaging and `present_files` are skipped; existing skills are read via `/mnt/skills/custom/<name>/SKILL.md`. Also carries Claude.ai-specific and Cowork-specific adaptation sections and a description-optimization loop (`scripts/run_loop.py`, 60/40 train/test split, `claude -p`) [Verified from source: skills/public/skill-creator/SKILL.md:1-535].
- **skill-reviewer** (120 lines): read-only reviewer. Must inspect targets exclusively through `review_skill_package` (never `read_file`/`bash`/network); treats reviewed content as untrusted and ignores embedded instructions; deterministic facts gate readiness (`blocked`/`revise`/`publish_candidate`) separately from assurance (`static_only`/`trigger_checked`/`behavior_verified`/`regression_verified`); mutations hand off to `skill-creator` [Verified from source: skills/public/skill-reviewer/SKILL.md:1-121].
- **deep-research** (198 lines): 4-phase research methodology (broad exploration → deep dive with `web_fetch` full reads → diversity/validation matrix → synthesis checklist), temporal-awareness rules keyed to `<current_date>`, quality bar and anti-patterns [Verified from source: skills/public/deep-research/SKILL.md:1-199].

---

## 4. Memory system

### Architecture: contract + pluggable backends

`MemoryManager` is a pydantic-BaseModel ABC with tiered methods: tier-1 abstract `add` / `get_context`; tier-2 defaults (`add_nowait` delegates to `add`, `search` raises unless overridden with `supports_search=True`, `get_memory`/`clear_memory`/`import_memory` raise, `shutdown_flush(timeout)` defaults True); tier-3 optional hooks (`warm`, `reload_memory`, `create_fact`/`delete_fact`/`update_fact`). Buckets are `(agent_name, user_id)`. An invariant validator forces `supports_search` to match whether `search()` is overridden, and `mode="tool"` requires a search-capable backend (fails at instantiation) [Verified from source: backend/packages/harness/deerflow/agents/memory/manager.py:79-297, 320-345, 352-413, 151-178].

Backends are drop-in folders under `backends/<name>/` exposing `MANAGER_CLASS`; the singleton factory resolves `memory.manager_class` (registered name or dotted path), fails loud on an unresolvable value ("memory is persistent state … refusing to silently fall back"), defaults `storage_path` to deer-flow's `runtime_home()`, and passes host hooks (`callbacks` = Langfuse span injection, `should_keep_hidden_message` = keep only clarification replies among hidden messages, `trace_context_manager`, `host_llm_factory`, `extraction_callback` = extraction metrics logging with a >60% rejection-rate warning) into `cls.from_config(...)` [Verified from source: manager.py:499-598, 615-763, 767-821].

Backends present: `deermem` (default), `noop`, `mem0`, `openviking` (ls verified).

- **noop (one paragraph):** functional empty backend and explicit template for new backends. Stores nothing, injects nothing, every read returns minimal `{"facts": []}` which the gateway casts into the DeerMem response shape. Its docstring codifies the portability golden rule: the only allowed `from deerflow` import in a backend folder is the ABC contract line; all host info arrives via method args and `backend_config` [Verified from source: backend/packages/harness/deerflow/agents/memory/backends/noop/noop_manager.py:1-50].
- **mem0 (one paragraph):** hosted/self-hosted mem0 API adapter; stateless in-process (dedup/extraction/storage server-side, multi-worker safe). Config via `backend_config` (`api_key_env: MEM0_API_KEY`, `base_url` HTTPS-required unless `allow_insecure_http`, `top_k`, `score_threshold`, `startup_policy fail_fast|tolerate`, `failure_policy.read fail_open|fail_closed`, `write log_and_drop|raise`). Identity map: `user_id→user_id`, `agent_name→agent_id`, `thread_id→run_id`. Middleware-mode recall is query-less (recent top_k injected); tool mode keeps passive writes (`requires_passive_writes_in_tool_mode`) because mem0 extracts from conversations via `add()`; fact CRUD/import/Settings editing unimplemented (gateway 501) [Verified from source: backend/packages/harness/deerflow/agents/memory/backends/mem0/README.md:1-60].

### Mode: middleware vs tool

`MemoryConfig` (host-shared only): `enabled` (default True), `mode: "middleware"|"tool"` (default middleware, mutually exclusive), `injection_enabled` (default True), `shutdown_flush_timeout_seconds` (default 30.0, 1–300), `manager_class` (default `"deermem"`), `backend_config` (dict passthrough). Legacy top-level DeerMem fields (storage_path, debounce_seconds, staleness_*, consolidation_*, model_name, …) are auto-migrated into `backend_config` with warnings on load [Verified from source: backend/packages/harness/deerflow/config/memory_config.py:21-52, 55-116, 163-228].

- **Middleware mode** (default): `MemoryMiddleware.aafter_agent` calls `manager.aadd` with the conversation; `DynamicContextMiddleware` injects the `<memory>` block on the read path. `should_use_memory_tools(config)` is True only for `enabled and mode=="tool"` [Verified from source: memory_config.py:114-116; backend/AGENTS.md Memory System].
- **Tool mode**: registers `memory_search`, `memory_add`, `memory_update`, `memory_delete` (`get_memory_tools()`); each resolves `(agent_name, user_id)` from LangGraph `ToolRuntime.context`, goes through the manager contract, and converts `NotImplementedError` into a JSON `{"error": ...}` result. `memory_add` fast-path-rejects case-folded duplicate content and reports honestly when the `max_facts` cap evicted the new fact (`fact_id is None`). Tool mode deliberately bypasses the staleness guardrails (model-directed CRUD is opt-in) [Verified from source: backend/packages/harness/deerflow/agents/memory/tools.py:31-250, 155-158].
- **Summarization flush hook**: before summarization removes messages, `memory_flush_hook(event)` enqueues the to-be-summarized messages via `add_nowait` with resolved user id — so compacted history is captured into memory rather than lost [Verified from source: backend/packages/harness/deerflow/agents/memory/summarization_hook.py:11-28]. Subagent chains skip this hook (`skip_memory_flush=True`) so subagent-internal turns don't pollute the parent thread's memory [Verified from source: backend/packages/harness/deerflow/agents/middlewares/summarization_middleware.py:695-701, 743-747].

### DeerMem storage layout (schema v2)

Path resolution is DeerMem-private (`core/paths.py`): root = `config.storage_path` or `$DEERMEM_DATA_DIR` or `~/.deermem/`; the deer-flow factory injects `runtime_home()` as the root, so in practice memory lands at `{base_dir}/users/{safe_user_id}/memory.json` [Verified from source: backend/packages/harness/deerflow/agents/memory/backends/deermem/deermem/core/paths.py:64-102; manager.py:793-808].

- **Global summary JSON** per user: `users/{uid}/memory.json` stores *only* `version`, shared revision/lastUpdated, `user` (`workContext` / `personalContext` / `topOfMind`, each `{summary, updatedAt}`), and `history` (`recentMonths` / `earlierContext` / `longTermBackground`); it never stores facts or a fact index [Verified from source: backend/packages/harness/deerflow/agents/memory/backends/deermem/deermem/core/storage.py:1-9, 84-101].
- **Per-agent fact Markdown**: each fact is canonical in one file at `users/{uid}/agents/{agent_name}/facts/{sha256(fact_id)[:2]}/{fact_id}.md` (2-hex shard prefix); YAML front matter carries structure, body carries the atomic fact text. `DOCUMENT_VERSION = "2.0"`; core categories: `preference, correction, context, goal, behavior, identity, constraint, decision, other` [Verified from source: core/paths.py:105-116; core/storage.py:38-39].
- Omitted `agent_name` resolves to the reserved bucket `__default__` (outside the `^[A-Za-z0-9-]+$` custom-agent grammar, so it can't collide); agent names canonicalized to lowercase [Verified from source: core/paths.py:33-36, 56-61; deer_mem.py:52-54].
- Concurrency/durability: shared user-memory revision + per-fact revisions (optimistic), typed conflict exceptions (`MemoryManifestRevisionConflict`, `MemoryFactRevisionConflict`) translated to `MemoryConflictError`/`MemoryCorruptionError` at the manager boundary; cache tokens combine `(mtime_ns, size, revision)`; v1→v2 migration durably writes `{manifest}.v1.bak` before any destructive write and aborts on backup mismatch [Verified from source: core/storage.py:42-60, 126-150; deer_mem.py:57-64].
- The compatibility document shape (`load/save`, gateway responses) still exposes `facts` as a list; structured `source` metadata is projected back to the legacy string field (`_compat_document`) [Verified from source: core/storage.py:84-101; deer_mem.py:67-90].

### Fact extraction prompts (bundled YAML, overridable via `backend_config.prompts_dir`)

Directory: `backends/deermem/deermem/core/prompts/` (ls verified). Custom `prompts_dir` templates are validated at construction; per-agent overrides `{prompts_dir}/{agent}/*.yaml` validate lazily [Verified from source: deer_mem.py:141-158; config.py:235-238].

| File | Job |
|---|---|
| `memory_update.chat.yaml` | The main per-batch extraction prompt (chat format). Instructs a structured reflection (error/retry detection, user-correction detection, project-constraint discovery), then classification of every write with `scope` (user/thread/project), `durability` (durable/temporary), `authority` (descriptive/transactional — transactional content must never become memory). Defines the section length guidelines for the six summary slots, fact categories, `expected_valid_days` lifetime tiers (≤14 transient … >365 very stable), confidence tiers (0.9+ explicit … 0.5 inferred), and the full output JSON: `user`/`history` section updates with `shouldUpdate`, `newFacts`, `factsToRemove` (with `scope`, `reason`, optional `replacementFactIndex`), `staleFactsToRemove`, `staleFactsToExtend`, `factsToConsolidate`. Explicitly forbids recording file-upload events [Verified from source: core/prompts/memory_update.chat.yaml:1-140]. |
| `staleness_review.yaml` | Text section spliced into the update prompt when aged candidates exist: lists `<stale_facts>` with `valid:Nd` annotations and asks KEEP / REMOVE (→ `staleFactsToRemove` with a reason citing conversational evidence) / EXTEND (→ `staleFactsToExtend` with `extend_by_days`) [Verified from source: core/prompts/staleness_review.yaml:1-35]. |
| `consolidation.yaml` | Text section for fragmented categories: per group decide CONSOLIDATE (sourceIds + synthesized fact with full classification labels; confidence = max of sources) or SKIP; "be conservative"; max `{max_groups}` groups per cycle [Verified from source: core/prompts/consolidation.yaml:1-35]. |
| `fact_extraction.yaml` | Standalone single-message fact-extraction prompt (facts JSON with category/confidence). Documented as **dormant** — not wired to any runtime caller, excluded from construction-time validation [Verified from source: core/prompts/fact_extraction.yaml:1-25; deer_mem.py:146-147]. |

Signal-detection patterns (used as extraction hints and backpressure priority) are externalized YAML in `core/message_patterns/`: `correction`, `decision`, `goal`, `identity`, `preference`, `reinforcement`, `trivial` (trivial = pure-acknowledgment filter) [Verified from source: ls of core/message_patterns/; deer_mem.py:123-131, 272-293].

### Write path: filter → signals → debounce queue

`DeerMem.add`: `filter_messages_for_memory` (user inputs + final AI; hidden messages kept only if the host hook accepts, i.e. clarification replies) → `filter_trivial` → require ≥1 human and ≥1 AI message → `detect_signals` → enqueue. `QueueFull` is logged and dropped (backpressure degrades to "update skipped"; the dropped update is re-fed next turn because the watermark doesn't advance) [Verified from source: deer_mem.py:202-293; manager.py:648-659].

`MemoryUpdateQueue` (`core/queue.py`): process-local in-memory list + `threading.Timer` debounce; coalesces multiple contexts per `(thread_id, user_id, agent_name)` key; **`debounce_seconds` default 30 (range 1–300)**; `queue_max_depth` default 1000 — when full, non-signal updates are rejected (`QueueFull`) while signal-bearing updates are always admitted; emergency `add_nowait` contexts carry `bypass_watermark=True` and coexist with pending normal updates; `flush_sync(timeout)` joins an in-flight worker then drains on a daemon thread with a hard timeout (used by `shutdown_flush`) [Verified from source: core/queue.py:1-133; config.py:76-86; deer_mem.py:469-479].

The updater runs sync LLM calls on a dedicated 4-worker thread pool (`memory-updater-sync`), never on the event loop; facts over `max_facts` are trimmed keeping highest confidence (coerced to [0,1], default 0.5 on malformed) [Verified from source: core/updater.py:34-88].

### Read path / injection format

Call site `_get_memory_context` (lead-agent prompt assembly): gated on `memory.enabled and memory.injection_enabled`; wraps the backend's text verbatim in `<memory>\n…\n</memory>\n`; on error returns `""` unless the backend's `failure_policy.read == "fail_closed"` for `MemoryManagerError` [Verified from source: backend/packages/harness/deerflow/agents/lead_agent/prompt.py:705-757]. `DynamicContextMiddleware` delivers it as part of the `<system-reminder>` injected into the first HumanMessage (keeping the base system prompt static for prefix caching) [Verified from source: backend/packages/harness/deerflow/agents/middlewares/dynamic_context_middleware.py:17, 105].

`format_memory_for_injection(memory_data, max_tokens=2000, use_tiktoken=True, guaranteed_categories=None, guaranteed_token_budget=500)` renders:

```
User Context:
- Work: …
- Personal: …
- Current Focus: …

History:
- Recent: …
- Earlier: …
- Background: …

Facts:
- [category | 0.95] content (avoid: sourceError-for-corrections)
```

Facts are greedily selected within the token budget in rank order (a shorter lower-ranked fact never slips past a skipped higher-ranked one); guaranteed-category facts (default `["correction"]`, config `guaranteed_token_budget` default 500, range 50–2000) are selected first from their own budget and placed at the front so regular facts can't evict them; all user-editable values are HTML-escaped so `</memory>` in a stored fact can't break out of the trust zone (#4097) [Verified from source: core/prompt.py:340-427, 466-599; config.py:96-115].

Key injection defaults (DeerMemConfig): `max_injection_tokens` **2000** (100–8000), `token_counting` `tiktoken|char` (default tiktoken; failed tiktoken loads cached with a 600 s cooldown falling back to CJK-aware char estimation), `max_facts` **100** (10–500), `fact_confidence_threshold` **0.7** [Verified from source: config.py:87-105; backend/AGENTS.md Token counting; deer_mem.py:296-323].

Mode-aware injection: middleware mode injects global summaries **plus** the selected agent's facts; tool mode injects only the global summaries (`injection_agent = None`) and leaves facts behind `memory_search` [Verified from source: deer_mem.py:296-323].

### Search / retrieval

`DeerMem.search` tries the retrieval adapter first (`retrieval_adapter` default `"fts5"`; empty string disables), then falls back to case-insensitive substring over canonical facts sorted by confidence. The FTS5 adapter is SQLite BM25 (default K1/B — a prior bug passing positional zeros silently disabled BM25) with optional jieba Chinese tokenization, FTS5 MATCH syntax support, time-decay + confidence weighting (`_CONFIDENCE_WEIGHT = 0.2`), category filtering, and per-scope isolation; it stores only rebuildable derived data under the storage root. Scopes are lazily rebuilt on first search until Gateway warm-up (`warm_retrieval`) completes a full rebuild; adapter failures log and fall back — retrieval errors never make canonical memory unavailable [Verified from source: deer_mem.py:325-424, 501-522; core/retrieval.py:1-68; config.py:71-74].

### Staleness review & consolidation (same LLM invocation, no extra API call)

Config defaults (all DeerMem-private, `backend_config.*`): `staleness_review_enabled` **true**; `staleness_age_days` **90** (30–365); `staleness_min_candidates` **3** (1–50); `staleness_max_removals_per_cycle` **10** (1–50); `staleness_protected_categories` **["correction"]**; `staleness_max_lifetime_multiplier` **20.0** (creation-time clamp: expected_valid_days ≤ 90×20 = 1800 d); `staleness_max_extension_days` **3650** (90–36500; extension clamp `min(days_since + extend_by, ceiling)`) [Verified from source: config.py:116-175]. `_apply_updates` enforces the guardrails unconditionally at apply time — removal and extension sets are intersected with the deterministically selected candidates before the per-cycle cap, so protected/non-aged facts can never be targeted regardless of model output (behavior contract per backend/AGENTS.md Memory workflow; guardrail config verified in config.py).

Consolidation: `consolidation_enabled` **false by default in code** ("consolidation is lossy … opt in explicitly"); `consolidation_min_facts` **8** (3–30); `consolidation_max_groups_per_cycle` **3** (1–10); `consolidation_max_sources` **8** (2–20). Merged facts carry the newest source `createdAt` and inherit an `expected_valid_days` due at the earliest source review deadline [Verified from source: config.py:176-206; merge semantics per backend/AGENTS.md Memory workflow]. (Note: repo-root AGENTS.md describes `consolidation_enabled` default as true; the code default in `DeerMemConfig` is False — code wins.)

Extraction gating: middleware-extracted writes pass a deterministic scope gate — only `scope=user` + `durability=durable` + `authority=descriptive` facts and wholly user-scoped descriptive summaries are accepted; labels are evaluated but not persisted; task/project removals fail closed; an un-migrated custom prompt makes the fail-closed gate reject every write, observable via `rejected_by_scope_gate` and the >60% warning [Verified from source: prompt contract in core/prompts/memory_update.chat.yaml (scope/durability/authority requirements); metrics plumbing in manager.py:681-741; behavior contract per backend/AGENTS.md].

### Other defaults worth porting

`watermark_max_keys` **4096** (bounded LRU on the conversation-watermark cache; 0 = unbounded; eviction = re-extract one batch next turn) [Verified from source: config.py:218-229]. `file_lock_timeout_seconds` **10** (1–120) for the per-scope cross-process advisory file lock; `strict_user_scope` default **false**; `manifest_filename` default `memory.json` [Verified from source: config.py:57-70].

---

## 5. Summarization config

`SummarizationConfig` [Verified from source: backend/packages/harness/deerflow/config/summarization_config.py:22-61]:

| Field | Default | Semantics |
|---|---|---|
| `enabled` | `False` in code (`config.example.yaml` ships `true`) | master switch [summarization_config.py:25-27; config.example.yaml summarization section] |
| `model_name` | `None` | None = summarize with the model the run actually executes with (lead run's model / subagent's own / custom-agent model), **not** `models[0]`; when set, that model generates and the run's model is the fallback [summarization_config.py:29-34; middleware builder at summarization_middleware.py:709-731] |
| `trigger` | `None` | one `ContextSize` or a list; **types**: `"fraction"` (of model max input tokens), `"tokens"`, `"messages"`; any threshold met triggers (OR). Example config ships `tokens: 32000` [summarization_config.py:7, 36-42; config.example.yaml] |
| `keep` | `ContextSize(type="messages", value=20)` | retention policy after summarization (messages / tokens / fraction). Example config ships `messages: 10` [summarization_config.py:43-49; config.example.yaml] |
| `trim_tokens_to_summarize` | `4000` | max tokens kept when preparing messages for the summary call; `null` skips trimming. Example ships 15564 [summarization_config.py:50-53] |
| `summary_prompt` | `None` | custom template; None = LangChain `SummarizationMiddleware`'s built-in default prompt (formatted with `{messages}`) [summarization_config.py:54-57; usage at summarization_middleware.py:450, 740-741; config.example.yaml:1622 `summary_prompt: null`] |
| `skill_file_read_tool_names` | `["read_file", "read", "view", "cat"]` | tool names counted as skill-file reads for durable `skill_context` capture [summarization_config.py:8, 58-61] |

**Summary prompt.** The default prompt text itself is LangChain's `SummarizationMiddleware` default (the middleware subclasses it and only formats `self.summary_prompt.format(messages=...)`); the default string is not vendored in this repo, so it cannot be quoted from source here (no installed venv at analysis time — honest coverage gap). What DeerFlow **does** own is the input construction it feeds into `{messages}`, which a port must reproduce:

```
<existing_summary>
{previous summary_text, trimmed, HTML-escaped}
</existing_summary>

<new_messages>
{get_buffer_string(trimmed tail), HTML-escaped}
</new_messages>
```

Escaping is a deliberate block-breakout defense (an unescaped `</new_messages>` could forge an authority section) [Verified from source: backend/packages/harness/deerflow/agents/middlewares/summarization_middleware.py:405-450]. Canned non-generated summaries `"No previous conversation history."` and `"Previous conversation was too long to summarize."` short-circuit model invocation [summarization_middleware.py:25-32].

**`summary_text` channel semantics.** `ThreadState.summary_text: NotRequired[str | None]` is a plain LastValue channel (no reducer annotation) [Verified from source: backend/packages/harness/deerflow/agents/thread_state.py:264-276]. Compaction rewrites the messages channel (via `RemoveMessage(REMOVE_ALL_MESSAGES)`) and stores the generated summary in `summary_text` instead of as a `messages` item; the previous `summary_text` is fed back as `<existing_summary>` on the next compaction (rolling summary) [summarization_middleware.py:458-479]. `DurableContextMiddleware` projects `summary_text` into each model request as a hidden `HumanMessage` data block (untrusted values are never promoted to system role); this also fixes strict providers rejecting assistant-first requests after keep-policy preservation [Verified from source: backend/AGENTS.md Middleware Chain item 17 and ThreadState description]. Manual compaction reuses the same middleware via `POST /threads/{id}/compact`. Failure semantics: automatic path swallows generation failure (state unchanged); manual path opts into `raise_on_failure` → `SummaryGenerationError` [summarization_middleware.py:35-42].

Subagents share the identical `summarization` config (same trigger/keep/model/prompt) via `build_subagent_runtime_middlewares`, with `skip_memory_flush=True` [summarization_middleware.py:689-701; backend/AGENTS.md #3875 Phase 3].

---

## 6. Port-relevant observations

### DeerFlow skills → Claude Code skills

**What maps 1:1.** The core package format is intentionally Claude-skill-shaped: a directory with `SKILL.md`, YAML frontmatter `name` + `description` (required), `license`, `metadata`, `compatibility`, `version`, `author`, optional `scripts/`, `references/`, `assets/` support dirs (DeerFlow additionally allows `templates/`) [validation.py; skill_storage.py:81-101]. Hyphen-case ≤64-char names and ≤1024-char descriptions match Claude Code conventions. `skill-creator`'s body even documents the same three-level progressive-disclosure model Claude Code uses (metadata always in context, body on trigger, resources on demand) [skills/public/skill-creator/SKILL.md:135-147]. These skills can largely be dropped into a Claude Code `skills/`/plugin directory after frontmatter adjustment.

**Frontmatter differences.**
- DeerFlow `allowed-tools` is a YAML **list**; Claude Code's `allowed-tools` is a comma-separated string. Semantics differ more than syntax: DeerFlow enforces it dynamically (schema filtering + execution blocking, union across active skills, slash-dominance, framework-tool exemptions) via middleware; Claude Code treats it as a permission pre-grant for the skill's execution context. A port must decide whether to keep union semantics or map each skill to Claude Code's per-skill grant.
- `required-secrets` / `secrets-autonomous` have **no Claude Code equivalent**. The whole request-scoped secret pipeline (frontmatter declaration → `context.secrets` carrier → env injection into the sandbox subprocess with output masking) would need to be replaced by Claude Code's env/settings machinery or an MCP-side credential broker. Notably, **no public skill uses these fields today** (grep-verified), so the public catalog ports cleanly; only the mechanism itself is DeerFlow-specific.
- `license` as a free-string frontmatter field and `enabled` living *outside* the package (extensions_config / `_skill_states.json`) both differ: Claude Code has no external enabled-state file — porting the enable/disable UX means either deleting/moving skill dirs or a wrapper that filters what gets symlinked into the skills dir (analogous to DeerFlow's enabled-only projection).

**Loading differences.**
- DeerFlow has **two** discovery modes: legacy full-metadata `<available_skills>` blocks and deferred `<skill_index>` + `describe_skill` tool. Claude Code natively behaves like a middle ground: name+description always in context (like the legacy block's metadata, but without location/body) with automatic body loading on trigger. The deferred `describe_skill`/`SkillCatalog` machinery is unnecessary in Claude Code; the `<disabled_skills>` MUST-NOT-read section has no equivalent (Claude Code simply doesn't list disabled skills).
- Slash activation maps well: DeerFlow `/skill-name task` ≈ Claude Code's `/skill-name` invocation (Skill tool / slash command). The reserved-command list (`bootstrap, goal, help, memory, models, new, status`) corresponds to Claude Code's built-in commands; a port must reconcile collisions. DeerFlow's "inject body as hidden current-turn context, policy scoped to the run" is close to Claude Code's skill-load-into-turn behavior.
- The **sandbox projection layer** (enabled-only hardlink trees at `/mnt/skills/{category}/`, manifest signatures, cross-process locks) exists because DeerFlow skills execute inside isolated sandboxes with mount semantics. Claude Code runs skills in the same working environment; the entire projection subsystem collapses to "the skills directory is the source of truth". The container-path indirection (`/mnt/skills/...` in prompts vs host paths) also disappears.
- Install-time hardening (zip-safety, magic-byte binary rejection, SkillScan, LLM content scan, review core) has no Claude Code counterpart; keep whatever subset matters as a pre-install lint if porting the marketplace/install flow.
- Several public skill **bodies contain DeerFlow-environment branches** (skill-creator's `skill_manage` section, `/mnt/user-data/outputs` paths, `present_files` references, `<current_date>` tag in deep-research). Ported copies need those sections rewritten to Claude Code equivalents (plain file writes, no `present_files`, Claude Code's env info) — the skill-creator file already demonstrates the pattern of per-environment sections (DeerFlow / Claude.ai / Cowork), so adding a Claude Code section is the low-risk path.

### DeerFlow memory → Claude Code memory-dir pattern

Claude Code's native memory is file-based context (`CLAUDE.md` imports, and file-based "memory directory" patterns where the agent reads/writes markdown notes). DeerFlow's DeerMem is structurally *very close* to a memory-dir already, which makes this the natural mapping:

- **Storage maps directly.** DeerMem v2 is "one JSON of rolling summaries + per-agent one-fact-per-Markdown-file with YAML front matter, sharded dirs" [core/paths.py; core/storage.py]. A Claude Code memory dir would keep the per-fact Markdown files nearly verbatim (front matter: category, confidence, createdAt, expected_valid_days, source) and turn `memory.json`'s six summary slots (`workContext`, `personalContext`, `topOfMind`, `recentMonths`, `earlierContext`, `longTermBackground`) into a single `profile.md` with six sections. The sharding prefix (`facts/{2-hex}/`) is only needed at DeerMem's 100-500 fact scale-with-listing-cost; a flat dir is fine for a port.
- **Injection maps to CLAUDE.md-style loading.** DeerFlow injects `<memory>…</memory>` (budget 2000 tokens, guaranteed `correction` facts first at 500 tokens) into the first user turn via middleware. In Claude Code the equivalent is `@import`-ing (or auto-reading at session start) the profile file plus a curated `facts-digest.md`. The token-budget + guaranteed-categories logic becomes a maintenance job that regenerates the digest file, rather than per-request formatting. The HTML-escaping breakout defense stays relevant if memory content is wrapped in tags.
- **Extraction has no native counterpart.** The debounced background LLM extraction pipeline (30 s debounce, signal detection, scope/durability/authority gate, staleness review, consolidation) is DeerFlow's biggest non-portable piece. In a Claude Code port this becomes either (a) a Stop/SessionEnd **hook** that invokes a one-shot extraction prompt over the transcript and applies the same write-gate rules, or (b) tool-mode-style explicit memory tools (DeerFlow's `memory_search/add/update/delete` map cleanly onto four small MCP tools or scripts the agent calls). DeerFlow's own tool mode is the proof this contract works model-directed; note its caveat that tool mode bypasses staleness guardrails [tools.py:155-158].
- **Guardrails worth carrying over regardless of mechanism:** the deterministic write gate (only user-scoped, durable, descriptive facts persist; transactional "authorizations" never become memory), duplicate rejection by case-folded content, `max_facts` trim keeping highest confidence, the correction category being both guaranteed-injected and staleness-protected, and the `.v1.bak`-before-migration discipline. These are policy, not infrastructure, and port to any storage.
- **What to drop:** the FTS5/BM25 retrieval index (at ≤100 facts substring or agent-driven grep over the memory dir is adequate — DeerMem itself keeps substring as the always-available fallback), the multi-process advisory-lock/revision machinery (Claude Code sessions are effectively single-writer; last-write-wins on Markdown files plus git history covers it), and the queue/backpressure layer (no long-lived multi-tenant server process).
- **Identity mapping:** DeerFlow buckets by `(user_id, agent_name)` with a `__default__` bucket. Claude Code is single-user per machine; `agent_name` maps to per-project memory dirs (project-level `.claude/memory/` vs user-level `~/.claude/memory/` mirrors DeerFlow's per-agent vs `__default__` split).
