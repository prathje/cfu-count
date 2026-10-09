/**
 * Mainline H: seed-constrained union-of-circles fitter (method brief §3–5).
 *
 * Per foreground cluster (connected component of the mask):
 *  1. Candidates: distance-transform peaks, circles fitted to contour arcs
 *     between concave points (outer and hole contours), LoG peaks at the prior
 *     scales; de-duplicated.
 *  2. Objective, in units of ONE TYPICAL COLONY (A0 = π r_med²):
 *       J = (FN + FP)/A0                       soft mask: Σ m over uncovered px + Σ (1 − m) over covered px,
 *                                              m = smoothstep of F over 0.2–0.6 × seed contrast (0 on background and
 *                                              in the 1–2 px seams between touching colonies, 1 inside)
 *         + α Σ_i E_i                          edge: exposed disk boundary away from the observed boundary
 *         + β Σ_i huber±((log r_i − μ)/s)      seed-derived size prior (oversize counts double)
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
import { detectBlobsLoG, localMaxima, logResponse, nmsCircles } from '../image/blobs.ts'
import { cropPlane, makeMask, type Mask, type Plane } from '../image/plane.ts'
import type { ClusterResult, Suggestion } from '../types.ts'
import { bboxToOriginal, clusterId, foregroundMask, sensitivityParams, type AnalysisPrior, type FixedColony, type MethodContext } from './common.ts'
import { priorRadii } from './log.ts'
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
  /** Σ m over uncovered pixels (float). */
  FN = 0
  /** Σ (1 − m) over covered pixels (float). */
  FP = 0
  /** Per-pixel soft membership m ∈ [0, 1]. */
  readonly mIn: Float32Array
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
    // soft membership: smoothstep of F between 0.2 and 0.6 of the seed contrast, inside the cluster only.
    // Uncovered pixels cost m, covered pixels cost 1 − m: seams between touching colonies argue
    // against a disk spanning them, and a colony's edge sits at its half-maximum (as for the seeds).
    this.mIn = new Float32Array(this.M.length)
    const lo = 0.2 * p.contrastRef
    const hi = 0.6 * p.contrastRef
    for (let i = 0; i < this.M.length; i++) {
      if (!this.M[i]) continue
      const t = Math.min(1, Math.max(0, (F.data[i] - lo) / (hi - lo)))
      this.mIn[i] = t * t * (3 - 2 * t)
      this.FN += this.mIn[i]
    }
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
    return sizeCost(r, this.p.prior.logR, this.p.prior.s, this.p.weights.huber)
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
          this.FN -= this.mIn[i]
          this.FP += 1 - this.mIn[i]
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
          this.FN += this.mIn[i]
          this.FP -= 1 - this.mIn[i]
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

  return sweepGroups(fit, mask, params, bounds, rMin)
}

// ---------------------------------------------------------------------------
// Groups (sub-clusters) and the per-group K sweep
// ---------------------------------------------------------------------------

/** One explanation of a group: K new colonies and the λ/prior-free part of J. */
export interface GroupConfig {
  k: number
  /** Patch coordinates. */
  disks: Circle3[]
  /** J of the whole cluster with this config, minus its count and size-prior terms. */
  base: number
  /** Σ (r_i / r̃)², multiplies λ. */
  count: number
}

export interface GroupFit {
  /** Configurations tried (one per K, best found for that K), sorted by k. */
  configs: GroupConfig[]
  fixedIds: string[]
  /** Inclusive patch bbox of the group's pixels. */
  bbox: [number, number, number, number]
  /** Foreground pixels of the group. */
  area: number
  /** Smallest and largest K swept; a best K on an open edge means the table may be incomplete. */
  kRange: [number, number]
}

export interface ClusterSolution {
  groups: GroupFit[]
  /** Patch raster: group index per foreground pixel, −1 elsewhere. */
  groupOf: Int32Array
}

const MAX_GROUP = 3
const MAX_SWEEP_K = 8

