/**
 * Assisted counting: the pending-suggestion layer and its review rules (pure).
 *
 * A detector run produces suggestions. They live in a SuggestionLayer: one per
 * image, in memory only. A layer is never part of an annotation document, never
 * counted, never saved and never in undo history. What is still pending is
 * DERIVED from the layer plus the image's current annotations:
 *
 *  - a suggestion is *covered* when a current annotation (any group) sits on it
 *    (accepted, or marked by hand since the run) and is no longer shown;
 *  - a cluster is *resolved* when current annotations carry one of this layer's
 *    accept run ids and that cluster id (so undoing an accept brings the
 *    cluster back as pending, and redo resolves it again);
 *  - rejections are the only review state kept in the layer.
 *
 * Accepting returns the ops and the DetectionRun for ONE editor.applyBatch, so
 * a batch accept is one undo step and undo also removes the run record.
 */
import type { Annotation, DetectionRun, ID } from '../../model/types'
import type { AnnotationOp } from '../../model/annotations'
import type { ClusterResult, DetectMethod, DetectResult, Suggestion } from '../../detection/types'
import { suggestionsToAnnotations } from '../../detection/accept'

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** The knobs offered in the review panel. */
export interface ReviewSettings {
  method: DetectMethod
  /** 0..1, higher = more suggestions. */
  sensitivity: number
  /** Size tolerance: multiplier on the seed-derived radius spread. */
  priorWidth: number
}

export const DEFAULT_REVIEW_SETTINGS: ReviewSettings = { method: 'fitter', sensitivity: 0.5, priorWidth: 1 }

/** A suggestion within this fraction of its radius of an existing annotation is the same colony. */
export const COVER_FRACTION = 0.7

// ---------------------------------------------------------------------------
// The layer and the per-image store
// ---------------------------------------------------------------------------

/** The parts of a DetectResult the review needs (no rasters). */
export type LayerResult = Pick<DetectResult, 'method' | 'suggestions' | 'clusters' | 'calibration' | 'roi' | 'run' | 'timingsMs'>

export interface SuggestionLayer {
  imageId: ID
  /** ImageRecord.fingerprint of the analysed bytes (the run record is only valid for these). */
  imageFingerprint: string
  /** Annotation group the suggestions are for (the active group when the run started). */
  groupId: ID
  result: LayerResult
  settings: ReviewSettings
  /** Reference image the examples came from, with its fingerprint (cross-plate seeds). */
  reference: { imageId: ID; fingerprint: string } | null
  /** Indices into result.suggestions the user rejected. */
  rejected: ReadonlySet<number>
  /** Run ids issued for accepts from this layer (one per accept batch). */
  acceptRunIds: readonly ID[]
  /** Wall-clock time of the run as seen by the UI, in ms (includes decoding). */
  elapsedMs: number
}

export function makeLayer(
  args: Omit<SuggestionLayer, 'rejected' | 'acceptRunIds'> & { rejected?: ReadonlySet<number> },
): SuggestionLayer {
  return { ...args, result: stripResult(args.result), rejected: args.rejected ?? new Set(), acceptRunIds: [] }
}

function stripResult(r: LayerResult): LayerResult {
  return { method: r.method, suggestions: r.suggestions, clusters: r.clusters, calibration: r.calibration, roi: r.roi, run: r.run, timingsMs: r.timingsMs }
}

/** In-memory suggestion layers keyed by image id (immutable: every change returns a new map). */
export type SuggestionStore = ReadonlyMap<ID, SuggestionLayer>

export const emptyStore = (): SuggestionStore => new Map()

export function putLayer(store: SuggestionStore, layer: SuggestionLayer): SuggestionStore {
  const next = new Map(store)
  next.set(layer.imageId, layer)
  return next
}

export function dropLayer(store: SuggestionStore, imageId: ID): SuggestionStore {
  if (!store.has(imageId)) return store
  const next = new Map(store)
  next.delete(imageId)
  return next
}

export function updateLayer(store: SuggestionStore, imageId: ID, fn: (l: SuggestionLayer) => SuggestionLayer): SuggestionStore {
  const layer = store.get(imageId)
  return layer ? putLayer(store, fn(layer)) : store
}

/**
 * Drop layers that can no longer be trusted: the image left the project, its
 * bytes no longer match (sourceMismatch), or the target group was deleted.
 */
