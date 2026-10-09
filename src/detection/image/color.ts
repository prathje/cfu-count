/**
 * Colour conversions from 8-bit RGBA to float planes.
 *
 * Lab uses sRGB (IEC 61966-2-1) with a D65 white point. Camera JPEGs are
 * assumed to be sRGB-encoded; the detector only needs a perceptually
 * reasonable opponent space, not colorimetric accuracy.
 */
import { makePlane, type Plane, type RgbaImage } from './plane.ts'

const SRGB_TO_LINEAR = (() => {
  const t = new Float32Array(256)
  for (let i = 0; i < 256; i++) {
    const c = i / 255
    t[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }
  return t
})()

// D65 reference white
const XN = 0.95047
const ZN = 1.08883

function fLab(t: number): number {
  return t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116
}

/** Convert one sRGB colour (0..255) to Lab. L in 0..100, a/b roughly −128..127. */
export function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const R = SRGB_TO_LINEAR[r | 0]
  const G = SRGB_TO_LINEAR[g | 0]
  const B = SRGB_TO_LINEAR[b | 0]
  const X = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / XN
  const Y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B
  const Z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / ZN
  const fx = fLab(X)
  const fy = fLab(Y)
  const fz = fLab(Z)
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

export interface LabPlanes {
  L: Plane
  a: Plane
  b: Plane
}

/** Whole-image Lab conversion. Uses a 15-bit colour cache because photos repeat colours heavily. */
export function toLab(img: RgbaImage): LabPlanes {
  const { width, height, data } = img
  const n = width * height
  const L = makePlane(width, height)
  const A = makePlane(width, height)
  const B = makePlane(width, height)
  // Cache keyed on 5-5-5 bits is too coarse for dark agar; key on full 24 bits lazily instead.
  const cache = new Map<number, number>()
  const vals: number[] = []
  for (let i = 0; i < n; i++) {
    const r = data[i * 4]
    const g = data[i * 4 + 1]
    const b = data[i * 4 + 2]
    const key = (r << 16) | (g << 8) | b
    let slot = cache.get(key)
    if (slot === undefined) {
      const lab = rgbToLab(r, g, b)
      slot = vals.length
      vals.push(lab[0], lab[1], lab[2])
      cache.set(key, slot)
    }
    L.data[i] = vals[slot]
    A.data[i] = vals[slot + 1]
    B.data[i] = vals[slot + 2]
  }
  return { L, a: A, b: B }
}

/** Rec. 709 luma on gamma-encoded values (0..255). Cheap; used for ROI finding. */
export function toLuma(img: RgbaImage): Plane {
  const { width, height, data } = img
  const out = makePlane(width, height)
  for (let i = 0, n = width * height; i < n; i++) {
    out.data[i] = 0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2]
  }
  return out
}

/** One RGBA channel (0 = R, 1 = G, 2 = B) as a float plane. */
export function channel(img: RgbaImage, c: 0 | 1 | 2): Plane {
  const out = makePlane(img.width, img.height)
  for (let i = 0, n = img.width * img.height; i < n; i++) out.data[i] = img.data[i * 4 + c]
  return out
}

/** Fraction-of-saturation map: 1 where any channel is at or above `level`. */
export function saturationMask(img: RgbaImage, level = 250): Uint8Array {
  const n = img.width * img.height
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const d = img.data
    if (d[i * 4] >= level || d[i * 4 + 1] >= level || d[i * 4 + 2] >= level) out[i] = 1
  }
  return out
}
