/**
 * Context shared by the three methods: the contrast plane, the prior in
 * analysis px, the foreground mask and its clusters, and helpers to map
 * results back to original coordinates.
 */
import { fillHoles, labelComponents, type Labelling } from '../image/components.ts'
import { makeMask, type Mask, type Plane } from '../image/plane.ts'
import type { PreparedImage } from '../features.ts'
import type { DetectSettings } from '../types.ts'

/** Radius prior in ANALYSIS px with the user's prior-width multiplier applied. */
export interface AnalysisPrior {
  /** log of the typical radius (analysis px). */
  logR: number
  s: number
  rMed: number
  /** exp(logR ∓ 2s). */
  rLo: number
  rHi: number
}

export interface FixedColony {
  id: string
  x: number
  y: number
  r: number
}

export interface MethodContext {
  prep: PreparedImage
  /** Background-flattened contrast plane (colonies > 0). */
  F: Plane
  /** F lightly smoothed (σ ≈ 0.15 r) for thresholding. */
  Fs: Plane
  noise: number
  prior: AnalysisPrior
  /** Median seed contrast in F units (or a noise-based guess without seeds). */
  contrastRef: number
  /** Robust lower bound of seed contrast relative to contrastRef (0..1). */
  contrastLo: number
  /** Existing annotations (all groups) in analysis px. */
  fixed: FixedColony[]
  settings: DetectSettings
  /** Yields to the event loop, reports progress and throws if cancelled. */
  checkpoint: (fraction: number) => Promise<void>
}

/** Mask threshold and count penalty from the 0..1 sensitivity slider. */
export function sensitivityParams(sensitivity: number): { thrFrac: number; noiseK: number; lambda: number; logFrac: number } {
  const t = Math.min(Math.max(sensitivity, 0), 1)
  return {
    /** Mask threshold as a fraction of the typical seed contrast. */
    thrFrac: 0.65 - 0.35 * t,
    /** ... but never below this many noise σ. */
    noiseK: 4 - 2 * t,
    /** Count penalty per new colony, in units of one typical colony area. */
    lambda: 0.3 - 0.25 * t,
    /** LoG detection threshold as a fraction of the median seed LoG response. */
    logFrac: 0.55 - 0.35 * t,
  }
}

export function maskThreshold(ctx: MethodContext): number {
  const { thrFrac, noiseK } = sensitivityParams(ctx.settings.sensitivity)
  return Math.max(noiseK * ctx.noise, thrFrac * ctx.contrastRef)
}

/**
 * Foreground: Fs above the threshold inside the ROI, specks removed and
 * holes smaller than ~15 % of a typical colony filled.
 */
export function foregroundMask(ctx: MethodContext, threshold = maskThreshold(ctx)): Mask {
  const { Fs, prep, prior } = ctx
  const roi = prep.roi.mask.data
  const m = makeMask(Fs.width, Fs.height)
  for (let i = 0; i < m.data.length; i++) m.data[i] = roi[i] && Fs.data[i] > threshold ? 1 : 0
  const a0 = Math.PI * prior.rMed * prior.rMed
  // fill small holes only
  const filled = fillHoles(m)
  const holes = makeMask(m.width, m.height)
  for (let i = 0; i < m.data.length; i++) holes.data[i] = filled.data[i] && !m.data[i] ? 1 : 0
  const hl = labelComponents(holes, 4)
  for (let i = 0; i < m.data.length; i++) {
    const l = hl.labels[i]
    if (l && hl.stats[l - 1].area < 0.15 * a0) m.data[i] = 1
  }
  // drop specks
  const minArea = Math.max(2, 0.3 * Math.PI * prior.rLo * prior.rLo)
  const cl = labelComponents(m, 8)
  for (let i = 0; i < m.data.length; i++) {
    const l = cl.labels[i]
    if (l && cl.stats[l - 1].area < minArea) m.data[i] = 0
  }
  return m
}

export function clusters(mask: Mask): Labelling {
  return labelComponents(mask, 8)
}

export const clusterId = (label: number): string => `c${label}`

/** Original-px bbox [x, y, w, h] from an inclusive analysis-px bbox. */
export function bboxToOriginal(minX: number, minY: number, maxX: number, maxY: number, scale: number): [number, number, number, number] {
  return [minX / scale, minY / scale, (maxX - minX + 1) / scale, (maxY - minY + 1) / scale]
}

/** Fixed colonies whose centre lies inside `region` (analysis-px mask), or within `slack` px of it. */
export function fixedInRegion(fixed: FixedColony[], labels: Int32Array, width: number, height: number, label: number): FixedColony[] {
  const out: FixedColony[] = []
  for (const f of fixed) {
    const x = Math.floor(f.x)
    const y = Math.floor(f.y)
    if (x < 0 || y < 0 || x >= width || y >= height) continue
    if (labels[y * width + x] === label) out.push(f)
  }
  return out
}

/** True if (x, y) lies within `factor` × r of any fixed colony (duplicate check). */
export function nearFixed(fixed: FixedColony[], x: number, y: number, r: number, factor = 0.6): boolean {
  for (const f of fixed) if (Math.hypot(f.x - x, f.y - y) < factor * Math.max(r, f.r)) return true
  return false
}
