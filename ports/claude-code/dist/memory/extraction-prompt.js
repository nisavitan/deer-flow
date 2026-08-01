// Renders the extraction request from the VERBATIM upstream prompt assets in
// `prompts/memory/*.yaml` (see prompts/memory/ATTRIBUTION.md).
//
// The templates stay byte-identical to DeerFlow's, so this module owns only the two mechanical
// jobs the Python side got from `str.format` + PyYAML:
//   1. parse the (deliberately simple) YAML shape those four files use;
//   2. substitute `{placeholder}` tokens and unescape `{{` / `}}` into literal braces.
//
// No YAML dependency: the port's package.json carries only typescript + vitest, and a general
// YAML parser is far more surface than these files need. The parser below therefore accepts
// exactly the shapes present in the assets and REJECTS anything else, so an unexpected upstream
// edit fails loudly instead of being silently mis-parsed:
//   * top-level `key: scalar`
//   * top-level `key: |-` block scalar
//   * `messages:` -> a list of `- role: <scalar>` / `content: |-` entries
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
/** Filenames of the four copied assets. */
export const MEMORY_PROMPT_FILES = {
    memoryUpdate: 'memory_update.chat.yaml',
    stalenessReview: 'staleness_review.yaml',
    consolidation: 'consolidation.yaml',
    factExtraction: 'fact_extraction.yaml',
};
/** Raised when a prompt asset does not match the shape this parser accepts. */
export class PromptTemplateError extends Error {
    filePath;
    detail;
    name = 'PromptTemplateError';
    constructor(filePath, detail) {
        super(`Invalid memory prompt template ${filePath}: ${detail}`);
        this.filePath = filePath;
        this.detail = detail;
    }
}
/**
 * Plugin root: `CLAUDE_PLUGIN_ROOT` when the harness supplies it, else two levels up from this
 * module (`dist/memory/…` and `src/memory/…` are both two deep, so the same walk serves the
 * compiled build and the vitest run).
 */
export function resolvePluginRoot(env = process.env) {
    const configured = env['CLAUDE_PLUGIN_ROOT'];
    if (configured !== undefined && configured !== '')
        return configured;
    return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}
/** `<plugin-root>/prompts/memory`. */
export function memoryPromptsDir(env) {
    return join(resolvePluginRoot(env), 'prompts', 'memory');
}
function stripBlockScalar(lines, startIndex, baseIndent) {
    const collected = [];
    let index = startIndex;
    let contentIndent = null;
    for (; index < lines.length; index += 1) {
        const line = lines[index] ?? '';
        if (line.trim() === '') {
            collected.push('');
            continue;
        }
        const indent = line.length - line.trimStart().length;
        if (indent <= baseIndent)
            break;
        if (contentIndent === null)
            contentIndent = indent;
        collected.push(line.slice(contentIndent));
    }
    // `|-` strips the trailing newline and any trailing blank lines.
    while (collected.length > 0 && (collected[collected.length - 1] ?? '').trim() === '')
        collected.pop();
    return { text: collected.join('\n'), nextIndex: index };
}
function unquote(raw) {
    const value = raw.trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
        return value.slice(1, -1);
    }
    return value;
}
/** Parse one of the four assets. Throws {@link PromptTemplateError} on any unexpected shape. */
export function parsePromptTemplate(text, filePath) {
    const lines = text.split('\n');
    let format;
    let version;
    let template;
    let messages;
    let index = 0;
    while (index < lines.length) {
        const line = lines[index] ?? '';
        if (line.trim() === '' || line.trimStart().startsWith('#')) {
            index += 1;
            continue;
        }
        if (line.startsWith(' '))
            throw new PromptTemplateError(filePath, `unexpected indentation at line ${index + 1}`);
        const colon = line.indexOf(':');
        if (colon === -1)
            throw new PromptTemplateError(filePath, `line ${index + 1} is not a mapping`);
        const key = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();
        if (key === 'format' || key === 'version') {
            if (key === 'format')
                format = unquote(value);
            else
                version = unquote(value);
            index += 1;
            continue;
        }
        if (key === 'template') {
            if (value !== '|-')
                throw new PromptTemplateError(filePath, `template must use the '|-' block scalar, found ${JSON.stringify(value)}`);
            const block = stripBlockScalar(lines, index + 1, 0);
            template = block.text;
            index = block.nextIndex;
            continue;
        }
        if (key === 'messages') {
            if (value !== '')
                throw new PromptTemplateError(filePath, 'messages must be a block list');
            const parsed = [];
            index += 1;
            while (index < lines.length) {
                const entry = lines[index] ?? '';
                if (entry.trim() === '') {
                    index += 1;
                    continue;
                }
                if (!entry.startsWith('  - '))
                    break;
                const roleLine = entry.slice(4).trim();
                if (!roleLine.startsWith('role:'))
                    throw new PromptTemplateError(filePath, `message entry at line ${index + 1} must start with 'role:'`);
                const role = unquote(roleLine.slice('role:'.length));
                index += 1;
                const contentLine = (lines[index] ?? '').trim();
                if (!contentLine.startsWith('content:'))
                    throw new PromptTemplateError(filePath, `message at line ${index + 1} is missing 'content:'`);
                if (unquote(contentLine.slice('content:'.length)) !== '|-') {
                    throw new PromptTemplateError(filePath, `message content must use the '|-' block scalar at line ${index + 1}`);
                }
                const block = stripBlockScalar(lines, index + 1, 4);
                parsed.push({ role, content: block.text });
                index = block.nextIndex;
            }
            messages = parsed;
            continue;
        }
        throw new PromptTemplateError(filePath, `unsupported top-level key ${JSON.stringify(key)}`);
    }
    if (format === undefined)
        throw new PromptTemplateError(filePath, "missing 'format'");
    if (version === undefined)
        throw new PromptTemplateError(filePath, "missing 'version'");
    if (format === 'chat' && (messages === undefined || messages.length === 0))
        throw new PromptTemplateError(filePath, "format: chat requires non-empty 'messages'");
    if (format === 'text' && template === undefined)
        throw new PromptTemplateError(filePath, "format: text requires 'template'");
    return {
        format,
        version,
        ...(template === undefined ? {} : { template }),
        ...(messages === undefined ? {} : { messages }),
    };
}
/** Load and parse one asset from the plugin's `prompts/memory` directory. */
export function loadPromptTemplate(fileName, env) {
    const path = join(memoryPromptsDir(env), fileName);
    return parsePromptTemplate(readFileSync(path, 'utf8'), path);
}
/**
 * Apply Python `str.format` semantics to a template.
 *
 * `{{` and `}}` are escaped literal braces (the output-JSON skeleton in the system prompt is
 * written that way); every remaining `{name}` is a substitution point. Names absent from
 * *values* render as the empty string, which is how the upstream call site passes an inactive
 * `{staleness_review_section}` / `{consolidation_section}`.
 */