/** Size-prior cost of a set of radii under (logR, s, huber δ). */
/**
 * Asymmetric Huber size cost. A disk LARGER than the prior is the typical
 * signature of merged colonies explained as one (the field failure "a cluster
 * of 3 became one"), while colonies smaller than the seeds are common and
 * legitimate, so the upper side counts double.
 */
export const OVERSIZE_FACTOR = 2

export function sizeCost(r: number, logR: number, s: number, huber: number): number {
  const zs = (Math.log(r) - logR) / s
  const z = Math.abs(zs)
  const c = z <= huber ? 0.5 * z * z : huber * (z - 0.5 * huber)
  return zs > 0 ? OVERSIZE_FACTOR * c : c
}

export function priorSum(disks: readonly Circle3[], logR: number, s: number, huber: number): number {
  let t = 0
  for (const d of disks) t += sizeCost(d.r, logR, s, huber)
  return t
}

/** Score of a stored configuration for the given count penalty and prior spread. */
export function configScore(c: GroupConfig, w: { lambda: number; beta: number; huber: number }, logR: number, s: number): number {
  return c.base + w.lambda * c.count + w.beta * priorSum(c.disks, logR, s, w.huber)
}

function sweepGroups(fit: ClusterFit, mask: Mask, params: ClusterFitParams, bounds: { minX: number; minY: number; maxX: number; maxY: number }, rMin: number): ClusterSolution {
  const { prior, weights } = params
  const w = mask.width
  const n = w * mask.height
  const dt = distanceTransform(mask)
  const all = fit.disks.slice() // free + fixed, current greedy solution
  // --- group the disks: merged unless a clear neck separates them (Kruskal with a size cap)
  const parent = all.map((_, i) => i)
  const size = all.map(() => 1)
  const find = (a: number): number => (parent[a] === a ? a : (parent[a] = find(parent[a])))
  const edges: [number, number, number][] = []
  for (let i = 0; i < all.length; i++)
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i]
      const b = all[j]
      const d = Math.hypot(a.x - b.x, a.y - b.y)
      if (d > a.r + b.r + 1) continue
      let neck = Infinity
      for (let t = 0.15; t <= 0.85; t += 0.05) {
        const x = Math.floor(a.x + (b.x - a.x) * t)
        const y = Math.floor(a.y + (b.y - a.y) * t)
        neck = Math.min(neck, x >= 0 && y >= 0 && x < w && y < mask.height ? dt.data[y * w + x] : 0)
      }
      const ratio = neck / Math.min(a.r, b.r)
      if (ratio >= 0.7) edges.push([i, j, ratio])
    }
  edges.sort((p, q) => q[2] - p[2])
  for (const [i, j] of edges) {
    const ri = find(i)
    const rj = find(j)
    if (ri === rj || size[ri] + size[rj] > MAX_GROUP) continue
    parent[rj] = ri
    size[ri] += size[rj]
  }
  // --- assign foreground pixels to the nearest disk (distance relative to radius)
  const groupOf = new Int32Array(n).fill(-1)
  const roots = new Map<number, number>()
  const diskGroup = all.map((_, i) => {
    const r = find(i)
    if (!roots.has(r)) roots.set(r, roots.size)
    return roots.get(r)!
  })
  if (all.length === 0) {
    for (let i = 0; i < n; i++) if (mask.data[i]) groupOf[i] = 0
  } else {
    for (let i = 0; i < n; i++) {
      if (!mask.data[i]) continue
      const x = (i % w) + 0.5
      const y = Math.floor(i / w) + 0.5
      let best = 0
      let bd = Infinity
      for (let k = 0; k < all.length; k++) {
        const d = Math.hypot(all[k].x - x, all[k].y - y) / all[k].r
        if (d < bd) {
          bd = d
          best = k
        }
      }
      groupOf[i] = diskGroup[best]
    }
  }
  const nGroups = Math.max(1, roots.size)
  const groups: GroupFit[] = []
  for (let g = 0; g < nGroups; g++) {
    const members = all.filter((_, k) => diskGroup[k] === g)
    const pix: number[] = []
    for (let i = 0; i < n; i++) if (groupOf[i] === g) pix.push(i)
    if (!pix.length && !members.some((d) => !d.fixed)) continue
    let minX = w, minY = mask.height, maxX = -1, maxY = -1
    for (const i of pix) {
      const x = i % w
      const y = Math.floor(i / w)
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
    const fixedHere = members.filter((d) => d.fixed)
    const free = members.filter((d) => !d.fixed)
    // pixels not explained by fixed colonies drive the expected count
    const open = pix.filter((i) => !fixedHere.some((f) => Math.hypot((i % w) + 0.5 - f.x, Math.floor(i / w) + 0.5 - f.y) < f.r))
    const k0 = free.length
    const ka = Math.round(open.length / (0.85 * fit.a0))
    const clearSingle = k0 <= 1 && ka <= 1
    const kLo = clearSingle ? 0 : Math.max(0, Math.min(k0, ka) - 1)
    const kHi = clearSingle ? k0 : Math.min(MAX_SWEEP_K, Math.max(k0, ka) + 1)
    const configs: GroupConfig[] = []
    const record = (disks: readonly Circle3[], k: number) => {
      const count = disks.reduce((a, d) => a + (d.r / prior.rMed) ** 2, 0)
      const base = fit.J() - weights.lambda * count - weights.beta * priorSum(disks, prior.logR, prior.s, weights.huber)
      const prev = configs.find((c) => c.k === k)
      const cand: GroupConfig = { k, disks: disks.map(({ x, y, r }) => ({ x, y, r })), base, count }
      if (!prev) configs.push(cand)
      else if (configScore(cand, weights, prior.logR, prior.s) < configScore(prev, weights, prior.logR, prior.s)) configs[configs.indexOf(prev)] = cand
    }
    // the greedy solution for k0
    record(free, k0)
    for (const d of free) fit.remove(d)
    for (let k = kLo; k <= kHi; k++) {
      if (k === 0) {
        record([], 0)
        continue
      }
      if (k === k0 && clearSingle) continue
      const init = kmeansInit(open.length ? open : pix, w, dt, k, prior, rMin, params.rMaxFit)
      let placed = init.map((c) => fit.add(c.x, c.y, c.r))
      for (let pass = 0; pass < 2; pass++) placed = placed.map((d) => fit.refine(d, bounds, rMin))
      record(placed, k)
      for (const d of placed) fit.remove(d)
    }
    configs.sort((a, b) => a.k - b.k)
    // leave the best configuration in place so later groups are fitted against it
    const best = configs.reduce((a, b) => (configScore(b, weights, prior.logR, prior.s) < configScore(a, weights, prior.logR, prior.s) ? b : a))
    for (const d of best.disks) fit.add(d.x, d.y, d.r)
    groups.push({ configs, fixedIds: fixedHere.map((f) => f.id!).filter(Boolean), bbox: [minX, minY, maxX, maxY], area: pix.length, kRange: [kLo, kHi] })
  }
  return { groups, groupOf }
}

