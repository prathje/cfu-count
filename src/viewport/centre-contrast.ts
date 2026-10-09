/**
 * Pure maths of the "Centre contrast" display mode (model/display.ts, channel
 * `centre`): each pixel's position along the colour axis from a sampled RIM
 * colour to a sampled colony CENTRE colour, in CIE Lab, mapped to grey so that
 * centres are bright, the rest of the disc mid-dark and the background dark.
 *
 * The per-pixel work is a lookup: the mapping is precomputed on a 33³ RGB grid
 * (a colour LUT) and read with trilinear interpolation, so the cost does not
 * depend on how expensive the colour maths is. Also: the eyedropper helpers
 * (patch mean, automatic rim estimate around a picked centre). No DOM.
 */

/** An sRGB colour, 0..255 per channel. */
export type Rgb = readonly [number, number, number]
export type Lab = readonly [number, number, number]

const srgbLinear = new Float64Array(256)
for (let i = 0; i < 256; i++) {
  const c = i / 255
  srgbLinear[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

function linearOf(v: number): number {
  if (Number.isInteger(v) && v >= 0 && v <= 255) return srgbLinear[v]
  const c = Math.min(255, Math.max(0, v)) / 255
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

const labF = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116)

/** sRGB (0..255, D65) to CIE L*a*b*. */
export function rgbToLab(r: number, g: number, b: number): Lab {
  const R = linearOf(r)
  const G = linearOf(g)
  const B = linearOf(b)
  const x = labF((0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047)
  const y = labF(0.2126729 * R + 0.7151522 * G + 0.072175 * B)
  const z = labF((0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883)
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)]
}

export const labDistance = (p: Lab, q: Lab) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])

/**
 * The axis is never shorter than this (ΔE): a centre that barely differs from
 * its rim would otherwise amplify JPEG noise into speckle.
 */
export const MIN_AXIS_DE = 6

/** Grey share given to the rest of the disc (between background and centre). */
export const RIM_LEVEL = 0.3

export interface CentreParams {
  centre: Rgb
  rim: Rgb
  /** Sigmoid steepness (≈ 2..16): higher = harder split between centre and rim. */
  separation: number
}

/**
 * Display value 0..1 for a pixel at axis position `t` (rim = 0, centre = 1):
 * two soft steps, background → rim at t = -0.5 (to RIM_LEVEL) and rim → centre
 * at t = 0.5 (to 1). Both steps share the steepness `k`.
 */
export function centreTone(t: number, k: number): number {
  const lo = 1 / (1 + Math.exp(-k * (t + 0.5)))
  const hi = 1 / (1 + Math.exp(-k * (t - 0.5)))
  return RIM_LEVEL * lo + (1 - RIM_LEVEL) * hi
}

/** Function from an sRGB colour to its axis position (rim = 0, centre = 1). */
export function axisPosition(centre: Rgb, rim: Rgb): (r: number, g: number, b: number) => number {
  const c = rgbToLab(...centre)
  const m = rgbToLab(...rim)
  let d = [c[0] - m[0], c[1] - m[1], c[2] - m[2]]
  let len = Math.hypot(d[0], d[1], d[2])
  if (len < 1e-6) {
    d = [1, 0, 0] // identical samples: fall back to lightness
    len = 1
  }
  const u = [d[0] / len, d[1] / len, d[2] / len]
  // Short axes are stretched to MIN_AXIS_DE about their midpoint (keeps centre above rim).
  const span = Math.max(len, MIN_AXIS_DE)
  const mid = [(c[0] + m[0]) / 2, (c[1] + m[1]) / 2, (c[2] + m[2]) / 2]
  return (r, g, b) => {
    const p = rgbToLab(r, g, b)
    return 0.5 + ((p[0] - mid[0]) * u[0] + (p[1] - mid[1]) * u[1] + (p[2] - mid[2]) * u[2]) / span
  }
}

// ------------------------------------------------------------------ colour LUT

/** Grid points per channel (0, 255/32, …, 255). */
export const CLUT_N = 33

/** A 3D lookup table: grey bytes on a CLUT_N³ RGB grid, index (r·N + g)·N + b. */
export interface ColourLut {
  n: number
  table: Uint8Array
}

/** Tabulate `fn` (sRGB → 0..1) on the grid. */
export function buildColourLut(fn: (r: number, g: number, b: number) => number, n = CLUT_N): ColourLut {
  const table = new Uint8Array(n * n * n)
  const step = 255 / (n - 1)
  let i = 0
  for (let r = 0; r < n; r++) {
    for (let g = 0; g < n; g++) {
      for (let b = 0; b < n; b++) {
        const v = fn(r * step, g * step, b * step)
        table[i++] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255)
      }
    }
  }
  return { n, table }
}

export function buildCentreLut(p: CentreParams): ColourLut {
  const pos = axisPosition(p.centre, p.rim)
  return buildColourLut((r, g, b) => centreTone(pos(r, g, b), p.separation))
}

