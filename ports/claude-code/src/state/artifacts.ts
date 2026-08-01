// Ported from backend/packages/harness/deerflow/agents/thread_state.py:merge_artifacts @ 0950924 — mechanical TypeScript translation
// Parity vectors: parity/baseline/state_reducers.json -> merge_artifacts.
import { threadStateFile } from './paths.js'
import { updateStateFile, type StateEnvelope, type UpdateOptions } from './atomic-io.js'

/** File name of the presented-artifacts channel. */
export const ARTIFACTS_FILE = 'artifacts.json'

export interface ArtifactsPayload {
  artifacts: string[]
  [key: string]: unknown
}

/**
 * Reducer for the artifacts list: merge and deduplicate preserving first-seen order.
 *
 * A `null` update preserves the existing list; an empty list is a no-op merge (not a clear).
 */
export function mergeArtifacts(
  existing: readonly string[] | null | undefined,
  incoming: readonly string[] | null | undefined,
): string[] {
  if (existing === null || existing === undefined) return incoming ? [...incoming] : []
  if (incoming === null || incoming === undefined) return [...existing]
  return [...new Set([...existing, ...incoming])]
}

/** Absolute path of a thread's `artifacts.json`. */
export function artifactsPath(threadId: string, env?: NodeJS.ProcessEnv): string {
  return threadStateFile(threadId, ARTIFACTS_FILE, env)
}

/** Apply an artifacts write under atomic-write + `rev` CAS. */
export function applyArtifacts(
  filePath: string,
  incoming: readonly string[] | null,
  options: UpdateOptions,
): StateEnvelope<ArtifactsPayload> {
  return updateStateFile<ArtifactsPayload>(
    filePath,
    (current) => ({ artifacts: mergeArtifacts(current?.artifacts ?? null, incoming) }),
    options,
  )
}