export function pruneStore(
  store: SuggestionStore,
  images: readonly { id: ID; fingerprint: string; sourceMismatch?: unknown }[],
  groupIds: readonly ID[],
): SuggestionStore {
  let next = store
  for (const [imageId, layer] of store) {
    const image = images.find((i) => i.id === imageId)
    const stale = !image || !!image.sourceMismatch || image.fingerprint !== layer.imageFingerprint || !groupIds.includes(layer.groupId)
    if (stale) next = dropLayer(next, imageId)
  }
  return next
}

export function toggleRejected(layer: SuggestionLayer, index: number): SuggestionLayer {
  if (index < 0 || index >= layer.result.suggestions.length) return layer
  const rejected = new Set(layer.rejected)
  if (rejected.has(index)) rejected.delete(index)
  else rejected.add(index)
  return { ...layer, rejected }
}

/**
 * Carry rejections over to a re-run (slider change): a new suggestion within
 * COVER_FRACTION of a previously rejected one's radius stays rejected.
 */
export function carryRejections(prev: SuggestionLayer | undefined, next: readonly Suggestion[]): Set<number> {
  const out = new Set<number>()
  if (!prev || prev.rejected.size === 0) return out
  const old = [...prev.rejected].map((i) => prev.result.suggestions[i]).filter(Boolean)
  next.forEach((s, i) => {
    if (old.some((o) => Math.hypot(o.x - s.x, o.y - s.y) < COVER_FRACTION * Math.max(o.r, s.r))) out.add(i)
  })
  return out
}

// ---------------------------------------------------------------------------
// Derived review state
// ---------------------------------------------------------------------------

/** Display state of a pending suggestion. */
export type PendingState = 'ok' | 'review' | 'rejected'

export interface PendingMark {
  /** Index into layer.result.suggestions. */
  index: number
  x: number
  y: number
  r: number
  state: PendingState
}

/** A cluster that needs a person's decision ("2 or 3?"). */
export interface ReviewCluster {
  clusterId: string
  /** [x, y, w, h] in original px. */
  bbox: [number, number, number, number]
  /** Pending, non-rejected suggestion indices of the detector's chosen explanation. */
  primary: number[]
  /** Rejected suggestion indices in this cluster. */
  rejected: number[]
  /** The runner-up explanation (new colonies only), when the detector produced one. */
  alternative: { k: number; colonies: { x: number; y: number; r: number }[] } | null
  /** Short question for the chip, e.g. "2 or 3?". */
  question: string
}

export interface PendingView {
  marks: PendingMark[]
  /** Pending, non-rejected suggestions outside review clusters ("Accept all OK"). */
  okIndices: number[]
  reviewClusters: ReviewCluster[]
  /** Regions too dense to fit: count by hand. */
  tooLarge: ClusterResult[]
  /** Pending, non-rejected suggestions (ok + review). Never a confirmed count. */
  suggested: number
  /** Pending, non-rejected suggestions inside review clusters. */
  needReview: number
  rejected: number
}

/** Uniform grid over annotation positions for cover queries. */
function annotationGrid(annotations: readonly Annotation[], cell: number) {
  const grid = new Map<string, Annotation[]>()
  for (const a of annotations) {
    const k = `${Math.floor(a.x / cell)},${Math.floor(a.y / cell)}`
    let list = grid.get(k)
    if (!list) grid.set(k, (list = []))
    list.push(a)
  }
  return {
    near(x: number, y: number, radius: number): Annotation | null {
      const x0 = Math.floor((x - radius) / cell)
      const x1 = Math.floor((x + radius) / cell)
      const y0 = Math.floor((y - radius) / cell)
      const y1 = Math.floor((y + radius) / cell)
      for (let cy = y0; cy <= y1; cy++)
        for (let cx = x0; cx <= x1; cx++)
          for (const a of grid.get(`${cx},${cy}`) ?? []) if (Math.hypot(a.x - x, a.y - y) < radius) return a
      return null
    },
  }
}

const maxRadius = (list: readonly { r: number }[]) => list.reduce((m, s) => Math.max(m, s.r), 1)

/** Is this candidate colony already marked by an annotation? */
export function coverChecker(annotations: readonly Annotation[], typicalR: number) {
  const grid = annotationGrid(annotations, Math.max(8, typicalR * 2))
  return (x: number, y: number, r: number) => grid.near(x, y, COVER_FRACTION * r) !== null
}

