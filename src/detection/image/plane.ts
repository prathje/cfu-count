/**
 * Raster containers shared by all detection primitives. Pure data, no DOM.
 *
 * Coordinates: pixel (x, y) is stored at index y * width + x. Its centre is at
 * (x + 0.5, y + 0.5) in continuous image coordinates, matching the app's data
 * contract (src/model/types.ts).
 */

/** Anything shaped like `ImageData` (RGBA, 8 bit, row-major). */
export interface RgbaImage {
  width: number
  height: number
  data: Uint8ClampedArray | Uint8Array
}

/** One float channel. */
export interface Plane {
  width: number
  height: number
  data: Float32Array
}

/** Binary (0/1) or small-integer raster. */
export interface Mask {
  width: number
  height: number
  data: Uint8Array
}

export function makePlane(width: number, height: number, fill = 0): Plane {
  const data = new Float32Array(width * height)
  if (fill !== 0) data.fill(fill)
  return { width, height, data }
}

export function makeMask(width: number, height: number, fill = 0): Mask {
  const data = new Uint8Array(width * height)
  if (fill !== 0) data.fill(fill)
  return { width, height, data }
}

export function clonePlane(p: Plane): Plane {
  return { width: p.width, height: p.height, data: p.data.slice() }
}

/** Bilinear sample at continuous coordinates (pixel centres at +0.5); clamps at the border. */
export function sampleBilinear(p: Plane, x: number, y: number): number {
  const fx = Math.min(Math.max(x - 0.5, 0), p.width - 1)
  const fy = Math.min(Math.max(y - 0.5, 0), p.height - 1)
  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  const x1 = Math.min(x0 + 1, p.width - 1)
  const y1 = Math.min(y0 + 1, p.height - 1)
  const tx = fx - x0
  const ty = fy - y0
  const w = p.width
  const d = p.data
  const a = d[y0 * w + x0] * (1 - tx) + d[y0 * w + x1] * tx
  const b = d[y1 * w + x0] * (1 - tx) + d[y1 * w + x1] * tx
  return a * (1 - ty) + b * ty
}

/** Copy a rectangular window (clipped to the plane) into a new plane. */
export function cropPlane(p: Plane, x0: number, y0: number, w: number, h: number): Plane {
  const out = makePlane(w, h)
  for (let y = 0; y < h; y++) {
    const sy = y + y0
    if (sy < 0 || sy >= p.height) continue
    for (let x = 0; x < w; x++) {
      const sx = x + x0
      if (sx < 0 || sx >= p.width) continue
      out.data[y * w + x] = p.data[sy * p.width + sx]
    }
  }
  return out
}

/** Bytes used by a set of rasters (for memory reporting). */
export function rasterBytes(...rs: ({ data: ArrayBufferView } | null | undefined)[]): number {
  let n = 0
  for (const r of rs) if (r) n += r.data.byteLength
  return n
}
