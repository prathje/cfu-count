import { describe, expect, it } from 'vitest'
import {
  CLUT_N,
  MIN_AXIS_DE,
  RIM_LEVEL,
  applyColourLut,
  axisPosition,
  buildCentreLut,
  buildColourLut,
  centreTone,
  estimateRim,
  labDistance,
  lookupColour,
  patchMean,
  rgbToLab,
  type Rgb,
} from './centre-contrast'

const close = (a: readonly number[], b: readonly number[], eps: number) => a.forEach((v, i) => expect(Math.abs(v - b[i])).toBeLessThanOrEqual(eps))
const identity = new Uint8ClampedArray(256).map((_, i) => i)

describe('rgbToLab', () => {
  it('matches reference values', () => {
    close(rgbToLab(255, 255, 255), [100, 0, 0], 0.01)
    close(rgbToLab(0, 0, 0), [0, 0, 0], 0.01)
    close(rgbToLab(255, 0, 0), [53.24, 80.09, 67.2], 0.05)
    close(rgbToLab(128, 128, 128), [53.59, 0, 0], 0.05)
  })
})

describe('centre tone and axis', () => {
  it('maps background dark, rim to the rim level and centre bright', () => {
    const k = 6
    expect(centreTone(-2, k)).toBeLessThan(0.02)
    expect(Math.abs(centreTone(0, k) - RIM_LEVEL)).toBeLessThan(0.05)
    expect(centreTone(1, k)).toBeGreaterThan(0.93)
    for (let t = -3; t < 3; t += 0.1) expect(centreTone(t + 0.1, k)).toBeGreaterThan(centreTone(t, k))
    // Steeper = harder split around the midpoint.
    expect(centreTone(0.8, 12)).toBeGreaterThan(centreTone(0.8, 3))
  })
  it('positions centre at 1 and rim at 0', () => {
    const pos = axisPosition([150, 150, 140], [100, 105, 110])
    expect(pos(150, 150, 140)).toBeCloseTo(1, 6)
    expect(pos(100, 105, 110)).toBeCloseTo(0, 6)
    expect(pos(60, 60, 60)).toBeLessThan(-0.5)
  })
  it('stretches short axes to the minimum length about their midpoint', () => {
    const c: Rgb = [120, 120, 120]
    const r: Rgb = [118, 118, 118]
    const pos = axisPosition(c, r)
    const len = labDistance(rgbToLab(...c), rgbToLab(...r))
    expect(len).toBeLessThan(MIN_AXIS_DE)
    expect(pos(...c) - pos(...r)).toBeCloseTo(len / MIN_AXIS_DE, 6)
    expect(pos(...c)).toBeGreaterThan(0.5)
    // Identical samples fall back to lightness: brighter = more centre-like.
    const same = axisPosition(c, c)
    expect(same(200, 200, 200)).toBeGreaterThan(same(50, 50, 50))
  })
})

