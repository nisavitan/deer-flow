/**
 * Tools the M7 guards watch. Everything else — the harness's own control surface (Task/Agent,
 * TaskCreate, AskUserQuestion, Skill, Workflow, TodoWrite …) — is deliberately unguarded: those are
 * orchestration calls, not the repetitive work loops the detector exists to break, and denying one
 * would break the port's own machinery.
 */
export const GUARDED_TOOL_NAMES = new Set([
    'Bash',
    'Edit',
    'Write',
    'Read',
    'Glob',
    'Grep',
    'WebFetch',
    'WebSearch',
]);
/** MCP tools are guarded as a class: they are exactly where an unbounded remote-call loop lives. */
export const MCP_TOOL_PREFIX = 'mcp__';
/** Whether the M7 guards act on this tool at all. */
export function isGuardedToolName(toolName) {
    if (typeof toolName !== 'string')
        return false;
    return GUARDED_TOOL_NAMES.has(toolName) || toolName.startsWith(MCP_TOOL_PREFIX);
}
/** Claude Code write tools the read-before-write gate covers. */
export const GATED_WRITE_TOOL_NAMES = new Set(['Write', 'Edit']);
/** Claude Code read tool the mark stamper covers. */
export const READ_TOOL_NAME = 'Read';
/** The native read tool the block message should tell the model to call. */
export const NATIVE_READ_TOOL_NAME = 'Read';
function stringField(input, key) {
    const value = input[key];
    return typeof value === 'string' ? value : undefined;
}
function numberField(input, key) {
    const value = input[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
/** Drop `undefined` entries so the canonical JSON matches what the original would have hashed. */
function compact(args) {
    const out = {};
    for (const [key, value] of Object.entries(args)) {
        if (value !== undefined)
            out[key] = value;
    }
    return out;
}
/**
 * Map one Claude Code tool call onto the `{name, args}` shape the detector's key rules understand.
 *
 * `Read`'s `offset`/`limit` become `start_line`/`end_line` so the 200-line bucketing survives:
 * DeerFlow's `read_file` took an inclusive line RANGE, Claude Code's `Read` takes a start plus a
 * count, so `end_line = offset + limit - 1`. With neither field present the call is the whole file,
 * which is what `start_line=1, end_line=1` already encodes in bucket 0.
 *
 * An MCP tool keeps its own name and arguments: there is no DeerFlow counterpart to map onto, and
 * the salient-field rule already picks up whichever of `path/url/query/command/pattern` it uses.
 */
export function toDeerflowToolCall(toolName, toolInput) {
    const input = typeof toolInput === 'object' && toolInput !== null && !Array.isArray(toolInput)
        ? toolInput
        : {};
    switch (toolName) {
        case 'Read': {
            const offset = numberField(input, 'offset');
            const limit = numberField(input, 'limit');
            return {
                name: 'read_file',
                args: compact({
                    path: stringField(input, 'file_path'),
                    start_line: offset,
                    end_line: offset !== undefined && limit !== undefined ? offset + limit - 1 : undefined,
                }),
            };
        }
        case 'Write':
            return {
                name: 'write_file',
                args: compact({ path: stringField(input, 'file_path'), content: stringField(input, 'content') }),
            };
        case 'Edit':
            return {
                name: 'str_replace',
                args: compact({
                    path: stringField(input, 'file_path'),
                    old_str: stringField(input, 'old_string'),
                    new_str: stringField(input, 'new_string'),
                }),
            };
        case 'Bash':
            return { name: 'bash', args: compact({ command: stringField(input, 'command') }) };
        case 'Grep':
            return {
                name: 'grep',
                args: compact({
                    pattern: stringField(input, 'pattern'),
                    path: stringField(input, 'path'),
                    glob: stringField(input, 'glob'),
                }),
            };
        case 'Glob':
            return { name: 'glob', args: compact({ pattern: stringField(input, 'pattern'), path: stringField(input, 'path') }) };
        case 'WebFetch':
            return { name: 'web_fetch', args: compact({ url: stringField(input, 'url') }) };
        case 'WebSearch':
            return { name: 'web_search', args: compact({ query: stringField(input, 'query') }) };
        default:
            return { name: toolName, args: input };
    }
}
/**
 * The tool name the meta taxonomy should see.
 *
 * Only one name matters to it: `web_fetch` unlocks the HTTP-error-shell rule, and Claude Code's
 * fetch tool is `WebFetch`. Every other name is passed through unchanged — the taxonomy is
 * name-agnostic everywhere else.
 */
export function toDeerflowMetaToolName(toolName) {
    return toolName === 'WebFetch' ? 'web_fetch' : toolName;
}