/** Per-byte cell index and 8-bit fraction for an n-point grid. */
function gridTables(n: number) {
  const cell = new Uint8Array(256)
  const frac = new Uint16Array(256)
  for (let v = 0; v < 256; v++) {
    const f = (v * (n - 1)) / 255
    const i = Math.min(n - 2, Math.floor(f))
    cell[v] = i
    frac[v] = Math.round((f - i) * 256)
  }
  return { cell, frac }
}
const gridCache = new Map<number, ReturnType<typeof gridTables>>()
function grid(n: number) {
  let t = gridCache.get(n)
  if (!t) gridCache.set(n, (t = gridTables(n)))
  return t
}

/** Trilinear lookup of one colour: the grey value times 2^24 (8-bit fractions per axis). */
function sampleFixed(table: Uint8Array, n: number, cell: Uint8Array, frac: Uint16Array, r: number, g: number, b: number): number {
  const fr = frac[r]
  const fg = frac[g]
  const fb = frac[b]
  const nn = n * n
  const i = cell[r] * nn + cell[g] * n + cell[b]
  const c000 = table[i]
  const c001 = table[i + 1]
  const c010 = table[i + n]
  const c011 = table[i + n + 1]
  const c100 = table[i + nn]
  const c101 = table[i + nn + 1]
  const c110 = table[i + nn + n]
  const c111 = table[i + nn + n + 1]
  const c00 = (c000 << 8) + (c001 - c000) * fb
  const c01 = (c010 << 8) + (c011 - c010) * fb
  const c10 = (c100 << 8) + (c101 - c100) * fb
  const c11 = (c110 << 8) + (c111 - c110) * fb
  const c0 = (c00 << 8) + (c01 - c00) * fg
  const c1 = (c10 << 8) + (c11 - c10) * fg
  return c0 * 256 + (c1 - c0) * fr // up to 2^32: plain number maths, not int32 shifts
}

const ONE = 2 ** 24
const HALF = 2 ** 23

/** Interpolated grey byte for one colour. */
export function lookupColour(lut: ColourLut, r: number, g: number, b: number): number {
  const { cell, frac } = grid(lut.n)
  return ((sampleFixed(lut.table, lut.n, cell, frac, r, g, b) + HALF) / ONE) | 0
}

/**
 * Replace RGBA pixels [start, end) by grey `lut1d[clut(r, g, b)]` in place
 * (alpha kept). The 1D LUT is the usual brightness/contrast/gamma/invert curve.
 */
export function applyColourLut(data: Uint8ClampedArray, clut: ColourLut, lut1d: Uint8ClampedArray, start = 0, end = data.length >> 2): void {
  const { n, table } = clut
  const { cell, frac } = grid(n)
  const i1 = Math.min(data.length, end << 2)
  for (let i = start << 2; i < i1; i += 4) {
    const v = lut1d[((sampleFixed(table, n, cell, frac, data[i], data[i + 1], data[i + 2]) + HALF) / ONE) | 0]
    data[i] = v
    data[i + 1] = v
    data[i + 2] = v
  }
}

/**
 * 3×3 box blur of a grey RGBA image (reads R, writes R = G = B; alpha kept),
 * edges clamped. Run after the colour LUT: the centre axis is only a few ΔE
 * long, so JPEG noise would otherwise show as speckle. One pixel of reach fits
 * inside the adjusted layer's tile padding, so tiles stay seamless.
 */
export function smoothGrey(data: Uint8ClampedArray, width: number, height: number): void {
  if (width < 2 || height < 2) return
  const row = new Uint16Array(width * height) // horizontal 3-sums
  for (let y = 0; y < height; y++) {
    const o = y * width
    for (let x = 0; x < width; x++) {
      const l = x > 0 ? x - 1 : 0
      const r = x < width - 1 ? x + 1 : x
      row[o + x] = data[(o + l) * 4] + data[(o + x) * 4] + data[(o + r) * 4]
    }
  }
  for (let y = 0; y < height; y++) {
    const up = (y > 0 ? y - 1 : 0) * width
    const mid = y * width
    const dn = (y < height - 1 ? y + 1 : y) * width
    for (let x = 0; x < width; x++) {
      const v = ((row[up + x] + row[mid + x] + row[dn + x]) * 7282 + 32768) >> 16 // ≈ /9, rounded
      const i = (mid + x) * 4
      data[i] = v
      data[i + 1] = v
      data[i + 2] = v
    }
  }
}

// ------------------------------------------------------------------ eyedropper

