/**
 * Mainline H: seed-constrained union-of-circles fitter (method brief §3–5).
 *
 * Per foreground cluster (connected component of the mask):
 *  1. Candidates: distance-transform peaks, circles fitted to contour arcs
 *     between concave points (outer and hole contours), LoG peaks at the prior
 *     scales; de-duplicated.
 *  2. Objective, in units of ONE TYPICAL COLONY (A0 = π r_med²):
 *       J = (FN + FP)/A0                       mask: uncovered colony px + disk px on background
 *         + α Σ_i E_i                          edge: exposed disk boundary away from the observed boundary
 *         + β Σ_i huber((log r_i − μ)/s)       seed-derived size prior
 *         + γ Σ_i A_i                          appearance: disk interior dimmer than the seeds, or ring-like
 *         + λ Σ_i (r_i/r_med)²                 count penalty, proportional to disk area
 *         + ω Σ_pairs overlap                  deep overlaps (centres closer than 0.7 (r_i + r_j))
 *     Existing annotations (any group) are fixed disks: they cover pixels and
 *     hide boundaries but pay no prior/appearance/count terms and never move.
 *  3. Search: lazy greedy forward selection from the candidates, local
 *     coordinate refinement of (x, y, r), pruning of disks whose removal lowers
 *     J, and a second greedy pass.
 *  4. Diagnostics: per-colony support m_i = J(without i) − J; runner-up K from
 *     the best removal (K−1) or addition (K+1); cluster status 'review' when
 *     the gap is below `reviewGap`, 'too-large' above kMax typical colonies.
 *
 * All terms are evaluated incrementally on the cluster patch raster, so the
 * cost of a move is O(disk area + neighbouring boundary samples).
 */
import { fillHoles, labelComponents } from '../image/components.ts'
import { arcSpan, circleResidual, concavePoints, fitCircleKasa, refineCircle, splitArcs, traceAllOuterContours } from '../image/contour.ts'
import { distanceTransform, squaredDistanceTo } from '../image/distance.ts'
import { localMaxima, nmsCircles, type Blob } from '../image/blobs.ts'
import { makeMask, type Mask, type Plane } from '../image/plane.ts'
import type { ClusterResult, Suggestion } from '../types.ts'
import { bboxToOriginal, clusterId, foregroundMask, sensitivityParams, type AnalysisPrior, type FixedColony, type MethodContext } from './common.ts'
import { logCandidates } from './log.ts'
import type { MethodOutput } from './watershed.ts'

export interface FitWeights {
  alpha: number
  beta: number
  gamma: number
  lambda: number
  /** Weight of disk pixels on background relative to uncovered colony pixels. */
  wFP: number
  /** Huber threshold for the size prior (in units of s). */
  huber: number
  /** Weight of the pairwise overlap penalty (deep overlaps are rare for real colonies). */
  omega: number
}

export const DEFAULT_WEIGHTS: Omit<FitWeights, 'lambda'> = { alpha: 0.5, beta: 0.6, gamma: 0.5, wFP: 1, huber: 2, omega: 1 }

export interface Circle3 {
  x: number
  y: number
  r: number
}

interface Disk extends Circle3 {
  fixed: boolean
  id?: string
  alive: boolean
  /** Boundary samples (patch coordinates), their misalignment cost and how many other disks hide them. */
  sx: Float32Array
  sy: Float32Array
  cost: Float32Array
  cover: Int16Array
  /** Weight of one sample: arc length / typical perimeter. */
  sw: number
  edge: number
  prior: number
  app: number
}

export interface ClusterFitParams {
  prior: AnalysisPrior
  weights: FitWeights
  contrastRef: number
  contrastLo: number
  /** Edge tolerance τ (px): misalignment saturates at τ. */
  tau: number
  rMaxFit: number
  /** F level of the "core" mask used for extra candidates (≈ 0.75 × seed contrast). */
  coreLevel: number
}

/** Fit state for one cluster patch. Exposed for unit tests. */
export class ClusterFit {
  readonly w: number
  readonly h: number
  readonly ox: number
  readonly oy: number
  readonly M: Uint8Array
  readonly F: Float32Array
  readonly dEdge: Float32Array
  readonly coverPx: Int16Array
  readonly a0: number
  FN = 0
  FP = 0
  sumEdge = 0
  sumPrior = 0
  sumApp = 0
  /** Σ (r_i / r_med)² over free disks: the count penalty scales with disk area so small colonies are not priced out. */
  sumCount = 0
  /** Σ over free-disk pairs of max(0, 0.7 (r_i + r_j) − d_ij)² / r_med². */
  sumOverlap = 0
  kNew = 0
  disks: Disk[] = []
  readonly p: ClusterFitParams
  /** Boundary samples up to this far OUTSIDE another disk count as hidden: touching colonies show no edge between them. */
  readonly hideTol: number
  private grid = new Map<number, Disk[]>()
  private cell: number

