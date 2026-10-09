/**
 * Baseline W: threshold → connected components → distance-transform
 * watershed. Markers are DT maxima at least ~0.7 typical radii apart. Each
 * watershed region is one colony (centroid, area-equivalent radius). No size
 * prior beyond marker spacing and a minimum area; no ambiguity estimate.
 */
import { labelComponents } from '../image/components.ts'
import { distanceTransform } from '../image/distance.ts'
import { gaussianBlur } from '../image/filters.ts'
import { localMaxima, nmsCircles } from '../image/blobs.ts'
import { makePlane } from '../image/plane.ts'
import { watershed } from '../image/watershed.ts'
import type { ClusterResult, Suggestion } from '../types.ts'
import { bboxToOriginal, clusterId, fixedInRegion, foregroundMask, nearFixed, type MethodContext } from './common.ts'

export interface MethodOutput {
  suggestions: Suggestion[]
  clusters: ClusterResult[]
  diagnostics: Record<string, unknown>
  /** Analysis-scale cluster labels (label L ↔ clusterId `c${L}`). */
  labels: Int32Array
}

export async function runWatershed(ctx: MethodContext): Promise<MethodOutput> {
  const { prior, prep } = ctx
  const scale = prep.scale
  const mask = foregroundMask(ctx)
  await ctx.checkpoint(0.55)
  const dt = gaussianBlur(distanceTransform(mask), 1)
  const cl = labelComponents(mask, 8)
  const peaks = localMaxima(dt, Math.max(1, Math.round(0.4 * prior.rMed)), 0.5 * prior.rLo, mask.data)
  const markers = nmsCircles(
    peaks.map((p) => ({ ...p, r: prior.rMed })),
    0.7,
    (p) => p.value,
  )
  // every component gets at least one marker (its deepest pixel)
  const hasMarker = new Uint8Array(cl.count + 1)
  const markerImg = new Int32Array(mask.width * mask.height)
  let next = 1
  for (const m of markers) {
    const i = Math.floor(m.y) * mask.width + Math.floor(m.x)
    markerImg[i] = next++
    hasMarker[cl.labels[i]] = 1
  }
  for (const s of cl.stats) {
    if (hasMarker[s.label]) continue
    let bi = -1
    let bv = -1
    for (let y = s.minY; y <= s.maxY; y++)
      for (let x = s.minX; x <= s.maxX; x++) {
        const i = y * mask.width + x
        if (cl.labels[i] === s.label && dt.data[i] > bv) [bv, bi] = [dt.data[i], i]
      }
    if (bi >= 0) markerImg[bi] = next++
  }
  await ctx.checkpoint(0.7)
  const cost = makePlane(mask.width, mask.height)
  for (let i = 0; i < cost.data.length; i++) cost.data[i] = -dt.data[i]
  const regions = watershed(cost, markerImg, mask.data)
  // region stats
  const n = next
  const area = new Float64Array(n)
  const sx = new Float64Array(n)
  const sy = new Float64Array(n)
  const comp = new Int32Array(n)
  for (let i = 0; i < regions.length; i++) {
    const l = regions[i]
    if (!l) continue
    area[l]++
    sx[l] += (i % mask.width) + 0.5
    sy[l] += Math.floor(i / mask.width) + 0.5
    comp[l] = cl.labels[i]
  }
  const minArea = 0.2 * Math.PI * prior.rLo * prior.rLo
  const perCluster = new Map<number, Suggestion[]>()
  for (let l = 1; l < n; l++) {
    if (area[l] < minArea) continue
    const x = sx[l] / area[l]
    const y = sy[l] / area[l]
    const r = Math.sqrt(area[l] / Math.PI)
    if (nearFixed(ctx.fixed, x, y, r)) continue
    const s: Suggestion = { x: x / scale, y: y / scale, r: r / scale, score: null, clusterId: clusterId(comp[l]), status: 'ok' }
    const list = perCluster.get(comp[l])
    if (list) list.push(s)
    else perCluster.set(comp[l], [s])
  }
  const suggestions: Suggestion[] = []
  const clustersOut: ClusterResult[] = []
  for (const s of cl.stats) {
    const list = perCluster.get(s.label) ?? []
    suggestions.push(...list)
    clustersOut.push({
      clusterId: clusterId(s.label),
      bbox: bboxToOriginal(s.minX, s.minY, s.maxX, s.maxY, scale),
      area: s.area / (scale * scale),
      fixedIds: fixedInRegion(ctx.fixed, cl.labels, mask.width, mask.height, s.label).map((f) => f.id),
      chosenK: list.length,
      runnerUpK: null,
      objectiveGap: null,
      status: 'ok',
    })
  }
  return { suggestions, clusters: clustersOut, diagnostics: { markers: n - 1, components: cl.count }, labels: cl.labels }
}
