import { describe, expect, it } from 'vitest'
import { detect, DetectionCancelled, chooseAnalysisScale, suggestionsToAnnotations } from './index.ts'
import { computeRoi } from './roi.ts'
import { measureSeed, radiusPrior, seedQuality } from './calibrate.ts'
import { ClusterFit, decideGroup, fitClusterSweep, partitionCluster, summarizeSolution, DEFAULT_WEIGHTS, type ClusterFitParams } from './methods/fitter.ts'
import type { FixedColony } from './methods/common.ts'
import type { Mask, Plane } from './image/plane.ts'
import { makeMask, makePlane, type RgbaImage } from './image/plane.ts'
import type { DetectInput } from './types.ts'

interface Disk {
  x: number
  y: number
  r: number
}

/**
 * Synthetic photo: bright foam background, dark square "plate" with a bright
 * rim, colonies as soft-edged bright disks (cream colour).
 */
function syntheticPlate(w: number, h: number, colonies: Disk[]): RgbaImage {
  const data = new Uint8ClampedArray(w * h * 4)
  const px0 = w * 0.15, px1 = w * 0.85, py0 = h * 0.1, py1 = h * 0.9
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const inPlate = x >= px0 && x < px1 && y >= py0 && y < py1
      const rim = inPlate && Math.min(x - px0, px1 - x, y - py0, py1 - y) < 6
      let v: [number, number, number] = inPlate ? (rim ? [200, 190, 150] : [70, 72, 75]) : [235, 235, 235]
      if (inPlate && !rim) {
        let a = 0
        for (const c of colonies) {
          const d = Math.hypot(x + 0.5 - c.x, y + 0.5 - c.y)
          a = Math.max(a, Math.min(1, Math.max(0, (c.r + 1 - d) / 2)))
        }
        v = [v[0] + a * (190 - v[0]), v[1] + a * (180 - v[1]), v[2] + a * (130 - v[2])]
      }
      // deterministic mild noise
      const n = ((x * 7919 + y * 104729) % 7) - 3
      data[i] = v[0] + n
      data[i + 1] = v[1] + n
      data[i + 2] = v[2] + n
      data[i + 3] = 255
    }
  return { width: w, height: h, data }
}

const W = 300
const H = 260
const R = 8
const isolated: Disk[] = [
  { x: 90, y: 80, r: R },
  { x: 140, y: 80, r: R },
  { x: 190, y: 80, r: R },
  { x: 90, y: 130, r: R },
  { x: 215, y: 190, r: R },
]
const pair: Disk[] = [
  { x: 140, y: 170, r: R },
  { x: 155, y: 170, r: R },
]
const all = [...isolated, ...pair]
const image = syntheticPlate(W, H, all)

function input(over: Partial<DetectInput> = {}): DetectInput {
  const seeds = isolated.slice(0, 4).map((d, i) => ({ annotationId: `s${i}`, imageId: 'img', x: d.x + 1, y: d.y - 1 }))
  return {
    image,
    scale: 1,
    originalWidth: W,
    originalHeight: H,
    imageId: 'img',
    targetGroupId: 'g',
    seeds,
    existing: seeds.map((s) => ({ id: s.annotationId, x: s.x, y: s.y, groupId: 'g', origin: 'manual' as const })),
    ...over,
  }
}

describe('roi', () => {
  it('finds the square plate and excludes the rim', () => {
    const roi = computeRoi(image, 1, undefined, 0.025)
    expect(roi.report.source).toBe('auto')
    expect(roi.report.shape).toBe('square')
    // centre in, foam out, rim out
    expect(roi.mask.data[130 * W + 150]).toBe(1)
    expect(roi.mask.data[5 * W + 5]).toBe(0)
    expect(roi.mask.data[130 * W + Math.floor(W * 0.15) + 2]).toBe(0)
  })
  it('never crashes and always yields a usable outline on blank or tiny images', () => {
    for (const [w, h] of [[12, 9], [3, 2], [1, 1]]) {
      const blank = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(128) }
      const roi = computeRoi(blank, 1, undefined, 0.025)
      expect(roi.report.outline.length).toBeGreaterThanOrEqual(3)
    }
  })
  it('honours a user circle', () => {
    const roi = computeRoi(image, 0.5, { kind: 'circle', cx: 150, cy: 130, r: 40 }, 0.025)
    expect(roi.report.source).toBe('user')
    expect(roi.mask.data[65 * W + 75]).toBe(1)
    expect(roi.mask.data[10 * W + 10]).toBe(0)
  })
})