  constructor(mask: Mask, F: Plane, ox: number, oy: number, p: ClusterFitParams) {
    this.p = p
    this.hideTol = 0.5 * p.tau
    this.w = mask.width
    this.h = mask.height
    this.ox = ox
    this.oy = oy
    this.M = mask.data
    this.F = F.data
    this.a0 = Math.PI * p.prior.rMed * p.prior.rMed
    this.coverPx = new Int16Array(this.w * this.h)
    for (let i = 0; i < this.M.length; i++) this.FN += this.M[i]
    // distance to the observed boundary (boundary = mask pixels with a background 4-neighbour)
    const w = this.w
    const isB = (i: number) => {
      if (!this.M[i]) return false
      const x = i % w
      const y = (i / w) | 0
      return x === 0 || y === 0 || x === w - 1 || y === this.h - 1 || !this.M[i - 1] || !this.M[i + 1] || !this.M[i - w] || !this.M[i + w]
    }
    const sq = squaredDistanceTo(this.w, this.h, isB)
    this.dEdge = new Float32Array(sq.length)
    for (let i = 0; i < sq.length; i++) this.dEdge[i] = Math.sqrt(sq[i])
    this.cell = Math.max(4, Math.ceil(2 * p.rMaxFit))
  }

  /** Total objective. */
  J(): number {
    const wt = this.p.weights
    return (
      (this.FN + wt.wFP * this.FP) / this.a0 +
      wt.alpha * this.sumEdge +
      wt.beta * this.sumPrior +
      wt.gamma * this.sumApp +
      wt.lambda * this.sumCount +
      wt.omega * this.sumOverlap
    )
  }

  private key(cx: number, cy: number): number {
    return cx * 100003 + cy
  }

  private neighbours(x: number, y: number, r: number): Disk[] {
    const out: Disk[] = []
    const c0x = Math.floor((x - r - this.p.rMaxFit) / this.cell)
    const c1x = Math.floor((x + r + this.p.rMaxFit) / this.cell)
    const c0y = Math.floor((y - r - this.p.rMaxFit) / this.cell)
    const c1y = Math.floor((y + r + this.p.rMaxFit) / this.cell)
    for (let cy = c0y; cy <= c1y; cy++)
      for (let cx = c0x; cx <= c1x; cx++)
        for (const d of this.grid.get(this.key(cx, cy)) ?? []) if (d.alive && Math.hypot(d.x - x, d.y - y) < d.r + r + this.hideTol) out.push(d)
    return out
  }

  private overlap(a: Circle3, b: Circle3): number {
    const v = 0.7 * (a.r + b.r) - Math.hypot(a.x - b.x, a.y - b.y)
    return v > 0 ? (v * v) / (this.p.prior.rMed * this.p.prior.rMed) : 0
  }

  private priorCost(r: number): number {
    const z = Math.abs((Math.log(r) - this.p.prior.logR) / this.p.prior.s)
    const d = this.p.weights.huber
    return z <= d ? 0.5 * z * z : d * (z - 0.5 * d)
  }

  private sampleF(x: number, y: number): number {
    const xi = Math.min(Math.max(Math.floor(x), 0), this.w - 1)
    const yi = Math.min(Math.max(Math.floor(y), 0), this.h - 1)
    return this.F[yi * this.w + xi]
  }

  private appearanceCost(x: number, y: number, r: number): number {
    const c = this.sampleF(x, y)
    let ring = 0
    for (let k = 0; k < 8; k++) {
      const t = (k / 8) * 2 * Math.PI
      ring += this.sampleF(x + 0.5 * r * Math.cos(t), y + 0.5 * r * Math.sin(t))
    }
    ring /= 8
    const rel = (0.4 * c + 0.6 * ring) / this.p.contrastRef
    let cost = 0
    if (rel < this.p.contrastLo) cost += Math.min(1.5, ((this.p.contrastLo - rel) / Math.max(0.15, this.p.contrastLo * 0.5)) ** 2)
    if (ring > 0 && c < 0.5 * ring) cost += 1 // ring-like: bubble or specular rim
    return cost
  }