/** Farthest-point seeding on deep pixels, then a few Lloyd iterations; radii from the assigned areas. */
function kmeansInit(pix: number[], w: number, dt: Plane, k: number, prior: AnalysisPrior, rMin: number, rMax: number): Circle3[] {
  const deep = pix.filter((i) => dt.data[i] >= 0.4 * prior.rLo)
  const pts = deep.length >= k ? deep : pix
  const xs = pts.map((i) => (i % w) + 0.5)
  const ys = pts.map((i) => Math.floor(i / w) + 0.5)
  let first = 0
  for (let j = 1; j < pts.length; j++) if (dt.data[pts[j]] > dt.data[pts[first]]) first = j
  const cx = [xs[first]]
  const cy = [ys[first]]
  const md = xs.map((x, j) => Math.hypot(x - cx[0], ys[j] - cy[0]))
  while (cx.length < k) {
    let far = 0
    for (let j = 1; j < pts.length; j++) if (md[j] > md[far]) far = j
    cx.push(xs[far])
    cy.push(ys[far])
    for (let j = 0; j < pts.length; j++) md[j] = Math.min(md[j], Math.hypot(xs[j] - xs[far], ys[j] - ys[far]))
  }
  const cnt = new Array(k).fill(0)
  for (let it = 0; it < 5; it++) {
    const sx = new Array(k).fill(0)
    const sy = new Array(k).fill(0)
    cnt.fill(0)
    for (let j = 0; j < pts.length; j++) {
      let b = 0
      let bd = Infinity
      for (let c = 0; c < k; c++) {
        const d = (xs[j] - cx[c]) ** 2 + (ys[j] - cy[c]) ** 2
        if (d < bd) {
          bd = d
          b = c
        }
      }
      sx[b] += xs[j]
      sy[b] += ys[j]
      cnt[b]++
    }
    for (let c = 0; c < k; c++)
      if (cnt[c]) {
        cx[c] = sx[c] / cnt[c]
        cy[c] = sy[c] / cnt[c]
      }
  }
  // radius: area of the Voronoi cell among ALL group pixels would bias low on deep-only points; use the prior median, bounded
  return cx.map((x, c) => ({ x, y: cy[c], r: Math.min(rMax, Math.max(rMin, cnt[c] ? Math.min(prior.rMed * 1.15, Math.max(prior.rMed * 0.8, Math.sqrt((cnt[c] * pix.length) / pts.length / Math.PI))) : prior.rMed)) }))
}

