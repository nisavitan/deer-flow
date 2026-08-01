// DeerFlow deep-run orchestration core — M1 stub.
// M6 replaces the body with the structural translation of
// backend/packages/harness/deerflow/subagents/executor.py (_aexecute) and
// tools/builtins/task_tool.py semantics @ 0950924.
export const meta = {
  name: 'deep-run',
  description: 'DeerFlow deterministic delegation engine (M1 smoke stub)',
  phases: [{ title: 'Probe' }],
}

phase('Probe')
const probe = await agent('Reply with exactly the text: DEEP-RUN-M1-OK', {
  label: 'probe',
  schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  effort: 'low',
})
return { deep_run_stub: probe ? probe.text : null, milestone: 'M1' }
