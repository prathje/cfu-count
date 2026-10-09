/**
 * Seed calibration (method brief §1–2).
 *
 * A seed is a POINT. Its radius is estimated from the contrast plane F along
 * 32 rays, each stopping at the FIRST significant boundary:
 *  - an edge: the profile falls below half-way between the ray's running
 *    maximum and the local background, or
 *  - a seam: the profile drops by a clear margin below its running maximum
 *    and rises again (the darker valley between touching colonies).
 * Rays that reach neither before rMax (merged into a neighbour without a
 * valley) are left out. The radius is the median of the remaining ray radii
 * after rejecting outliers, and a circle fitted to the inlier boundary
 * points re-centres the estimate on the colony (the annotation itself is
 * never moved). Stopping at the first boundary instead of the steepest or
 * the outermost one is what keeps a seed inside a dense streak from
 * measuring the whole streak.
 *
 * Usable seeds (quality 'ok', and 'touching' seeds whose radius is bounded by
 * seams, at a lower weight) feed a robust log-normal radius prior
 * μ = weighted median(log r), s = max(s_min, 1.4826·MAD)·√(1 + 1/n), and
 * per-feature robust appearance ranges.
 */
import { localMaxima } from './image/blobs.ts'
import { fitCircleKasa, type Pt } from './image/contour.ts'
import { gaussianBlur } from './image/filters.ts'
import { sampleBilinear, type Plane } from './image/plane.ts'
import { mad, median } from './image/threshold.ts'
import type { CalibrationReport, RadiusPrior, RobustRange, SeedQuality } from './types.ts'

const RAYS = 32
const STEP = 0.5
/** A seam must drop this fraction of the ray's contrast below its running maximum ... */
const SEAM_DROP = 0.08
/** ... and rise again by this fraction. */
const SEAM_RISE = 0.03
/** Prior weight of a usable seed that touches other colonies (seam-bounded radius). */
export const TOUCHING_WEIGHT = 0.6

export interface SeedMeasurement {
  /** Re-centred position, analysis px of the plane measured. */
  cx: number
  cy: number
  /** Boundary radius in analysis px (median over inlier rays), or null if no estimate. */
  r: number | null
  /** Radius of steepest radial descent (analysis px), or null. */
  rEdge: number | null
  /** F at the colony peak minus local baseline. */
  contrast: number
  snr: number
  /** Robust coefficient of variation of the ray radii (0 = perfect circle). */
  cv: number
  /** Fraction of rays without a usable boundary: none before rMax, or an outlier far from the colony's radius (merged into a neighbour without a seam). */
  blockedFrac: number
  /** Fraction of rays bounded by a seam (valley to a touching neighbour). */
  seamFrac: number
  /** Number of inlier rays the radius rests on. */
  nRays: number
  /** Fraction of saturated pixels inside the radius. */
  saturatedFrac: number
  /** Centre is darker than the ring around it (bubble / specular ring). */
  dip: boolean
  /** Distance from the centre to the edge of the analysed region minus r (≤ 0: touches it). */
  edgeClearance: number
  /** Max descent slope × r / contrast (dimensionless edge sharpness). */
  sharpness: number
}

export interface MeasureContext {
  F: Plane
  noise: number
  /** Largest radius to search (analysis px). */
  rMax: number
  saturated?: Uint8Array
  /** Distance from each pixel to the edge of the analysed region (analysis px). */
  regionDistance?: Plane
}