/** Cluster ids already accepted from this layer (derived from the current annotations). */
export function resolvedClusters(layer: SuggestionLayer, annotations: readonly Annotation[]): Set<string> {
  const out = new Set<string>()
  if (layer.acceptRunIds.length === 0) return out
  const runs = new Set(layer.acceptRunIds)
  for (const a of annotations) {
    const d = a.detector
    if (d && runs.has(d.runId) && typeof d.params?.clusterId === 'string') out.add(d.params.clusterId)
  }
  return out
}

function question(chosen: number, alt: number | null): string {
  // Nothing new proposed, but the runner-up adds colonies next to marked ones.
  if (chosen === 0 && alt) return alt === 1 ? 'One more?' : `${alt} more?`
  if (alt === null || alt === chosen) return chosen === 1 ? 'Colony?' : `${chosen} colonies?`
  const [a, b] = chosen < alt ? [chosen, alt] : [alt, chosen]
  return `${a} or ${b}?`
}

/**
 * What is still pending on the image, given its CURRENT annotations. Review
 * clusters are clusters the detector flagged, plus any cluster holding a
 * suggestion flagged on its own.
 */
export function pendingView(layer: SuggestionLayer, annotations: readonly Annotation[]): PendingView {
  const { suggestions, clusters } = layer.result
  const covered = coverChecker(annotations, maxRadius(suggestions))
  const resolved = resolvedClusters(layer, annotations)
  const clusterById = new Map(clusters.map((c) => [c.clusterId, c]))
  const reviewIds = new Set(clusters.filter((c) => c.status === 'review').map((c) => c.clusterId))
  for (const s of suggestions) if (s.status === 'review') reviewIds.add(s.clusterId)

  const marks: PendingMark[] = []
  const okIndices: number[] = []
  const byCluster = new Map<string, { primary: number[]; rejected: number[] }>()
  let rejectedCount = 0
  suggestions.forEach((s, index) => {
    if (resolved.has(s.clusterId) || covered(s.x, s.y, s.r)) return
    const inReview = reviewIds.has(s.clusterId)
    const isRejected = layer.rejected.has(index)
    marks.push({ index, x: s.x, y: s.y, r: s.r, state: isRejected ? 'rejected' : inReview ? 'review' : 'ok' })
    if (isRejected) rejectedCount++
    if (inReview) {
      let e = byCluster.get(s.clusterId)
      if (!e) byCluster.set(s.clusterId, (e = { primary: [], rejected: [] }))
      ;(isRejected ? e.rejected : e.primary).push(index)
    } else if (!isRejected) okIndices.push(index)
  })

  const reviewClusters: ReviewCluster[] = []
  for (const id of reviewIds) {
    if (resolved.has(id)) continue
    const c = clusterById.get(id)
    const e = byCluster.get(id) ?? { primary: [], rejected: [] }
    const alt = c?.alternative && c.alternative.colonies.length > 0 ? c.alternative : null
    // Nothing left to decide: every suggestion here is covered and there is no alternative.
    if (e.primary.length === 0 && e.rejected.length === 0 && !alt) continue
    const pts = e.primary.concat(e.rejected).map((i) => suggestions[i])
    reviewClusters.push({
      clusterId: id,
      bbox: c?.bbox ?? bboxOf(pts),
      primary: e.primary,
      rejected: e.rejected,
      alternative: alt ? { k: alt.k, colonies: alt.colonies } : null,
      question: question(e.primary.length, alt ? alt.colonies.length : null),
    })
  }
  // Reading order (top to bottom, then left to right) for next/previous navigation.
  reviewClusters.sort((a, b) => a.bbox[1] + a.bbox[3] / 2 - (b.bbox[1] + b.bbox[3] / 2) || a.bbox[0] - b.bbox[0])

  const needReview = reviewClusters.reduce((n, c) => n + c.primary.length, 0)
  return {
    marks,
    okIndices,
    reviewClusters,
    tooLarge: clusters.filter((c) => c.status === 'too-large' && !resolved.has(c.clusterId)),
    suggested: okIndices.length + needReview,
    needReview,
    rejected: rejectedCount,
  }
}

function bboxOf(pts: readonly { x: number; y: number; r: number }[]): [number, number, number, number] {
  if (pts.length === 0) return [0, 0, 0, 0]
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const p of pts) {
    x0 = Math.min(x0, p.x - p.r)
    y0 = Math.min(y0, p.y - p.r)
    x1 = Math.max(x1, p.x + p.r)
    y1 = Math.max(y1, p.y + p.r)
  }
  return [x0, y0, x1 - x0, y1 - y0]
}

// ---------------------------------------------------------------------------
// Accept
// ---------------------------------------------------------------------------

