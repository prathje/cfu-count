/**
 * Seed calibration (method brief §1–2).
 *
 * A seed is a POINT. Its radius is estimated from the contrast plane F with a
 * sector-wise radial profile: in each of 24 directions the boundary is where
 * the profile falls to half-way between the colony and the local background.
 * Directions that never fall (merged neighbour) or fall and rise again
 * (touching neighbour) are left out; a circle fitted to the remaining
 * boundary points re-centres the estimate (the annotation itself is never
 * moved). The radial edge (steepest descent) and quality flags come from the
 * same profiles.
 *
 * Usable seeds (quality 'ok') feed a robust log-normal radius prior
 * μ = median(log r), s = max(s_min, 1.4826·MAD)·√(1 + 1/n), and per-feature
 * robust appearance ranges.
 */
import { fitCircleKasa, type Pt } from './image/contour.ts'
import { sampleBilinear, type Plane } from './image/plane.ts'
import { mad, median } from './image/threshold.ts'
import type { CalibrationReport, RadiusPrior, RobustRange, SeedQuality } from './types.ts'

const SECTORS = 24
const STEP = 0.5

export interface SeedMeasurement {
  /** Re-centred position, analysis px of the plane measured. */
  cx: number
  cy: number
  /** Half-level radius in analysis px, or null if no estimate. */
  r: number | null
  /** Radius of steepest radial descent (analysis px), or null. */
  rEdge: number | null
  /** F at the centre minus local baseline. */
  contrast: number
  snr: number
  /** Robust coefficient of variation of the sector radii (0 = perfect circle). */
  cv: number
  /** Fraction of sectors without a clean boundary (merged or touching). */
  blockedFrac: number
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
  // re-centre up to twice using the circle through clean boundary points
  for (let it = 0; it < 2 && m.r !== null && m.boundary.length >= 8; it++) {
    const c = fitCircleKasa(m.boundary)
    if (!c || !Number.isFinite(c.x)) break
    const shift = Math.hypot(c.x - x, c.y - y)
    if (shift > 0.6 * m.r + 1) break // do not walk to a neighbouring colony
    cx = c.x
    cy = c.y
    m = profileAt(ctx, cx, cy)
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
  dip: boolean
  sharpness: number
  boundary: Pt[]
}

function profileAt(ctx: MeasureContext, cx: number, cy: number): Profiled {
  const { F, rMax } = ctx
  const nk = Math.max(4, Math.ceil(rMax / STEP) + 1)
  const prof: Float32Array[] = []
  for (let s = 0; s < SECTORS; s++) {
    const p = new Float32Array(nk)
    for (const off of [-1 / 3, 0, 1 / 3]) {
      const th = ((s + off) / SECTORS) * 2 * Math.PI
      const ux = Math.cos(th)
      const uy = Math.sin(th)
      for (let k = 0; k < nk; k++) p[k] += sampleBilinear(F, cx + ux * k * STEP, cy + uy * k * STEP) / 3
    }
    prof.push(p)
  }
  const k1 = Math.max(1, Math.round(1 / STEP))
  const centre = median(prof.map((p) => mean(p, 0, k1 + 1)))
  const ringMax = median(prof.map((p) => max(p, 0, Math.max(k1 + 1, Math.floor(nk / 3)))))
  const tail = median(prof.map((p) => mean(p, Math.floor(nk * 0.8), nk)))
  const peak = Math.max(centre, ringMax)
  const dip = centre < 0.6 * ringMax && ringMax > 0
  const baseline = Math.min(tail, 0.25 * peak)
  const level = baseline + 0.5 * (peak - baseline)
  const radii: number[] = []
  const boundary: Pt[] = []
  let blocked = 0
  const slope = new Float64Array(nk)
  let slopeN = 0
  for (let s = 0; s < SECTORS; s++) {
    const p = prof[s]
    // start searching after the peak region
    let kPeak = 0
    for (let k = 0; k < Math.floor(nk / 3); k++) if (p[k] > p[kPeak]) kPeak = k
    let cross = -1
    for (let k = kPeak + 1; k < nk; k++) {
      if (p[k] < level) {
        cross = k
        break
      }
    }
    if (cross < 0) {
      blocked++
      continue
    }
    const t = (p[cross - 1] - level) / Math.max(p[cross - 1] - p[cross], 1e-9)
    const rs = (cross - 1 + t) * STEP
    // rising again above the level within ~1.2 r: a touching neighbour in this direction
    let rerise = false
    const kEnd = Math.min(nk, Math.ceil((rs * 2.2) / STEP))
    for (let k = cross + 1; k < kEnd; k++) {
      if (p[k] > level) {
        rerise = true
        break
      }
    }
    if (rerise) blocked++
    radii.push(rs)
    if (!rerise) {
      const th = (s / SECTORS) * 2 * Math.PI
      boundary.push({ x: cx + Math.cos(th) * rs, y: cy + Math.sin(th) * rs })
      for (let k = 1; k < nk - 1; k++) slope[k] += (p[k - 1] - p[k + 1]) / (2 * STEP)
      slopeN++
    }
  }
  const contrast = peak - baseline
  if (radii.length < SECTORS / 4 || contrast <= 0) {
    return { r: null, rEdge: null, contrast, cv: 1, blockedFrac: blocked / SECTORS, dip, sharpness: 0, boundary: [] }
  }
  const clean = boundary.length >= SECTORS / 4 ? boundary.map((b) => Math.hypot(b.x - cx, b.y - cy)) : radii
  const r = median(clean)
  const cv = mad(clean) / r
  let rEdge: number | null = null
  let sharp = 0
  if (slopeN > 0) {
    let best = -Infinity
    for (let k = Math.max(1, Math.floor((0.3 * r) / STEP)); k < Math.min(nk - 1, Math.ceil((1.7 * r) / STEP)); k++) {
      const v = slope[k] / slopeN
      if (v > best) {
        best = v
        rEdge = k * STEP
      }
    }
    sharp = best > 0 ? (best * r) / contrast : 0
  }
  return { r, rEdge, contrast, cv, blockedFrac: blocked / SECTORS, dip, sharpness: sharp, boundary }
}

function mean(p: Float32Array, a: number, b: number): number {
  let s = 0
  for (let k = a; k < b; k++) s += p[k]
  return s / Math.max(1, b - a)
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
  if (m.blockedFrac >= 0.3) return { quality: 'touching', note: 'touches other colonies' }
  if (m.snr < 4) return { quality: 'weak', note: 'low contrast' }
  if (m.cv > 0.3) return { quality: 'weak', note: 'irregular outline' }
  if (m.rEdge !== null && Math.abs(Math.log(m.rEdge / m.r)) > 0.5) return { quality: 'weak', note: 'blurred or ambiguous edge' }
  return { quality: 'ok' }
}

/** Robust log-normal prior from radii in ORIGINAL px. */
export function radiusPrior(radiiOriginal: number[], sMin: number): RadiusPrior | null {
  const n = radiiOriginal.length
  if (n === 0) return null
  const z = radiiOriginal.map(Math.log)
  const mu = median(z)
  const raw = n > 1 ? mad(z, mu) : 0
  const s = Math.max(sMin, raw) * Math.sqrt(1 + 1 / n)
  return { mu, s, sMin, n, rMedian: Math.exp(mu), rRange: [Math.exp(mu - 2 * s), Math.exp(mu + 2 * s)] }
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
