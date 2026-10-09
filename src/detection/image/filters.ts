/**
 * Linear and rank filters on float planes. Borders are handled by clamping
 * (replicating the edge pixel), except the masked/normalised blur, which
 * ignores pixels outside the mask entirely.
 */
import { makePlane, type Plane } from './plane.ts'

/** Normalised 1-D Gaussian kernel truncated at ±ceil(3σ). */
export function gaussianKernel(sigma: number): Float32Array {
  const rad = Math.max(1, Math.ceil(3 * sigma))
  const k = new Float32Array(2 * rad + 1)
  let sum = 0
  for (let i = -rad; i <= rad; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma))
    k[i + rad] = v
    sum += v
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum
  return k
}

/** Convolve rows then columns with the same symmetric kernel. */
export function convolveSeparable(src: Plane, kernel: Float32Array): Plane {
  const { width: w, height: h } = src
  const rad = (kernel.length - 1) >> 1
  const tmp = new Float32Array(w * h)
  const out = makePlane(w, h)
  const s = src.data
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      let acc = 0
      for (let k = -rad; k <= rad; k++) {
        let xx = x + k
        if (xx < 0) xx = 0
        else if (xx >= w) xx = w - 1
        acc += s[row + xx] * kernel[k + rad]
      }
      tmp[row + x] = acc
    }
  }
  const o = out.data
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0
      for (let k = -rad; k <= rad; k++) {
        let yy = y + k
        if (yy < 0) yy = 0
        else if (yy >= h) yy = h - 1
        acc += tmp[yy * w + x] * kernel[k + rad]
      }
      o[y * w + x] = acc
    }
  }
  return out
}

/**
 * Gaussian blur. Small σ uses an exact separable kernel; large σ (> 8 px) uses
 * three box passes, which approximate a Gaussian closely at O(1) per pixel.
 */
export function gaussianBlur(src: Plane, sigma: number): Plane {
  if (sigma <= 0) return { width: src.width, height: src.height, data: src.data.slice() }
  if (sigma <= 8) return convolveSeparable(src, gaussianKernel(sigma))
  let p = src
  for (const r of boxRadiiForGauss(sigma, 3)) p = boxBlur(p, r)
  return p
}

/** Box radii whose repeated application approximates a Gaussian of `sigma` (Kovesi 2010). */
export function boxRadiiForGauss(sigma: number, n: number): number[] {
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1)
  let wl = Math.floor(wIdeal)
  if (wl % 2 === 0) wl--
  const wu = wl + 2
  const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4)
  const m = Math.round(mIdeal)
  const radii: number[] = []
  for (let i = 0; i < n; i++) radii.push(((i < m ? wl : wu) - 1) / 2)
  return radii
}

/** Mean over a (2r+1)² window, running sums, clamped borders. */
export function boxBlur(src: Plane, r: number): Plane {
  const { width: w, height: h } = src
  if (r <= 0) return { width: w, height: h, data: src.data.slice() }
  const tmp = new Float32Array(w * h)
  const out = makePlane(w, h)
  const norm = 1 / (2 * r + 1)
  const s = src.data
  for (let y = 0; y < h; y++) {
    const row = y * w
    let acc = 0
    for (let k = -r; k <= r; k++) acc += s[row + Math.min(Math.max(k, 0), w - 1)]
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc * norm
      const add = Math.min(x + r + 1, w - 1)
      const sub = Math.max(x - r, 0)
      acc += s[row + add] - s[row + sub]
    }
  }
  const o = out.data
  for (let x = 0; x < w; x++) {
    let acc = 0
    for (let k = -r; k <= r; k++) acc += tmp[Math.min(Math.max(k, 0), h - 1) * w + x]
    for (let y = 0; y < h; y++) {
      o[y * w + x] = acc * norm
      const add = Math.min(y + r + 1, h - 1)
      const sub = Math.max(y - r, 0)
      acc += tmp[add * w + x] - tmp[sub * w + x]
    }
  }
  return out
}

/**
 * Normalised (masked) Gaussian: blur(src·weight) / blur(weight). Pixels with
 * weight 0 do not contribute; where the blurred weight is ~0 the result is
 * `fallback`. Used to estimate background while ignoring colonies and the
 * area outside the plate.
 */