  private makeDisk(x: number, y: number, r: number, fixed: boolean, id?: string): Disk {
    const n = Math.max(16, Math.ceil(2 * Math.PI * r))
    const sx = new Float32Array(n)
    const sy = new Float32Array(n)
    const cost = new Float32Array(n)
    const tau2 = this.p.tau * this.p.tau
    for (let k = 0; k < n; k++) {
      const t = (k / n) * 2 * Math.PI
      const px = x + r * Math.cos(t)
      const py = y + r * Math.sin(t)
      sx[k] = px
      sy[k] = py
      const xi = Math.floor(px)
      const yi = Math.floor(py)
      if (xi < 0 || yi < 0 || xi >= this.w || yi >= this.h) cost[k] = 1
      else {
        const d = this.dEdge[yi * this.w + xi]
        cost[k] = Math.min(d * d, tau2) / tau2
      }
    }
    return {
      x, y, r, fixed, id, alive: false, sx, sy, cost, cover: new Int16Array(n),
      sw: r / (n * this.p.prior.rMed),
      edge: 0,
      prior: fixed ? 0 : this.priorCost(r),
      app: fixed ? 0 : this.appearanceCost(x, y, r),
    }
  }

  /** Add a disk; returns it. */
  add(x: number, y: number, r: number, fixed = false, id?: string): Disk {
    const d = this.makeDisk(x, y, r, fixed, id)
    this.insert(d)
    return d
  }

  private insert(d: Disk): void {
    const { x, y, r } = d
    // mask term
    const r2 = r * r
    for (let yy = Math.max(0, Math.floor(y - r)); yy < Math.min(this.h, Math.ceil(y + r) + 1); yy++) {
      for (let xx = Math.max(0, Math.floor(x - r)); xx < Math.min(this.w, Math.ceil(x + r) + 1); xx++) {
        const dx = xx + 0.5 - x
        const dy = yy + 0.5 - y
        if (dx * dx + dy * dy > r2) continue
        const i = yy * this.w + xx
        if (this.coverPx[i] === 0) {
          if (this.M[i]) this.FN--
          else this.FP++
        }
        this.coverPx[i]++
      }
    }
    // edge term: hide neighbours' samples, count own exposure
    const nb = this.neighbours(x, y, r)
    const hideR = r + this.hideTol
    for (const o of nb) {
      for (let k = 0; k < o.cover.length; k++) {
        if (Math.hypot(o.sx[k] - x, o.sy[k] - y) < hideR) {
          if (o.cover[k] === 0) {
            o.edge -= o.cost[k] * o.sw
            this.sumEdge -= o.cost[k] * o.sw
          }
          o.cover[k]++
        }
      }
    }
    let e = 0
    for (let k = 0; k < d.cover.length; k++) {
      let c = 0
      for (const o of nb) if (Math.hypot(d.sx[k] - o.x, d.sy[k] - o.y) < o.r + this.hideTol) c++
      d.cover[k] = c
      if (c === 0) e += d.cost[k] * d.sw
    }
    d.edge = e
    this.sumEdge += e
    for (const o of nb) this.sumOverlap += this.overlap(d, o)
    if (!d.fixed) {
      this.sumPrior += d.prior
      this.sumApp += d.app
      this.sumCount += (d.r / this.p.prior.rMed) ** 2
      this.kNew++
    }
    d.alive = true
    const key = this.key(Math.floor(x / this.cell), Math.floor(y / this.cell))
    const list = this.grid.get(key)
    if (list) list.push(d)
    else this.grid.set(key, [d])
    this.disks.push(d)
  }