export interface GroupDecision {
  best: GroupConfig
  runnerUp: GroupConfig | null
  /** J(runner-up) − J(best), in units of one typical colony. */
  gap: number | null
  /**
   * gap / contested area: the colonies that differ between the two explanations
   * (unmatched disks), in units of one typical colony (floor 0.25). Evidence per
   * contested colony — not biased against small colonies like the raw gap.
   */
  relativeGap: number | null
  /** The best K lies on an open edge of the swept range: the table may miss a better K. */
  incomplete: boolean
}

/** Area (in typical-colony units) of disks in `a` with no counterpart in `b` and vice versa. */
export function contestedArea(a: readonly Circle3[], b: readonly Circle3[], rMed: number): number {
  const usedB = new Uint8Array(b.length)
  let area = 0
  for (const d of a) {
    let best = -1
    let bd = Infinity
    b.forEach((e, j) => {
      if (usedB[j]) return
      const dist = Math.hypot(d.x - e.x, d.y - e.y)
      if (dist < 0.5 * Math.max(d.r, e.r) && Math.abs(Math.log(d.r / e.r)) < 0.3 && dist < bd) {
        bd = dist
        best = j
      }
    })
    if (best >= 0) usedB[best] = 1
    else area += (d.r / rMed) ** 2
  }
  b.forEach((e, j) => {
    if (!usedB[j]) area += (e.r / rMed) ** 2
  })
  return area
}

/** Pick the best and runner-up configuration of a group for the given weights and prior spread. */
export function decideGroup(g: GroupFit, wts: { lambda: number; beta: number; huber: number }, logR: number, s: number, rMed = Math.exp(logR)): GroupDecision {
  const scored = g.configs.map((c) => ({ c, j: configScore(c, wts, logR, s) })).sort((a, b) => a.j - b.j)
  const best = scored[0]
  const runner = scored[1] ?? null
  const k = best.c.k
  const incomplete = (k === g.kRange[1] && k < MAX_SWEEP_K && g.configs.length > 1) || (k === g.kRange[0] && k > 0 && g.configs.length > 1)
  const gap = runner ? runner.j - best.j : null
  const relativeGap = runner && gap !== null ? gap / Math.max(0.25, contestedArea(best.c.disks, runner.c.disks, rMed)) : null
  return { best: best.c, runnerUp: runner?.c ?? null, gap, relativeGap, incomplete }
}