describe('seed calibration', () => {
  it('estimates the radius of an isolated colony from an off-centre click', () => {
    const F = makePlane(40, 40)
    for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) F.data[y * 40 + x] = Math.min(1, Math.max(0, (9 - Math.hypot(x + 0.5 - 20, y + 0.5 - 20)) / 2)) * 50
    const m = measureSeed({ F, noise: 1, rMax: 18 }, 22, 19)
    expect(m.r).not.toBeNull()
    expect(Math.abs(m.r! - 8)).toBeLessThan(1)
    expect(Math.hypot(m.cx - 20, m.cy - 20)).toBeLessThan(0.7)
    expect(seedQuality(m).quality).toBe('ok')
  })
  it('flags a seed touching a neighbour', () => {
    const F = makePlane(60, 40)
    for (let y = 0; y < 40; y++)
      for (let x = 0; x < 60; x++) {
        const a = Math.max(0, Math.min(1, (9 - Math.hypot(x + 0.5 - 22, y + 0.5 - 20)) / 2), Math.min(1, (9 - Math.hypot(x + 0.5 - 38, y + 0.5 - 20)) / 2))
        F.data[y * 60 + x] = a * 50
      }
    const m = measureSeed({ F, noise: 1, rMax: 18 }, 22, 20)
    expect(m.blockedFrac).toBeGreaterThan(0)
  })
  it('builds a robust log-normal prior with a floor', () => {
    const p = radiusPrior([10, 10, 10, 10], 0.2)!
    expect(p.rMedian).toBeCloseTo(10)
    expect(p.s).toBeCloseTo(0.2 * Math.sqrt(1.25))
    expect(radiusPrior([], 0.2)).toBeNull()
  })
})