export function renderTemplate(template, values) {
    let output = '';
    let index = 0;
    while (index < template.length) {
        const character = template[index] ?? '';
        if (character === '{') {
            if (template[index + 1] === '{') {
                output += '{';
                index += 2;
                continue;
            }
            const close = template.indexOf('}', index + 1);
            if (close === -1) {
                output += character;
                index += 1;
                continue;
            }
            const name = template.slice(index + 1, close);
            output += values[name] ?? '';
            index = close + 1;
            continue;
        }
        if (character === '}' && template[index + 1] === '}') {
            output += '}';
            index += 2;
            continue;
        }
        output += character;
        index += 1;
    }
    return output;
}
/**
 * Render the extraction request from the verbatim `memory_update.chat.yaml`.
 *
 * The system message carries no placeholders (only escaped `{{`/`}}` braces), so it renders
 * to the upstream text byte-for-byte; only the user message is substituted.
 */
export function renderExtractionRequest(input, env) {
    const parsed = loadPromptTemplate(MEMORY_PROMPT_FILES.memoryUpdate, env);
    const values = {
        current_memory: input.currentMemory,
        conversation: input.conversation,
        correction_hint: input.correctionHint ?? '',
        staleness_review_section: input.stalenessReviewSection ?? '',
        consolidation_section: input.consolidationSection ?? '',
    };
    return (parsed.messages ?? []).map((message) => ({ role: message.role, content: renderTemplate(message.content, values) }));
}
/** Render `staleness_review.yaml` with the aged-candidate block. */
export function renderStalenessReviewSection(staleFacts, env) {
    const parsed = loadPromptTemplate(MEMORY_PROMPT_FILES.stalenessReview, env);
    return renderTemplate(parsed.template ?? '', { stale_facts: staleFacts });
}
/** Render `consolidation.yaml` with the fragmented-category groups. */
export function renderConsolidationSection(consolidationGroups, maxGroups, env) {
    const parsed = loadPromptTemplate(MEMORY_PROMPT_FILES.consolidation, env);
    return renderTemplate(parsed.template ?? '', { consolidation_groups: consolidationGroups, max_groups: String(maxGroups) });
}
