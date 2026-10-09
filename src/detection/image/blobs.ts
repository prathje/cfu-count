/**
 * Scale-normalised Laplacian-of-Gaussian, local maxima and non-maximum
 * suppression. A disk of radius r gives the strongest normalised LoG response
 * at σ = r / √2.
 */
import { gaussianBlur } from './filters.ts'
import { makePlane, type Plane } from './plane.ts'

/** −σ² ∇²(G_σ * I): positive at the centre of BRIGHT blobs. 5-point Laplacian, clamped borders. */
export function logResponse(src: Plane, sigma: number): Plane {
  const g = gaussianBlur(src, sigma)
  const { width: w, height: h } = g
  const out = makePlane(w, h)
  const d = g.data
  const s2 = sigma * sigma
  for (let y = 0; y < h; y++) {
    const ym = y > 0 ? y - 1 : 0
    const yp = y < h - 1 ? y + 1 : h - 1
    for (let x = 0; x < w; x++) {
      const xm = x > 0 ? x - 1 : 0
      const xp = x < w - 1 ? x + 1 : w - 1
      const lap = d[y * w + xm] + d[y * w + xp] + d[ym * w + x] + d[yp * w + x] - 4 * d[y * w + x]
      out.data[y * w + x] = -s2 * lap
    }
  }
  return out
}

/** Radii → LoG sigmas. */
export const sigmaForRadius = (r: number): number => r / Math.SQRT2
export const radiusForSigma = (s: number): number => s * Math.SQRT2

export interface Peak {
  x: number
  y: number
  value: number
}

/**
 * Strict local maxima over a (2r+1)² window with value ≥ `minValue`, restricted
 * to `within` (if given). Plateaus keep their first pixel in raster order.
 * Returned coordinates are pixel centres (+0.5).
 */
export function localMaxima(p: Plane, r: number, minValue: number, within?: Uint8Array): Peak[] {
  const { width: w, height: h, data } = p
  const out: Peak[] = []
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const v = data[i]
      if (v < minValue || (within && !within[i])) continue
      let isMax = true
      for (let dy = -r; dy <= r && isMax; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= h) continue
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= w || (dx === 0 && dy === 0)) continue
          const u = data[yy * w + xx]
          // strict against earlier pixels in raster order, non-strict against later ones
          const earlier = dy < 0 || (dy === 0 && dx < 0)
          if (u > v || (earlier && u === v)) {
            isMax = false
            break
          }
        }
      }
      if (isMax) out.push({ x: x + 0.5, y: y + 0.5, value: v })
    }
  }
  return out
}

export interface Blob {
  x: number
  y: number
  r: number
  sigma: number
  response: number
}

/**
 * Multi-scale LoG blob detection: maxima in (x, y) per scale that also beat
 * the neighbouring scales at the same pixel; then circle NMS.
 */
export function detectBlobsLoG(
  src: Plane,
  radii: number[],
  minResponse: number,
  within?: Uint8Array,
  overlap = 0.5,
): { blobs: Blob[]; responses: Plane[] } {
  const sigmas = radii.map(sigmaForRadius)
  const responses = sigmas.map((s) => logResponse(src, s))
  const blobs: Blob[] = []
  for (let k = 0; k < sigmas.length; k++) {
    const nr = Math.max(1, Math.round(sigmas[k] * 0.7))
    for (const pk of localMaxima(responses[k], nr, minResponse, within)) {
      const i = Math.floor(pk.y) * src.width + Math.floor(pk.x)
      if (k > 0 && responses[k - 1].data[i] > pk.value) continue
      if (k < sigmas.length - 1 && responses[k + 1].data[i] > pk.value) continue
      blobs.push({ x: pk.x, y: pk.y, sigma: sigmas[k], r: radii[k], response: pk.value })
    }
  }
  return { blobs: nmsCircles(blobs, overlap, (b) => b.response), responses }
}

/**
 * Greedy circle NMS: keep the highest-scoring circle and drop any lower-scoring
 * circle whose centre is closer than `overlap` × max(r_a, r_b) to a kept one.
 */
export function nmsCircles<T extends { x: number; y: number; r: number }>(items: T[], overlap: number, score: (t: T) => number): T[] {
  const sorted = items.slice().sort((a, b) => score(b) - score(a))
  const kept: T[] = []
  // uniform grid for neighbour lookup
  const cell = Math.max(1, Math.max(...sorted.map((s) => s.r), 1) * overlap * 2)
  const grid = new Map<string, T[]>()
  const key = (cx: number, cy: number) => `${cx},${cy}`
  for (const c of sorted) {
    const gx = Math.floor(c.x / cell)
    const gy = Math.floor(c.y / cell)
    let ok = true
    for (let dy = -1; dy <= 1 && ok; dy++) {
      for (let dx = -1; dx <= 1 && ok; dx++) {
        for (const k of grid.get(key(gx + dx, gy + dy)) ?? []) {
          if (Math.hypot(k.x - c.x, k.y - c.y) < overlap * Math.max(k.r, c.r)) {
            ok = false
            break
          }
        }
      }
    }
    if (!ok) continue
    kept.push(c)
    const kk = key(gx, gy)
    const list = grid.get(kk)
    if (list) list.push(c)
    else grid.set(kk, [c])
  }
  return kept
}