describe('union-of-circles fit', () => {
  const prior = { logR: Math.log(R), s: 0.2, rMed: R, rLo: R * Math.exp(-0.4), rHi: R * Math.exp(0.4) }
  const params = { prior, weights: { ...DEFAULT_WEIGHTS, lambda: 0.175 }, contrastRef: 50, contrastLo: 0.5, tau: 2, rMaxFit: 14, coreLevel: 37 }
  const fitCluster = (m: Mask, F: Plane, ox: number, oy: number, p: ClusterFitParams, fixed: FixedColony[], _blobs: Disk[]) => summarizeSolution(fitClusterSweep(m, F, ox, oy, p, fixed), p)
  function patch(ds: Disk[], w = 70, h = 50) {
    const m = makeMask(w, h)
    const F = makePlane(w, h)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let a = 0
        for (const d of ds) a = Math.max(a, Math.min(1, Math.max(0, (d.r + 1 - Math.hypot(x + 0.5 - d.x, y + 0.5 - d.y)) / 2)))
        F.data[y * w + x] = a * 50
        m.data[y * w + x] = a > 0.5 ? 1 : 0
      }
    return { m, F }
  }
  it('keeps the incremental objective exact under add/remove', () => {
    const { m, F } = patch([{ x: 25, y: 25, r: R }])
    const fit = new ClusterFit(m, F, 0, 0, params)
    const j0 = fit.J()
    const a = fit.add(25, 25, R)
    const b = fit.add(31, 25, R)
    fit.remove(a)
    fit.remove(b)
    expect(fit.J()).toBeCloseTo(j0, 9)
  })
  it('deltaAdd (read-only) equals the change of J on insert, with fixed and free neighbours', () => {
    const { m, F } = patch([{ x: 25, y: 25, r: R }, { x: 40, y: 25, r: R }])
    const fit = new ClusterFit(m, F, 0, 0, params)
    fit.add(25, 25, R, true, 'f')
    fit.add(38, 24, R - 1)
    for (const [x, y, r] of [[31, 25, R], [40.5, 26, R + 1.5], [5, 5, 4], [26, 25, R]]) {
      const pred = fit.deltaAdd(x, y, r)
      const j0 = fit.J()
      const d = fit.add(x, y, r)
      expect(fit.J() - j0).toBeCloseTo(pred, 6)
      fit.remove(d)
      expect(fit.J()).toBeCloseTo(j0, 9)
    }
  })
  it('explains a touching pair with two disks and a single colony with one', () => {
    const two = patch([{ x: 27, y: 25, r: R }, { x: 42, y: 25, r: R }])
    const sol2 = fitCluster(two.m, two.F, 0, 0, params, [], [])
    expect(sol2.chosenK).toBe(2)
    const one = patch([{ x: 30, y: 25, r: R }])
    const sol1 = fitCluster(one.m, one.F, 0, 0, params, [], [])
    expect(sol1.chosenK).toBe(1)
    expect(Math.hypot(sol1.colonies[0].x - 30, sol1.colonies[0].y - 25)).toBeLessThan(1.5)
    expect(sol1.gap).toBeGreaterThan(0)
  })
  /** Like patch(), but colonies dim towards the rim, so touching colonies show a darker seam. */
  function seamPatch(ds: Disk[], w = 80, h = 50) {
    const m = makeMask(w, h)
    const F = makePlane(w, h)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let a = 0
        for (const d of ds) {
          const t = Math.hypot(x + 0.5 - d.x, y + 0.5 - d.y) / d.r
          a = Math.max(a, t <= 1 ? 1 - 0.6 * t * t : 0)
        }
        F.data[y * w + x] = a * 50
        m.data[y * w + x] = a > 0.1 ? 1 : 0
      }
    return { m, F }
  }
  it('partitions at seams between touching colonies, not inside a merged pair', () => {
    const touching = seamPatch([{ x: 25, y: 25, r: R }, { x: 45, y: 25, r: R }])
    expect(partitionCluster(touching.m, touching.F, prior).n).toBe(2)
    const merged = patch([{ x: 30, y: 25, r: R }, { x: 37, y: 25, r: R }])
    expect(partitionCluster(merged.m, merged.F, prior).n).toBe(1)
  })
  it('sweeps every K from 0 to K_max per unit, deterministically, with a runner-up of another K', () => {
    const tri = patch([{ x: 30, y: 20, r: R }, { x: 42, y: 20, r: R }, { x: 36, y: 30, r: R }], 70, 50)
    const a = fitClusterSweep(tri.m, tri.F, 0, 0, params, [], 7)
    const b = fitClusterSweep(tri.m, tri.F, 0, 0, params, [], 7)
    expect(JSON.stringify(a.groups)).toBe(JSON.stringify(b.groups))
    expect(a.groups).toHaveLength(1)
    const g = a.groups[0]
    const ks = new Set(g.configs.map((c) => c.k))
    for (let k = g.kRange[0]; k <= g.kRange[1]; k++) expect(ks.has(k)).toBe(true)
    expect(g.kRange[1]).toBeGreaterThanOrEqual(Math.ceil(2 * g.kEst) + 2)
    const d = decideGroup(g, params.weights, prior.logR, prior.s)
    expect(d.best.k).toBe(3)
    expect(d.runnerUp!.k).not.toBe(3)
  })
  it('counts an existing annotation as a fixed colony instead of re-suggesting it', () => {
    const two = patch([{ x: 27, y: 25, r: R }, { x: 42, y: 25, r: R }])
    const sol = fitCluster(two.m, two.F, 0, 0, params, [{ id: 'm1', x: 27, y: 25, r: R }], [])
    expect(sol.chosenK).toBe(1)
    expect(sol.fixedIds).toEqual(['m1'])
    expect(Math.abs(sol.colonies[0].x - 42)).toBeLessThan(2)
  })
})

