/**
 * Plate region of interest.
 *
 * Auto-detection does not assume a round dish (the first real test set uses
 * square plates). It grows the agar region from the image centre on a small
 * luma image, keeps the component touching the centre, fills holes (colonies,
 * writing, bubbles), takes the convex hull (colonies touching the wall would
 * otherwise notch the outline) and finally erodes by a rim margin.
 * A user ROI (circle or rectangle, original px) overrides the auto result.
 */
import { toLuma } from './image/color.ts'
import { fillHoles, labelComponents } from './image/components.ts'
import { traceAllOuterContours, fitCircleKasa, type Pt } from './image/contour.ts'
import { distanceTransform } from './image/distance.ts'
import { resizeArea } from './image/filters.ts'
import { convexHull, polygonArea, rasterizeCircle, rasterizePolygon, rasterizeRect, simplifyPolyline } from './image/geometry.ts'
import { makeMask, type Mask, type RgbaImage } from './image/plane.ts'
import { mad, median } from './image/threshold.ts'
import type { Roi, RoiReport } from './types.ts'

export interface RoiResult {
  /** Analysis-scale mask of pixels to analyse (after the margin). */
  mask: Mask
  /** Analysis-scale mask of the whole plate (before the margin). */
  plate: Mask
  report: RoiReport
  warnings: string[]
}

const WORK_SIDE = 480

/**
 * @param image analysis-scale RGBA
 * @param scale analysis px per original px
 */