/** Measure one seed at (x, y) analysis px. */
export function measureSeed(ctx: MeasureContext, x: number, y: number): SeedMeasurement {
  let cx = x
  let cy = y
  let m = profileAt(ctx, cx, cy)
  // re-centre (up to three times) on a robust circle through ALL boundary points found: from an
  // off-centre click the ray radii differ legitimately, but the points still lie on one circle
  for (let it = 0; it < 3 && m.r !== null && m.boundary.length >= 8; it++) {
    const c = robustCircle(m.boundary, m.points)
    if (!c) break
    // the circle must contain the click and not balloon to a neighbouring structure
    if (Math.hypot(c.x - x, c.y - y) > 0.8 * c.r || c.r > 2 * m.r) break
    if (Math.hypot(c.x - cx, c.y - cy) < 0.05) break
    const next = profileAt(ctx, c.x, c.y)
    if (next.r === null) break
    cx = c.x
    cy = c.y
    m = next
  }
  const { F, saturated, regionDistance } = ctx
  let satFrac = 0
  if (saturated && m.r) {
    let n = 0
    let s = 0
    const r = m.r
    for (let yy = Math.floor(cy - r); yy <= Math.ceil(cy + r); yy++) {
      for (let xx = Math.floor(cx - r); xx <= Math.ceil(cx + r); xx++) {
        if (xx < 0 || yy < 0 || xx >= F.width || yy >= F.height) continue
        if (Math.hypot(xx + 0.5 - cx, yy + 0.5 - cy) > r) continue
        n++
        s += saturated[yy * F.width + xx]
      }
    }
    satFrac = n ? s / n : 0
  }
  const clearance = regionDistance ? sampleBilinear(regionDistance, cx, cy) - (m.r ?? 0) : Infinity
  return {
    cx,
    cy,
    r: m.r,
    rEdge: m.rEdge,
    contrast: m.contrast,
    snr: m.contrast / ctx.noise,
    cv: m.cv,
    blockedFrac: m.blockedFrac,
    seamFrac: m.seamFrac,
    nRays: m.boundary.length,
    saturatedFrac: satFrac,
    dip: m.dip,
    edgeClearance: clearance,
    sharpness: m.sharpness,
  }
}

interface Profiled {
  r: number | null
  rEdge: number | null
  contrast: number
  cv: number
  blockedFrac: number
  seamFrac: number
  dip: boolean
  sharpness: number
  /** Inlier boundary points (analysis px). */
  boundary: Pt[]
  /** All boundary points found (analysis px), for re-centring. */
  points: Pt[]
}

interface RayHit {
  /** Boundary radius (analysis px). */
  r: number
  kind: 'edge' | 'seam'
  /** Steepest descent before the boundary: radius and slope (F per px). */
  rSteep: number
  slope: number
  /** Running maximum before the boundary. */
  max: number
}

/** Radial profiles: mean of three sub-rays, lightly smoothed (≈ 1 px). */
function profiles(F: Plane, cx: number, cy: number, nk: number): Float32Array[] {
  const out: Float32Array[] = []
  const tmp = new Float32Array(nk)
  for (let s = 0; s < RAYS; s++) {
    tmp.fill(0)
    for (const off of [-1 / 3, 0, 1 / 3]) {
      const th = ((s + off) / RAYS) * 2 * Math.PI
      const ux = Math.cos(th)
      const uy = Math.sin(th)
      for (let k = 0; k < nk; k++) tmp[k] += sampleBilinear(F, cx + ux * k * STEP, cy + uy * k * STEP) / 3
    }
    const p = new Float32Array(nk)
    for (let k = 0; k < nk; k++) p[k] = 0.25 * tmp[Math.max(0, k - 1)] + 0.5 * tmp[k] + 0.25 * tmp[Math.min(nk - 1, k + 1)]
    out.push(p)
  }
  return out
}

/** First significant boundary along one profile (see the module comment). */
function firstBoundary(p: Float32Array, base: number, noise: number): RayHit | null {
  const nk = p.length
  let M = p[0]
  let mn = p[0]
  let kMin = 0
  let steep = 0
  let kSteep = 0
  for (let k = 1; k < nk; k++) {
    const v = p[k]
    if (v > M) {
      M = v
      mn = v
      kMin = k
      steep = 0
      kSteep = k
      continue
    }
    const d = p[k - 1] - v
    if (d > steep) {
      steep = d
      kSteep = k
    }
    if (v < mn) {
      mn = v
      kMin = k
    }
    const c = M - base
    if (c <= 0) continue
    const level = base + 0.5 * c
    if (v < level) {
      const t = (p[k - 1] - level) / Math.max(p[k - 1] - v, 1e-9)
      return { r: (k - 1 + Math.min(Math.max(t, 0), 1)) * STEP, kind: 'edge', rSteep: (kSteep - 0.5) * STEP, slope: steep / STEP, max: M }
    }
    if (M - mn >= Math.max(SEAM_DROP * c, 4 * noise) && v - mn >= Math.max(SEAM_RISE * c, 2 * noise)) {
      return { r: kMin * STEP, kind: 'seam', rSteep: (kSteep - 0.5) * STEP, slope: steep / STEP, max: M }
    }
  }
  return null
}