describe('detect()', () => {
  it.each(['fitter', 'watershed', 'log'] as const)('%s finds the unmarked colonies on a synthetic plate', async (method) => {
    const r = await detect(input({ settings: { method } }))
    // 7 colonies, 4 already marked → 3 new ones (1 isolated + the pair)
    expect(r.suggestions.length).toBeGreaterThanOrEqual(method === 'watershed' ? 2 : 3)
    expect(r.suggestions.length).toBeLessThanOrEqual(3)
    for (const s of r.suggestions) {
      const d = Math.min(...all.map((c) => Math.hypot(c.x - s.x, c.y - s.y)))
      expect(d).toBeLessThan(4)
    }
    expect(r.calibration.nUsable).toBe(4)
    expect(Math.abs(r.calibration.prior!.rMedian - R)).toBeLessThan(1.5)
    expect(r.run.method).toBe(`colony-${method}`)
    expect(r.run.seeds).toHaveLength(4)
    expect(r.run.imageFingerprint).toBe('')
  })
  it('maps results to original coordinates at analysis scale < 1', async () => {
    // same plate rendered at half size, claimed to come from a 2× original
    const half = syntheticPlate(W / 2, H / 2, all.map((d) => ({ x: d.x / 2, y: d.y / 2, r: d.r / 2 })))
    const r = await detect(input({ image: half, scale: 0.5, settings: { method: 'log' } }))
    expect(r.suggestions.length).toBeGreaterThan(0)
    for (const s of r.suggestions) expect(Math.min(...all.map((c) => Math.hypot(c.x - s.x, c.y - s.y)))).toBeLessThan(6)
  })
  it('reports progress and can be cancelled', async () => {
    const stages: string[] = []
    const ac = new AbortController()
    const p = detect(input(), (pr) => {
      stages.push(pr.stage)
      if (pr.stage === 'calibrate') ac.abort()
    }, ac.signal)
    await expect(p).rejects.toBeInstanceOf(DetectionCancelled)
    expect(stages[0]).toBe('prepare')
  })
  it('turns accepted suggestions into automated, accepted annotations with geometry', async () => {
    const r = await detect(input())
    let n = 0
    const anns = suggestionsToAnnotations(r.suggestions, { groupId: 'g', run: r.run, at: '2026-01-01T00:00:00Z', newId: () => `a${n++}` })
    expect(anns[0]).toMatchObject({ origin: 'automated', reviewStatus: 'accepted', lastEditSource: 'automated', manuallyAdjusted: false })
    expect(anns[0].detector).toMatchObject({ runId: r.run.runId, confidence: null })
    expect(anns[0].geometry).toMatchObject({ kind: 'circle', source: 'fit' })
  })
})

describe('chooseAnalysisScale', () => {
  it('keeps small colonies resolvable, has no default cap and honours an explicit one', () => {
    const a = chooseAnalysisScale({ width: 6000, height: 4000, minRadiusOriginal: 20, typicalRadiusOriginal: 30 })
    expect(a.scale).toBeCloseTo(8 / 30)
    // tiny colonies: full resolution, no silent downsampling
    const b = chooseAnalysisScale({ width: 6000, height: 4000, minRadiusOriginal: 2 })
    expect(b.scale).toBe(1)
    expect(b.reason).toBe('full-resolution')
    const c = chooseAnalysisScale({ width: 6000, height: 4000, minRadiusOriginal: 2, maxPixels: 4_000_000 })
    expect(c.reason).toBe('pixel-cap')
    expect(c.width * c.height).toBeLessThanOrEqual(4_000_000 * 1.01)
    expect(chooseAnalysisScale({ width: 6000, height: 4000 }).width).toBe(2048)
  })
})
