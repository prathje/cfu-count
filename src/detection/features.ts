/**
 * Analysis planes shared by all methods.
 *
 * The CONTRAST plane F is the background-flattened projection of the Lab
 * image onto the colour axis that separates the seeds from their local
 * background:   F = (Lab − background(Lab)) · axis
 * so the agar is ≈ 0 everywhere (uneven illumination removed) and colonies are
 * positive whatever their polarity or colour. The background is a normalised
 * (masked) Gaussian of each Lab channel over the plate, excluding detected
 * foreground in the second pass, so dense streaks do not bias it.
 */
import { toLab, saturationMask, type LabPlanes } from './image/color.ts'
import { blurWeight, normalizedBlur } from './image/filters.ts'
import { makePlane, type Mask, type Plane, type RgbaImage } from './image/plane.ts'
import { mad, median, selectValues } from './image/threshold.ts'
import { computeRoi, type RoiResult } from './roi.ts'
import type { Roi } from './types.ts'

export interface PreparedImage {
  width: number
  height: number
  /** Analysis px per original px. */
  scale: number
  lab: LabPlanes
  /** 1 where any RGB channel is (nearly) saturated. */
  saturated: Uint8Array
  roi: RoiResult
  /** Equivalent diameter of the plate in analysis px. */
  plateDiameter: number
}

export function prepareImage(image: RgbaImage, scale: number, userRoi: Roi | undefined, edgeMarginFrac: number): PreparedImage {
  const lab = toLab(image)
  const roi = computeRoi(image, scale, userRoi, edgeMarginFrac)
  let area = 0
  for (let i = 0; i < roi.plate.data.length; i++) area += roi.plate.data[i]
  return {
    width: image.width,
    height: image.height,
    scale,
    lab,
    saturated: saturationMask(image),
    roi,
    plateDiameter: 2 * Math.sqrt(Math.max(area, 1) / Math.PI),
  }
}

export type LabBackground = [Plane, Plane, Plane]

/** Masked Gaussian background of each Lab channel. `weight` 1 = background evidence. */
export function labBackground(lab: LabPlanes, weight: Uint8Array, sigma: number): LabBackground {
  // the blurred weights are the same for L, a and b
  const den = blurWeight(weight, lab.L.width, lab.L.height, sigma)
  const fb = (p: Plane) => {
    const vals = selectValues(p, weight, 50_000)
    return normalizedBlur(p, weight, sigma, vals.length ? median(vals) : 0, den)
  }
  return [fb(lab.L), fb(lab.a), fb(lab.b)]
}

/** Lab minus background at a point, averaged over a (2r+1)² window. */
export function labDiffAt(lab: LabPlanes, bg: LabBackground, x: number, y: number, r = 1): [number, number, number] {
  const { width: w, height: h } = lab.L
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const acc = [0, 0, 0]
  let n = 0
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const xx = xi + dx
      const yy = yi + dy
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue
      const i = yy * w + xx
      acc[0] += lab.L.data[i] - bg[0].data[i]
      acc[1] += lab.a.data[i] - bg[1].data[i]
      acc[2] += lab.b.data[i] - bg[2].data[i]
      n++
    }
  }
  return n ? [acc[0] / n, acc[1] / n, acc[2] / n] : [0, 0, 0]
}

/** Unit axis from seed colour differences; defaults to +L (bright colonies) when unknown. */
export function colorAxisFromDiffs(diffs: [number, number, number][]): [number, number, number] {
  if (diffs.length === 0) return [1, 0, 0]
  // median per component is robust to one odd seed (glare, bubble)
  const m: [number, number, number] = [median(diffs.map((d) => d[0])), median(diffs.map((d) => d[1])), median(diffs.map((d) => d[2]))]
  const n = Math.hypot(m[0], m[1], m[2])
  if (n < 1e-6) return [1, 0, 0]
  return [m[0] / n, m[1] / n, m[2] / n]
}

/** F = (Lab − bg) · axis. */
export function contrastPlane(lab: LabPlanes, bg: LabBackground, axis: [number, number, number]): Plane {
  const { width: w, height: h } = lab.L
  const F = makePlane(w, h)
  for (let i = 0; i < F.data.length; i++) {
    F.data[i] =
      (lab.L.data[i] - bg[0].data[i]) * axis[0] + (lab.a.data[i] - bg[1].data[i]) * axis[1] + (lab.b.data[i] - bg[2].data[i]) * axis[2]
  }
  return F
}

/** Robust noise σ of F over background pixels (`select`). */
export function noiseSigma(F: Plane, select: Uint8Array): number {
  const v = selectValues(F, select, 100_000)
  const s = mad(v, median(v))
  return Number.isFinite(s) && s > 1e-3 ? s : 1e-3
}

/** Weight mask: inside `region` and not in `exclude`. */
export function weightMask(region: Mask, exclude?: Mask): Uint8Array {
  const out = new Uint8Array(region.data.length)
  for (let i = 0; i < out.length; i++) out[i] = region.data[i] && !(exclude && exclude.data[i]) ? 1 : 0
  return out
}