export function normalizedBlur(src: Plane, weight: Uint8Array | Float32Array, sigma: number, fallback = 0): Plane {
  const n = src.width * src.height
  const num = makePlane(src.width, src.height)
  const den = makePlane(src.width, src.height)
  for (let i = 0; i < n; i++) {
    const wt = weight[i]
    num.data[i] = src.data[i] * wt
    den.data[i] = wt
  }
  const bn = gaussianBlur(num, sigma)
  const bd = gaussianBlur(den, sigma)
  const out = makePlane(src.width, src.height)
  for (let i = 0; i < n; i++) out.data[i] = bd.data[i] > 1e-4 ? bn.data[i] / bd.data[i] : fallback
  return out
}

/** Median over a (2r+1)² window (r ≤ 2 intended: 3×3 or 5×5 despeckle). */
export function medianFilter(src: Plane, r = 1): Plane {
  const { width: w, height: h } = src
  const out = makePlane(w, h)
  const win = new Float32Array((2 * r + 1) * (2 * r + 1))
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let k = 0
      for (let dy = -r; dy <= r; dy++) {
        const yy = Math.min(Math.max(y + dy, 0), h - 1)
        for (let dx = -r; dx <= r; dx++) {
          const xx = Math.min(Math.max(x + dx, 0), w - 1)
          win[k++] = src.data[yy * w + xx]
        }
      }
      win.sort()
      out.data[y * w + x] = win[k >> 1]
    }
  }
  return out
}

/** Central-difference gradient magnitude. */
export function gradientMagnitude(src: Plane): Plane {
  const { width: w, height: h } = src
  const out = makePlane(w, h)
  const d = src.data
  for (let y = 0; y < h; y++) {
    const ym = Math.max(y - 1, 0)
    const yp = Math.min(y + 1, h - 1)
    for (let x = 0; x < w; x++) {
      const xm = Math.max(x - 1, 0)
      const xp = Math.min(x + 1, w - 1)
      const gx = (d[y * w + xp] - d[y * w + xm]) * 0.5
      const gy = (d[yp * w + x] - d[ym * w + x]) * 0.5
      out.data[y * w + x] = Math.hypot(gx, gy)
    }
  }
  return out
}

/** Sobel gradients (gx, gy), for Hough voting. */
export function sobel(src: Plane): { gx: Plane; gy: Plane } {
  const { width: w, height: h } = src
  const gx = makePlane(w, h)
  const gy = makePlane(w, h)
  const d = src.data
  const at = (x: number, y: number) => d[Math.min(Math.max(y, 0), h - 1) * w + Math.min(Math.max(x, 0), w - 1)]
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = at(x - 1, y - 1), b = at(x, y - 1), c = at(x + 1, y - 1)
      const dd = at(x - 1, y), f = at(x + 1, y)
      const g = at(x - 1, y + 1), hh = at(x, y + 1), ii = at(x + 1, y + 1)
      gx.data[y * w + x] = (c + 2 * f + ii - a - 2 * dd - g) / 8
      gy.data[y * w + x] = (g + 2 * hh + ii - a - 2 * b - c) / 8
    }
  }
  return { gx, gy }
}

/** Area-average downsample by an arbitrary factor (scale < 1). Exact box integration per output pixel. */
export function resizeArea(src: Plane, outW: number, outH: number): Plane {
  const out = makePlane(outW, outH)
  const sx = src.width / outW
  const sy = src.height / outH
  for (let oy = 0; oy < outH; oy++) {
    const y0 = oy * sy
    const y1 = y0 + sy
    for (let ox = 0; ox < outW; ox++) {
      const x0 = ox * sx
      const x1 = x0 + sx
      let acc = 0
      let wsum = 0
      for (let y = Math.floor(y0); y < Math.min(Math.ceil(y1), src.height); y++) {
        const wy = Math.min(y + 1, y1) - Math.max(y, y0)
        for (let x = Math.floor(x0); x < Math.min(Math.ceil(x1), src.width); x++) {
          const wx = Math.min(x + 1, x1) - Math.max(x, x0)
          acc += src.data[y * src.width + x] * wx * wy
          wsum += wx * wy
        }
      }
      out.data[oy * outW + ox] = wsum > 0 ? acc / wsum : 0
    }
  }
  return out
}
