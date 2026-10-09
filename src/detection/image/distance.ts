/**
 * Exact Euclidean distance transform (Felzenszwalb & Huttenlocher 2012,
 * "Distance Transforms of Sampled Functions"): two passes of the 1-D lower
 * envelope of parabolas. O(n) in the number of pixels.
 */
import { makePlane, type Mask, type Plane } from './plane.ts'

const INF = 1e20

function dt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0
  v[0] = 0
  z[0] = -INF
  z[1] = INF
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    while (s <= z[k]) {
      k--
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    }
    k++
    v[k] = q
    z[k] = s
    z[k + 1] = INF
  }
  k = 0
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++
    const dq = q - v[k]
    d[q] = dq * dq + f[v[k]]
  }
}

/**
 * Squared distance from every pixel to the nearest pixel where `isTarget` holds.
 * If no target exists the result is ~1e20 everywhere.
 */
export function squaredDistanceTo(width: number, height: number, isTarget: (i: number) => boolean): Float64Array {
  const n = Math.max(width, height)
  const f = new Float64Array(n)
  const d = new Float64Array(n)
  const v = new Int32Array(n)
  const z = new Float64Array(n + 1)
  const grid = new Float64Array(width * height)
  for (let i = 0; i < grid.length; i++) grid[i] = isTarget(i) ? 0 : INF
  // columns
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) f[y] = grid[y * width + x]
    dt1d(f, height, d, v, z)
    for (let y = 0; y < height; y++) grid[y * width + x] = d[y]
  }
  // rows
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) f[x] = grid[y * width + x]
    dt1d(f, width, d, v, z)
    for (let x = 0; x < width; x++) grid[y * width + x] = d[x]
  }
  return grid
}

/**
 * For each foreground pixel (mask ≠ 0): Euclidean distance to the nearest
 * background pixel. Background pixels get 0. Pixels outside the raster count
 * as background when `borderIsBackground` (default true), so a blob touching
 * the border is not treated as infinitely deep.
 */
export function distanceTransform(mask: Mask, borderIsBackground = true): Plane {
  const { width: w, height: h } = mask
  const pw = borderIsBackground ? w + 2 : w
  const ph = borderIsBackground ? h + 2 : h
  const off = borderIsBackground ? 1 : 0
  const isBg = (i: number) => {
    const x = (i % pw) - off
    const y = ((i / pw) | 0) - off
    if (x < 0 || y < 0 || x >= w || y >= h) return true
    return mask.data[y * w + x] === 0
  }
  const sq = squaredDistanceTo(pw, ph, isBg)
  const out = makePlane(w, h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) out.data[y * w + x] = Math.sqrt(sq[(y + off) * pw + x + off])
  }
  return out
}
