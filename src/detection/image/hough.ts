/**
 * Gradient-direction circle Hough transform and a RANSAC-style robust circle
 * fit. Used to find a round dish; also usable for any single dominant circle.
 */
import { sobel } from './filters.ts'
import { fitCircleKasa, refineCircle, type Circle, type Pt } from './contour.ts'
import type { Plane } from './plane.ts'

export interface HoughOptions {
  rMin: number
  rMax: number
  /** Edge pixels need gradient magnitude ≥ this quantile of all magnitudes (default 0.9). */
  edgeQuantile?: number
  /** Vote towards brighter (+1), darker (−1) or both (0) sides of the edge. */
  polarity?: -1 | 0 | 1
}

export interface HoughCircle extends Circle {
  /** Fraction of the circle's circumference supported by edge pixels (0..1). */
  support: number
}

/** Find the single strongest circle. Null if nothing plausible. */
export function houghCircle(src: Plane, opts: HoughOptions): HoughCircle | null {
  const { width: w, height: h } = src
  const { gx, gy } = sobel(src)
  const mag = new Float32Array(w * h)
  for (let i = 0; i < mag.length; i++) mag[i] = Math.hypot(gx.data[i], gy.data[i])
  const sorted = Float32Array.from(mag).sort()
  const tMag = sorted[Math.floor((opts.edgeQuantile ?? 0.9) * (sorted.length - 1))]
  const acc = new Float32Array(w * h)
  const edges: number[] = []
  const pol = opts.polarity ?? 0
  const rStep = 1
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const m = mag[i]
      if (m <= tMag || m === 0) continue
      edges.push(i)
      const ux = gx.data[i] / m
      const uy = gy.data[i] / m
      const dirs = pol === 0 ? [1, -1] : [pol]
      for (const s of dirs) {
        for (let r = opts.rMin; r <= opts.rMax; r += rStep) {
          const cx = Math.round(x + s * ux * r)
          const cy = Math.round(y + s * uy * r)
          if (cx < 0 || cy < 0 || cx >= w || cy >= h) break
          acc[cy * w + cx] += 1
        }
      }
    }
  }
  // smooth the accumulator lightly by 3×3 sum, then take the max
  let best = -1
  let bi = -1
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let s = 0
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += acc[(y + dy) * w + x + dx]
      if (s > best) {
        best = s
        bi = y * w + x
      }
    }
  }
  if (bi < 0 || edges.length === 0) return null
  const cx = (bi % w) + 0.5
  const cy = ((bi / w) | 0) + 0.5
  // radius histogram of edge pixels around the centre
  const nb = Math.ceil(opts.rMax - opts.rMin) + 1
  const hist = new Float32Array(nb)
  for (const i of edges) {
    const d = Math.hypot((i % w) + 0.5 - cx, ((i / w) | 0) + 0.5 - cy)
    const b = Math.round(d - opts.rMin)
    if (b >= 0 && b < nb) hist[b] += 1 / Math.max(d, 1)
  }
  let hb = 0
  for (let b = 1; b < nb; b++) if (hist[b] + (hist[b - 1] ?? 0) > hist[hb] + (hist[hb - 1] ?? 0)) hb = b
  const r = opts.rMin + hb
  // support: fraction of angle bins with an edge pixel within ±2 px of the circle
  const bins = new Uint8Array(180)
  for (const i of edges) {
    const px = (i % w) + 0.5
    const py = ((i / w) | 0) + 0.5
    const d = Math.hypot(px - cx, py - cy)
    if (Math.abs(d - r) <= 2) bins[Math.floor(((Math.atan2(py - cy, px - cx) + Math.PI) / (2 * Math.PI)) * 179.999)] = 1
  }
  let sup = 0
  for (const b of bins) sup += b
  return { x: cx, y: cy, r, support: sup / bins.length }
}

/** Robust circle fit: random minimal triples, inlier consensus within `tol` px, then least-squares refit. */
export function ransacCircle(pts: Pt[], tol: number, iterations = 200, rng: () => number = Math.random): (Circle & { inliers: number }) | null {
  if (pts.length < 3) return null
  let best: Circle | null = null
  let bestIn = -1
  for (let it = 0; it < iterations; it++) {
    const a = pts[Math.floor(rng() * pts.length)]
    const b = pts[Math.floor(rng() * pts.length)]
    const c = pts[Math.floor(rng() * pts.length)]
    const circ = fitCircleKasa([a, b, c])
    if (!circ) continue
    let inl = 0
    for (const p of pts) if (Math.abs(Math.hypot(p.x - circ.x, p.y - circ.y) - circ.r) <= tol) inl++
    if (inl > bestIn) {
      bestIn = inl
      best = circ
    }
  }
  if (!best) return null
  const inliers = pts.filter((p) => Math.abs(Math.hypot(p.x - best!.x, p.y - best!.y) - best!.r) <= tol)
  const k = fitCircleKasa(inliers)
  const refined = k ? refineCircle(inliers, k) : best
  return { ...refined, inliers: inliers.length }
}
