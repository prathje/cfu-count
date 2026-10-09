/**
 * Grey-scale morphology with square structuring elements using the van Herk /
 * Gil–Werman running min/max (O(1) per pixel regardless of size), plus
 * binary helpers.
 */
import { makePlane, type Mask, type Plane } from './plane.ts'

type Op = (a: number, b: number) => number

/** 1-D van Herk min/max over windows of length 2r+1, out-of-range treated as `pad`. */
function vanHerk1D(src: Float32Array, out: Float32Array, n: number, r: number, op: Op, pad: number): void {
  const k = 2 * r + 1
  const len = n + 2 * r
  const padded = new Float32Array(len + k)
  padded.fill(pad)
  for (let i = 0; i < n; i++) padded[i + r] = src[i]
  const g = new Float32Array(len + k)
  const hBuf = new Float32Array(len + k)
  for (let start = 0; start < len; start += k) {
    const end = Math.min(start + k, len + k)
    g[start] = padded[start]
    for (let i = start + 1; i < end; i++) g[i] = op(g[i - 1], padded[i])
    hBuf[end - 1] = padded[end - 1]
    for (let i = end - 2; i >= start; i--) hBuf[i] = op(hBuf[i + 1], padded[i])
  }
  for (let i = 0; i < n; i++) out[i] = op(hBuf[i], g[i + k - 1])
}

function separableRank(src: Plane, r: number, op: Op, pad: number): Plane {
  const { width: w, height: h } = src
  const tmp = makePlane(w, h)
  const out = makePlane(w, h)
  const row = new Float32Array(w)
  const rowOut = new Float32Array(w)
  for (let y = 0; y < h; y++) {
    row.set(src.data.subarray(y * w, y * w + w))
    vanHerk1D(row, rowOut, w, r, op, pad)
    tmp.data.set(rowOut, y * w)
  }
  const col = new Float32Array(h)
  const colOut = new Float32Array(h)
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) col[y] = tmp.data[y * w + x]
    vanHerk1D(col, colOut, h, r, op, pad)
    for (let y = 0; y < h; y++) out.data[y * w + x] = colOut[y]
  }
  return out
}

/** Grey erosion (minimum) over a (2r+1)² square. Borders are ignored (not padded with 0). */
export function erode(src: Plane, r: number): Plane {
  return separableRank(src, r, Math.min, Infinity)
}

/** Grey dilation (maximum) over a (2r+1)² square. */
export function dilate(src: Plane, r: number): Plane {
  return separableRank(src, r, Math.max, -Infinity)
}

export const opening = (src: Plane, r: number): Plane => dilate(erode(src, r), r)
export const closing = (src: Plane, r: number): Plane => erode(dilate(src, r), r)

/** White top-hat: src − opening. Keeps bright structures narrower than 2r+1. */
export function whiteTopHat(src: Plane, r: number): Plane {
  const o = opening(src, r)
  const out = makePlane(src.width, src.height)
  for (let i = 0; i < out.data.length; i++) out.data[i] = src.data[i] - o.data[i]
  return out
}

/** Black top-hat: closing − src. Keeps dark structures narrower than 2r+1. */
export function blackTopHat(src: Plane, r: number): Plane {
  const c = closing(src, r)
  const out = makePlane(src.width, src.height)
  for (let i = 0; i < out.data.length; i++) out.data[i] = c.data[i] - src.data[i]
  return out
}

/** Binary mask erosion by a disk of radius r (via the distance transform of the background). */
export function erodeMaskDisk(mask: Mask, r: number, edt: (m: Mask) => Plane): Mask {
  // distance from each pixel to the nearest background pixel
  const d = edt(mask)
  const out: Mask = { width: mask.width, height: mask.height, data: new Uint8Array(mask.data.length) }
  for (let i = 0; i < out.data.length; i++) out.data[i] = mask.data[i] && d.data[i] > r ? 1 : 0
  return out
}
