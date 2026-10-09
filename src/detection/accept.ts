/**
 * Turning accepted suggestions into Annotations (pure). The editor wraps the
 * result in ONE applyBatch of `add` ops together with storing `run` in the
 * image's `detectionRuns`, so accepting a batch is a single undo step.
 */
import type { Annotation, DetectionRun, ID } from '../model/types.ts'
import type { Suggestion } from './types.ts'

export interface AcceptOptions {
  /** Group the new annotations go to (normally run.targetGroupId). */
  groupId: ID
  run: DetectionRun
  /** ISO timestamp used for createdAt/updatedAt/reviewedAt. */
  at: string
  newId: () => ID
}

/**
 * origin 'automated' (immutable), reviewStatus 'accepted' (a person accepted it),
 * geometry from the fit, detector provenance with confidence null (scores are not
 * probabilities).
 */
export function suggestionsToAnnotations(suggestions: readonly Suggestion[], opts: AcceptOptions): Annotation[] {
  return suggestions.map((s) => ({
    id: opts.newId(),
    x: s.x,
    y: s.y,
    groupId: opts.groupId,
    origin: 'automated',
    createdAt: opts.at,
    updatedAt: opts.at,
    reviewStatus: 'accepted',
    reviewedAt: opts.at,
    lastEditSource: 'automated',
    manuallyAdjusted: false,
    detector: {
      name: opts.run.method,
      version: opts.run.version,
      runId: opts.run.runId,
      params: { clusterId: s.clusterId, ...(s.score !== null ? { score: s.score } : {}), status: s.status },
      confidence: null,
    },
    geometry: { kind: 'circle', r: Math.round(s.r * 100) / 100, source: 'fit' },
  }))
}
