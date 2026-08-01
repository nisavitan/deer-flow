import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  RESPONSE_STYLE_SECTION,
  TODO_LIST_SYSTEM_SECTION,
  renderCriticalReminders,
  renderSubagentSection,
  renderWorkingDirectorySection,
} from './lead.js';

/**
 * skills/run/SKILL.md and skills/plan/SKILL.md must stay consistent with
 * src/prompts/lead.ts: the shared policy passages are emitted by lead.ts, so an
 * edit to lead.ts that is not mirrored into the skill bodies (or a hand-edit of
 * a generated block) fails here.
 */

const SKILLS_DIR = fileURLToPath(new URL('../../skills/', import.meta.url));

const RUN_SKILL = readFileSync(`${SKILLS_DIR}run/SKILL.md`, 'utf8');
const PLAN_SKILL = readFileSync(`${SKILLS_DIR}plan/SKILL.md`, 'utf8');

/** The delegation configuration the run skill advertises: 3 concurrent / 6 per run. */
const RUN_SKILL_SUBAGENTS = [{ name: 'general-purpose' }, { name: 'bash' }] as const;
const MAX_CONCURRENT = 3;
const MAX_TOTAL = 6;

function frontmatter(body: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(body);
  expect(match, 'SKILL.md must start with YAML frontmatter').toBeTruthy();
  const fields: Record<string, string> = {};
  for (const line of (match?.[1] ?? '').split('\n')) {
    const separator = line.indexOf(':');
    if (separator > 0) {
      fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
    }
  }
  return fields;
}

describe('skills/run/SKILL.md', () => {
  it('has frontmatter usable for auto-invocation and /deerflow:run', () => {
    const fields = frontmatter(RUN_SKILL);
    expect(fields.name).toBe('run');
    expect(fields.description).toBeTruthy();
    expect((fields.description ?? '').length).toBeLessThanOrEqual(1024);
    expect(fields.description).toContain('/deerflow:run');
  });

  it('carries no leftover M1 smoke stub', () => {
    expect(RUN_SKILL).not.toContain('DEERFLOW-M1-PONG');
    expect(RUN_SKILL).not.toContain('M1 smoke stub');
  });

  it('embeds the delegation policy exactly as lead.ts renders it (n>1 variant)', () => {
    const section = renderSubagentSection({
      maxConcurrentSubagents: MAX_CONCURRENT,
      maxTotalSubagents: MAX_TOTAL,
      subagents: RUN_SKILL_SUBAGENTS,
    });
    expect(RUN_SKILL).toContain(section);
    // The n>1 variant, with the caps stated as 3 concurrent / 6 total.
    expect(section).toContain('**Hard vetoes for parallel dispatch');
    expect(section).toContain('**MAXIMUM 3 `Agent` CALLS PER RESPONSE');
    expect(section).toContain('**MAXIMUM 6 `Agent` CALLS PER RUN');
  });

  it('embeds the outputs/ delivery contract exactly as lead.ts renders it', () => {
    expect(RUN_SKILL).toContain(renderWorkingDirectorySection());
    expect(RUN_SKILL).not.toContain('/mnt/user-data');
    expect(RUN_SKILL).not.toContain('present_files');
  });

  it('embeds the response style and critical reminders exactly as lead.ts renders them', () => {
    expect(RUN_SKILL).toContain(RESPONSE_STYLE_SECTION);
    expect(RUN_SKILL).toContain(
      renderCriticalReminders({
        subagentEnabled: true,
        maxConcurrentSubagents: MAX_CONCURRENT,
        maxTotalSubagents: MAX_TOTAL,
      }),
    );
  });

  it('embeds the todo discipline exactly as lead.ts renders it', () => {
    expect(RUN_SKILL).toContain(TODO_LIST_SYSTEM_SECTION);
    expect(TODO_LIST_SYSTEM_SECTION).toContain('`TaskCreate`');
    expect(TODO_LIST_SYSTEM_SECTION).toContain('`TaskUpdate`');
    expect(TODO_LIST_SYSTEM_SECTION).not.toContain('write_todos');
  });

  it('routes heavy multi-agent work through the deep-run workflow, not ad-hoc Agent calls', () => {
    expect(RUN_SKILL).toContain('deerflow:deep-run');
    expect(RUN_SKILL).toContain('Workflow tool');
    expect(RUN_SKILL).toContain('ad-hoc parallel Agent calls');
  });

  it('states the identity, goal command and terminal-response discipline', () => {
    expect(RUN_SKILL).toContain('You are DeerFlow 2.0, an open-source super agent');
    expect(RUN_SKILL).toContain('/deerflow:goal');
    expect(RUN_SKILL).toContain('Every turn MUST end with a visible response.');
  });
});

describe('skills/plan/SKILL.md', () => {
  it('has frontmatter usable for auto-invocation and /deerflow:plan', () => {
    const fields = frontmatter(PLAN_SKILL);
    expect(fields.name).toBe('plan');
    expect(fields.description).toBeTruthy();
    expect((fields.description ?? '').length).toBeLessThanOrEqual(1024);
    expect(fields.description).toContain('/deerflow:plan');
  });

  it('embeds the ported todo discipline exactly as lead.ts renders it', () => {
    expect(PLAN_SKILL).toContain(TODO_LIST_SYSTEM_SECTION);
  });

  it('reproduces DeerFlow plan-mode gating and defers the rest to the run policy', () => {
    expect(PLAN_SKILL).toContain('configurable.is_plan_mode');
    expect(PLAN_SKILL).toContain('/deerflow:run');
  });
});