/** Best explanation of a whole cluster under the fit weights (tests and tools). */
export function summarizeSolution(sol: ClusterSolution, params: ClusterFitParams): { colonies: Circle3[]; chosenK: number; gap: number | null; fixedIds: string[] } {
  const ds = sol.groups.map((g) => decideGroup(g, params.weights, params.prior.logR, params.prior.s))
  const gaps = ds.map((d) => d.gap).filter((g): g is number => g !== null)
  return {
    colonies: ds.flatMap((d) => d.best.disks),
    chosenK: ds.reduce((a, d) => a + d.best.k, 0),
    gap: gaps.length ? Math.min(...gaps) : null,
    fixedIds: sol.groups.flatMap((g) => g.fixedIds),
  }
}

/** Everything the fitter computed that does not depend on λ (sensitivity) or the prior width. */
export interface FitterState {
  key: string
  clusters: {
    label: number
    stats: { minX: number; minY: number; maxX: number; maxY: number; area: number }
    x0: number
    y0: number
    /** Patch width (row stride of sol.groupOf). */
    pw: number
    tooLarge: boolean
    fixedIds: string[]
    sol: ClusterSolution | null
    /** Inputs kept so one cluster can be refitted when its table is incomplete. */
    refit: () => ClusterSolution
  }[]
  /** Cluster labels of the mask (analysis px). */
  labels: Int32Array
  width: number
  logCandidateThreshold: number
  baseWeights: FitWeights
}

/** Reference sensitivity at which the configuration tables are built. */
const TABLE_SENSITIVITY = 0.5

async function buildFitterState(ctx: MethodContext, seedPts: { x: number; y: number }[], key: string): Promise<FitterState> {
  const { prior, settings } = ctx
  const sp = sensitivityParams(TABLE_SENSITIVITY)
  const baseWeights: FitWeights = { ...DEFAULT_WEIGHTS, lambda: sp.lambda, ...settings.fitWeights }
  // the mask does not follow the sensitivity slider (so the expensive part can be cached)
  const mask = foregroundMask(ctx, maskThresholdAt(ctx, TABLE_SENSITIVITY))
  await ctx.checkpoint(0.5)
  // LoG candidates per cluster patch (no whole-image LoG stack in memory), with a
  // permissive threshold relative to the seeds' response: they only propose
  const radii = priorRadii(prior)
  const logThreshold = sp.logFrac * 0.6 * (seedLogReference(ctx.F, seedPts, radii, prior) ?? 0.5 * ctx.contrastRef)
  await ctx.checkpoint(0.55)
  const cl = labelComponents(mask, 8)
  const rMaxFit = Math.max(prior.rHi * 1.3, prior.rMed * 1.8)
  const pad = Math.ceil(rMaxFit) + 2
  const a0 = Math.PI * prior.rMed * prior.rMed
  const params: ClusterFitParams = {
    prior,
    weights: baseWeights,
    contrastRef: ctx.contrastRef,
    contrastLo: ctx.contrastLo,
    tau: Math.max(1.5, 0.25 * prior.rMed),
    rMaxFit,
    coreLevel: 0.75 * ctx.contrastRef,
  }
  const clusters: FitterState['clusters'] = []
  let lastYield = Date.now()
  const order = cl.stats.slice().sort((a, b) => a.minY - b.minY || a.minX - b.minX)
  for (let ci = 0; ci < order.length; ci++) {
    const st = order[ci]
    if (Date.now() - lastYield > 40) {
      await ctx.checkpoint(0.55 + 0.43 * (ci / order.length))
      lastYield = Date.now()
    }
    const x0 = Math.max(0, st.minX - pad)
    const y0 = Math.max(0, st.minY - pad)
    const x1 = Math.min(mask.width - 1, st.maxX + pad)
    const y1 = Math.min(mask.height - 1, st.maxY + pad)
    const pw = x1 - x0 + 1
    const ph = y1 - y0 + 1
    const pm = makeMask(pw, ph)
    const pF: Plane = { width: pw, height: ph, data: new Float32Array(pw * ph) }
    for (let y = 0; y < ph; y++)
      for (let x = 0; x < pw; x++) {
        const i = (y + y0) * mask.width + x + x0
        pm.data[y * pw + x] = cl.labels[i] === st.label ? 1 : 0
        pF.data[y * pw + x] = ctx.F.data[i]
      }
    const fixedHere = ctx.fixed
      .filter((f) => {
        const xi = Math.floor(f.x)
        const yi = Math.floor(f.y)
        return xi >= 0 && yi >= 0 && xi < mask.width && yi < mask.height && cl.labels[yi * mask.width + xi] === st.label
      })
      .map((f) => ({ ...f, x: f.x - x0, y: f.y - y0 }))
    const tooBig = st.area > settings.kMax * a0
    const blobs: Circle3[] = tooBig ? [] : detectBlobsLoG(pF, radii, logThreshold, pm.data, 0.7).blobs.map((b) => ({ x: b.x, y: b.y, r: b.r }))
    const tooLarge = tooBig
    const refit = (w: FitWeights = baseWeights, s = prior.s) => fitCluster(pm, pF, x0, y0, { ...params, weights: w, prior: { ...prior, s } }, fixedHere, blobs)
    clusters.push({
      label: st.label,
      stats: st,
      x0,
      y0,
      pw,
      tooLarge,
      fixedIds: fixedHere.map((f) => f.id),
      sol: tooLarge ? null : refit(),
      refit: () => refit(),
    })
  }
  return { key, clusters, labels: cl.labels, width: mask.width, logCandidateThreshold: logThreshold, baseWeights }
}