describe('colour LUT', () => {
  it('is exact on grid points and close (trilinear) in between', () => {
    const fn = (r: number, g: number, b: number) => (0.3 * r + 0.5 * g + 0.2 * b) / 255
    const lut = buildColourLut(fn)
    expect(lut.table.length).toBe(CLUT_N ** 3)
    expect(lookupColour(lut, 0, 0, 0)).toBe(0)
    expect(lookupColour(lut, 255, 255, 255)).toBe(255)
    // A linear function is reproduced (up to rounding) everywhere.
    for (const [r, g, b] of [[1, 2, 3], [100, 37, 250], [254, 128, 9]]) expect(Math.abs(lookupColour(lut, r, g, b) - fn(r, g, b) * 255)).toBeLessThanOrEqual(1)
  })
  it('follows the centre mapping closely on real colony colours', () => {
    const p = { centre: [143, 148, 142] as Rgb, rim: [108, 116, 117] as Rgb, separation: 8 }
    const lut = buildCentreLut(p)
    const pos = axisPosition(p.centre, p.rim)
    let worst = 0
    let sum = 0
    let n = 0
    for (let r = 60; r < 200; r += 7) {
      for (let g = 60; g < 200; g += 7) {
        for (let b = 60; b < 200; b += 7) {
          const e = Math.abs(lookupColour(lut, r, g, b) - centreTone(pos(r, g, b), p.separation) * 255)
          worst = Math.max(worst, e)
          sum += e
          n++
        }
      }
    }
    expect(sum / n).toBeLessThan(2)
    expect(worst).toBeLessThan(16)
    expect(lookupColour(lut, ...p.centre.map(Math.round) as [number, number, number])).toBeGreaterThan(220)
    expect(lookupColour(lut, 84, 88, 90)).toBeLessThan(15) // agar
  })
  it('applies to RGBA in place as grey through the 1D LUT, keeping alpha', () => {
    const lut = buildColourLut((r) => r / 255)
    const inv = identity.map((v) => 255 - v)
    const data = new Uint8ClampedArray([0, 9, 9, 7, 255, 0, 0, 200, 128, 1, 2, 3])
    applyColourLut(data, lut, inv, 0, 2)
    expect(Array.from(data)).toEqual([255, 255, 255, 7, 0, 0, 0, 200, 128, 1, 2, 3])
  })
})

/** RGBA buffer with a radial colony: centre colour → edge colour inside R, background outside. */
function colony(w: number, R: number, centre: Rgb, edge: Rgb, bg: Rgb) {
  const data = new Uint8ClampedArray(w * w * 4)
  const c = w / 2
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const d = Math.hypot(x - c, y - c) / R
      const col = d <= 1 ? centre.map((v, i) => v + (edge[i] - v) * d) : bg
      const i = (y * w + x) * 4
      data.set([...col.map(Math.round), 255], i)
    }
  }
  return { data, c }
}

describe('eyedropper', () => {
  it('averages a clipped patch', () => {
    const data = new Uint8ClampedArray(3 * 3 * 4)
    for (let i = 0; i < 9; i++) data.set([i * 10, 0, 100, 255], i * 4)
    expect(patchMean(data, 3, 3, 1, 1, 1)).toEqual([40, 0, 100])
    expect(patchMean(data, 3, 3, 0, 0, 1)).toEqual([20, 0, 100]) // pixels 0, 1, 3, 4
  })
  it('finds the colony radius and samples the rim inside it', () => {
    const { data, c } = colony(200, 40, [200, 200, 180], [140, 140, 130], [50, 50, 55])
    const centre = patchMean(data, 200, 200, c, c, 3)!
    const est = estimateRim(data, 200, 200, c, c, centre)!
    expect(Math.abs(est.radius - 40)).toBeLessThanOrEqual(3)
    // Ring at 0.65..0.85 R: about 75 % of the way from centre to edge colour.
    close(est.rim, [155, 155, 142.5], 6)
  })
  it('points a uniform colony’s rim toward the background', () => {
    const { data, c } = colony(200, 40, [180, 170, 120], [180, 170, 120], [60, 60, 60])
    const centre = patchMean(data, 200, 200, c, c, 3)!
    const est = estimateRim(data, 200, 200, c, c, centre)!
    const d = labDistance(rgbToLab(...est.rim), rgbToLab(...centre))
    expect(d).toBeGreaterThan(MIN_AXIS_DE * 0.7)
    expect(d).toBeLessThan(MIN_AXIS_DE * 1.5)
    expect(est.rim[0]).toBeLessThan(180) // darker, toward the agar
  })
  it('gives up without an edge or too close to the border', () => {
    const flat = colony(100, 1000, [90, 90, 90], [90, 90, 90], [90, 90, 90])
    expect(estimateRim(flat.data, 100, 100, 50, 50, [90, 90, 90])).toBeNull()
    expect(estimateRim(flat.data, 100, 100, 3, 50, [90, 90, 90])).toBeNull()
  })
})
