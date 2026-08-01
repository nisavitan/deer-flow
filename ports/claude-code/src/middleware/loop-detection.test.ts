// Parity suite G1 — replays parity/baseline/loop_detection.json against src/middleware/loop-detection.ts.
//
// The baseline README says to assert on the recorded equal/not_equal RELATION rather than the Python
// md5 literal, "unless the TS canonicalizer is proven byte-identical to json.dumps(..., sort_keys=True)".
// It is (src/middleware/python-json.ts), and this file is that proof: every recorded hash — 18 from
// `hash_relations` and one per scenario step — is asserted as a literal, and the relations are asserted
// on top. If the canonicalizer ever drifts, the literal assertions fail first and loudly.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_HARD_LIMIT,
  DEFAULT_LOOP_DETECTION_CONFIG,
  DEFAULT_TOOL_FREQ_HARD_LIMIT,
  DEFAULT_TOOL_FREQ_WARN,
  DEFAULT_WARN_THRESHOLD,
  DEFAULT_WINDOW_SIZE,
  EMPTY_LOOP_DETECTION_STATE,
  HARD_STOP_CONTENT_SEPARATOR,
  LOOP_STOP_REASON,
  hashToolCalls,
  parseLoopDetectionState,
  step,
  toolFrequencyWindowSize,
  type LoopDecision,
  type LoopToolCall,
} from './loop-detection.js'

interface BaselineStep {
  readonly step: number
  readonly tool_calls: LoopToolCall[]
  readonly call_hash: string
  readonly decision: LoopDecision
  readonly injected_message: string | null
  readonly stop_reason: string | null
  readonly hash_count_in_window: number
  readonly hash_window_length: number
  readonly tool_frequency_counts: Record<string, number>
}

interface BaselineFile {
  readonly config_defaults: Record<string, unknown>
  readonly hash_relations: {
    readonly name: string
    readonly relation: 'equal' | 'not_equal'
    readonly left: LoopToolCall[]
    readonly right: LoopToolCall[]
    readonly left_hash: string
    readonly right_hash: string
  }[]
  readonly scenarios: Record<string, { readonly description: string; readonly steps: BaselineStep[] }>
}

const BASELINE = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../parity/baseline/loop_detection.json', import.meta.url)), 'utf8'),
) as BaselineFile

describe('loop detection — config defaults (baseline config_defaults)', () => {
  it('matches every threshold the original engine reported', () => {
    expect(BASELINE.config_defaults['warn_threshold']).toBe(DEFAULT_WARN_THRESHOLD)
    expect(BASELINE.config_defaults['hard_limit']).toBe(DEFAULT_HARD_LIMIT)
    expect(BASELINE.config_defaults['window_size']).toBe(DEFAULT_WINDOW_SIZE)
    expect(BASELINE.config_defaults['tool_freq_warn']).toBe(DEFAULT_TOOL_FREQ_WARN)
    expect(BASELINE.config_defaults['tool_freq_hard_limit']).toBe(DEFAULT_TOOL_FREQ_HARD_LIMIT)
    expect(BASELINE.config_defaults['tool_freq_overrides']).toEqual({})
    expect(BASELINE.config_defaults['enabled']).toBe(true)
  })

  it('sizes the frequency window to the largest hard limit, never below it', () => {
    expect(toolFrequencyWindowSize(DEFAULT_LOOP_DETECTION_CONFIG)).toBe(DEFAULT_TOOL_FREQ_HARD_LIMIT)
    expect(
      toolFrequencyWindowSize({ ...DEFAULT_LOOP_DETECTION_CONFIG, toolFreqOverrides: { bash: [500, 1000] } }),
    ).toBe(1000)
    // Warn thresholds must NOT inflate the window (the original excludes them on purpose).
    expect(
      toolFrequencyWindowSize({ ...DEFAULT_LOOP_DETECTION_CONFIG, toolFreqOverrides: { bash: [900, 10] } }),
    ).toBe(DEFAULT_TOOL_FREQ_HARD_LIMIT)
  })
})

describe('loop detection — call-set hashing (baseline hash_relations)', () => {
  it.each(BASELINE.hash_relations.map((relation) => [relation.name, relation] as const))(
    '%s',
    (_name, relation) => {
      const left = hashToolCalls(relation.left)
      const right = hashToolCalls(relation.right)
      // Literal parity with the Python md5 the original produced.
      expect(left).toBe(relation.left_hash)
      expect(right).toBe(relation.right_hash)
      // And the relation the baseline README says is the portable claim.
      if (relation.relation === 'equal') expect(left).toBe(right)
      else expect(left).not.toBe(right)
    },
  )

  it('consumed every recorded relation', () => {
    expect(BASELINE.hash_relations).toHaveLength(9)
  })
})

const SCENARIO_NAMES = Object.keys(BASELINE.scenarios).sort()

