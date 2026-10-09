/**
 * Mainline H: seed-constrained union-of-circles fitter (method brief §3–5).
 *
 * Per foreground cluster (connected component of the mask):
 *  1. Partition into UNITS (sub-clusters): watershed basins of the lightly
 *     smoothed contrast plane (plus a little distance-transform depth), so cuts
 *     follow the darker seams between colonies; neighbouring basins merge when
 *     there is evidence of neither a seam nor a neck, up to ~6 typical colonies;
 *     a unit larger than ~10 colonies is cut geometrically (k-means on its
 *     pixels). Units are fitted independently: the other units' pixels are
 *     "someone else's" (covering them costs half a background pixel, leaving
 *     them uncovered costs nothing).
 *  2. Objective, in units of ONE TYPICAL COLONY (A0 = π r_med²):
 *       J = (FN + wFP·FP)/A0                   soft mask: Σ m over uncovered px + Σ (1 − m) over covered px,
 *                                              m = smoothstep of F over 0.3–0.7 × the unit's brightness (0 on background and
 *                                              in the 1–2 px seams between touching colonies, 1 inside)
 *         + α Σ_i E_i                          edge: exposed disk boundary away from the observed boundary
 *         + β Σ_i huber±((log r_i − μ)/s)      seed-derived size prior (oversize ×2, undersize ×0.5; 'brief': ½ z²)
 *         + γ Σ_i A_i                          appearance: disk interior dimmer than the seeds, or ring-like
 *         + λ Σ_i (r_i/r_med)²                 count penalty, proportional to disk area ('brief': λ K)
 *         + ω Σ_pairs overlap                  deep overlaps (centres closer than 0.7 (r_i + r_j))
 *     Existing annotations (any group) are fixed disks: they cover pixels and
 *     hide boundaries but pay no prior/appearance/count terms and never move.
 *  3. A TRUE K SWEEP per unit: K_est = open area / A0, and for every K in
 *     0 … K_max = min(⌈2 K_est⌉ + 2, 30) the best K-circle configuration from
 *     several starts (previous K plus a disk at the residual peak; farthest-point
 *     k-means; distance/core-peak seeding; seeded random k-means++), each jointly
 *     refined in (x, y, r); then a backward pass (K+1 minus its weakest disk).
 *     Deterministic: a seeded RNG per unit, no dependence on the slider.
 *  4. The sweep tables store, per K, the best few configurations with their
 *     λ- and prior-free objective, so a slider change (λ, prior width) only
 *     re-scores: pick the minimum over all K; the runner-up is the best
 *     configuration of any OTHER K. A unit is flagged for review when its chosen
 *     K is not stable within a small slider neighbourhood (sensitivity ± 0.05,
 *     size tolerance ± 10 %).
 *
 * All terms are evaluated incrementally on the unit patch raster, so the
 * cost of a move is O(disk area + neighbouring boundary samples).
 */
import { labelComponents } from '../image/components.ts'
import { distanceTransform, squaredDistanceTo } from '../image/distance.ts'
import { gaussianBlur } from '../image/filters.ts'
import { localMaxima } from '../image/blobs.ts'
import { makeMask, type Mask, type Plane } from '../image/plane.ts'
import { watershed } from '../image/watershed.ts'
import type { ClusterResult, Suggestion } from '../types.ts'
import { bboxToOriginal, clusterId, foregroundMask, sensitivityParams, type AnalysisPrior, type FixedColony, type MethodContext } from './common.ts'
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
  /** Multiplier on the size cost of disks LARGER than the prior (1 = symmetric). */
  oversize: number
  /** Multiplier on the size cost of disks SMALLER than the prior (seeds are biased to large colonies). */
  undersize: number
  /** 1: count penalty λ·Σ(r_i/r̃)² (area-proportional); 0: λ·K (the method brief). */
  areaCount: number
}

export type FitObjective = 'tuned' | 'brief'

/** Size prior and count shape only (the parts that enter the stored configuration tables). */
export type ScoreWeights = Pick<FitWeights, 'lambda' | 'beta' | 'huber' | 'oversize' | 'undersize' | 'areaCount'>

/**
 * Objective variants (lambda comes from the sensitivity slider):
 *  - 'tuned': this repo's version — area-proportional count, asymmetric Huber prior
 *    (oversize ×2), appearance term γ and overlap term ω.
 *  - 'brief': exactly the product owner's formula — L_mask + α L_boundary
 *    + β Σ ((log r − μ)/s)² + λ K; γ = ω = 0. (β applies to ½ z², as in 'tuned'.)
 */
export const OBJECTIVES: Record<FitObjective, Omit<FitWeights, 'lambda'>> = {
  tuned: { alpha: 0.5, beta: 0.6, gamma: 0.5, wFP: 0.5, huber: 2, omega: 1, oversize: 2, undersize: 0.5, areaCount: 1 },
  brief: { alpha: 0.5, beta: 0.6, gamma: 0, wFP: 0.5, huber: Infinity, omega: 0, oversize: 1, undersize: 1, areaCount: 0 },
}

export const DEFAULT_WEIGHTS: Omit<FitWeights, 'lambda'> = OBJECTIVES.tuned

/** Count term of one disk under the variant. */
export const countTerm = (r: number, rMed: number, areaCount: number): number => (areaCount ? (r / rMed) ** 2 : 1)

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
  /** F level of the "core" mask used for extra start positions (≈ 0.75 × seed contrast). */
  coreLevel: number
}

/** Weight of exposed disk boundary that lies INSIDE the foreground, relative to on the background. */
export const INTERIOR_EDGE = 0.25
/** Cost of covering a pixel that belongs to a NEIGHBOURING unit (relative to a background pixel). */
export const NEIGHBOUR_COVER = 0.5

type Bounds = { minX: number; minY: number; maxX: number; maxY: number }

