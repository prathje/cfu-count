/**
 * Detector A: scale-normalised LoG at seed-derived radii. Used on its own as
 * a baseline/fallback and as a candidate source for the fitter.
 */
import { detectBlobsLoG, type Blob } from '../image/blobs.ts'
import { labelComponents } from '../image/components.ts'
import type { Plane } from '../image/plane.ts'
import type { ClusterResult, Suggestion } from '../types.ts'
import { bboxToOriginal, clusterId, fixedInRegion, foregroundMask, nearFixed, sensitivityParams, type AnalysisPrior, type MethodContext } from './common.ts'
import type { MethodOutput } from './watershed.ts'

/** 5 radii spanning the prior (±1.5 s), at least 1.5 px apart in σ terms. */
export function priorRadii(prior: AnalysisPrior): number[] {
  const out: number[] = []
  for (const k of [-1.5, -0.75, 0, 0.75, 1.5]) {
    const r = Math.max(1.5, Math.exp(prior.logR + k * prior.s))
    if (!out.length || r - out[out.length - 1] > 0.4) out.push(r)
  }
  return out
}

/** Median LoG response at the seeds, at the scale nearest the typical radius (null without seeds). */
export function expectedLogResponse(F: Plane, prior: AnalysisPrior, seeds: { x: number; y: number }[], responses: Plane[], radii: number[]): number | null {
  if (!seeds.length) return null
  const k = radii.reduce((bi, r, i) => (Math.abs(r - prior.rMed) < Math.abs(radii[bi] - prior.rMed) ? i : bi), 0)
  const vals = seeds
    .map((s) => {
      const x = Math.floor(s.x)
      const y = Math.floor(s.y)
      if (x < 0 || y < 0 || x >= F.width || y >= F.height) return NaN
      // best response in a small neighbourhood (click may be off-centre)
      let best = -Infinity
      const rr = Math.max(1, Math.round(prior.rMed * 0.3))
      for (let dy = -rr; dy <= rr; dy++)
        for (let dx = -rr; dx <= rr; dx++) {
          const xx = x + dx
          const yy = y + dy
          if (xx < 0 || yy < 0 || xx >= F.width || yy >= F.height) continue
          best = Math.max(best, responses[k].data[yy * F.width + xx])
        }
      return best
    })
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b)
  if (!vals.length) return null
  return vals[Math.floor(vals.length / 2)]
}

export interface LogCandidates {
  blobs: Blob[]
  radii: number[]
  responses: Plane[]
  threshold: number
}

/** LoG blobs inside the ROI above `frac` × the typical seed response (or a contrast-based guess). */
export function logCandidates(ctx: MethodContext, seedPts: { x: number; y: number }[], frac: number): LogCandidates {
  const radii = priorRadii(ctx.prior)
  // compute responses once, then threshold
  const { blobs: all, responses } = detectBlobsLoG(ctx.F, radii, 0, ctx.prep.roi.mask.data, 0.7)
  const ref = expectedLogResponse(ctx.F, ctx.prior, seedPts, responses, radii) ?? 0.5 * ctx.contrastRef
  const threshold = Math.max(frac * ref, 3 * ctx.noise * 0.5)
  return { blobs: all.filter((b) => b.response >= threshold), radii, responses, threshold }
}

export async function runLog(ctx: MethodContext, seedPts: { x: number; y: number }[]): Promise<MethodOutput> {
  const scale = ctx.prep.scale
  const { logFrac } = sensitivityParams(ctx.settings.sensitivity)
  const cand = logCandidates(ctx, seedPts, logFrac)
  await ctx.checkpoint(0.7)
  // assign blobs to foreground clusters for reporting (singletons when outside the mask)
  const mask = foregroundMask(ctx)
  const cl = labelComponents(mask, 8)
  const suggestions: Suggestion[] = []
  const counts = new Map<number, number>()
  let single = 0
  for (const b of cand.blobs) {
    if (nearFixed(ctx.fixed, b.x, b.y, b.r)) continue
    const l = cl.labels[Math.floor(b.y) * mask.width + Math.floor(b.x)]
    const id = l ? clusterId(l) : `s${++single}`
    if (l) counts.set(l, (counts.get(l) ?? 0) + 1)
    suggestions.push({ x: b.x / scale, y: b.y / scale, r: b.r / scale, score: b.response / cand.threshold, clusterId: id, status: 'ok' })
  }
  const clustersOut: ClusterResult[] = cl.stats.map((s) => ({
    clusterId: clusterId(s.label),
    bbox: bboxToOriginal(s.minX, s.minY, s.maxX, s.maxY, scale),
    area: s.area / (scale * scale),
    fixedIds: fixedInRegion(ctx.fixed, cl.labels, mask.width, mask.height, s.label).map((f) => f.id),
    chosenK: counts.get(s.label) ?? 0,
    runnerUpK: null,
    objectiveGap: null,
    status: 'ok',
  }))
  return { suggestions, clusters: clustersOut, diagnostics: { logThreshold: cand.threshold, radii: cand.radii, blobsOutsideMask: single }, labels: cl.labels }
}