  /** Remove a disk (exact inverse of insert). */
  remove(d: Disk): void {
    if (!d.alive) return
    d.alive = false
    const key = this.key(Math.floor(d.x / this.cell), Math.floor(d.y / this.cell))
    const list = this.grid.get(key)!
    list.splice(list.indexOf(d), 1)
    this.disks.splice(this.disks.indexOf(d), 1)
    const { x, y, r } = d
    const r2 = r * r
    for (let yy = Math.max(0, Math.floor(y - r)); yy < Math.min(this.h, Math.ceil(y + r) + 1); yy++) {
      for (let xx = Math.max(0, Math.floor(x - r)); xx < Math.min(this.w, Math.ceil(x + r) + 1); xx++) {
        const dx = xx + 0.5 - x
        const dy = yy + 0.5 - y
        if (dx * dx + dy * dy > r2) continue
        const i = yy * this.w + xx
        this.coverPx[i]--
        if (this.coverPx[i] === 0) {
          if (this.M[i]) this.FN++
          else this.FP--
        }
      }
    }
    const nb = this.neighbours(x, y, r)
    const hideR = r + this.hideTol
    for (const o of nb) {
      for (let k = 0; k < o.cover.length; k++) {
        if (Math.hypot(o.sx[k] - x, o.sy[k] - y) < hideR) {
          o.cover[k]--
          if (o.cover[k] === 0) {
            o.edge += o.cost[k] * o.sw
            this.sumEdge += o.cost[k] * o.sw
          }
        }
      }
    }
    this.sumEdge -= d.edge
    for (const o of nb) this.sumOverlap -= this.overlap(d, o)
    if (!d.fixed) {
      this.sumPrior -= d.prior
      this.sumApp -= d.app
      this.sumCount -= (d.r / this.p.prior.rMed) ** 2
      this.kNew--
    }
  }

  /** ΔJ of adding a circle, without changing the state. */
  deltaAdd(x: number, y: number, r: number): number {
    const before = this.J()
    const d = this.makeDisk(x, y, r, false)
    this.insert(d)
    const after = this.J()
    this.remove(d)
    return after - before
  }

  /** ΔJ of removing a disk, without changing the state. */
  deltaRemove(d: Disk): number {
    const before = this.J()
    this.remove(d)
    const after = this.J()
    this.insert(d)
    return after - before
  }

  /** Coordinate-descent refinement of one free disk; returns the (possibly replaced) disk. */
  refine(d: Disk, bounds: { minX: number; minY: number; maxX: number; maxY: number }, rMin: number): Disk {
    let cur = d
    for (const step of [1, 0.5]) {
      for (let it = 0; it < 8; it++) {
        const base = this.J()
        this.remove(cur)
        const j0 = this.J()
        let best: Circle3 = { x: cur.x, y: cur.y, r: cur.r }
        let bestJ = base
        const moves: Circle3[] = [
          { x: cur.x + step, y: cur.y, r: cur.r },
          { x: cur.x - step, y: cur.y, r: cur.r },
          { x: cur.x, y: cur.y + step, r: cur.r },
          { x: cur.x, y: cur.y - step, r: cur.r },
          { x: cur.x, y: cur.y, r: cur.r + step },
          { x: cur.x, y: cur.y, r: cur.r - step },
        ]
        for (const m of moves) {
          if (m.r < rMin || m.r > this.p.rMaxFit || m.x < bounds.minX || m.x > bounds.maxX || m.y < bounds.minY || m.y > bounds.maxY) continue
          const j = j0 + this.deltaAdd(m.x, m.y, m.r)
          if (j < bestJ - 1e-9) {
            bestJ = j
            best = m
          }
        }
        cur = this.add(best.x, best.y, best.r)
        if (bestJ >= base - 1e-9) break
      }
    }
    return cur
  }
}