/** Median LoG response at the seeds (scale nearest r̃), from small patches around each seed. */
function seedLogReference(F: Plane, seeds: { x: number; y: number }[], radii: number[], prior: AnalysisPrior): number | null {
  if (!seeds.length) return null
  const k = radii.reduce((bi, r, i) => (Math.abs(r - prior.rMed) < Math.abs(radii[bi] - prior.rMed) ? i : bi), 0)
  const half = Math.ceil(3 * prior.rHi + 3 * (radii[k] / Math.SQRT2))
  const vals: number[] = []
  for (const s of seeds) {
    const x0 = Math.floor(s.x) - half
    const y0 = Math.floor(s.y) - half
    const patch = cropPlane(F, x0, y0, 2 * half + 1, 2 * half + 1)
    const resp = logResponse(patch, radii[k] / Math.SQRT2)
    let best = -Infinity
    const rr = Math.max(1, Math.round(prior.rMed * 0.3))
    for (let dy = -rr; dy <= rr; dy++) for (let dx = -rr; dx <= rr; dx++) best = Math.max(best, resp.data[(half + dy) * patch.width + half + dx])
    if (Number.isFinite(best)) vals.push(best)
  }
  vals.sort((a, b) => a - b)
  return vals.length ? vals[Math.floor(vals.length / 2)] : null
}

/** Mask threshold for a given sensitivity (the fitter uses the table sensitivity). */
function maskThresholdAt(ctx: MethodContext, sensitivity: number): number {
  const { thrFrac, noiseK } = sensitivityParams(sensitivity)
  return Math.max(noiseK * ctx.noise, thrFrac * ctx.contrastRef)
}