function profileAt(ctx: MeasureContext, cx: number, cy: number): Profiled {
  const { F, rMax } = ctx
  const nk = Math.max(4, Math.ceil(rMax / STEP) + 1)
  const prof = profiles(F, cx, cy, nk)
  const k1 = Math.max(1, Math.round(1 / STEP))
  const centre = median(prof.map((p) => mean(p, 0, k1 + 1)))
  // background: the darkest part of each ray (in a streak that is a seam, so cap it)
  const floor = median(prof.map((p) => min(p, 0, nk)))
  // provisional peak: brightest point near the click (≤ ~3 px or a quarter of rMax)
  const kNear = Math.max(k1 + 1, Math.min(nk, Math.ceil(Math.max(3, 0.25 * rMax) / STEP)))
  const nearMax = median(prof.map((p) => max(p, 0, kNear)))
  const dip = centre < 0.6 * nearMax && nearMax > 0
  const base = Math.min(floor, 0.25 * Math.max(centre, nearMax))
  const noise = ctx.noise / Math.sqrt(3)
  const hits: (RayHit | null)[] = prof.map((p) => firstBoundary(p, base, noise))
  const found = hits.filter((h): h is RayHit => h !== null)
  const blockedFrac = (RAYS - found.length) / RAYS
  const peak = found.length ? median(found.map((h) => h.max)) : Math.max(centre, nearMax)
  const contrast = peak - base
  const points: Pt[] = []
  hits.forEach((h, s) => {
    if (!h) return
    const th = (s / RAYS) * 2 * Math.PI
    points.push({ x: cx + Math.cos(th) * h.r, y: cy + Math.sin(th) * h.r })
  })
  const fail: Profiled = { r: null, rEdge: null, contrast, cv: 1, blockedFrac, seamFrac: 0, dip, sharpness: 0, boundary: [], points }
  if (found.length < RAYS / 4 || contrast <= 0) return fail
  // robust radius: median, reject rays far from it, median again
  let r = median(found.map((h) => h.r))
  if (!(r > 0)) return fail
  let inl = found
  for (let it = 0; it < 2; it++) {
    const rr = r
    inl = found.filter((h) => h.r >= 0.6 * rr && h.r <= 1.6 * rr)
    if (inl.length < RAYS / 4) return { ...fail, blockedFrac: 1 - inl.length / RAYS }
    r = median(inl.map((h) => h.r))
  }
  const boundary: Pt[] = []
  hits.forEach((h, s) => {
    if (!h || h.r < 0.6 * r || h.r > 1.6 * r) return
    const th = (s / RAYS) * 2 * Math.PI
    boundary.push({ x: cx + Math.cos(th) * h.r, y: cy + Math.sin(th) * h.r })
  })
  const radii = inl.map((h) => h.r)
  const cv = mad(radii) / r
  const seamFrac = inl.filter((h) => h.kind === 'seam').length / RAYS
  const steep = inl.filter((h) => h.slope > 0)
  const rEdge = steep.length ? median(steep.map((h) => h.rSteep)) : null
  const sharpness = steep.length ? (median(steep.map((h) => h.slope)) * r) / contrast : 0
  // rays without a boundary, or whose boundary is far from the colony's (ran into a neighbour without a seam)
  return { r, rEdge, contrast, cv, blockedFrac: 1 - inl.length / RAYS, seamFrac, dip, sharpness, boundary, points }
}