/** Candidate circles for one cluster patch (patch coordinates). */
export function clusterCandidates(
  mask: Mask,
  prior: AnalysisPrior,
  rMaxFit: number,
  logBlobs: Circle3[],
  core?: { F: Plane; level: number },
): (Circle3 & { score: number })[] {
  const out: (Circle3 & { score: number })[] = []
  const dt = distanceTransform(mask)
  const rMinC = Math.max(1, 0.6 * prior.rLo)
  // 0. peaks of the CORE mask (F above a high level): seams between touching colonies
  //    usually stay below it, so its distance-transform peaks separate them
  if (core) {
    const cm = makeMask(mask.width, mask.height)
    for (let i = 0; i < cm.data.length; i++) cm.data[i] = mask.data[i] && core.F.data[i] > core.level ? 1 : 0
    const cdt = distanceTransform(cm)
    for (const p of localMaxima(cdt, Math.max(1, Math.round(0.3 * prior.rMed)), Math.max(1, 0.25 * prior.rLo), cm.data)) {
      out.push({ x: p.x, y: p.y, r: Math.min(prior.rMed, rMaxFit), score: p.value * 1.2 })
    }
  }
  // 1. DT peaks
  for (const p of localMaxima(dt, Math.max(1, Math.round(0.25 * prior.rMed)), 0.4 * prior.rLo, mask.data)) {
    const r = Math.min(Math.max(p.value, rMinC), rMaxFit)
    out.push({ x: p.x, y: p.y, r, score: p.value })
    if (Math.abs(Math.log(r / prior.rMed)) > 0.25) out.push({ x: p.x, y: p.y, r: Math.min(prior.rMed, rMaxFit), score: p.value * 0.9 })
  }
  // 2. arcs between concave points on outer and hole contours
  const k = Math.max(2, Math.round(0.5 * prior.rMed))
  const contours = traceAllOuterContours(mask, 6)
  const filled = fillHoles(mask)
  const holes = makeMask(mask.width, mask.height)
  for (let i = 0; i < holes.data.length; i++) holes.data[i] = filled.data[i] && !mask.data[i] ? 1 : 0
  contours.push(...traceAllOuterContours(holes, 6))
  const minArc = Math.max(5, Math.round(0.8 * prior.rMed))
  for (const c of contours) {
    for (const arc of splitArcs(c, concavePoints(c, mask, k))) {
      if (arc.length < minArc) continue
      const kasa = fitCircleKasa(arc)
      if (!kasa) continue
      const fit = refineCircle(arc, kasa, 6)
      if (!(fit.r >= rMinC && fit.r <= rMaxFit)) continue
      if (circleResidual(arc, fit) > 0.12 * fit.r + 0.6) continue
      if (arcSpan(arc, fit) < Math.PI / 3) continue
      const xi = Math.floor(fit.x)
      const yi = Math.floor(fit.y)
      if (xi < 0 || yi < 0 || xi >= mask.width || yi >= mask.height || dt.data[yi * mask.width + xi] < 0.3 * fit.r) continue
      out.push({ x: fit.x, y: fit.y, r: fit.r, score: fit.r })
    }
  }
  // 3. LoG peaks inside the mask
  for (const b of logBlobs) {
    const xi = Math.floor(b.x)
    const yi = Math.floor(b.y)
    if (xi < 0 || yi < 0 || xi >= mask.width || yi >= mask.height || !mask.data[yi * mask.width + xi]) continue
    out.push({ x: b.x, y: b.y, r: Math.min(Math.max(b.r, rMinC), rMaxFit), score: b.r })
  }
  // de-duplicate near-identical circles
  return nmsCircles(out, 0.25, (c) => c.score)
}

/** Candidates at peaks of the uncovered foreground (what the current disks fail to explain). */
function residualCandidates(fit: ClusterFit, params: ClusterFitParams, w: number, h: number): (Circle3 & { score: number })[] {
  const res = makeMask(w, h)
  let n = 0
  for (let i = 0; i < res.data.length; i++) {
    if (fit.M[i] && fit.coverPx[i] === 0) {
      res.data[i] = 1
      n++
    }
  }
  const { prior, rMaxFit } = params
  if (n < 0.25 * fit.a0) return []
  const dt = distanceTransform(res)
  const out: (Circle3 & { score: number })[] = []
  for (const p of localMaxima(dt, Math.max(1, Math.round(0.5 * prior.rMed)), Math.max(1, 0.35 * prior.rLo), res.data)) {
    out.push({ x: p.x, y: p.y, r: Math.min(Math.max(p.value, 0.8 * prior.rMed), rMaxFit), score: p.value })
    out.push({ x: p.x, y: p.y, r: Math.min(prior.rMed, rMaxFit), score: p.value })
  }
  return out
}

export interface ClusterSolution {
  colonies: (Circle3 & { support: number })[]
  fixedIds: string[]
  chosenK: number
  runnerUpK: number | null
  gap: number | null
  alternative?: Circle3[]
  J: number
}

/**
 * Fit one cluster. `mask` / `F` are patch rasters; `fixed` and `logBlobs` in
 * patch coordinates. Pure.
 */