export async function runFitter(ctx: MethodContext, seedPts: { x: number; y: number }[], cached?: { key: string; get: () => FitterState | null; set: (s: FitterState) => void }): Promise<MethodOutput> {
  const { prior, prep, settings } = ctx
  const scale = prep.scale
  const t0 = Date.now()
  let state = cached?.get() ?? null
  const reused = !!state && state.key === cached?.key
  if (!reused) {
    state = await buildFitterState(ctx, seedPts, cached?.key ?? '')
    cached?.set(state)
  } else await ctx.checkpoint(0.6)
  const st = state!
  // scoring for THIS run: λ from the sensitivity, s from the prior width
  const wts = { ...st.baseWeights, lambda: sensitivityParams(settings.sensitivity).lambda, ...(settings.fitWeights?.lambda !== undefined ? { lambda: settings.fitWeights.lambda } : {}) }
  const s = prior.s * settings.priorWidth
  const suggestions: Suggestion[] = []
  const clustersOut: ClusterResult[] = []
  const labels = new Int32Array(st.labels.length)
  const counts = { ok: 0, review: 0, tooLarge: 0, refitted: 0 }
  let nextId = 1
  for (const c of st.clusters) {
    const { minX, minY, maxX, maxY, area } = c.stats
    if (c.tooLarge || !c.sol) {
      counts.tooLarge++
      const id = clusterId(nextId++)
      clustersOut.push({ clusterId: id, bbox: bboxToOriginal(minX, minY, maxX, maxY, scale), area: area / (scale * scale), fixedIds: c.fixedIds, chosenK: 0, runnerUpK: null, objectiveGap: null, status: 'too-large' })
      for (let i = 0; i < st.labels.length; i++) if (st.labels[i] === c.label) labels[i] = nextId - 1
      continue
    }
    let decisions = c.sol.groups.map((g) => decideGroup(g, wts, prior.logR, s, prior.rMed))
    if (decisions.some((d) => d.incomplete) && (wts.lambda !== st.baseWeights.lambda || settings.priorWidth !== 1)) {
      // the stored table cannot answer this setting: refit the cluster under the new weights
      c.sol = c.refit()
      decisions = c.sol.groups.map((g) => decideGroup(g, wts, prior.logR, s, prior.rMed))
      counts.refitted++
    }
    const groupIds = c.sol.groups.map(() => nextId++)
    c.sol.groups.forEach((g, gi) => {
      const d = decisions[gi]
      const id = clusterId(groupIds[gi])
      // "is it a colony at all?" (runner-up K = 0) is answered by tap-to-reject, not by a "k or k+1?" region
      const existenceOnly = d.runnerUp !== null && d.runnerUp.k === 0 && g.fixedIds.length === 0
      const review = !existenceOnly && d.relativeGap !== null && d.relativeGap < settings.reviewGap
      if (review) counts.review++
      else counts.ok++
      const toOrig = (q: Circle3) => ({ x: (q.x + c.x0) / scale, y: (q.y + c.y0) / scale, r: q.r / scale })
      for (const q of d.best.disks) suggestions.push({ ...toOrig(q), score: d.relativeGap === null ? null : round3(d.relativeGap), clusterId: id, status: review ? 'review' : 'ok' })
      const [gx0, gy0, gx1, gy1] = g.bbox
      const result: ClusterResult = {
        clusterId: id,
        bbox: bboxToOriginal(gx0 + c.x0, gy0 + c.y0, gx1 + c.x0, gy1 + c.y0, scale),
        area: g.area / (scale * scale),
        fixedIds: g.fixedIds,
        chosenK: d.best.k,
        runnerUpK: d.runnerUp?.k ?? null,
        objectiveGap: d.gap === null ? null : round3(d.gap),
        relativeGap: d.relativeGap === null ? null : round3(d.relativeGap),
        status: review ? 'review' : 'ok',
      }
      if (review && d.runnerUp) result.alternative = { k: d.runnerUp.k, colonies: d.runnerUp.disks.map(toOrig) }
      clustersOut.push(result)
    })
    // group label raster (analysis px)
    for (let y = minY; y <= maxY; y++)
      for (let x = minX; x <= maxX; x++) {
        const i = y * st.width + x
        if (st.labels[i] !== c.label) continue
        const g = c.sol.groupOf[(y - c.y0) * c.pw + (x - c.x0)]
        labels[i] = g >= 0 ? groupIds[g] : 0
      }
  }
  return {
    suggestions,
    clusters: clustersOut,
    diagnostics: {
      weights: wts,
      priorS: round3(s),
      logCandidateThreshold: st.logCandidateThreshold,
      reusedFit: reused,
      clustersRefitted: counts.refitted,
      groupsOk: counts.ok,
      groupsReview: counts.review,
      clustersTooLarge: counts.tooLarge,
      emitMs: Date.now() - t0,
    },
    labels,
  }
}

const round3 = (v: number) => Math.round(v * 1000) / 1000
