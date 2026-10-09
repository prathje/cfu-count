/**
 * Pure pixel maths for display adjustments (model/display.ts). Each pixel goes
 * through a colour stage, either a 3x3 channel matrix (channel view +
 * saturation) or, for the centre view, a 3D colour LUT to grey
 * (centre-contrast.ts), then a 256-entry lookup table shared by all channels
 * (auto-contrast stretch, brightness, contrast, gamma, invert). Works on RGBA
 * byte arrays in place; alpha is kept. No DOM: used by the adjust worker and
 * its main-thread fallback.
 */
import type { ImageDisplayAdjust } from '../model/types'
import { centreKey, effectiveRim } from '../model/display'
import { applyColourLut, buildCentreLut, lookupColour, type ColourLut } from './centre-contrast'

/** Rec. 709 luma weights (applied to the encoded sRGB values: a display approximation). */
export const LUMA = [0.2126, 0.7152, 0.0722] as const

/** Row-major 3x3: out[r,g,b] = M · in[r,g,b]. */
export type Matrix3 = readonly [number, number, number, number, number, number, number, number, number]

const IDENTITY: Matrix3 = [1, 0, 0, 0, 1, 0, 0, 0, 1]

export function channelMatrix(a: Pick<ImageDisplayAdjust, 'channel' | 'saturation'>): Matrix3 {
  const [wr, wg, wb] = LUMA
  switch (a.channel) {
    case 'centre': // no colour LUT (nothing sampled yet): plain grey
      return [wr, wg, wb, wr, wg, wb, wr, wg, wb]
    case 'red':
      return [1, 0, 0, 1, 0, 0, 1, 0, 0]
    case 'green':
      return [0, 1, 0, 0, 1, 0, 0, 1, 0]
    case 'blue':
      return [0, 0, 1, 0, 0, 1, 0, 0, 1]
    case 'luma':
      return [wr, wg, wb, wr, wg, wb, wr, wg, wb]
    default: {
      const s = a.saturation
      if (s === 1) return IDENTITY
      const k = 1 - s
      return [k * wr + s, k * wg, k * wb, k * wr, k * wg + s, k * wb, k * wr, k * wg, k * wb + s]
    }
  }
}

/** First per-pixel step: a channel matrix, or a colour LUT straight to grey. */
export type ColourStage = { kind: 'matrix'; matrix: Matrix3 } | { kind: 'clut'; clut: ColourLut }

/** The colour stage of an adjustment, and a key that is equal for equal stages. */
export function colourStage(a: Pick<ImageDisplayAdjust, 'channel' | 'saturation' | 'centre' | 'separation'>): { stage: ColourStage; key: string } {
  if (a.channel === 'centre' && a.centre) {
    const clut = buildCentreLut({ centre: a.centre.centre, rim: effectiveRim(a.centre), separation: a.separation })
    return { stage: { kind: 'clut', clut }, key: `c:${centreKey(a)}` }
  }
  const matrix = channelMatrix(a)
  return { stage: { kind: 'matrix', matrix }, key: `m:${matrix.join(',')}` }
}

/** Apply a colour stage then the 1D LUT to RGBA pixels [start, end) in place. */
export function applyStage(data: Uint8ClampedArray, stage: ColourStage, lut: Uint8ClampedArray, start = 0, end = data.length >> 2): void {
  if (stage.kind === 'clut') applyColourLut(data, stage.clut, lut, start, end)
  else applyAdjust(data, stage.matrix, lut, start, end)
}

/** Histogram of a colour stage's output (see `histogram`). */
export function stageHistogram(data: Uint8ClampedArray, stage: ColourStage): Uint32Array {
  if (stage.kind === 'matrix') return histogram(data, stage.matrix)
  const hist = new Uint32Array(256)
  const pixels = data.length >> 2
  const step = Math.max(1, Math.ceil(pixels / HISTOGRAM_MAX_SAMPLES)) << 2
  for (let i = 0; i < data.length; i += step) {
    if (data[i + 3] === 0) continue
    hist[lookupColour(stage.clut, data[i], data[i + 1], data[i + 2])]++
  }
  return hist
}

/** Levels stretch from auto contrast: input `lo` maps to 0, `hi` to 255. */
export interface LevelRange {
  lo: number
  hi: number
}

/**
 * Per-value transfer curve, in order: stretch `range` (auto contrast) →
 * brightness (adds brightness/2) → contrast (slope 2^(2·contrast) about 0.5) →
 * clamp → gamma (v^(1/gamma)) → invert.
 */
export function buildLut(a: Pick<ImageDisplayAdjust, 'brightness' | 'contrast' | 'gamma' | 'invert'>, range: LevelRange | null = null): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256)
  const slope = Math.pow(2, 2 * a.contrast)
  const invGamma = 1 / a.gamma
  const lo = range ? range.lo : 0
  const span = range && range.hi > range.lo ? range.hi - range.lo : 255
  for (let i = 0; i < 256; i++) {
    let v = (i - lo) / span
    v += a.brightness / 2
    v = (v - 0.5) * slope + 0.5
    v = v < 0 ? 0 : v > 1 ? 1 : v
    if (invGamma !== 1) v = Math.pow(v, invGamma)
    if (a.invert) v = 1 - v
    lut[i] = Math.round(v * 255)
  }
  return lut
}