/** Which suggestions an accept takes. */
export type AcceptScope =
  | { kind: 'ok' }
  /** One review cluster: the detector's choice or the runner-up count. */
  | { kind: 'cluster'; clusterId: string; choice: 'primary' | 'alternative' }

export interface AcceptPlan {
  ops: AnnotationOp[]
  annotations: Annotation[]
  run: DetectionRun
  /** Suggestions dropped because an annotation already sits on them. */
  duplicates: number
  /** Cluster ids covered by this accept (for navigation). */
  clusterIds: string[]
}

export interface AcceptContext {
  /** Current annotations of the image (all groups, any state). */
  annotations: readonly Annotation[]
  image: { id: ID; fingerprint: string }
  runId: ID
  at: string
  newId: () => ID
}

/**
 * Turn a scope into ONE batch: the new annotations (origin automated, accepted,
 * fitted circle, provenance) and the run record (image + seed fingerprints,
 * negatives = rejected suggestions in scope). Never re-adds a colony that is
 * already marked: candidates are checked against the current annotations and
 * against each other. Returns null when the scope is empty.
 */
export function planAccept(layer: SuggestionLayer, view: PendingView, scope: AcceptScope, ctx: AcceptContext): AcceptPlan | null {
  const all = layer.result.suggestions
  let picked: Suggestion[]
  let negatives: { x: number; y: number }[]
  let clusterIds: string[]
  if (scope.kind === 'ok') {
    picked = view.okIndices.map((i) => all[i])
    clusterIds = [...new Set(picked.map((s) => s.clusterId))]
    // Rejections outside review clusters are decisions on the same "OK" set.
    const inReview = new Set(view.reviewClusters.flatMap((c) => c.rejected))
    negatives = view.marks.filter((m) => m.state === 'rejected' && !inReview.has(m.index)).map((m) => ({ x: m.x, y: m.y }))
  } else {
    const c = view.reviewClusters.find((rc) => rc.clusterId === scope.clusterId)
    if (!c) return null
    clusterIds = [c.clusterId]
    negatives = c.rejected.map((i) => ({ x: all[i].x, y: all[i].y }))
    if (scope.choice === 'primary') picked = c.primary.map((i) => all[i])
    else {
      if (!c.alternative) return null
      picked = c.alternative.colonies.map((p) => ({ ...p, score: null, clusterId: c.clusterId, status: 'review' as const }))
      // The alternative replaces the detector's choice: record the choice as a review decision.
      negatives = negatives.concat(
        c.primary.map((i) => all[i]).filter((s) => !picked.some((p) => Math.hypot(p.x - s.x, p.y - s.y) < COVER_FRACTION * s.r)).map((s) => ({ x: s.x, y: s.y })),
      )
    }
  }
  const covered = coverChecker(ctx.annotations, maxRadius(picked))
  const kept: Suggestion[] = []
  for (const s of picked) {
    if (covered(s.x, s.y, s.r)) continue
    if (kept.some((k) => Math.hypot(k.x - s.x, k.y - s.y) < COVER_FRACTION * Math.max(k.r, s.r))) continue
    kept.push(s)
  }
  if (kept.length === 0) return null
  const base = layer.result.run
  const run: DetectionRun = {
    ...structuredClone(base),
    runId: ctx.runId,
    createdAt: ctx.at,
    imageFingerprint: ctx.image.fingerprint,
    ...(layer.reference ? { seedImageFingerprints: { [layer.reference.imageId]: layer.reference.fingerprint } } : {}),
    targetGroupId: layer.groupId,
    ...(negatives.length ? { negatives } : {}),
    diagnostics: {
      ...(base.diagnostics ?? {}),
      detectRunId: base.runId,
      accepted: kept.length,
      acceptScope: scope.kind === 'ok' ? 'ok' : `cluster:${scope.choice}`,
      duplicatesSkipped: picked.length - kept.length,
    },
  }
  if (!layer.reference) delete run.seedImageFingerprints
  const annotations = suggestionsToAnnotations(kept, { groupId: layer.groupId, run, at: ctx.at, newId: ctx.newId })
  return {
    ops: annotations.map((annotation) => ({ kind: 'add', annotation })),
    annotations,
    run,
    duplicates: picked.length - kept.length,
    clusterIds,
  }
}

/** Record that an accept batch was applied (its run id resolves clusters). */
export function noteAccepted(layer: SuggestionLayer, runId: ID): SuggestionLayer {
  return { ...layer, acceptRunIds: [...layer.acceptRunIds, runId] }
}