export function fitCluster(mask: Mask, F: Plane, ox: number, oy: number, params: ClusterFitParams, fixed: FixedColony[], logBlobs: Circle3[]): ClusterSolution {
  const fit = new ClusterFit(mask, F, ox, oy, params)
  for (const f of fixed) fit.add(f.x, f.y, f.r, true, f.id)
  const cands = clusterCandidates(mask, params.prior, params.rMaxFit, logBlobs, { F, level: params.coreLevel })
  const bounds = { minX: 0, minY: 0, maxX: mask.width, maxY: mask.height }
  const rMin = Math.max(1, 0.5 * params.prior.rLo)
  let used = new Uint8Array(cands.length)
  let cache = new Float64Array(cands.length)
  let dirty = new Uint8Array(cands.length).fill(1)
  let bestR = new Float64Array(cands.length)

  /** Best ΔJ over a few radii at the candidate's centre (NMS keeps one radius per centre). */
  const evalCand = (c: number): number => {
    const k = cands[c]
    const rs = [k.r, params.prior.rMed, 0.85 * k.r, 1.15 * k.r]
    let best = Infinity
    for (const r0 of rs) {
      const r = Math.min(Math.max(r0, rMin), params.rMaxFit)
      const d = fit.deltaAdd(k.x, k.y, r)
      if (d < best) {
        best = d
        bestR[c] = r
      }
    }
    return best
  }
  const greedy = () => {
    for (;;) {
      let best = -1
      let bestD = -1e-9
      for (let c = 0; c < cands.length; c++) {
        if (used[c]) continue
        if (dirty[c]) {
          cache[c] = evalCand(c)
          dirty[c] = 0
        }
        if (cache[c] < bestD) {
          bestD = cache[c]
          best = c
        }
      }
      if (best < 0) return
      used[best] = 1
      const d = fit.add(cands[best].x, cands[best].y, bestR[best])
      markDirty(d.x, d.y, d.r)
    }
  }
  /** Accept additions that only pay off after local refinement (top few candidates). */
  const polish = (): boolean => {
    let changed = false
    for (let it = 0; it < 50; it++) {
      const order: number[] = []
      for (let c = 0; c < cands.length; c++) if (!used[c]) order.push(c)
      for (const c of order) if (dirty[c]) {
        cache[c] = evalCand(c)
        dirty[c] = 0
      }
      order.sort((a, b) => cache[a] - cache[b])
      let accepted = false
      for (const c of order.slice(0, 6)) {
        const j0 = fit.J()
        const d = fit.add(cands[c].x, cands[c].y, bestR[c])
        const nd = fit.refine(d, bounds, rMin)
        if (fit.J() < j0 - 1e-6) {
          used[c] = 1
          markDirty(nd.x, nd.y, nd.r)
          accepted = changed = true
          break
        }
        fit.remove(nd)
      }
      if (!accepted) break
    }
    return changed
  }
  const markDirty = (x: number, y: number, r: number) => {
    for (let c = 0; c < cands.length; c++) {
      if (!used[c] && Math.hypot(cands[c].x - x, cands[c].y - y) < cands[c].r + r + params.tau + 1) dirty[c] = 1
    }
  }
  const refineAll = () => {
    for (const d of fit.disks.filter((q) => !q.fixed)) {
      if (!d.alive) continue
      const nd = fit.refine(d, bounds, rMin)
      if (nd !== d) {
        markDirty(d.x, d.y, d.r)
        markDirty(nd.x, nd.y, nd.r)
      }
    }
    // split move: an over-large disk may be two touching colonies
    const big = Math.exp(params.prior.s) * params.prior.rMed
    for (const d of fit.disks.filter((q) => !q.fixed && q.r > big)) {
      if (!d.alive) continue
      const j0 = fit.J()
      fit.remove(d)
      let best: [Circle3, Circle3] | null = null
      let bestJ = j0
      const r2 = Math.min(params.prior.rMed, d.r)
      for (let a = 0; a < 4; a++) {
        const t = (a / 4) * Math.PI
        const off = Math.max(0.5 * d.r, d.r - r2)
        const A = { x: d.x + off * Math.cos(t), y: d.y + off * Math.sin(t), r: r2 }
        const B = { x: d.x - off * Math.cos(t), y: d.y - off * Math.sin(t), r: r2 }
        const da = fit.add(A.x, A.y, A.r)
        const db = fit.add(B.x, B.y, B.r)
        const ra = fit.refine(da, bounds, rMin)
        const rb = fit.refine(db, bounds, rMin)
        const j = fit.J()
        if (j < bestJ - 1e-9) {
          bestJ = j
          best = [{ x: ra.x, y: ra.y, r: ra.r }, { x: rb.x, y: rb.y, r: rb.r }]
        }
        fit.remove(ra)
        fit.remove(rb)
      }
      if (best) {
        for (const c of best) fit.add(c.x, c.y, c.r)
        markDirty(d.x, d.y, d.r * 2)
      } else fit.add(d.x, d.y, d.r)
    }
  }
  const prune = () => {
    for (;;) {
      let worst: Disk | null = null
      let worstD = -1e-9
      // snapshot: deltaRemove re-inserts disks, which reorders fit.disks
      for (const d of fit.disks.slice()) {
        if (d.fixed) continue
        const dr = fit.deltaRemove(d)
        if (dr < worstD) {
          worstD = dr
          worst = d
        }
      }
      if (!worst) return
      fit.remove(worst)
      markDirty(worst.x, worst.y, worst.r)
    }
  }

  for (let round = 0; round < 4; round++) {
    const before = fit.kNew
    greedy()
    refineAll()
    prune()
    // residual-driven candidates: peaks of the distance transform of still-uncovered foreground
    const added = residualCandidates(fit, params, mask.width, mask.height)
    const n0 = cands.length
    for (const c of added) cands.push(c)
    if (cands.length > n0) {
      const grow = (a: Uint8Array | Float64Array, fill: number) => {
        const b = new (a.constructor as Uint8ArrayConstructor)(cands.length)
        b.set(a as Uint8Array)
        b.fill(fill, a.length)
        return b
      }
      used = grow(used, 0)
      dirty = grow(dirty, 1)
      cache = Float64Array.from({ length: cands.length }, (_, i) => (i < cache.length ? cache[i] : 0))
      bestR = Float64Array.from({ length: cands.length }, (_, i) => (i < bestR.length ? bestR[i] : cands[i].r))
    }
    if (round > 0 && fit.kNew === before && cands.length === n0) break
  }
  if (polish()) {
    refineAll()
    prune()
  }

  // diagnostics
  const free = fit.disks.filter((d) => !d.fixed)
  const support = free.map((d) => fit.deltaRemove(d))
  const J = fit.J()
  let gapMinus = Infinity
  let weakest = -1
  support.forEach((s, i) => {
    if (s < gapMinus) {
      gapMinus = s
      weakest = i
    }
  })
  let gapPlus = Infinity
  let bestAdd: Circle3 | null = null
  // the K+1 alternative must be a separate colony, not a disk nested in an existing one
  const separate = (x: number, y: number, r: number) => fit.disks.every((d) => Math.hypot(d.x - x, d.y - y) >= 0.7 * Math.max(d.r, r))
  for (let c = 0; c < cands.length; c++) {
    if (!separate(cands[c].x, cands[c].y, cands[c].r)) continue
    const d = fit.deltaAdd(cands[c].x, cands[c].y, cands[c].r)
    if (d < gapPlus) {
      gapPlus = d
      bestAdd = cands[c]
    }
  }
  if (bestAdd) {
    // a quick refinement of the best addition gives a fairer runner-up
    const d = fit.add(bestAdd.x, bestAdd.y, bestAdd.r)
    const nd = fit.refine(d, bounds, rMin)
    const refinedGap = fit.J() - J
    const refined = { x: nd.x, y: nd.y, r: nd.r }
    fit.remove(nd)
    // keep the refined version only if it is still a separate colony
    if (separate(refined.x, refined.y, refined.r)) {
      gapPlus = Math.min(gapPlus, refinedGap)
      bestAdd = refined
    }
  }
  const K = free.length
  let runnerUpK: number | null = null
  let gap: number | null = null
  let alternative: Circle3[] | undefined
  if (K > 0 && gapMinus <= gapPlus) {
    runnerUpK = K - 1
    gap = gapMinus
    alternative = free.filter((_, i) => i !== weakest).map(({ x, y, r }) => ({ x, y, r }))
  } else if (Number.isFinite(gapPlus) && bestAdd) {
    runnerUpK = K + 1
    gap = gapPlus
    alternative = [...free.map(({ x, y, r }) => ({ x, y, r })), bestAdd]
  }
  return {
    colonies: free.map((d, i) => ({ x: d.x, y: d.y, r: d.r, support: support[i] })),
    fixedIds: fixed.map((f) => f.id),
    chosenK: K,
    runnerUpK,
    gap,
    alternative,
    J,
  }
}