/** How a matrix can be evaluated cheaply. */
type MatrixKind = { kind: 'identity' } | { kind: 'channel'; index: number } | { kind: 'grey'; w: readonly [number, number, number] } | { kind: 'full' }

function classify(m: Matrix3): MatrixKind {
  if (m.every((v, i) => v === IDENTITY[i])) return { kind: 'identity' }
  const sameRows = m[0] === m[3] && m[3] === m[6] && m[1] === m[4] && m[4] === m[7] && m[2] === m[5] && m[5] === m[8]
  if (!sameRows) return { kind: 'full' }
  const row = [m[0], m[1], m[2]] as const
  const one = row.findIndex((v) => v === 1)
  if (one >= 0 && row.filter((v) => v === 0).length === 2) return { kind: 'channel', index: one }
  return { kind: 'grey', w: row }
}

const toByte = (v: number) => (v <= 0 ? 0 : v >= 255 ? 255 : (v + 0.5) | 0)

/**
 * Apply matrix then LUT to RGBA pixels in place, for pixels [start, end) (pixel
 * indices, not byte offsets) so callers can process in chunks.
 */
export function applyAdjust(data: Uint8ClampedArray, m: Matrix3, lut: Uint8ClampedArray, start = 0, end = data.length >> 2): void {
  const k = classify(m)
  const i0 = start << 2
  const i1 = Math.min(data.length, end << 2)
  switch (k.kind) {
    case 'identity':
      for (let i = i0; i < i1; i += 4) {
        data[i] = lut[data[i]]
        data[i + 1] = lut[data[i + 1]]
        data[i + 2] = lut[data[i + 2]]
      }
      return
    case 'channel': {
      const c = k.index
      for (let i = i0; i < i1; i += 4) {
        const v = lut[data[i + c]]
        data[i] = v
        data[i + 1] = v
        data[i + 2] = v
      }
      return
    }
    case 'grey': {
      const [a, b, c] = k.w
      for (let i = i0; i < i1; i += 4) {
        const v = lut[toByte(a * data[i] + b * data[i + 1] + c * data[i + 2])]
        data[i] = v
        data[i + 1] = v
        data[i + 2] = v
      }
      return
    }
    default:
      for (let i = i0; i < i1; i += 4) {
        const r = data[i]
        const g = data[i + 1]
        const b = data[i + 2]
        data[i] = lut[toByte(m[0] * r + m[1] * g + m[2] * b)]
        data[i + 1] = lut[toByte(m[3] * r + m[4] * g + m[5] * b)]
        data[i + 2] = lut[toByte(m[6] * r + m[7] * g + m[8] * b)]
      }
  }
}

/** Upper bound of pixels sampled for a histogram (strided beyond this). */
export const HISTOGRAM_MAX_SAMPLES = 1 << 20

/**
 * Histogram (256 bins) of the matrix outputs: every output channel for colour
 * views, the single grey value for channel/greyscale views. Fully transparent
 * pixels are skipped.
 */
export function histogram(data: Uint8ClampedArray, m: Matrix3): Uint32Array {
  const hist = new Uint32Array(256)
  const k = classify(m)
  const pixels = data.length >> 2
  const step = Math.max(1, Math.ceil(pixels / HISTOGRAM_MAX_SAMPLES)) << 2
  for (let i = 0; i < data.length; i += step) {
    if (data[i + 3] === 0) continue
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    switch (k.kind) {
      case 'identity':
        hist[r]++
        hist[g]++
        hist[b]++
        break
      case 'channel':
        hist[data[i + k.index]]++
        break
      case 'grey':
        hist[toByte(k.w[0] * r + k.w[1] * g + k.w[2] * b)]++
        break
      default:
        hist[toByte(m[0] * r + m[1] * g + m[2] * b)]++
        hist[toByte(m[3] * r + m[4] * g + m[5] * b)]++
        hist[toByte(m[6] * r + m[7] * g + m[8] * b)]++
    }
  }
  return hist
}

/** Default clip fractions for auto contrast (0.5 % at each end). */
export const AUTO_CLIP = 0.005
/** Ranges narrower than this are not stretched (flat images would only show noise). */
export const MIN_STRETCH_SPAN = 8

/**
 * Percentile stretch range: the values below which `clip` of the samples lie
 * (lo) and above which `clip` lie (hi). Null when empty or too narrow.
 */
export function percentileRange(hist: Uint32Array, clip = AUTO_CLIP): LevelRange | null {
  let total = 0
  for (let i = 0; i < 256; i++) total += hist[i]
  if (total === 0) return null
  const cut = total * clip
  let lo = 0
  let acc = 0
  for (; lo < 255; lo++) {
    acc += hist[lo]
    if (acc > cut) break
  }
  let hi = 255
  acc = 0
  for (; hi > 0; hi--) {
    acc += hist[hi]
    if (acc > cut) break
  }
  if (hi - lo < MIN_STRETCH_SPAN) return null
  return { lo, hi }
}
