/**
 * "Compare with detector" (pure): turn the user's manual marks inside a region
 * into a ground-truth check of the detector. The detector runs on the region
 * WITHOUT those marks as fixed colonies; its suggestions are matched to the
 * marks one-to-one within the typical colony radius (the same matching and
 * radius as scripts/eval: `matchPoints`, d = 1.0 × r_typical). Nothing here
 * changes annotations.
 *
 * Examples (seeds), as in the evaluation harness, are never scored:
 *  - 'inside': up to COMPARE_MAX_SEEDS spread-out manual marks from the region
 *    are given to the detector as examples (and as fixed colonies); the other
 *    marks in the region are scored.
 *  - 'outside': the group's manual marks OUTSIDE the region are the examples and
 *    every manual mark inside is scored.
 * Automated marks of the group inside the region stay fixed and are not scored.
 */
import type { Annotation, ID, ImageRecord } from '../../model/types'
import { annotationsInRegion, polygonArea, polygonBounds, type Pt, type RegionPolygon } from '../../model/region'
import { matchPoints, prf } from '../../detection/match'
import type { DetectResult, Suggestion } from '../../detection/types'
import { buildRequest, MAX_SEEDS, MIN_SEEDS, seedAnnotations, type RequestWithoutBytes } from '../assist/seeds'
import type { ReviewSettings } from '../assist/review'

/** At most this many examples are taken from inside the region. */
export const COMPARE_MAX_SEEDS = 8

export type CompareSeedMode = 'inside' | 'outside'

/**
 * Farthest-point sampling: k items spread over the set (deterministic: starts
 * from the item nearest the centroid, then repeatedly the one farthest from all
 * picked; ties keep list order).
 */
export function pickSpread<T extends Pt>(list: readonly T[], k: number): T[] {
  if (k <= 0 || list.length === 0) return []
  if (list.length <= k) return list.slice()
  const cx = list.reduce((s, p) => s + p.x, 0) / list.length
  const cy = list.reduce((s, p) => s + p.y, 0) / list.length
  let first = 0
  let best = Infinity
  list.forEach((p, i) => {
    const d = Math.hypot(p.x - cx, p.y - cy)
    if (d < best) [first, best] = [i, d]
  })
  const picked = [first]
  const dist = list.map((p) => Math.hypot(p.x - list[first].x, p.y - list[first].y))
  while (picked.length < k) {
    let far = -1
    let farD = -1
    dist.forEach((d, i) => {
      if (d > farD && !picked.includes(i)) [far, farD] = [i, d]
    })
    picked.push(far)
    const q = list[far]
    list.forEach((p, i) => (dist[i] = Math.min(dist[i], Math.hypot(p.x - q.x, p.y - q.y))))
  }
  return picked.map((i) => list[i])
}

export interface ComparePlan {
  mode: CompareSeedMode
  /** Manual marks of the group inside the region that are scored (the ground truth). */
  scored: Annotation[]
  /** Examples given to the detector (also fixed colonies). */
  seeds: Annotation[]
  /** Every annotation of the image except the scored ones (fixed colonies). */
  existing: Annotation[]
  /** Automated marks of the group inside the region (fixed, not scored). */
  automatedInside: number
}

export type ComparePlanResult = { ok: true; plan: ComparePlan } | { ok: false; message: string; detail: string }

/** How many manual marks the two seed modes would use (for the choice in the UI). */
export function compareCounts(annotations: readonly Annotation[], region: RegionPolygon, groupId: ID): { inside: number; outside: number } {
  const all = annotations.filter((a) => a.groupId === groupId && a.origin === 'manual' && a.reviewStatus === 'accepted')
  const inside = annotationsInRegion(all, region).length
  return { inside, outside: all.length - inside }
}

