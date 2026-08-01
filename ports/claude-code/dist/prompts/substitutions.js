/**
 * THE WHITELIST — every deliberate deviation of `src/prompts/lead.ts` from the
 * frozen golden renders produced by the original DeerFlow engine
 * (`parity/baseline/prompt_renders/lead_prompt_*.txt`, commit 0950924).
 *
 * This file is the honesty contract for Milestone M3. `lead.test.ts` applies
 * these substitutions to the golden text and then requires a byte-exact match
 * against `renderLeadPrompt(...)`. Consequences:
 *
 *   - Any drift in the ported prompt that is NOT declared here fails the test.
 *   - Any declared substitution that no longer matches its golden text fails the
 *     test (stale whitelist entries cannot rot silently).
 *
 * Nothing in here is generated from `lead.ts`; both sides are authored
 * independently so the comparison is a real check, not a tautology.
 */
export const GOLDEN_CONFIG_IDS = [
    'subagents_enabled_n3_two_skills',
    'subagents_enabled_n1',
    'subagents_disabled_non_interactive',
];
/**
 * Tool-name remapping table (documentation for the token substitutions below
 * plus the tool names embedded in the rewritten blocks).
 * Source: prompts-and-skills-map.md §1.2 forced change 1, §1o, §1p.
 */
