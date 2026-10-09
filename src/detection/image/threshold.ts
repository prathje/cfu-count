/**
 * Global (Otsu) and local (adaptive mean) thresholds, plus robust statistics.
 */
import { boxBlur } from './filters.ts'
import { makeMask, type Mask, type Plane } from './plane.ts'

/**
 * Otsu's threshold over the values selected by `select` (all pixels if omitted).
 * Returns the threshold t such that "foreground" is value > t.
 */
export function otsuThreshold(values: Float32Array, select?: Uint8Array, bins = 256): number {
  let lo = Infinity
  let hi = -Infinity
  for (let i = 0; i < values.length; i++) {
    if (select && !select[i]) continue
    const v = values[i]
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  if (!(hi > lo)) return lo
  const hist = new Float64Array(bins)
  const scale = (bins - 1) / (hi - lo)
  let total = 0
  for (let i = 0; i < values.length; i++) {
    if (select && !select[i]) continue
    hist[Math.round((values[i] - lo) * scale)]++
    total++
  }
  let sumAll = 0
  for (let b = 0; b < bins; b++) sumAll += b * hist[b]
  let wB = 0
  let sumB = 0
  let best = -1
  let bestFirst = 0
  let bestLast = 0
  for (let b = 0; b < bins; b++) {
    wB += hist[b]
    if (wB === 0) continue
    const wF = total - wB
    if (wF === 0) break
    sumB += b * hist[b]
    const mB = sumB / wB
    const mF = (sumAll - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (between > best * (1 + 1e-9)) {
      best = between
      bestFirst = bestLast = b
    } else if (between >= best * (1 - 1e-9)) bestLast = b
  }
  // empty histogram gaps give a plateau of equal scores: take its middle
  return lo + ((bestFirst + bestLast) / 2 + 0.5) / scale
}

/** value > t → 1, restricted to `within` if given. */
export function thresholdAbove(p: Plane, t: number | Plane, within?: Uint8Array): Mask {
  const m = makeMask(p.width, p.height)
  for (let i = 0; i < m.data.length; i++) {
    if (within && !within[i]) continue
    const ti = typeof t === 'number' ? t : t.data[i]
    if (p.data[i] > ti) m.data[i] = 1
  }
  return m
}

/** Adaptive threshold: value > local mean over (2r+1)² + offset. */
export function adaptiveThreshold(p: Plane, r: number, offset: number, within?: Uint8Array): Mask {
  const mean = boxBlur(p, r)
  for (let i = 0; i < mean.data.length; i++) mean.data[i] += offset
  return thresholdAbove(p, mean, within)
}

/** Median of an array (copies). NaN for an empty input. */
export function median(xs: ArrayLike<number>): number {
  const n = xs.length
  if (n === 0) return NaN
  const a = Float64Array.from(xs as ArrayLike<number>).sort()
  return n % 2 ? a[(n - 1) / 2] : 0.5 * (a[n / 2 - 1] + a[n / 2])
}

/** Scaled median absolute deviation (≈ σ for Gaussian data). */
export function mad(xs: ArrayLike<number>, centre = median(xs)): number {
  const dev = new Float64Array(xs.length)
  for (let i = 0; i < xs.length; i++) dev[i] = Math.abs(xs[i] - centre)
  return 1.4826 * median(dev)
}

/** Quantile by sorting (q in 0..1). */
export function quantile(xs: ArrayLike<number>, q: number): number {
  if (xs.length === 0) return NaN
  const a = Float64Array.from(xs as ArrayLike<number>).sort()
  const pos = Math.min(Math.max(q, 0), 1) * (a.length - 1)
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return a[lo] + (a[hi] - a[lo]) * (pos - lo)
}

/** Values of a plane where `select` is set, optionally subsampled to at most `maxN` values. */
export function selectValues(p: Plane, select: Uint8Array, maxN = 200_000): Float32Array {
  let count = 0
  for (let i = 0; i < select.length; i++) if (select[i]) count++
  const step = Math.max(1, Math.floor(count / maxN))
  const out = new Float32Array(Math.ceil(count / step))
  let k = 0
  let seen = 0
  for (let i = 0; i < select.length; i++) {
    if (!select[i]) continue
    if (seen++ % step === 0 && k < out.length) out[k++] = p.data[i]
  }
  return out.subarray(0, k)
}
