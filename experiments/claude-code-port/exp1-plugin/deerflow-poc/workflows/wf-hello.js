export const meta = {
  name: 'wf-hello',
  description: 'Proof: a workflow packaged inside a plugin, spawning one agent',
  phases: [{ title: 'Probe' }],
}

phase('Probe')
const r = await agent('Reply with exactly the text: WF-IN-PLUGIN-OK', {
  label: 'probe',
  schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  model: 'haiku',
  effort: 'low',
})
return { workflow_from_plugin: r ? r.text : null }