export const TOOL_NAME_MAP = {
    write_file: 'Write',
    str_replace: 'Edit',
    read_file: 'Read',
    bash: 'Bash',
    ls: 'Glob / Bash',
    web_search: 'WebSearch',
    web_fetch: 'WebFetch',
    task: 'Agent (delegation; heavy fan-out goes through the deerflow:deep-run workflow)',
    ask_clarification: 'AskUserQuestion',
    present_files: 'outputs/ delivery contract (final response lists produced files)',
    describe_skill: 'native Skill listing / Skill tool',
    list_uploaded_files: 'native file references / Read',
    skill_manage: 'direct edits to the plugin skills/ directory',
    write_todos: 'TaskCreate / TaskUpdate',
};
const ALL = GOLDEN_CONFIG_IDS;
export const LEAD_PROMPT_SUBSTITUTIONS = [
    // -------------------------------------------------------------------------
    // 0. Extractor provenance header (not part of the rendered prompt)
    // -------------------------------------------------------------------------
    {
        id: 'baseline-header',
        kind: 'regex',
        original: '^# BASELINE PROMPT RENDER[\\s\\S]*?# ---8<--- render begins on the next line ---8<---\\n',
        originalDescription: 'The 8-line "# BASELINE PROMPT RENDER ..." comment block that extract_vectors.py prepends to each golden file.',
        replacement: '',
        reason: 'Extractor provenance header written by ports/claude-code/parity/baseline/extract_vectors.py; it is not part of the prompt the engine returned.',
        appliesTo: ALL,
    },
    // -------------------------------------------------------------------------
    // 1. Whole-section rewrites (map verdict: rewrite-needed)
    // -------------------------------------------------------------------------
    {
        id: 'working-directory-section',
        kind: 'literal',
        original: `<working_directory existed="true">
- Current uploads: \`/mnt/user-data/uploads\` - Files uploaded in the current run are listed in \`<current_uploads>\`
- Historical uploads: \`/mnt/user-data/uploads\` - Files from earlier turns. Use \`list_uploaded_files\` to discover which historical files exist. If you know the filename, access it directly with \`read_file\` or \`grep\`.
- User workspace: \`/mnt/user-data/workspace\` - Working directory for temporary files
- Output files: \`/mnt/user-data/outputs\` - Final deliverables must be saved here

**File Management:**
- Newly uploaded files in this run are listed in the \`<current_uploads>\` section before your first response
- Use \`read_file\` tool to read uploaded files using their paths from the list
- For PDF, PPT, Excel, and Word files, converted Markdown versions (*.md) are available alongside originals
- Files uploaded in previous turns are NOT automatically listed. Use \`list_uploaded_files\` to discover them on demand — it returns filenames, sizes, and optionally document outlines
- All temporary work happens in \`/mnt/user-data/workspace\`
- Treat \`/mnt/user-data/workspace\` as your default current working directory for coding and file-editing tasks
- When writing scripts or commands that create/read files from the workspace, prefer relative paths such as \`hello.txt\`, \`../uploads/data.csv\`, and \`../outputs/report.md\`
- Avoid hardcoding \`/mnt/user-data/...\` inside generated scripts when a relative path from the workspace is enough
- Final deliverables must be copied to \`/mnt/user-data/outputs\` and presented using \`present_files\` tool (⚠️ Skills are NOT deliverables — use \`skill_manage\` tool instead)

</working_directory>`,
        replacement: `<working_directory>
- Project root: the current working directory - every relative path resolves from here
- Output files: \`outputs/\` under the project root - Final deliverables must be saved here

**File Management:**
- Treat the project root as your default current working directory for coding and file-editing tasks
- When writing scripts or commands that create/read files, prefer project-relative paths such as \`hello.txt\`, \`data/input.csv\`, and \`outputs/report.md\`
- Avoid hardcoding absolute machine paths when a project-relative path is enough
- Final deliverables must be written under \`outputs/\` and listed by absolute path in your final response
</working_directory>`,
        reason: 'WHOLE-SECTION REWRITE (map §1m, verdict rewrite-needed). The `/mnt/user-data/{uploads,workspace,outputs}` virtual paths, the Gateway upload pipeline (`list_uploaded_files`, `<current_uploads>`, PDF/Office conversion), the `present_files` delivery step, and the `skill_manage` carve-out have no Claude Code equivalent. Replaced by the project-relative `outputs/` delivery contract (recommended-architecture §5). The trailing blank line came from the empty `{acp_section}` slot (ACP + custom sandbox mounts are excluded subsystems).',
        appliesTo: ALL,
    },
    {
        id: 'clarification-how-to-and-example',
        kind: 'literal',
        original: `**How to Use:**
\`\`\`python
ask_clarification(
    question="Your specific question here?",
    clarification_type="missing_info",  # or other type
    context="Why you need this information",  # optional but recommended
    options=["option1", "option2"]  # optional, for choices
)
\`\`\`

**Example:**
User: "Deploy the application"
You (thinking): Missing environment info - I MUST ask for clarification
You (action): ask_clarification(
    question="Which environment should I deploy to?",
    clarification_type="approach_choice",
    context="I need to know the target environment for proper configuration",
    options=["development", "staging", "production"]
)
[Execution stops - wait for user response]`,
        replacement: `**How to Use:**
Call AskUserQuestion with the specific question and, when the answer is a choice,
the concrete options to pick from. Word the question so the clarification type
from the taxonomy above is obvious.

**Example:**
User: "Deploy the application"
You (thinking): Missing environment info - I MUST ask for clarification
You (action): AskUserQuestion — "Which environment should I deploy to?"
    (approach_choice; options: development, staging, production)
[Execution stops - wait for user response]`,
        reason: "The `ask_clarification` Python call signature (question / clarification_type / context / options kwargs, plus the v2 `fields` form mode) is a DeerFlow tool schema. Claude Code asks through the native AskUserQuestion tool with a different parameter contract, and structured forms exceed its question capability (map §1.8: hold back `fields`, degrade to plain text). The five-scenario taxonomy above it is platform-neutral policy and is preserved verbatim.",
        appliesTo: ALL,
    },
    {
        id: 'non-interactive-clarification-note',
        kind: 'literal',
        original: `</clarification_system>`,
        replacement: `
**NON-INTERACTIVE RUN - AskUserQuestion IS NOT AVAILABLE:**
- No user is available to answer during this run, so clarification cannot be requested.
- Proceed with the most reasonable interpretation and state every assumption you made in your final response.
- Stop and report instead of guessing when the ambiguity concerns a destructive or irreversible action.
</clarification_system>`,
        reason: "ADDITIVE, non_interactive configuration only. In DeerFlow `context.non_interactive` is not an input to `apply_prompt_template` at all — the rendered prompt is byte-identical and the entire effect is removing `ask_clarification` from the bound toolset in `make_lead_agent` (`_NON_INTERACTIVE_DISABLED_TOOL_NAMES`, recorded in parity/baseline/prompt_renders/non_interactive_tool_filter.txt). The port has no tool-binding filter, so the removal must be stated in the prompt or the model would keep being told to ask a user who cannot answer.",
        appliesTo: ['subagents_disabled_non_interactive'],
    },
    // -------------------------------------------------------------------------
    // 2. Skills section (deferred `<skill_index>` variant)
    // -------------------------------------------------------------------------
    {
        id: 'skill-discovery-steps',
        kind: 'literal',
        original: `2. Call describe_skill(name) to fetch its description and capabilities
3. If the skill matches, call read_file on the returned location to load full instructions`,
        replacement: `2. Invoke it with the Skill tool to load its description and capabilities
3. If the skill matches, Read its SKILL.md at the listed location to load full instructions`,
        reason: 'The `describe_skill` tool and its SkillCatalog query grammar are platform-native in Claude Code (map §2.5): skill names + descriptions are always in context and bodies load through the native Skill tool / Read. The surrounding four-step discovery wording is otherwise preserved verbatim.',
        appliesTo: ['subagents_enabled_n3_two_skills'],
    },
    {
        id: 'skills-located-at',
        kind: 'literal',
        original: `Skills are located at: /mnt/skills`,
        replacement: `Skills are located at: the deerflow plugin's skills/ directory`,
        reason: 'The `/mnt/skills` container projection (skills.container_path) and its enabled-only projection trees do not exist in the port; skills ship inside the plugin package (map §2.4).',
        appliesTo: ['subagents_enabled_n3_two_skills'],
    },
    // -------------------------------------------------------------------------
    // 3. Subagent section (map §1l: reuse text, remap tool names)
    // -------------------------------------------------------------------------
    {
        id: 'subagent-direct-execution-example',
        kind: 'literal',
        original: `\`\`\`python
# User asks: "Read the README"
# Thinking: Single straightforward file read
# → Execute directly

read_file("/mnt/user-data/workspace/README.md")  # Direct execution, not task()
\`\`\``,
        replacement: `\`\`\`text
# User asks: "Read the README"
# Thinking: Single straightforward file read
# → Execute directly

Read("README.md")  # Direct execution, not an Agent delegation
\`\`\``,
        reason: 'Tool-name remap (`read_file`→Read, `task()`→Agent delegation) plus `/mnt/user-data/workspace` → project-relative path. The fence language changes from `python` to `text` because the snippet is illustrative pseudo-code, not a callable Python API, in the port.',
        appliesTo: ['subagents_enabled_n3_two_skills', 'subagents_enabled_n1'],
    },
    {
        id: 'subagent-direct-tool-examples',
        kind: 'literal',
        original: `(ls, read_file, web_search, etc.)`,
        replacement: `(Read, Glob, WebSearch, etc.)`,
        reason: 'Tool-name remap of the direct-execution tool list. DeerFlow `ls` has no standalone Claude Code equivalent and folds into Glob/Bash (map §1.2 forced change 1).',
        appliesTo: ['subagents_enabled_n3_two_skills', 'subagents_enabled_n1'],
    },
    // -------------------------------------------------------------------------
    // 4. Critical reminders
    // -------------------------------------------------------------------------
    {
        id: 'skill-first-reminder',
        kind: 'literal',
        original: `- Skill First: For complex tasks, call describe_skill(name) to check if a matching skill exists, then read_file to load it.`,
        replacement: `- Skill First: Always load the relevant skill before starting **complex** tasks.`,
        reason: 'Map §1p: the deferred-mode `skill_first_reminder` wording is dropped as platform-native (no describe_skill in Claude Code); the legacy wording is reused verbatim from prompt.py:1062.',
        appliesTo: ALL,
    },
    {
        id: 'output-files-reminder',
        kind: 'literal',
        original: `- Output Files: Final deliverables must be in \`/mnt/user-data/outputs\` (⚠️ Skills are NOT deliverables — use \`skill_manage\` tool instead)`,
        replacement: `- Output Files: Final deliverables must be in \`outputs/\` under the project root`,
        reason: '`/mnt/user-data/outputs` becomes the project-relative `outputs/` contract (map §1m). The `skill_manage` carve-out is dropped: the tool does not exist and skills are edited as plain files in the plugin skills/ directory.',
        appliesTo: ALL,
    },
    {
        id: 'file-editing-workflow-reminder',
        kind: 'literal',
        original: `- File Editing Workflow: When revising an existing file, prefer
  \`str_replace\` over \`write_file\` — it sends only the diff and avoids
  re-emitting the whole file (mirrors Claude Code's Edit and Codex's
  apply_patch). When writing long new content from scratch, split it
  into sections: the first \`write_file\` call creates the file, then use
  \`write_file\` with append=True to extend it section by section. This
  keeps each tool call small and avoids mid-stream chunk-gap timeouts
  on oversized single-shot writes. (See issue #3189.)  `,
        replacement: `- File Editing Workflow: When revising an existing file, prefer
  \`Edit\` over \`Write\` — it sends only the diff and avoids
  re-emitting the whole file.`,
        reason: "Tool-name remap (`str_replace`→Edit, `write_file`→Write) — which also makes the original's own \"mirrors Claude Code's Edit\" aside redundant. The append=True section-splitting strategy is dropped: Claude Code's Write has no append mode and the mid-stream chunk-gap timeout it mitigated (#3189) is a DeerFlow sandbox concern (map §1p).",
        appliesTo: ALL,
    },
    {
        id: 'images-and-mermaid-reminder',
        kind: 'literal',
        original: `- Including Images and Mermaid: Images and Mermaid diagrams are welcomed in Markdown.
  - To render an output image in a final response, use its complete virtual artifact path, for example \`![Chart](/mnt/user-data/outputs/chart.png)\`.
  - Never use a bare or workspace-relative filename.
  - Call \`present_files\` for the image before referencing it.
  - Use "\`\`\`mermaid" for Mermaid diagrams.`,
        replacement: `- Including Images and Mermaid: Images and Mermaid diagrams are welcomed in Markdown.
  - To reference an output image in a final response, use its path under \`outputs/\`, for example \`![Chart](outputs/chart.png)\`.
  - Use "\`\`\`mermaid" for Mermaid diagrams.`,
        reason: 'Virtual artifact paths (`/mnt/user-data/outputs/...`) become project-relative `outputs/` paths, so the "never use a workspace-relative filename" rule inverts and is dropped. `present_files` does not exist — there is no separate presentation step in the port (map §1m/§1p).',
        appliesTo: ALL,
    },
    // -------------------------------------------------------------------------
    // 5. Neutral phrasing
    // -------------------------------------------------------------------------
    {
        id: 'deerflow-ui-reference',
        kind: 'literal',
        original: `is user-managed data (visible and editable via the DeerFlow UI) — you may`,
        replacement: `is user-managed data (visible and editable by the user) — you may`,
        reason: 'The DeerFlow web UI / Gateway is not part of the port; neutral phrasing per map §1c. The memory block itself and its confidentiality carve-out are preserved.',
        appliesTo: ALL,
    },
    // -------------------------------------------------------------------------
    // 6. Tool-name token remaps (applied after the block rewrites above)
    // -------------------------------------------------------------------------
    {
        id: 'token-ask-clarification',
        kind: 'regex',
        original: 'ask_clarification',
        originalDescription: 'Every remaining prose reference to the `ask_clarification` tool name.',
        replacement: 'AskUserQuestion',
        reason: 'Tool-name remap: DeerFlow `ask_clarification` → Claude Code native AskUserQuestion (map §1g).',
        appliesTo: ALL,
    },
    {
        id: 'token-task-tool',
        kind: 'regex',
        original: '`task`',
        originalDescription: 'Every backtick-quoted reference to the DeerFlow `task` delegation tool.',
        replacement: '`Agent`',
        reason: "Tool-name remap: DeerFlow's `task` tool → Claude Code's Agent tool (map §1l). Both block until the subagent returns its result, so the closing \"waits ... no polling is needed\" contract holds unchanged. Heavy multi-agent fan-out in the port additionally routes through the deerflow:deep-run workflow, which is where the per-run cap is actually enforced (prompt-side limits only, per map §1l delta).",
        appliesTo: ['subagents_enabled_n3_two_skills', 'subagents_enabled_n1'],
    },
    {
        id: 'token-read-file',
        kind: 'regex',
        original: '`read_file`',
        originalDescription: 'Every remaining backtick-quoted reference to the `read_file` tool name.',
        replacement: '`Read`',
        reason: 'Tool-name remap: DeerFlow `read_file` → Claude Code `Read` (map §1.2 forced change 1).',
        appliesTo: ['subagents_enabled_n3_two_skills'],
    },
    {
        id: 'token-web-search',
        kind: 'regex',
        original: 'web_search',
        originalDescription: 'Every remaining reference to the `web_search` tool name (citations section).',
        replacement: 'WebSearch',
        reason: 'Tool-name remap: DeerFlow `web_search` → Claude Code `WebSearch` (map §1o). Citation format itself is unchanged.',
        appliesTo: ALL,
    },
    {
        id: 'token-web-fetch',
        kind: 'regex',
        original: 'web_fetch',
        originalDescription: 'Every remaining reference to the `web_fetch` tool name (citations section).',
        replacement: 'WebFetch',
        reason: 'Tool-name remap: DeerFlow `web_fetch` → Claude Code `WebFetch` (map §1o). Citation format itself is unchanged.',
        appliesTo: ALL,
    },
];
/**
 * Port behaviour that no golden render exercises, and therefore cannot be
 * covered by the parity test. Declared here so the coverage gap is explicit
 * rather than silent.
 */