/**
 * Circle through the inlier boundary points (ray radii near their median),
 * then refitted with every boundary point close to that circle: from an
 * off-centre click the inliers are one-sided but still lie on the colony's
 * circle, and the other rays' points that agree with it are added. Points far
 * from it (rays that ran into a neighbour) never pull the circle outwards.
 */
function robustCircle(inliers: Pt[], all: Pt[]): { x: number; y: number; r: number } | null {
  let c = fitCircleKasa(inliers)
  if (!c || !Number.isFinite(c.x) || !(c.r > 0)) return null
  for (let it = 0; it < 2; it++) {
    const cc = c
    const tol = Math.max(1, 0.15 * cc.r)
    const near = all.filter((p) => Math.abs(Math.hypot(p.x - cc.x, p.y - cc.y) - cc.r) <= tol)
    if (near.length < 8) break
    const n = fitCircleKasa(near)
    if (!n || !Number.isFinite(n.x) || !(n.r > 0)) break
    c = n
  }
  return c
}

function mean(p: Float32Array, a: number, b: number): number {
  let s = 0
  for (let k = a; k < b; k++) s += p[k]
  return s / Math.max(1, b - a)
}
function min(p: Float32Array, a: number, b: number): number {
  let m = Infinity
  for (let k = a; k < b; k++) m = Math.min(m, p[k])
  return m
}
function max(p: Float32Array, a: number, b: number): number {
  let m = -Infinity
  for (let k = a; k < b; k++) m = Math.max(m, p[k])
  return m
}

/** Quality flag and an explanation. Precedence: edge > glare > touching > weak > ok. */
export function seedQuality(m: SeedMeasurement): { quality: SeedQuality; note?: string } {
  if (m.edgeClearance < 1) return { quality: 'edge', note: 'touches the edge of the analysed region' }
  if (m.saturatedFrac > 0.25) return { quality: 'glare', note: 'saturated (glare) pixels' }
  if (m.dip) return { quality: 'glare', note: 'centre darker than its rim (bubble or reflection?)' }
  if (m.r === null) {
    return m.blockedFrac > 0.5 && m.snr >= 4
      ? { quality: 'touching', note: 'merged with neighbours; no clear boundary' }
      : { quality: 'weak', note: 'no clear boundary' }
  }
  if (m.blockedFrac + m.seamFrac >= 0.3) {
    return touchingUsable(m)
      ? { quality: 'touching', note: 'touches other colonies; size taken from the seams between them' }
      : { quality: 'touching', note: 'merged with neighbours; size uncertain' }
  }
  if (m.snr < 4) return { quality: 'weak', note: 'low contrast' }
  if (m.cv > 0.3) return { quality: 'weak', note: 'irregular outline' }
  if (m.rEdge !== null && Math.abs(Math.log(m.rEdge / m.r)) > 0.5) return { quality: 'weak', note: 'blurred or ambiguous edge' }
  return { quality: 'ok' }
}

/** A touching seed whose boundary is still well defined by seams and edges. */
function touchingUsable(m: SeedMeasurement): boolean {
  return m.r !== null && m.blockedFrac <= 0.5 && m.nRays >= RAYS / 3 && m.snr >= 4 && m.cv <= 0.35
}

/**
 * Weight of a seed in the size prior: 1 for a clean isolated colony,
 * TOUCHING_WEIGHT for a touching colony with a seam-bounded radius, 0 otherwise
 * (edge, glare, weak, or merged without seams).
 */
export function seedWeight(m: SeedMeasurement | null): number {
  if (!m || m.r === null) return 0
  const q = seedQuality(m).quality
  if (q === 'ok') return 1
  if (q === 'touching' && touchingUsable(m)) return TOUCHING_WEIGHT
  return 0
}