/** Mean colour of the (2·radius+1)² patch around (cx, cy) in an RGBA buffer (clipped to it). */
export function patchMean(data: Uint8ClampedArray, width: number, height: number, cx: number, cy: number, radius: number): Rgb | null {
  const x0 = Math.max(0, Math.round(cx) - radius)
  const y0 = Math.max(0, Math.round(cy) - radius)
  const x1 = Math.min(width - 1, Math.round(cx) + radius)
  const y1 = Math.min(height - 1, Math.round(cy) + radius)
  let r = 0
  let g = 0
  let b = 0
  let k = 0
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * width + x) * 4
      r += data[i]
      g += data[i + 1]
      b += data[i + 2]
      k++
    }
  }
  return k ? [r / k, g / k, b / k] : null
}

/** Rays cast from the picked centre when estimating the rim. */
const RAYS = 32

export interface RimEstimate {
  rim: Rgb
  /** Estimated colony radius in buffer px. */
  radius: number
}

/**
 * Estimate the rim colour of the colony whose centre (cx, cy) the user picked,
 * from an RGBA buffer around it. Along each of 32 rays, the colony edge is the
 * first strong rise (a local peak at least half the ray's steepest) of colour
 * distance from the centre (smoothed); the median of
 * those is the radius R, and the rim is the mean colour of the ring at
 * 0.65–0.85 R. When that ring barely differs from the centre (uniform
 * colonies), the rim is moved toward the background just outside R, so the
 * axis keeps a useful direction. Null when nothing like an edge is found.
 */
export function estimateRim(data: Uint8ClampedArray, width: number, height: number, cx: number, cy: number, centre: Rgb): RimEstimate | null {
  const maxR = Math.floor(Math.min(cx, cy, width - 1 - cx, height - 1 - cy))
  if (maxR < 8) return null
  const cLab = rgbToLab(...centre)
  const at = (x: number, y: number): Lab => {
    const i = (Math.round(y) * width + Math.round(x)) * 4
    return rgbToLab(data[i], data[i + 1], data[i + 2])
  }
  const edges: number[] = []
  for (let k = 0; k < RAYS; k++) {
    const a = (k / RAYS) * 2 * Math.PI
    const dx = Math.cos(a)
    const dy = Math.sin(a)
    const dist: number[] = []
    for (let r = 0; r <= maxR; r++) dist.push(labDistance(at(cx + r * dx, cy + r * dy), cLab))
    // Box-smoothed distance; edge = largest rise over a short window.
    const w = Math.max(1, Math.round(maxR / 60))
    const sm = dist.map((_, i) => {
      let s = 0
      let n = 0
      for (let j = Math.max(0, i - w); j <= Math.min(dist.length - 1, i + w); j++) (s += dist[j], n++)
      return s / n
    })
    const gap = Math.max(2, w * 2)
    const rise: number[] = []
    for (let r = 0; r + gap < sm.length; r++) rise.push(r < 3 ? 0 : sm[r + gap] - sm[r])
    let top = 0
    for (const v of rise) top = Math.max(top, v)
    // The FIRST strong edge: in a dense cluster the largest rise is often the
    // cluster's outer edge, several colonies away.
    let best = 0
    let bestR = -1
    for (let r = 3; r < rise.length; r++) {
      if (rise[r] < Math.max(2, top * 0.5)) continue
      if (r + 1 < rise.length && rise[r + 1] >= rise[r]) continue // climb to the local peak
      best = rise[r]
      bestR = r + gap / 2
      break
    }
    if (bestR > 0 && best > 2) edges.push(bestR)
  }
  if (edges.length < RAYS / 4) return null
  edges.sort((p, q) => p - q)
  const R = edges[edges.length >> 1]
  const ring = (f0: number, f1: number): Rgb => {
    let r = 0
    let g = 0
    let b = 0
    let n = 0
    for (let k = 0; k < RAYS * 2; k++) {
      const a = (k / (RAYS * 2)) * 2 * Math.PI
      for (let f = f0; f <= f1 + 1e-9; f += 0.05) {
        const x = Math.round(cx + f * R * Math.cos(a))
        const y = Math.round(cy + f * R * Math.sin(a))
        if (x < 0 || y < 0 || x >= width || y >= height) continue
        const i = (y * width + x) * 4
        r += data[i]
        g += data[i + 1]
        b += data[i + 2]
        n++
      }
    }
    return n ? [r / n, g / n, b / n] : centre
  }
  let rim = ring(0.65, 0.85)
  const rimLab = rgbToLab(...rim)
  if (labDistance(rimLab, cLab) < MIN_AXIS_DE) {
    // Uniform colony: point the axis at the background (median-ish ring just outside).
    const bg = ring(1.3, 1.6)
    const bgLab = rgbToLab(...bg)
    const d = labDistance(bgLab, cLab)
    if (d > 1e-6) {
      const f = Math.min(1, MIN_AXIS_DE / d)
      rim = [centre[0] + (bg[0] - centre[0]) * f, centre[1] + (bg[1] - centre[1]) * f, centre[2] + (bg[2] - centre[2]) * f]
    }
  }
  return { rim, radius: R }
}