export function planComparison(annotations: readonly Annotation[], region: RegionPolygon, groupId: ID, mode: CompareSeedMode): ComparePlanResult {
  const groupMarks = annotations.filter((a) => a.groupId === groupId)
  const insideIds = new Set(annotationsInRegion(groupMarks, region).map((a) => a.id))
  const manualInside = groupMarks.filter((a) => insideIds.has(a.id) && a.origin === 'manual' && a.reviewStatus === 'accepted')
  const automatedInside = groupMarks.filter((a) => insideIds.has(a.id) && a.origin !== 'manual').length
  let seeds: Annotation[]
  let scored: Annotation[]
  if (mode === 'inside') {
    if (manualInside.length < MIN_SEEDS + 1)
      return { ok: false, message: 'Not enough marks in the region', detail: `Comparing needs at least ${MIN_SEEDS + 1} manual marks of this group inside the region (${manualInside.length} now).` }
    // keep at least half of the marks for scoring
    seeds = pickSpread(manualInside, Math.min(COMPARE_MAX_SEEDS, Math.max(MIN_SEEDS, Math.floor(manualInside.length / 2))))
    const seedIds = new Set(seeds.map((a) => a.id))
    scored = manualInside.filter((a) => !seedIds.has(a.id))
  } else {
    const outside = seedAnnotations(
      groupMarks.filter((a) => !insideIds.has(a.id)),
      groupId,
    )
    if (outside.length < MIN_SEEDS)
      return { ok: false, message: 'Not enough examples outside the region', detail: `Mark at least ${MIN_SEEDS} typical colonies of this group outside the region, or use examples from inside it.` }
    if (manualInside.length === 0) return { ok: false, message: 'No manual marks in the region', detail: 'Mark the colonies in the region by hand first; the comparison checks the detector against them.' }
    seeds = outside.slice(-MAX_SEEDS)
    scored = manualInside
  }
  const scoredIds = new Set(scored.map((a) => a.id))
  return { ok: true, plan: { mode, scored, seeds, existing: annotations.filter((a) => !scoredIds.has(a.id)), automatedInside } }
}

/** The detector request for a comparison (bytes added by the caller). */
export function buildCompareRequest(i: { image: ImageRecord; groupId: ID; plan: ComparePlan; region: RegionPolygon; settings: ReviewSettings; runId: ID }): RequestWithoutBytes {
  const req = buildRequest({ image: i.image, groupId: i.groupId, annotations: i.plan.existing, settings: i.settings, runId: i.runId, roi: i.region })
  req.seeds = i.plan.seeds.map((a) => ({ annotationId: a.id, imageId: i.image.id, x: a.x, y: a.y }))
  return req
}

export interface CompareSummary {
  /** Scored manual marks. */
  manual: number
  /** Detector suggestions in the region (pending, never annotations). */
  detected: number
  matched: number
  /** Indices into the scored marks without a matching detection. */
  missed: number[]
  /** Indices into the suggestions without a matching manual mark. */
  extra: number[]
  /** [suggestionIndex, scoredIndex, distance px] */
  pairs: [number, number, number][]
  precision: number
  recall: number
  f1: number
  /** Match radius in image px (= typical colony radius). */
  matchRadius: number
}

/** Match detections to the scored manual marks (one-to-one within `matchRadius`). */
export function summarizeComparison(scored: readonly Pt[], detected: readonly Pt[], matchRadius: number): CompareSummary {
  const m = matchPoints(detected, scored, matchRadius)
  const p = prf(m.tp, m.fp, m.fn)
  return {
    manual: scored.length,
    detected: detected.length,
    matched: m.tp,
    missed: m.unmatchedGt,
    extra: m.unmatchedPred,
    pairs: m.pairs,
    precision: p.precision,
    recall: p.recall,
    f1: p.f1,
    matchRadius,
  }
}

/** Typical colony radius of a run: the seed prior, else the median fitted radius, else a guess. */
export function typicalRadius(result: Pick<DetectResult, 'calibration' | 'suggestions'>, fallback: number): number {
  const prior = result.calibration.prior?.rMedian
  if (prior && prior > 0) return prior
  const rs = result.suggestions.map((s) => s.r).sort((a, b) => a - b)
  return rs.length ? rs[Math.floor(rs.length / 2)] : fallback
}