/** Weighted median (lower median for ties). */
export function weightedMedian(xs: number[], ws: number[]): number {
  const idx = xs.map((_, i) => i).sort((a, b) => xs[a] - xs[b])
  const total = ws.reduce((a, b) => a + b, 0)
  let acc = 0
  for (let j = 0; j < idx.length; j++) {
    acc += ws[idx[j]]
    if (acc >= total / 2 - 1e-12) {
      // exactly half: average with the next value (matches the plain median for equal weights)
      if (Math.abs(acc - total / 2) < 1e-12 && j + 1 < idx.length) return 0.5 * (xs[idx[j]] + xs[idx[j + 1]])
      return xs[idx[j]]
    }
  }
  return NaN
}

/**
 * Robust log-normal prior from radii in ORIGINAL px, optionally weighted
 * (touching seeds count less). n is the effective number of seeds (Σw).
 */
export function radiusPrior(radiiOriginal: number[], sMin: number, weights?: number[]): RadiusPrior | null {
  if (radiiOriginal.length === 0) return null
  const w = weights ?? radiiOriginal.map(() => 1)
  const z = radiiOriginal.map(Math.log)
  const mu = weightedMedian(z, w)
  const nEff = w.reduce((a, b) => a + b, 0)
  const raw = z.length > 1 ? 1.4826 * weightedMedian(z.map((v) => Math.abs(v - mu)), w) : 0
  const s = Math.max(sMin, raw) * Math.sqrt(1 + 1 / nEff)
  const n = Math.round(nEff * 100) / 100
  return { mu, s, sMin, n, rMedian: Math.exp(mu), rRange: [Math.exp(mu - 2 * s), Math.exp(mu + 2 * s)] }
}

/**
 * Plain-language note when the usable examples differ a lot in size (largest
 * / smallest ≥ 1.8): e.g. big isolated colonies and small ones inside a
 * streak. Null otherwise.
 */
export function sizeSpreadNote(radiiOriginal: number[]): string | null {
  if (radiiOriginal.length < 2) return null
  const lo = Math.min(...radiiOriginal)
  const hi = Math.max(...radiiOriginal)
  if (hi / lo < 1.8) return null
  return `Examples vary in size (radius ${Math.round(lo)}–${Math.round(hi)} px), so the allowed size range is wide. If there are two kinds of colonies, mark a few of each.`
}

/** Robust median/scale with a relative floor (so 1–2 seeds do not give a zero-width range). */
export function robustRange(xs: number[], floor: number): RobustRange {
  const m = median(xs)
  const s = xs.length > 1 ? mad(xs, m) : 0
  return { median: m, scale: Math.max(s, floor) }
}

export function calibrationSummary(nTotal: number, nUsable: number): string {
  const ex = nTotal === 1 ? 'manual example' : 'manual examples'
  return `${nTotal} ${ex}; ${nUsable} usable for size estimation`
}

/** Warnings about seed coverage (brief §2: report poor coverage of small/unusual colonies). */
export function coverageWarnings(report: Pick<CalibrationReport, 'nTotal' | 'nUsable' | 'prior'>, minUsable: number): string[] {
  const w: string[] = []
  if (report.nTotal === 0) w.push('No examples in this group: using a generic size guess. Mark a few typical colonies first.')
  else if (report.nUsable === 0) w.push('None of the examples gave a reliable size. Mark a few isolated colonies away from the rim.')
  else if (report.nUsable < minUsable) w.push(`Only ${report.nUsable} usable example${report.nUsable === 1 ? '' : 's'}: results are tentative. Add isolated examples, including small colonies.`)
  if (report.prior && report.prior.n >= 3) {
    const spread = Math.exp(report.prior.s) - 1
    if (spread < 0.15) w.push('All examples have nearly the same size; smaller or larger colonies may be missed. Add a small colony as an example if there are any.')
  }
  return w
}

/** Size prior (original px) from measured seeds: weighted by seedWeight; `scale` = plane px per original px. */
export function priorFromSeeds(ms: { m: SeedMeasurement | null; scale: number }[], sMin: number): RadiusPrior | null {
  const use = ms.filter((q) => seedWeight(q.m) > 0)
  return radiusPrior(
    use.map((q) => q.m!.r! / q.scale),
    sMin,
    use.map((q) => seedWeight(q.m)),
  )
}