/** Fit state for one unit patch. Exposed for unit tests. */
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
  /** Σ over uncovered pixels of their uncovered cost (m on own pixels, 0 elsewhere). */
  FN = 0
  /** Σ over covered pixels of their covered cost (1 − m own, NEIGHBOUR_COVER on other units, 1 on background). */
  FP = 0
  /** Per-pixel soft membership m ∈ [0, 1] (own pixels; 0 elsewhere). */
  readonly mIn: Float32Array
  private readonly uncov: Float32Array
  private readonly cov: Float32Array
  sumEdge = 0
  sumPrior = 0
  sumApp = 0
  /** Σ (r_i / r_med)² over free disks (or K for the brief's flat count). */
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

  /**
   * @param mask  foreground of the whole cluster (patch raster)
   * @param own   pixels of the unit being fitted (default: the whole mask)
   */
  constructor(mask: Mask, F: Plane, ox: number, oy: number, p: ClusterFitParams, own?: Uint8Array) {
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
    const n = this.M.length
    const mine = own ?? this.M
    // soft membership: smoothstep of F between 0.3 and 0.7 of the unit's own brightness (90th
    // percentile, at least half the seed contrast). Uncovered pixels cost m, covered pixels 1 − m:
    // seams between touching colonies argue against a disk spanning them. Relative to the unit (not
    // the seeds) so colonies dimmer than the seeds are not priced out.
    this.mIn = new Float32Array(n)
    this.uncov = new Float32Array(n)
    this.cov = new Float32Array(n)
    const inside: number[] = []
    for (let i = 0; i < n; i++) if (mine[i]) inside.push(F.data[i])
    inside.sort((a, b) => a - b)
    const refC = Math.max(0.5 * p.contrastRef, inside.length ? inside[Math.floor(0.9 * (inside.length - 1))] : p.contrastRef)
    const lo = 0.3 * refC
    const hi = 0.7 * refC
    for (let i = 0; i < n; i++) {
      if (mine[i]) {
        const t = Math.min(1, Math.max(0, (F.data[i] - lo) / (hi - lo)))
        const m = t * t * (3 - 2 * t)
        this.mIn[i] = m
        this.uncov[i] = m
        this.cov[i] = 1 - m
        this.FN += m
      } else this.cov[i] = this.M[i] ? NEIGHBOUR_COVER : 1
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
        for (const d of this.grid.get(this.key(cx, cy)) ?? []) {
          const lim = d.r + r + this.hideTol
          if (d.alive && (d.x - x) ** 2 + (d.y - y) ** 2 < lim * lim) out.push(d)
        }
    return out
  }

  private overlap(a: Circle3, b: Circle3): number {
    const v = 0.7 * (a.r + b.r) - Math.hypot(a.x - b.x, a.y - b.y)
    return v > 0 ? (v * v) / (this.p.prior.rMed * this.p.prior.rMed) : 0
  }

  private priorCost(r: number): number {
    return sizeCost(r, this.p.prior.logR, this.p.prior.s, this.p.weights.huber, this.p.weights.oversize, this.p.weights.undersize)
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

  /** Misalignment cost of one boundary sample at (px, py). */
  private sampleCost(px: number, py: number): number {
    const xi = Math.floor(px)
    const yi = Math.floor(py)
    if (xi < 0 || yi < 0 || xi >= this.w || yi >= this.h) return 1
    const i = yi * this.w + xi
    const d = this.dEdge[i]
    const tau2 = this.p.tau * this.p.tau
    const c = Math.min(d * d, tau2) / tau2
    // a disk edge running through foreground (where a neighbour is not explained yet) is
    // mostly priced by the mask term; only an edge out on the background is a true misfit
    return this.M[i] ? INTERIOR_EDGE * c : c
  }

  private makeDisk(x: number, y: number, r: number, fixed: boolean, id?: string): Disk {
    const n = samplesFor(r)
    const [cs, sn] = trig(n)
    const sx = new Float32Array(n)
    const sy = new Float32Array(n)
    const cost = new Float32Array(n)
    for (let k = 0; k < n; k++) {
      const px = x + r * cs[k]
      const py = y + r * sn[k]
      sx[k] = px
      sy[k] = py
      cost[k] = this.sampleCost(px, py)
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
          this.FN -= this.uncov[i]
          this.FP += this.cov[i]
        }
        this.coverPx[i]++
      }
    }
    // edge term: hide neighbours' samples, count own exposure
    const nb = this.neighbours(x, y, r)
    const hideR2 = (r + this.hideTol) ** 2
    for (const o of nb) {
      for (let k = 0; k < o.cover.length; k++) {
        if ((o.sx[k] - x) ** 2 + (o.sy[k] - y) ** 2 < hideR2) {
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
      for (const o of nb) if ((d.sx[k] - o.x) ** 2 + (d.sy[k] - o.y) ** 2 < (o.r + this.hideTol) ** 2) c++
      d.cover[k] = c
      if (c === 0) e += d.cost[k] * d.sw
    }
    d.edge = e
    this.sumEdge += e
    for (const o of nb) this.sumOverlap += this.overlap(d, o)
    if (!d.fixed) {
      this.sumPrior += d.prior
      this.sumApp += d.app
      this.sumCount += countTerm(d.r, this.p.prior.rMed, this.p.weights.areaCount)
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
          this.FN += this.uncov[i]
          this.FP -= this.cov[i]
        }
      }
    }
    const nb = this.neighbours(x, y, r)
    const hideR2 = (r + this.hideTol) ** 2
    for (const o of nb) {
      for (let k = 0; k < o.cover.length; k++) {
        if ((o.sx[k] - x) ** 2 + (o.sy[k] - y) ** 2 < hideR2) {
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
      this.sumCount -= countTerm(d.r, this.p.prior.rMed, this.p.weights.areaCount)
      this.kNew--
    }
  }

  /** ΔJ of adding a free circle, without changing the state (read-only; equals insert's change of J). */
  deltaAdd(x: number, y: number, r: number): number {
    const wt = this.p.weights
    let dFN = 0
    let dFP = 0
    const r2 = r * r
    for (let yy = Math.max(0, Math.floor(y - r)); yy < Math.min(this.h, Math.ceil(y + r) + 1); yy++) {
      const dy = yy + 0.5 - y
      for (let xx = Math.max(0, Math.floor(x - r)); xx < Math.min(this.w, Math.ceil(x + r) + 1); xx++) {
        const dx = xx + 0.5 - x
        if (dx * dx + dy * dy > r2) continue
        const i = yy * this.w + xx
        if (this.coverPx[i] === 0) {
          dFN -= this.uncov[i]
          dFP += this.cov[i]
        }
      }
    }
    const nb = this.neighbours(x, y, r)
    const hideR2 = (r + this.hideTol) ** 2
    let dEdge = 0
    let dOverlap = 0
    for (const o of nb) {
      for (let k = 0; k < o.cover.length; k++) if (o.cover[k] === 0 && (o.sx[k] - x) ** 2 + (o.sy[k] - y) ** 2 < hideR2) dEdge -= o.cost[k] * o.sw
      dOverlap += this.overlap({ x, y, r }, o)
    }
    const n = samplesFor(r)
    const [cs, sn] = trig(n)
    const sw = r / (n * this.p.prior.rMed)
    for (let k = 0; k < n; k++) {
      const px = x + r * cs[k]
      const py = y + r * sn[k]
      let hidden = false
      for (const o of nb)
        if ((px - o.x) ** 2 + (py - o.y) ** 2 < (o.r + this.hideTol) ** 2) {
          hidden = true
          break
        }
      if (!hidden) dEdge += this.sampleCost(px, py) * sw
    }
    return (
      (dFN + wt.wFP * dFP) / this.a0 +
      wt.alpha * dEdge +
      wt.beta * this.priorCost(r) +
      wt.gamma * this.appearanceCost(x, y, r) +
      wt.lambda * countTerm(r, this.p.prior.rMed, wt.areaCount) +
      wt.omega * dOverlap
    )
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
  refine(d: Disk, bounds: Bounds, rMin: number, maxIt = 8): Disk {
    let cur = d
    for (const step of [1, 0.5]) {
      for (let it = 0; it < maxIt; it++) {
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

/** Boundary samples of a disk of radius r. */
const samplesFor = (r: number): number => Math.max(16, Math.ceil(2 * Math.PI * r))
const trigCache = new Map<number, [Float64Array, Float64Array]>()
/** cos/sin of k/n · 2π, cached per n. */
function trig(n: number): [Float64Array, Float64Array] {
  let t = trigCache.get(n)
  if (!t) {
    const c = new Float64Array(n)
    const s = new Float64Array(n)
    for (let k = 0; k < n; k++) {
      c[k] = Math.cos((k / n) * 2 * Math.PI)
      s[k] = Math.sin((k / n) * 2 * Math.PI)
    }
    trigCache.set(n, (t = [c, s]))
  }
  return t
}

// ---------------------------------------------------------------------------
// Size prior and scoring
// ---------------------------------------------------------------------------

/**
 * Asymmetric Huber size cost. A disk LARGER than the prior is the typical
 * signature of merged colonies explained as one (the field failure "a cluster
 * of 3 became one"), while colonies smaller than the seeds are common and
 * legitimate, so the upper side counts double. huber = ∞ and both
 * multipliers 1 give the brief's ½ z².
 */
export function sizeCost(r: number, logR: number, s: number, huber: number, oversize: number, undersize = 1): number {
  const zs = (Math.log(r) - logR) / s
  const z = Math.abs(zs)
  const c = z <= huber ? 0.5 * z * z : huber * (z - 0.5 * huber)
  return zs > 0 ? oversize * c : undersize * c
}

export function priorSum(disks: readonly Circle3[], logR: number, s: number, huber: number, oversize: number, undersize = 1): number {
  let t = 0
  for (const d of disks) t += sizeCost(d.r, logR, s, huber, oversize, undersize)
  return t
}

/** One explanation of a unit: K new colonies and the λ/prior-free part of J. */
export interface GroupConfig {
  k: number
  /** Cluster-patch coordinates. */
  disks: Circle3[]
  /** J of the unit with this config, minus its count and size-prior terms. */
  base: number
  /** Σ (r_i / r̃)² (or K), multiplies λ. */
  count: number
}

/** Score of a stored configuration for the given count penalty and prior spread. */
export function configScore(c: GroupConfig, w: ScoreWeights, logR: number, s: number): number {
  return c.base + w.lambda * c.count + w.beta * priorSum(c.disks, logR, s, w.huber, w.oversize, w.undersize)
}

export interface GroupFit {
  /** Configurations kept by the sweep (the best few per K), sorted by k. */
  configs: GroupConfig[]
  fixedIds: string[]
  /** Inclusive cluster-patch bbox of the unit's pixels. */
  bbox: [number, number, number, number]
  /** Foreground pixels of the unit. */
  area: number
  /** Open area (not covered by existing colonies) / A0. */
  kEst: number
  /** Swept K range (inclusive). */
  kRange: [number, number]
}

export interface ClusterSolution {
  groups: GroupFit[]
  /** Cluster-patch raster: unit index per foreground pixel, −1 elsewhere. */
  groupOf: Int32Array
}

/** Hard cap on K per unit (the sweep cost grows ~K_max²). */
export const SWEEP_K_CAP = 30
/** Basins are merged into units up to this many typical colonies. */
const UNIT_MERGE_EST = 6
/** A unit larger than this is cut geometrically (k-means) before the sweep. */
const UNIT_SPLIT_EST = 10
/** Basins whose distance-transform saddle is at least this fraction of the shallower basin's depth have a wide neck. */
const NECK = 0.7
/** Basins whose brightness saddle is at least this fraction of the dimmer peak show no seam between them. */
const SEAM = 0.85
/**
 * Recall bias for "colony or nothing?": when the best explanation of a unit is
 * empty but colonies cost less than this much more (typical-colony units), the
 * colonies are suggested (rejecting is one tap, a miss is a manual add).
 */
const EXISTENCE_MARGIN = 0.05
/** Configurations kept per K (for re-scoring under other λ / prior widths). */
const KEEP_PER_K = 3
/** Smallest λ the slider can produce: the sweep must cover the best K at λ = LAMBDA_MIN. */
const LAMBDA_MIN = 0

// ---------------------------------------------------------------------------
// Partition: brightness basins → units
// ---------------------------------------------------------------------------

/**
 * Split a cluster into units. Basins: watershed of the lightly smoothed contrast
 * plane F from its maxima, so cuts run along the darker seams between colonies
 * (a distance transform sees no seam inside a dense streak). Two neighbouring
 * basins join when there is evidence of neither a seam (brightness saddle ≥ SEAM
 * × the dimmer peak) nor a neck (distance-transform saddle ≥ NECK × the shallower
 * depth), largest seam ratio first, up to UNIT_MERGE_EST colonies; basins smaller
 * than 0.35 colonies join their brightest neighbour; units larger than
 * UNIT_SPLIT_EST colonies are cut by k-means. Deterministic. Returns the unit
 * index per pixel (−1 off the mask).
 */
export function partitionCluster(mask: Mask, F: Plane, prior: AnalysisPrior): { unitOf: Int32Array; n: number } {
  const w = mask.width
  const h = mask.height
  const N = w * h
  const a0 = Math.PI * prior.rMed * prior.rMed
  const dt = distanceTransform(mask)
  const Fm: Plane = { width: w, height: h, data: new Float32Array(N) }
  for (let i = 0; i < N; i++) Fm.data[i] = mask.data[i] ? Math.max(0, F.data[i]) : 0
  const fs = gaussianBlur(Fm, Math.max(0.7, 0.2 * prior.rMed))
  for (let i = 0; i < N; i++) if (!mask.data[i]) fs.data[i] = 0
  // flooding landscape: brightness (seams) plus a little depth (necks), both normalised; uniformly
  // bright colonies (no brightness peak of their own) still get a basin from the depth term
  const inside: number[] = []
  for (let i = 0; i < N; i++) if (mask.data[i]) inside.push(fs.data[i])
  inside.sort((a, b) => a - b)
  const refF = Math.max(1e-6, inside.length ? inside[Math.floor(0.9 * (inside.length - 1))] : 1)
  const land: Plane = { width: w, height: h, data: new Float32Array(N) }
  for (let i = 0; i < N; i++) if (mask.data[i]) land.data[i] = fs.data[i] / refF + 0.5 * Math.min(1, dt.data[i] / prior.rMed)
  // markers: maxima of the landscape and of the distance transform (over-segmentation is fine; merging follows)
  const markers = new Int32Array(N)
  let nb = 0
  const mr = Math.max(1, Math.round(0.35 * prior.rMed))
  for (const p of [...localMaxima(land, mr, 1e-6, mask.data), ...localMaxima(dt, mr, Math.max(0.5, 0.25 * prior.rLo), mask.data)]) {
    const i = Math.floor(p.y) * w + Math.floor(p.x)
    if (!markers[i]) markers[i] = ++nb
  }
  if (nb === 0) {
    let best = -1
    for (let i = 0; i < N; i++) if (mask.data[i] && (best < 0 || dt.data[i] > dt.data[best])) best = i
    if (best < 0) return { unitOf: new Int32Array(N).fill(-1), n: 0 }
    markers[best] = ++nb
  }
  const cost = { width: w, height: h, data: new Float32Array(N) }
  for (let i = 0; i < N; i++) cost.data[i] = -land.data[i]
  const lab = watershed(cost, markers, mask.data)
  for (let i = 0; i < N; i++) if (mask.data[i] && !lab[i]) lab[i] = 1
  // basin stats
  const area = new Float64Array(nb + 1)
  const depth = new Float64Array(nb + 1)
  const peakF = new Float64Array(nb + 1)
  for (let i = 0; i < N; i++) {
    const l = lab[i]
    if (!l) continue
    area[l]++
    if (dt.data[i] > depth[l]) depth[l] = dt.data[i]
    if (fs.data[i] > peakF[l]) peakF[l] = fs.data[i]
  }
  // saddles between adjacent basins: max over the shared boundary of min(·_i, ·_j)
  const sadD = new Map<number, number>()
  const sadF = new Map<number, number>()
  const pairKey = (a: number, b: number) => (a < b ? a * (nb + 1) + b : b * (nb + 1) + a)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const a = lab[i]
      if (!a) continue
      for (const j of [x + 1 < w ? i + 1 : -1, y + 1 < h ? i + w : -1]) {
        if (j < 0) continue
        const b = lab[j]
        if (!b || b === a) continue
        const k = pairKey(a, b)
        const vd = Math.min(dt.data[i], dt.data[j])
        if (vd > (sadD.get(k) ?? -1)) sadD.set(k, vd)
        const vf = Math.min(fs.data[i], fs.data[j])
        if (vf > (sadF.get(k) ?? -1)) sadF.set(k, vf)
      }
    }
  const parent = Array.from({ length: nb + 1 }, (_, i) => i)
  const uArea = Array.from(area)
  const find = (a: number): number => (parent[a] === a ? a : (parent[a] = find(parent[a])))
  const union = (a: number, b: number) => {
    const ra = find(a)
    const rb = find(b)
    if (ra === rb) return
    const [lo, hi] = ra < rb ? [ra, rb] : [rb, ra]
    parent[hi] = lo
    uArea[lo] += uArea[hi]
  }
  const edges = [...sadD.entries()].map(([k, vd]) => {
    const a = Math.floor(k / (nb + 1))
    const b = k % (nb + 1)
    const vf = sadF.get(k)!
    return { a, b, vf, neck: vd / Math.max(1e-6, Math.min(depth[a], depth[b])), seam: vf / Math.max(1e-6, Math.min(peakF[a], peakF[b])) }
  })
  edges.sort((p, q) => q.seam - p.seam || q.neck - p.neck || p.a - q.a || p.b - q.b)
  for (const e of edges) {
    if (e.seam < SEAM || e.neck < NECK) continue
    const ra = find(e.a)
    const rb = find(e.b)
    if (ra !== rb && uArea[ra] + uArea[rb] <= UNIT_MERGE_EST * a0) union(ra, rb)
  }
  // tiny units (noise maxima, slivers, filled holes) join the neighbour across their brightest saddle
  edges.sort((p, q) => q.vf - p.vf || p.a - q.a || p.b - q.b)
  for (let pass = 0; pass < 2; pass++)
    for (const e of edges) {
      const ra = find(e.a)
      const rb = find(e.b)
      if (ra === rb) continue
      if (Math.min(uArea[ra], uArea[rb]) < 0.35 * a0) union(ra, rb)
    }
  // compact unit ids
  const ids = new Map<number, number>()
  const unitOf = new Int32Array(N).fill(-1)
  for (let i = 0; i < N; i++) {
    if (!lab[i]) continue
    const r = find(lab[i])
    let id = ids.get(r)
    if (id === undefined) ids.set(r, (id = ids.size))
    unitOf[i] = id
  }
  let n = ids.size
  // oversized units: geometric cut (k-means on pixel coordinates, deterministic init)
  const pixOf: number[][] = Array.from({ length: n }, () => [])
  for (let i = 0; i < N; i++) if (unitOf[i] >= 0) pixOf[unitOf[i]].push(i)
  for (let u = 0, n0 = n; u < n0; u++) {
    const pix = pixOf[u]
    const est = pix.length / a0
    if (est <= UNIT_SPLIT_EST) continue
    const parts = Math.ceil(est / UNIT_MERGE_EST)
    const assign = kmeansPixels(pix, w, dt, parts)
    for (let j = 0; j < pix.length; j++) if (assign[j] > 0) unitOf[pix[j]] = n + assign[j] - 1
    n += parts - 1
  }
  return { unitOf, n }
}

/** k-means on pixel coordinates: farthest-point init from the deepest pixel, 8 Lloyd iterations. */
function kmeansPixels(pix: number[], w: number, dt: Plane, k: number): Int32Array {
  const xs = pix.map((i) => (i % w) + 0.5)
  const ys = pix.map((i) => Math.floor(i / w) + 0.5)
  let first = 0
  for (let j = 1; j < pix.length; j++) if (dt.data[pix[j]] > dt.data[pix[first]]) first = j
  const cx = [xs[first]]
  const cy = [ys[first]]
  const md = xs.map((x, j) => Math.hypot(x - cx[0], ys[j] - cy[0]))
  while (cx.length < k) {
    let far = 0
    for (let j = 1; j < pix.length; j++) if (md[j] > md[far]) far = j
    cx.push(xs[far])
    cy.push(ys[far])
    for (let j = 0; j < pix.length; j++) md[j] = Math.min(md[j], Math.hypot(xs[j] - xs[far], ys[j] - ys[far]))
  }
  const assign = new Int32Array(pix.length)
  for (let it = 0; it < 8; it++) {
    const sx = new Float64Array(k)
    const sy = new Float64Array(k)
    const cnt = new Float64Array(k)
    for (let j = 0; j < pix.length; j++) {
      let b = 0
      let bd = Infinity
      for (let c = 0; c < k; c++) {
        const d = (xs[j] - cx[c]) ** 2 + (ys[j] - cy[c]) ** 2
        if (d < bd) {
          bd = d
          b = c
        }
      }
      assign[j] = b
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
  return assign
}

// ---------------------------------------------------------------------------
// The per-unit K sweep
// ---------------------------------------------------------------------------

/** Deterministic PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Per-K table of the best few distinct configurations under the table weights. */
class SweepTable {
  readonly byK = new Map<number, { c: GroupConfig; j: number }[]>()
  private readonly params: ClusterFitParams
  constructor(params: ClusterFitParams) {
    this.params = params
  }
  record(fit: ClusterFit, disks: readonly Circle3[]): void {
    const { prior, weights } = this.params
    const k = disks.length
    const count = disks.reduce((a, d) => a + countTerm(d.r, prior.rMed, weights.areaCount), 0)
    const j = fit.J()
    const base = j - weights.lambda * count - weights.beta * priorSum(disks, prior.logR, prior.s, weights.huber, weights.oversize, weights.undersize)
    const c: GroupConfig = { k, disks: disks.map(({ x, y, r }) => ({ x, y, r })), base, count }
    const list = this.byK.get(k) ?? []
    // the same explanation found twice (every disk matched): keep the better copy
    const same = list.findIndex((e) => sameConfig(e.c.disks, c.disks))
    if (same >= 0) {
      if (j < list[same].j) list[same] = { c, j }
    } else list.push({ c, j })
    list.sort((a, b) => a.j - b.j)
    if (list.length > KEEP_PER_K) list.length = KEEP_PER_K
    this.byK.set(k, list)
  }
  best(k: number): GroupConfig | null {
    return this.byK.get(k)?.[0]?.c ?? null
  }
  /** K of the best configuration under a different λ (same prior). */
  argminK(lambda: number): number {
    const { prior, weights } = this.params
    let bk = 0
    let bj = Infinity
    for (const [k, list] of this.byK)
      for (const e of list) {
        const j = configScore(e.c, { ...weights, lambda }, prior.logR, prior.s)
        if (j < bj - 1e-12 || (Math.abs(j - bj) <= 1e-12 && k < bk)) {
          bj = j
          bk = k
        }
      }
    return bk
  }
  configs(): GroupConfig[] {
    return [...this.byK.keys()].sort((a, b) => a - b).flatMap((k) => this.byK.get(k)!.map((e) => e.c))
  }
}

function sameConfig(a: readonly Circle3[], b: readonly Circle3[]): boolean {
  if (a.length !== b.length) return false
  const used = new Uint8Array(b.length)
  for (const d of a) {
    let hit = -1
    for (let j = 0; j < b.length; j++)
      if (!used[j] && Math.abs(d.x - b[j].x) < 0.75 && Math.abs(d.y - b[j].y) < 0.75 && Math.abs(d.r - b[j].r) < 0.75) {
        hit = j
        break
      }
    if (hit < 0) return false
    used[hit] = 1
  }
  return true
}

export interface UnitInput {
  /** Foreground of the whole cluster, unit patch raster. */
  mask: Mask
  F: Plane
  /** Pixels of this unit (patch raster). */
  own: Uint8Array
  /** Patch origin in analysis px. */
  ox: number
  oy: number
  /** Existing colonies overlapping the patch (patch coordinates). */
  fixed: FixedColony[]
  /** RNG seed (deterministic per unit). */
  seed: number
}

/**
 * The K sweep for one unit. For K = 0 … K_max: several starts, each jointly
 * refined; a backward pass from K_max down; extended while the best K at the
 * smallest slider λ sits on the upper edge. Returns the table in patch coordinates.
 */
export function sweepUnit(u: UnitInput, params: ClusterFitParams): { configs: GroupConfig[]; kRange: [number, number]; kEst: number } {
  const { prior } = params
  const fit = new ClusterFit(u.mask, u.F, u.ox, u.oy, params, u.own)
  for (const f of u.fixed) fit.add(f.x, f.y, f.r, true, f.id)
  const w = u.mask.width
  const h = u.mask.height
  const rMin = Math.max(1, 0.5 * prior.rLo)
  const ownPix: number[] = []
  let minX = w, minY = h, maxX = 0, maxY = 0
  for (let i = 0; i < u.own.length; i++)
    if (u.own[i]) {
      ownPix.push(i)
      const x = i % w
      const y = (i / w) | 0
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  // centres stay on (or right next to) the unit's own pixels
  const bounds: Bounds = { minX: minX - 1, minY: minY - 1, maxX: maxX + 2, maxY: maxY + 2 }
  const openPix = ownPix.filter((i) => fit.coverPx[i] === 0)
  const kEst = openPix.length / fit.a0
  let kMax = Math.min(SWEEP_K_CAP, Math.ceil(2 * kEst) + 2)
  const ownMask: Mask = { width: w, height: h, data: u.own }
  const dt = distanceTransform(ownMask)
  const pts = openPix.length ? openPix : ownPix
  const deep = pts.filter((i) => dt.data[i] >= 0.4 * prior.rLo)
  const kmPts = deep.length >= 4 ? deep : pts
  const peaks = unitPeaks(u, dt, params, ownPix)
  const rand = mulberry32(u.seed)
  const table = new SweepTable(params)
  const rClamp = (r: number) => Math.min(params.rMaxFit, Math.max(rMin, r))

  table.record(fit, [])
  const place = (cs: readonly Circle3[]) => cs.map((c) => fit.add(c.x, c.y, rClamp(c.r)))
  const jointRefine = (ds: Disk[], first: Disk | null, passes: number): Disk[] => {
    if (first) ds[ds.indexOf(first)] = fit.refine(first, bounds, rMin)
    for (let p = 0; p < passes; p++) {
      const j0 = fit.J()
      for (let q = 0; q < ds.length; q++) ds[q] = fit.refine(ds[q], bounds, rMin, 6)
      if (j0 - fit.J() < 1e-4) break
    }
    return ds
  }
  const seen = new Set<string>()
  const startKey = (cs: readonly Circle3[]) =>
    cs
      .map((c) => `${Math.round(c.x)},${Math.round(c.y)}`)
      .sort()
      .join(';')
  const tryStart = (init: Circle3[], newIdx: number | null, passes: number) => {
    const key = startKey(init)
    if (seen.has(key)) return
    seen.add(key)
    let ds = place(init)
    ds = jointRefine(ds, newIdx === null ? null : ds[newIdx], passes)
    table.record(fit, ds)
    for (const d of ds) fit.remove(d)
  }
  const forward = (k: number) => {
    // 1. the best K−1 explanation plus a disk at the residual peak
    const prev = table.best(k - 1)
    if (prev) {
      const ds = place(prev.disks)
      const add = residualPeak(fit, w, h, prior, ownPix)
      for (const d of ds) fit.remove(d)
      if (add) tryStart([...prev.disks, add], prev.disks.length, 2)
    }
    // full multi-start only in the plausible range (beyond it the augmented start suffices)
    if (k <= Math.ceil(1.5 * kEst) + 2) {
      tryStart(kmeansStart(kmPts, w, dt, k, prior, pts.length, null), null, 3)
      tryStart(peakStart(peaks, kmPts, w, dt, k, prior, pts.length), null, 3)
      const nRandom = k >= 3 ? 2 : k === 2 ? 1 : 0
      for (let s = 0; s < nRandom; s++) tryStart(kmeansStart(kmPts, w, dt, k, prior, pts.length, rand), null, 3)
    }
  }
  for (let k = 1; k <= kMax; k++) forward(k)
  // the table must contain the best K for every slider position (λ ≥ LAMBDA_MIN)
  while (kMax < SWEEP_K_CAP && table.argminK(LAMBDA_MIN) >= kMax) forward(++kMax)
  // backward pass: K+1 minus its weakest disk, refined
  for (let k = kMax - 1; k >= 1; k--) {
    const next = table.best(k + 1)
    if (!next) continue
    const ds = place(next.disks)
    let worst = 0
    let worstD = Infinity
    ds.forEach((d, i) => {
      const dr = fit.deltaRemove(d)
      if (dr < worstD) {
        worstD = dr
        worst = i
      }
    })
    fit.remove(ds[worst])
    const rest = ds.filter((_, i) => i !== worst)
    const init = rest.map(({ x, y, r }) => ({ x, y, r }))
    for (const d of rest) fit.remove(d)
    tryStart(init, null, 2)
  }
  for (const f of fit.disks.slice()) fit.remove(f)
  return { configs: table.configs(), kRange: [0, kMax], kEst }
}

/** Start positions from the unit's core-mask and distance-transform peaks (best first). */
function unitPeaks(u: UnitInput, dt: Plane, params: ClusterFitParams, ownPix: number[]): Circle3[] {
  const { prior } = params
  const w = u.mask.width
  const h = u.mask.height
  const out: (Circle3 & { s: number })[] = []
  // core mask: seams between touching colonies usually stay below its level
  const cm = makeMask(w, h)
  for (const i of ownPix) cm.data[i] = u.F.data[i] > params.coreLevel ? 1 : 0
  const cdt = distanceTransform(cm)
  for (const p of localMaxima(cdt, Math.max(1, Math.round(0.3 * prior.rMed)), Math.max(1, 0.25 * prior.rLo), cm.data)) out.push({ x: p.x, y: p.y, r: prior.rMed, s: p.value + 0.5 * prior.rMed })
  for (const p of localMaxima(dt, Math.max(1, Math.round(0.25 * prior.rMed)), 0.4 * prior.rLo, u.own)) out.push({ x: p.x, y: p.y, r: Math.min(Math.max(p.value, 0.8 * prior.rMed), 1.15 * prior.rMed), s: p.value })
  out.sort((a, b) => b.s - a.s || a.y - b.y || a.x - b.x)
  const kept: Circle3[] = []
  for (const c of out) if (!kept.some((k) => Math.hypot(k.x - c.x, k.y - c.y) < 0.6 * prior.rMed)) kept.push({ x: c.x, y: c.y, r: c.r })
  return kept
}

/** The top-k peaks, completed by farthest-point picks when there are fewer. */
function peakStart(peaks: Circle3[], pts: number[], w: number, dt: Plane, k: number, prior: AnalysisPrior, nPix: number): Circle3[] {
  if (peaks.length >= k) return peaks.slice(0, k)
  const km = kmeansStart(pts, w, dt, k, prior, nPix, null, peaks)
  return km
}

/**
 * k-means start on the unit's (deep) pixels. Initial centres: given ones, then
 * farthest-point (rand = null) or k-means++ (D² sampling with the seeded RNG);
 * a few Lloyd iterations; radii from the cell areas, bounded near the prior.
 */
function kmeansStart(pix: number[], w: number, dt: Plane, k: number, prior: AnalysisPrior, nPix: number, rand: (() => number) | null, init: Circle3[] = []): Circle3[] {
  const n = pix.length
  const xs = new Float64Array(n)
  const ys = new Float64Array(n)
  for (let j = 0; j < n; j++) {
    xs[j] = (pix[j] % w) + 0.5
    ys[j] = Math.floor(pix[j] / w) + 0.5
  }
  const cx: number[] = []
  const cy: number[] = []
  const fixedN = Math.min(init.length, k)
  for (let c = 0; c < fixedN; c++) {
    cx.push(init[c].x)
    cy.push(init[c].y)
  }
  if (!cx.length) {
    let first = 0
    if (rand) first = Math.min(n - 1, Math.floor(rand() * n))
    else for (let j = 1; j < n; j++) if (dt.data[pix[j]] > dt.data[pix[first]]) first = j
    cx.push(xs[first])
    cy.push(ys[first])
  }
  const md = new Float64Array(n).fill(Infinity)
  const upd = (c: number) => {
    for (let j = 0; j < n; j++) md[j] = Math.min(md[j], (xs[j] - cx[c]) ** 2 + (ys[j] - cy[c]) ** 2)
  }
  for (let c = 0; c < cx.length; c++) upd(c)
  while (cx.length < k) {
    let pick = 0
    if (rand) {
      let tot = 0
      for (let j = 0; j < n; j++) tot += md[j]
      let t = rand() * tot
      for (pick = 0; pick < n - 1; pick++) {
        t -= md[pick]
        if (t <= 0) break
      }
    } else for (let j = 1; j < n; j++) if (md[j] > md[pick]) pick = j
    cx.push(xs[pick])
    cy.push(ys[pick])
    upd(cx.length - 1)
  }
  const cnt = new Float64Array(k)
  for (let it = 0; it < 5; it++) {
    const sx = new Float64Array(k)
    const sy = new Float64Array(k)
    cnt.fill(0)
    for (let j = 0; j < n; j++) {
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
  // radius: the cell's share of the unit's area, bounded to 0.8–1.15 × the prior median
  return cx.map((x, c) => ({ x, y: cy[c], r: cnt[c] ? Math.min(prior.rMed * 1.15, Math.max(prior.rMed * 0.8, Math.sqrt((cnt[c] * nPix) / Math.max(1, n) / Math.PI))) : prior.rMed }))
}

/** A disk at the deepest point of the unit's still-uncovered foreground (null if nothing is left). */
function residualPeak(fit: ClusterFit, w: number, h: number, prior: AnalysisPrior, ownPix: number[]): Circle3 | null {
  const res = makeMask(w, h)
  let n = 0
  for (const i of ownPix)
    if (fit.coverPx[i] === 0 && fit.mIn[i] > 0.25) {
      res.data[i] = 1
      n++
    }
  if (n === 0) {
    // everything is covered: the own pixel farthest from every disk centre
    let best = -1
    let bd = -1
    for (const i of ownPix) {
      const x = (i % w) + 0.5
      const y = Math.floor(i / w) + 0.5
      let d = Infinity
      for (const q of fit.disks) d = Math.min(d, Math.hypot(q.x - x, q.y - y) - q.r)
      if (d > bd) {
        bd = d
        best = i
      }
    }
    return best < 0 ? null : { x: (best % w) + 0.5, y: Math.floor(best / w) + 0.5, r: 0.8 * prior.rMed }
  }
  const dt = distanceTransform(res)
  let best = -1
  for (const i of ownPix) if (res.data[i] && (best < 0 || dt.data[i] > dt.data[best])) best = i
  return { x: (best % w) + 0.5, y: Math.floor(best / w) + 0.5, r: Math.min(1.1 * prior.rMed, Math.max(0.7 * prior.rMed, dt.data[best])) }
}

/**
 * Fit one cluster: partition into units, sweep each. `mask` / `F` are cluster
 * patch rasters; `fixed` in patch coordinates. Pure and deterministic.
 */
export function fitClusterSweep(mask: Mask, F: Plane, ox: number, oy: number, params: ClusterFitParams, fixed: FixedColony[], seed = 1): ClusterSolution {
  const { unitOf, n } = partitionCluster(mask, F, params.prior)
  const groups: GroupFit[] = []
  const w = mask.width
  const h = mask.height
  const pad = Math.ceil(params.rMaxFit) + 2
  for (let g = 0; g < n; g++) {
    let minX = w, minY = h, maxX = -1, maxY = -1
    let area = 0
    for (let i = 0; i < unitOf.length; i++)
      if (unitOf[i] === g) {
        area++
        const x = i % w
        const y = (i / w) | 0
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    const x0 = Math.max(0, minX - pad)
    const y0 = Math.max(0, minY - pad)
    const x1 = Math.min(w - 1, maxX + pad)
    const y1 = Math.min(h - 1, maxY + pad)
    const pw = x1 - x0 + 1
    const ph = y1 - y0 + 1
    const pm = makeMask(pw, ph)
    const own = new Uint8Array(pw * ph)
    const pF: Plane = { width: pw, height: ph, data: new Float32Array(pw * ph) }
    for (let y = 0; y < ph; y++)
      for (let x = 0; x < pw; x++) {
        const i = (y + y0) * w + x + x0
        const j = y * pw + x
        pm.data[j] = mask.data[i]
        own[j] = unitOf[i] === g ? 1 : 0
        pF.data[j] = F.data[i]
      }
    const fixedHere = fixed.filter((f) => f.x + f.r > x0 && f.x - f.r < x1 + 1 && f.y + f.r > y0 && f.y - f.r < y1 + 1).map((f) => ({ ...f, x: f.x - x0, y: f.y - y0 }))
    const fixedIds = fixed
      .filter((f) => {
        const xi = Math.floor(f.x)
        const yi = Math.floor(f.y)
        return xi >= 0 && yi >= 0 && xi < w && yi < h && unitOf[yi * w + xi] === g
      })
      .map((f) => f.id)
    const sw = sweepUnit({ mask: pm, F: pF, own, ox: ox + x0, oy: oy + y0, fixed: fixedHere, seed: (Math.imul(seed, 0x9e3779b1) ^ Math.imul(g + 1, 0x85ebca6b)) >>> 0 }, params)
    groups.push({
      configs: sw.configs.map((c) => ({ ...c, disks: c.disks.map((d) => ({ x: d.x + x0, y: d.y + y0, r: d.r })) })),
      fixedIds,
      bbox: [minX, minY, maxX, maxY],
      area,
      kEst: sw.kEst,
      kRange: sw.kRange,
    })
  }
  return { groups, groupOf: unitOf }
}

// ---------------------------------------------------------------------------
// Decisions (re-scoring) and review alternatives
// ---------------------------------------------------------------------------

export interface GroupDecision {
  best: GroupConfig
  /** Best configuration of any OTHER K (second-best K across the whole sweep). */
  runnerUp: GroupConfig | null
  /** J(runner-up) − J(best), in units of one typical colony. */
  gap: number | null
  /**
   * gap / contested area: the colonies that differ between the two explanations
   * (unmatched disks), in units of one typical colony (floor 0.25). Evidence per
   * contested colony — not biased against small colonies like the raw gap.
   */
  relativeGap: number | null
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

/**
 * Primary vs alternative as a diff: indices of primary disks the alternative drops, and the
 * alternative's disks without a counterpart (centres within 0.5·max(r), radii within ±35 %).
 */
export function diffSets(primary: readonly Circle3[], alt: readonly Circle3[], toOrig: (c: Circle3) => Circle3): { added: Circle3[]; removed: number[] } {
  const usedAlt = new Uint8Array(alt.length)
  const removed: number[] = []
  primary.forEach((p, i) => {
    let best = -1
    let bd = Infinity
    alt.forEach((a, j) => {
      if (usedAlt[j]) return
      const d = Math.hypot(p.x - a.x, p.y - a.y)
      if (d <= 0.5 * Math.max(p.r, a.r) && Math.abs(Math.log(p.r / a.r)) <= 0.3 && d < bd) {
        bd = d
        best = j
      }
    })
    if (best >= 0) usedAlt[best] = 1
    else removed.push(i)
  })
  return { added: alt.filter((_, j) => !usedAlt[j]).map(toOrig), removed }
}

/** Pick the best configuration and the best one of any other K for the given weights and prior spread. */
export function decideGroup(g: GroupFit, wts: ScoreWeights, logR: number, s: number, rMed = Math.exp(logR)): GroupDecision {
  let best: { c: GroupConfig; j: number } | null = null
  for (const c of g.configs) {
    const j = configScore(c, wts, logR, s)
    if (!best || j < best.j - 1e-12 || (Math.abs(j - best.j) <= 1e-12 && c.k < best.c.k)) best = { c, j }
  }
  let runner: { c: GroupConfig; j: number } | null = null
  for (const c of g.configs) {
    if (c.k === best!.c.k) continue
    const j = configScore(c, wts, logR, s)
    if (!runner || j < runner.j - 1e-12 || (Math.abs(j - runner.j) <= 1e-12 && c.k < runner.c.k)) runner = { c, j }
  }
  const gap = runner ? runner.j - best!.j : null
  const relativeGap = runner && gap !== null ? gap / Math.max(0.25, contestedArea(best!.c.disks, runner.c.disks, rMed)) : null
  return { best: best!.c, runnerUp: runner?.c ?? null, gap, relativeGap }
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

// ---------------------------------------------------------------------------
// Whole image: cached tables, re-scoring per run
// ---------------------------------------------------------------------------

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
  }[]
  /** Cluster labels of the mask (analysis px). */
  labels: Int32Array
  width: number
  baseWeights: FitWeights
  /** Sweep statistics (diagnostics). */
  sweep: { units: number; configs: number; maxKSwept: number; buildMs: number }
}

/** Reference sensitivity at which the configuration tables are built. */
const TABLE_SENSITIVITY = 0.5

async function buildFitterState(ctx: MethodContext, key: string): Promise<FitterState> {
  const t0 = Date.now()
  const { prior, settings } = ctx
  const sp = sensitivityParams(TABLE_SENSITIVITY)
  const baseWeights: FitWeights = { ...OBJECTIVES[settings.objective ?? 'tuned'], lambda: sp.lambda, ...settings.fitWeights }
  // the mask does not follow the sensitivity slider (so the expensive part can be cached)
  const mask = foregroundMask(ctx, maskThresholdAt(ctx, TABLE_SENSITIVITY))
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
  const stats = { units: 0, configs: 0, maxKSwept: 0, buildMs: 0 }
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
    const fixedHere = ctx.fixed
      .filter((f) => {
        const xi = Math.floor(f.x)
        const yi = Math.floor(f.y)
        return xi >= 0 && yi >= 0 && xi < mask.width && yi < mask.height && cl.labels[yi * mask.width + xi] === st.label
      })
      .map((f) => ({ ...f, x: f.x - x0, y: f.y - y0 }))
    const tooLarge = st.area > settings.kMax * a0
    let sol: ClusterSolution | null = null
    if (!tooLarge) {
      const pm = makeMask(pw, ph)
      const pF: Plane = { width: pw, height: ph, data: new Float32Array(pw * ph) }
      for (let y = 0; y < ph; y++)
        for (let x = 0; x < pw; x++) {
          const i = (y + y0) * mask.width + x + x0
          pm.data[y * pw + x] = cl.labels[i] === st.label ? 1 : 0
          pF.data[y * pw + x] = ctx.F.data[i]
        }
      // seed from the cluster's position: the result does not depend on processing order
      sol = fitClusterSweep(pm, pF, x0, y0, params, fixedHere, (st.minX * 73856093) ^ (st.minY * 19349663) ^ st.area)
      stats.units += sol.groups.length
      for (const g of sol.groups) {
        stats.configs += g.configs.length
        stats.maxKSwept = Math.max(stats.maxKSwept, g.kRange[1])
      }
    }
    clusters.push({ label: st.label, stats: st, x0, y0, pw, tooLarge, fixedIds: fixedHere.map((f) => f.id), sol })
  }
  stats.buildMs = Date.now() - t0
  return { key, clusters, labels: cl.labels, width: mask.width, baseWeights, sweep: stats }
}

/** Mask threshold for a given sensitivity (the fitter uses the table sensitivity). */
function maskThresholdAt(ctx: MethodContext, sensitivity: number): number {
  const { thrFrac, noiseK } = sensitivityParams(sensitivity)
  return Math.max(noiseK * ctx.noise, thrFrac * ctx.contrastRef)
}

export async function runFitter(ctx: MethodContext, cached?: { key: string; get: () => FitterState | null; set: (s: FitterState) => void }): Promise<MethodOutput> {
  const { prior, prep, settings } = ctx
  const scale = prep.scale
  const t0 = Date.now()
  let state = cached?.get() ?? null
  const reused = !!state && state.key === cached?.key
  if (!reused) {
    state = await buildFitterState(ctx, cached?.key ?? '')
    cached?.set(state)
  } else await ctx.checkpoint(0.6)
  const st = state!
  // scoring for THIS run: λ from the sensitivity, s from the prior width. The tables are
  // read-only here, so the same settings always give the same result.
  const wts = { ...st.baseWeights, lambda: sensitivityParams(settings.sensitivity).lambda, ...(settings.fitWeights?.lambda !== undefined ? { lambda: settings.fitWeights.lambda } : {}) }
  const s = prior.s * settings.priorWidth
  // the slider neighbourhood used for the review flag: sensitivity ± δ (λ moves 0.2 δ), size tolerance × (1 ± 2δ)
  const dl = 0.2 * settings.reviewStability
  const perturbed: [ScoreWeights, number][] = [
    [{ ...wts, lambda: Math.max(0, wts.lambda - dl) }, s],
    [{ ...wts, lambda: wts.lambda + dl }, s],
    [wts, s * (1 + 2 * settings.reviewStability)],
    [wts, s / (1 + 2 * settings.reviewStability)],
  ]
  const suggestions: Suggestion[] = []
  const clustersOut: ClusterResult[] = []
  const labels = new Int32Array(st.labels.length)
  const counts = { ok: 0, review: 0, tooLarge: 0 }
  let nextId = 1
  for (const c of st.clusters) {
    const { minX, minY, maxX, maxY, area } = c.stats
    if (c.tooLarge || !c.sol) {
      counts.tooLarge++
      const id = clusterId(nextId++)
      clustersOut.push({ clusterId: id, bbox: bboxToOriginal(minX, minY, maxX, maxY, scale), area: area / (scale * scale), fixedIds: c.fixedIds, chosenK: 0, runnerUpK: null, objectiveGap: null, status: 'too-large' })
      for (let y = minY; y <= maxY; y++)
        for (let x = minX; x <= maxX; x++) if (st.labels[y * st.width + x] === c.label) labels[y * st.width + x] = nextId - 1
      continue
    }
    const sol = c.sol
    const groupIds = sol.groups.map(() => nextId++)
    sol.groups.forEach((g, gi) => {
      let d = decideGroup(g, wts, prior.logR, s, prior.rMed)
      // stability: the K chosen under slightly different slider positions
      const kAt = (w: ScoreWeights, sp: number) => decideGroup(g, w, prior.logR, sp, prior.rMed).best.k
      const flips = new Set<number>()
      for (const [w, sp] of perturbed) {
        const k = kAt(w, sp)
        if (k !== d.best.k) flips.add(k)
      }
      // recall bias: "nothing" vs "colonies" unstable → suggest the colonies (rejecting is a tap)
      if (d.best.k === 0 && g.fixedIds.length === 0 && d.runnerUp && d.runnerUp.k > 0 && d.gap !== null && d.gap < EXISTENCE_MARGIN) flips.add(d.runnerUp.k)
      if (d.best.k === 0 && g.fixedIds.length === 0 && flips.size) {
        const kMore = Math.min(...[...flips].filter((k) => k > 0))
        if (Number.isFinite(kMore)) {
          const score = (q: GroupConfig) => configScore(q, wts, prior.logR, s)
          const pick = g.configs.filter((q) => q.k === kMore).reduce((a, b) => (score(b) < score(a) ? b : a))
          // gap stays "J(runner-up) − J(chosen)", here slightly negative: the colonies were chosen for recall
          const gap = score(d.best) - score(pick)
          d = { best: pick, runnerUp: d.best, gap, relativeGap: gap / Math.max(0.25, contestedArea(pick.disks, [], prior.rMed)) }
          flips.clear()
        }
      }
      const id = clusterId(groupIds[gi])
      // "is it a colony at all?" (runner-up K = 0) is answered by tap-to-reject, not by a "k or k+1?" region
      const existenceOnly = d.runnerUp !== null && (d.runnerUp.k === 0 || d.best.k === 0) && g.fixedIds.length === 0
      const unstable = flips.size > 0 || (d.relativeGap !== null && d.relativeGap < settings.reviewGap)
      const review = !existenceOnly && d.runnerUp !== null && unstable
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
      if (review && d.runnerUp) result.alternative = { k: d.runnerUp.k, colonies: d.runnerUp.disks.map(toOrig), ...diffSets(d.best.disks, d.runnerUp.disks, toOrig) }
      clustersOut.push(result)
    })
    // unit label raster (analysis px)
    for (let y = minY; y <= maxY; y++)
      for (let x = minX; x <= maxX; x++) {
        const i = y * st.width + x
        if (st.labels[i] !== c.label) continue
        const g = sol.groupOf[(y - c.y0) * c.pw + (x - c.x0)]
        labels[i] = g >= 0 ? groupIds[g] : 0
      }
  }
  return {
    suggestions,
    clusters: clustersOut,
    diagnostics: {
      weights: wts,
      priorS: round3(s),
      reusedFit: reused,
      sweep: st.sweep,
      groupsOk: counts.ok,
      groupsReview: counts.review,
      clustersTooLarge: counts.tooLarge,
      emitMs: Date.now() - t0,
    },
    labels,
  }
}

const round3 = (v: number) => Math.round(v * 1000) / 1000