export async function runFitter(ctx: MethodContext, seedPts: { x: number; y: number }[]): Promise<MethodOutput> {
  const { prior, prep, settings } = ctx
  const scale = prep.scale
  const sp = sensitivityParams(settings.sensitivity)
  const weights: FitWeights = { ...DEFAULT_WEIGHTS, lambda: sp.lambda, ...settings.fitWeights }
  const mask = foregroundMask(ctx)
  await ctx.checkpoint(0.5)
  // LoG candidates with a permissive threshold (they only propose; the objective decides)
  const lc = logCandidates(ctx, seedPts, sp.logFrac * 0.6)
  await ctx.checkpoint(0.55)
  const cl = labelComponents(mask, 8)
  const rMaxFit = Math.max(prior.rHi * 1.3, prior.rMed * 1.8)
  const pad = Math.ceil(rMaxFit) + 2
  const a0 = Math.PI * prior.rMed * prior.rMed
  const params: ClusterFitParams = {
    prior,
    weights,
    contrastRef: ctx.contrastRef,
    contrastLo: ctx.contrastLo,
    tau: Math.max(1.5, 0.25 * prior.rMed),
    rMaxFit,
    coreLevel: 0.75 * ctx.contrastRef,
  }
  const suggestions: Suggestion[] = []
  const clustersOut: ClusterResult[] = []
  const counts = { ok: 0, review: 0, tooLarge: 0 }
  let lastYield = Date.now()
  const order = cl.stats.slice().sort((a, b) => a.minY - b.minY || a.minX - b.minX)
  for (let ci = 0; ci < order.length; ci++) {
    const s = order[ci]
    if (Date.now() - lastYield > 40) {
      await ctx.checkpoint(0.55 + 0.43 * (ci / order.length))
      lastYield = Date.now()
    }
    const id = clusterId(s.label)
    const bbox = bboxToOriginal(s.minX, s.minY, s.maxX, s.maxY, scale)
    const x0 = Math.max(0, s.minX - pad)
    const y0 = Math.max(0, s.minY - pad)
    const x1 = Math.min(mask.width - 1, s.maxX + pad)
    const y1 = Math.min(mask.height - 1, s.maxY + pad)
    const pw = x1 - x0 + 1
    const ph = y1 - y0 + 1
    const pm = makeMask(pw, ph)
    const pF: Plane = { width: pw, height: ph, data: new Float32Array(pw * ph) }
    for (let y = 0; y < ph; y++)
      for (let x = 0; x < pw; x++) {
        const i = (y + y0) * mask.width + x + x0
        pm.data[y * pw + x] = cl.labels[i] === s.label ? 1 : 0
        pF.data[y * pw + x] = ctx.F.data[i]
      }
    const fixedHere = ctx.fixed
      .filter((f) => {
        const xi = Math.floor(f.x)
        const yi = Math.floor(f.y)
        return xi >= 0 && yi >= 0 && xi < mask.width && yi < mask.height && cl.labels[yi * mask.width + xi] === s.label
      })
      .map((f) => ({ ...f, x: f.x - x0, y: f.y - y0 }))
    if (s.area > settings.kMax * a0) {
      counts.tooLarge++
      clustersOut.push({ clusterId: id, bbox, area: s.area / (scale * scale), fixedIds: fixedHere.map((f) => f.id), chosenK: 0, runnerUpK: null, objectiveGap: null, status: 'too-large' })
      continue
    }
    const blobs: Circle3[] = lc.blobs
      .filter((b: Blob) => b.x >= x0 && b.y >= y0 && b.x <= x1 + 1 && b.y <= y1 + 1)
      .map((b) => ({ x: b.x - x0, y: b.y - y0, r: b.r }))
    const sol = fitCluster(pm, pF, x0, y0, params, fixedHere, blobs)
    const review = sol.gap !== null && sol.gap < settings.reviewGap
    if (review) counts.review++
    else counts.ok++
    for (const c of sol.colonies) {
      suggestions.push({
        x: (c.x + x0) / scale,
        y: (c.y + y0) / scale,
        r: c.r / scale,
        score: round3(c.support),
        clusterId: id,
        status: c.support < settings.reviewGap ? 'review' : 'ok',
      })
    }
    const result: ClusterResult = {
      clusterId: id,
      bbox,
      area: s.area / (scale * scale),
      fixedIds: sol.fixedIds,
      chosenK: sol.chosenK,
      runnerUpK: sol.runnerUpK,
      objectiveGap: sol.gap === null ? null : round3(sol.gap),
      status: review ? 'review' : 'ok',
    }
    if (review && sol.alternative && sol.runnerUpK !== null) {
      result.alternative = { k: sol.runnerUpK, colonies: sol.alternative.map((c) => ({ x: (c.x + x0) / scale, y: (c.y + y0) / scale, r: c.r / scale })) }
    }
    clustersOut.push(result)
  }
  return {
    suggestions,
    clusters: clustersOut,
    diagnostics: {
      weights,
      tau: params.tau,
      rMaxFit,
      logCandidateThreshold: lc.threshold,
      clustersOk: counts.ok,
      clustersReview: counts.review,
      clustersTooLarge: counts.tooLarge,
    },
    labels: cl.labels,
  }
}

const round3 = (v: number) => Math.round(v * 1000) / 1000