/** Radii (original px) of the seeds that feed the prior. */
export function usableSeedRadii(ms: { m: SeedMeasurement | null; scale: number }[]): number[] {
  return ms.filter((q) => seedWeight(q.m) > 0).map((q) => q.m!.r! / q.scale)
}

/** A colony measured automatically at a brightness maximum (analysis px of the plane). */
export interface LocalColony {
  x: number
  y: number
  r: number
  /** seedWeight of the measurement (1 isolated, TOUCHING_WEIGHT seam-bounded). */
  weight: number
  /** Robust CV of the ray radii (roundness; 0 = perfect circle). */
  cv: number
}

export interface LocalColonyOptions {
  /** Smallest colony radius worth resolving (analysis px): sets smoothing and peak spacing. */
  rMin: number
  /** Largest radius searched along each ray (analysis px). */
  rMax: number
  /** Brightness maxima below this F value are ignored. */
  threshold: number
  /** At most this many maxima are measured (brightest first). */
  maxCount?: number
}

/**
 * Local colony sizes without seeds: every brightness maximum inside `within`
 * is measured like a seed (first boundary along rays: edge or seam), and
 * maxima that converge on the same colony are merged (the rounder
 * measurement wins). Maxima without a usable measurement (merged without
 * seams, too weak) are left out. priorsForClusters uses the clean round ones
 * as evidence for colonies LARGER than the seeds.
 */
export function measureLocalColonies(F: Plane, within: Uint8Array, noise: number, opt: LocalColonyOptions): LocalColony[] {
  const Fs = gaussianBlur(F, Math.max(0.7, 0.35 * opt.rMin))
  const peaks = localMaxima(Fs, Math.max(1, Math.round(0.6 * opt.rMin)), opt.threshold, within)
  peaks.sort((a, b) => b.value - a.value || a.y - b.y || a.x - b.x)
  const cap = opt.maxCount ?? 3000
  const found: LocalColony[] = []
  for (const p of peaks.slice(0, cap)) {
    if (found.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 0.5 * q.r)) continue
    const m = measureSeed({ F, noise, rMax: opt.rMax }, p.x, p.y)
    const w = seedWeight(m)
    if (w <= 0 || m.r === null || m.r < 0.5 * opt.rMin) continue
    found.push({ x: m.cx, y: m.cy, r: m.r, weight: w, cv: m.cv })
  }
  // two measurements whose centres lie inside each other's disks describe one colony (a maximum
  // off the colony centre, e.g. plateau noise, gives a smaller, off-centre circle): keep the
  // rounder one (lower cv), then the larger
  found.sort((a, b) => a.cv - b.cv || b.r - a.r || a.y - b.y || a.x - b.x)
  const kept: LocalColony[] = []
  for (const q of found) {
    if (kept.some((k) => Math.hypot(k.x - q.x, k.y - q.y) < 0.8 * Math.max(k.r, q.r))) continue
    kept.push(q)
  }
  return kept
}

/** Evidence weight of one manual mark (seed or existing colony, radius measured like a seed). */
const MARK_EVIDENCE = 3
/** An isolated automatic measurement this round (ray-radius CV) is evidence for a colony LARGER than the seeds ... */
const ROUND_CV = 0.06
/** ... when at least this share of the cluster's measurements are such colonies. */
const ROUND_SHARE = 0.3
/** Evidence weight of one such round colony. */
const ROUND_EVIDENCE = 3

export interface SizePrior {
  logR: number
  s: number
  rMed: number
  rLo: number
  rHi: number
}

/**
 * The prior moved towards a local log radius `logR` backed by evidence `n`:
 * shift = d · n / (n + 0.5) (n capped at 8), faded in by a smoothstep between
 * |d| = s/2 and s, so small differences are ignored and nothing jumps; s is
 * widened to at least |d| / 2 so both sizes stay plausible. Null when the
 * difference is within s/2 or has the wrong sign (`sign` 0: both allowed).
 */