/** Overlay marks: missed manual marks, extra detections, matched detections. */
export function compareMarks(summary: CompareSummary, scored: readonly Pt[], detected: readonly Suggestion[]): { x: number; y: number; r: number; kind: 'missed' | 'extra' | 'matched' }[] {
  const r = summary.matchRadius
  return [
    ...summary.pairs.map(([si]) => ({ x: detected[si].x, y: detected[si].y, r: detected[si].r, kind: 'matched' as const })),
    ...summary.extra.map((i) => ({ x: detected[i].x, y: detected[i].y, r: detected[i].r, kind: 'extra' as const })),
    ...summary.missed.map((i) => ({ x: scored[i].x, y: scored[i].y, r, kind: 'missed' as const })),
  ]
}

/** One completed comparison (in memory, per image). */
export interface Comparison {
  imageId: ID
  groupId: ID
  region: Pt[]
  plan: ComparePlan
  result: Pick<DetectResult, 'suggestions' | 'calibration' | 'roi' | 'run' | 'timingsMs'>
  summary: CompareSummary
  settings: ReviewSettings
  createdAt: string
  elapsedMs: number
}

const r2 = (v: number) => Math.round(v * 100) / 100

/**
 * Shareable JSON of a comparison ("Export comparison"): the region, what was
 * scored and used as examples, the detector settings and calibration, the
 * counts and every missed / extra position. No image bytes.
 */
export function comparisonExport(c: Comparison, ctx: { projectName: string; image: Pick<ImageRecord, 'id' | 'name' | 'width' | 'height' | 'fingerprint'>; groupName: string; appVersion?: string }) {
  const s = c.summary
  const pt = (p: Pt) => ({ x: r2(p.x), y: r2(p.y) })
  const b = polygonBounds(c.region)
  return {
    kind: 'cfu-count/region-comparison',
    version: 1,
    createdAt: c.createdAt,
    project: ctx.projectName,
    image: { id: ctx.image.id, name: ctx.image.name, width: ctx.image.width, height: ctx.image.height, fingerprint: ctx.image.fingerprint },
    group: { id: c.groupId, name: ctx.groupName },
    region: { points: c.region.map(pt), bbox: { x: r2(b.x), y: r2(b.y), width: r2(b.width), height: r2(b.height) }, areaPx: Math.round(polygonArea(c.region)) },
    examples: { mode: c.plan.mode, count: c.plan.seeds.length, points: c.plan.seeds.map((a) => ({ id: a.id, ...pt(a) })) },
    automatedInsideNotScored: c.plan.automatedInside,
    detector: {
      method: c.result.run.method,
      version: c.result.run.version,
      settings: c.settings,
      typicalRadiusPx: r2(s.matchRadius),
      calibration: c.result.calibration.summary,
      warnings: c.result.calibration.warnings,
      roi: { source: c.result.roi.source, analysedAreaPx: Math.round(c.result.roi.area), contextBandPx: c.result.roi.regionContextPx !== undefined ? r2(c.result.roi.regionContextPx) : null },
      timingsMs: c.result.timingsMs,
      elapsedMs: c.elapsedMs,
    },
    matching: { method: 'greedy one-to-one by distance (scripts/eval matchPoints)', radiusPx: r2(s.matchRadius) },
    counts: {
      manual: s.manual,
      detected: s.detected,
      matched: s.matched,
      missed: s.missed.length,
      extra: s.extra.length,
      precision: r2(s.precision),
      recall: r2(s.recall),
      f1: r2(s.f1),
    },
    missed: s.missed.map((i) => ({ id: c.plan.scored[i].id, ...pt(c.plan.scored[i]) })),
    extra: s.extra.map((i) => ({ ...pt(c.result.suggestions[i]), r: r2(c.result.suggestions[i].r), status: c.result.suggestions[i].status })),
    matched: s.pairs.map(([si, mi, d]) => ({ manualId: c.plan.scored[mi].id, detected: pt(c.result.suggestions[si]), distancePx: r2(d) })),
  }
}