export function computeRoi(image: RgbaImage, scale: number, userRoi: Roi | undefined, edgeMarginFrac: number): RoiResult {
  const { width: w, height: h } = image
  const warnings: string[] = []
  if (userRoi) {
    const plate =
      userRoi.kind === 'circle'
        ? rasterizeCircle(userRoi.cx * scale, userRoi.cy * scale, userRoi.r * scale, w, h)
        : rasterizeRect(userRoi.x * scale, userRoi.y * scale, userRoi.w * scale, userRoi.h * scale, w, h)
    const outline =
      userRoi.kind === 'circle'
        ? Array.from({ length: 64 }, (_, i) => ({
            x: userRoi.cx + userRoi.r * Math.cos((i / 64) * 2 * Math.PI),
            y: userRoi.cy + userRoi.r * Math.sin((i / 64) * 2 * Math.PI),
          }))
        : [
            { x: userRoi.x, y: userRoi.y },
            { x: userRoi.x + userRoi.w, y: userRoi.y },
            { x: userRoi.x + userRoi.w, y: userRoi.y + userRoi.h },
            { x: userRoi.x, y: userRoi.y + userRoi.h },
          ]
    return { mask: plate, plate, report: { source: 'user', outline, shape: 'user', marginPx: 0, area: count(plate) / (scale * scale) }, warnings }
  }

  // --- auto: work on a small luma image
  const f = Math.min(1, WORK_SIDE / Math.max(w, h))
  const sw = Math.max(8, Math.round(w * f))
  const sh = Math.max(8, Math.round(h * f))
  const small = resizeArea(toLuma(image), sw, sh)
  const centre: number[] = []
  for (let y = Math.floor(sh * 0.35); y < Math.ceil(sh * 0.65); y++)
    for (let x = Math.floor(sw * 0.35); x < Math.ceil(sw * 0.65); x++) centre.push(small.data[y * sw + x])
  const agar = median(centre)
  const spread = mad(centre)
  const lo = Math.min(agar * 0.55, agar - 4 * spread)
  const hi = Math.max(agar * 1.5, agar + 4 * spread)
  const cand = makeMask(sw, sh)
  for (let i = 0; i < cand.data.length; i++) cand.data[i] = small.data[i] >= lo && small.data[i] <= hi ? 1 : 0
  // open by a small disk to cut thin bridges to the surroundings
  const openR = Math.max(1, Math.round(Math.min(sw, sh) * 0.006))
  const eroded = thresholdDistance(distanceTransform(cand), openR)
  const lab = labelComponents(eroded, 4)
  // component covering most of the central window
  const votes = new Map<number, number>()
  for (let y = Math.floor(sh * 0.35); y < Math.ceil(sh * 0.65); y++)
    for (let x = Math.floor(sw * 0.35); x < Math.ceil(sw * 0.65); x++) {
      const l = lab.labels[y * sw + x]
      if (l) votes.set(l, (votes.get(l) ?? 0) + 1)
    }
  let bestLabel = 0
  let bestVotes = 0
  for (const [l, v] of votes) if (v > bestVotes) [bestLabel, bestVotes] = [l, v]
  let plateSmall = makeMask(sw, sh)
  if (bestLabel) {
    for (let i = 0; i < plateSmall.data.length; i++) plateSmall.data[i] = lab.labels[i] === bestLabel ? 1 : 0
    // undo the erosion: dilate by the same radius
    const inv = makeMask(sw, sh)
    for (let i = 0; i < inv.data.length; i++) inv.data[i] = plateSmall.data[i] ? 0 : 1
    const dOut = distanceTransform(inv, false)
    for (let i = 0; i < plateSmall.data.length; i++) plateSmall.data[i] = dOut.data[i] <= openR ? 1 : 0
    plateSmall = fillHoles(plateSmall)
  }
  const areaFrac = count(plateSmall) / (sw * sh)
  let source: RoiReport['source'] = 'auto'
  let hullSmall: Pt[]
  if (!bestLabel || areaFrac < 0.08 || areaFrac > 0.97) {
    source = 'fallback'
    warnings.push('Could not find the plate outline; analysing the central 90 % of the image. Draw a region to restrict the search.')
    const mx = sw * 0.05
    const my = sh * 0.05
    hullSmall = [
      { x: mx, y: my },
      { x: sw - mx, y: my },
      { x: sw - mx, y: sh - my },
      { x: mx, y: sh - my },
    ]
  } else {
    const contour = traceAllOuterContours(plateSmall, 8).sort((a, b) => b.length - a.length)[0] ?? []
    hullSmall = convexHull(contour)
  }
  // map hull to analysis scale and rasterise
  const toAnalysis = (p: Pt): Pt => ({ x: (p.x / sw) * w, y: (p.y / sh) * h })
  const hullA = hullSmall.map(toAnalysis)
  const plate = rasterizePolygon(hullA, w, h)
  const areaA = count(plate)
  const eqDiam = 2 * Math.sqrt(areaA / Math.PI)
  const marginA = source === 'fallback' ? 0 : edgeMarginFrac * eqDiam
  const dist = distanceTransform(plate)
  const mask = thresholdDistance(dist, marginA)
  const outline = simplifyPolyline([...hullA, hullA[0]], 0.75).slice(0, -1).map((p) => ({ x: p.x / scale, y: p.y / scale }))
  return {
    mask,
    plate,
    report: { source, outline, shape: source === 'fallback' ? 'other' : classifyShape(hullA), marginPx: marginA / scale, area: count(mask) / (scale * scale) },
    warnings,
  }
}

/** Pixels whose distance to the background exceeds `r`. */
function thresholdDistance(d: { width: number; height: number; data: Float32Array }, r: number): Mask {
  const m = makeMask(d.width, d.height)
  for (let i = 0; i < m.data.length; i++) m.data[i] = d.data[i] > r ? 1 : 0
  return m
}

function count(m: Mask): number {
  let n = 0
  for (let i = 0; i < m.data.length; i++) n += m.data[i]
  return n
}

/** Round if the hull fills its fitted circle, square-ish if it fills its bounding box. */
export function classifyShape(hull: Pt[]): RoiReport['shape'] {
  if (hull.length < 3) return 'other'
  const area = polygonArea(hull)
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of hull) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x)
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y)
  }
  const boxFill = area / ((maxX - minX) * (maxY - minY))
  const c = fitCircleKasa(hull)
  const circleFill = c ? area / (Math.PI * c.r * c.r) : 0
  if (boxFill > 0.9) return 'square'
  if (circleFill > 0.9 && boxFill < 0.82) return 'round'
  return 'other'
}