function shiftPrior<P extends SizePrior>(global: P, logR: number, n: number, sign: -1 | 0 | 1): (P & { adapted: boolean }) | null {
  const d = logR - global.logR
  const dz = 0.5 * global.s
  if (Math.abs(d) <= dz || (sign !== 0 && Math.sign(d) !== sign)) return null
  const t = Math.min(1, (Math.abs(d) - dz) / dz)
  const k = Math.min(8, n)
  const mu = global.logR + (d * t * t * (3 - 2 * t) * k) / (k + 0.5)
  const s = Math.max(global.s, Math.abs(d) / 2)
  const rMed = Math.exp(mu)
  return { ...global, logR: mu, s, rMed, rLo: Math.max(1, Math.exp(mu - 2 * s)), rHi: Math.exp(mu + 2 * s), adapted: true }
}

export interface ClusterEvidence {
  /** Foreground area (analysis px²). */
  area: number
  /** Colonies measured automatically inside the cluster. */
  cols: LocalColony[]
  /** Radii (analysis px) of manual marks (seeds, existing colonies) inside the cluster. */
  marks: number[]
}

/**
 * Size prior per cluster (connected foreground region), so that one plate can
 * hold colonies of different sizes (e.g. small colonies in a dense streak and
 * large isolated ones). In order:
 *  1. Marks inside the cluster: the prior moves towards their median (either
 *     way). Manual marks are the only unbiased local size evidence.
 *  2. Mainly clean, near-perfectly round isolated colonies (automatic
 *     measurements, CV ≤ ROUND_CV, at least ROUND_SHARE of the cluster's): the
 *     prior can only grow. A merged clump of overlapping colonies without seams
 *     also measures as one big, roughly round colony (CV ≈ 0.1) and must keep
 *     being split; a dense streak contains a few round lobes too.
 *  3. Crowded clusters (≥ 2 typical colonies) without marks use the marks of
 *     all crowded clusters that have them: colonies in the dense areas of one
 *     plate grow alike, so marks in one streak inform the other.
 *  4. Otherwise the seed prior.
 * Automatic measurements never make the prior SMALLER: on these photos they
 * are biased both ways (blurry streaks: merged lobes, too large; crisp touching
 * colonies: seam radius, too small), and using them shrank the prior on
 * plates whose examples were representative (2026-10-09, detection-results.md §SC).
 */
export function priorsForClusters<P extends SizePrior>(global: P, groups: ClusterEvidence[]): (P & { adapted: boolean })[] {
  const a0 = Math.PI * global.rMed * global.rMed
  const crowded = (g: ClusterEvidence) => g.area >= 2 * a0
  const poolMarks = groups.filter((g) => crowded(g)).flatMap((g) => g.marks)
  const fromMarks = (marks: number[]) => shiftPrior(global, median(marks.map(Math.log)), MARK_EVIDENCE * marks.length, 0)
  return groups.map((g) => {
    if (g.marks.length) return fromMarks(g.marks) ?? { ...global, adapted: false }
    const round = g.cols.filter((c) => c.weight >= 1 && c.cv <= ROUND_CV)
    if (round.length && round.length >= ROUND_SHARE * g.cols.length) {
      const up = shiftPrior(global, median(round.map((c) => Math.log(c.r))), ROUND_EVIDENCE * round.length, 1)
      if (up) return up
    }
    if (crowded(g) && poolMarks.length >= 2) return fromMarks(poolMarks) ?? { ...global, adapted: false }
    return { ...global, adapted: false }
  })
}

/** Options for measuring local colonies under a given prior (analysis px). */
export function localColonyOptions(prior: Pick<SizePrior, 'rLo' | 'rHi'>, threshold: number): LocalColonyOptions {
  // rMin: half the smallest expected colony; rMax: big enough for a colony well above the prior,
  // which is exactly the case the round-colony evidence is for
  return { rMin: Math.max(1.5, 0.5 * prior.rLo), rMax: Math.max(6, 3 * prior.rHi), threshold }
}