describe('loop detection — scenario replay (baseline scenarios)', () => {
  it.each(SCENARIO_NAMES)('%s', (scenarioName) => {
    const scenario = BASELINE.scenarios[scenarioName]
    expect(scenario, `scenario ${scenarioName} missing`).toBeDefined()
    const steps = scenario?.steps ?? []

    let state = EMPTY_LOOP_DETECTION_STATE
    const actualDecisions: LoopDecision[] = []
    const expectedDecisions: LoopDecision[] = []

    for (const expected of steps) {
      const result = step(state, expected.tool_calls)
      state = result.state

      actualDecisions.push(result.decision)
      expectedDecisions.push(expected.decision)

      const where = `${scenarioName} step ${expected.step}`
      expect(result.callHash, `${where}: call hash`).toBe(expected.call_hash)
      expect(result.decision, `${where}: decision`).toBe(expected.decision)
      expect(result.hashCount, `${where}: hash count`).toBe(expected.hash_count_in_window)
      expect(state.hashWindow.length, `${where}: window length`).toBe(expected.hash_window_length)
      expect(result.toolFrequencyCounts, `${where}: frequency counts`).toEqual(expected.tool_frequency_counts)
      expect(result.stopReason, `${where}: stop reason`).toBe(expected.stop_reason)

      // Message text. A hard stop's recorded `injected_message` is the REWRITTEN AIMessage content:
      // `_append_text` joined the (empty) original content to the stop text with two newlines.
      if (expected.decision === 'none') {
        expect(result.message, `${where}: message`).toBeNull()
        expect(expected.injected_message, `${where}: baseline message`).toBeNull()
      } else if (expected.decision === 'hard_stop') {
        expect(`${HARD_STOP_CONTENT_SEPARATOR}${result.message}`, `${where}: message`).toBe(
          expected.injected_message,
        )
        expect(result.stopReason).toBe(LOOP_STOP_REASON)
      } else {
        expect(result.message, `${where}: message`).toBe(expected.injected_message)
      }
    }

    // The decision SEQUENCE as a whole, not just per-step: an off-by-one that shifts every
    // decision one step later would still pass the per-step loop if it also shifted the vectors.
    expect(actualDecisions).toEqual(expectedDecisions)
  })

  it('consumed all 6 scenarios and all 99 recorded steps', () => {
    expect(SCENARIO_NAMES).toHaveLength(6)
    const total = SCENARIO_NAMES.reduce((sum, name) => sum + (BASELINE.scenarios[name]?.steps.length ?? 0), 0)
    expect(total).toBe(99)
  })
})

describe('loop detection — port-side behaviour the vectors do not cover', () => {
  it('treats an empty tool-call list as a no-op', () => {
    const result = step(EMPTY_LOOP_DETECTION_STATE, [])
    expect(result.decision).toBe('none')
    expect(result.callHash).toBeNull()
    expect(result.state).toEqual(EMPTY_LOOP_DETECTION_STATE)
  })

  it('warns only once per hash while that hash stays in the window', () => {
    const call: LoopToolCall[] = [{ name: 'grep', args: { pattern: 'x', path: '/s' } }]
    let state = EMPTY_LOOP_DETECTION_STATE
    const decisions: LoopDecision[] = []
    for (let index = 0; index < 4; index += 1) {
      const result = step(state, call)
      state = result.state
      decisions.push(result.decision)
    }
    expect(decisions).toEqual(['none', 'none', 'warn', 'none'])
  })

  it('applies a per-tool frequency override instead of the global thresholds', () => {
    const config = { ...DEFAULT_LOOP_DETECTION_CONFIG, toolFreqOverrides: { bash: [2, 3] as const } }
    let state = EMPTY_LOOP_DETECTION_STATE
    const decisions: LoopDecision[] = []
    for (let index = 0; index < 3; index += 1) {
      // Distinct commands so Layer 1 never fires and Layer 2 is the only decision-maker.
      const result = step(state, [{ name: 'bash', args: { command: `echo ${index}` } }], config)
      state = result.state
      decisions.push(result.decision)
    }
    expect(decisions).toEqual(['none', 'warn', 'hard_stop'])
  })

  it('survives a corrupt or foreign state file instead of throwing', () => {
    expect(parseLoopDetectionState(null)).toEqual(EMPTY_LOOP_DETECTION_STATE)
    expect(parseLoopDetectionState('nonsense')).toEqual(EMPTY_LOOP_DETECTION_STATE)
    expect(parseLoopDetectionState({ hashWindow: [1, 'a', null], warnedHashes: 'x' })).toEqual({
      ...EMPTY_LOOP_DETECTION_STATE,
      hashWindow: ['a'],
    })
  })

  it('round-trips its state through JSON unchanged', () => {
    const result = step(EMPTY_LOOP_DETECTION_STATE, [{ name: 'grep', args: { pattern: 'x' } }])
    expect(parseLoopDetectionState(JSON.parse(JSON.stringify(result.state)))).toEqual(result.state)
  })
})