export const UNCOVERED_BY_GOLDENS = [
    {
        what: '`renderSubagentSection` bash-available branch (`Bash, Read, Glob, WebSearch, etc.` tool list, the `Bash("npm test")` direct-execution example, and the `bash` entry in **Available Subagents**).',
        why: 'All three goldens were extracted with `LocalSandboxProvider`, where `get_available_subagent_names()` does not include `bash`, so the engine rendered only the no-bash branch. The port exercises it in a dedicated unit test instead.',
    },
    {
        what: '`renderLeadPrompt({ soul })` — the `<soul>` block.',
        why: 'The extractor pinned `agent_name=None`, so `get_agent_soul` returned an empty string in every golden. The html-escaping rule it carries is unit-tested directly.',
    },
    {
        what: '`renderLeadPrompt({ modelInfo })` — the `<model_info>` block.',
        why: 'Port-only addition; DeerFlow has no model-info prompt section, so no golden can contain it. Omitted by default and therefore absent from every parity render.',
    },
    {
        what: '`renderLeadPrompt({ planMode: true })` — the appended `<todo_list_system>` block.',
        why: 'DeerFlow injects this through TodoMiddleware (gated on `configurable.is_plan_mode`), not through `apply_prompt_template`, so it can never appear in an `apply_prompt_template` golden. It is ported from agents/factory.py:44-55 and pinned by a unit test plus skills/plan/SKILL.md.',
    },
    {
        what: '`renderWorkingDirectorySection({ workingDirectory })` — the absolute-path variant of the project-root line.',
        why: 'Port-only parameter; the parity renders use the path-neutral default so the whitelisted replacement text stays free of machine-specific paths.',
    },
];
/**
 * Apply the whitelist to one golden render, in declaration order.
 * Returns the transformed text plus the ids that actually matched something.
 */
export function applySubstitutions(goldenText, configId, substitutions = LEAD_PROMPT_SUBSTITUTIONS) {
    let text = goldenText;
    const appliedIds = new Set();
    for (const substitution of substitutions) {
        const scope = substitution.appliesTo ?? ALL;
        if (!scope.includes(configId)) {
            continue;
        }
        const before = text;
        if (substitution.kind === 'regex') {
            text = text.replace(new RegExp(substitution.original, 'gm'), () => substitution.replacement);
        }
        else {
            text = text.split(substitution.original).join(substitution.replacement);
        }
        if (text !== before) {
            appliedIds.add(substitution.id);
        }
    }
    return { text, appliedIds };
}
