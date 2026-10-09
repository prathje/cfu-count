import { describe, expect, it } from 'vitest'
import { DEFAULT_DISPLAY } from '../model/display'
import type { ImageDisplayAdjust } from '../model/types'
import { applyAdjust, buildLut, channelMatrix, histogram, percentileRange, HISTOGRAM_MAX_SAMPLES } from './image-adjust'

const adj = (p: Partial<ImageDisplayAdjust> = {}): ImageDisplayAdjust => ({ ...DEFAULT_DISPLAY, ...p })
const px = (...rgba: number[]) => new Uint8ClampedArray(rgba)

function run(p: Partial<ImageDisplayAdjust>, data: Uint8ClampedArray, range = null) {
  const a = adj(p)
  applyAdjust(data, channelMatrix(a), buildLut(a, range))
  return Array.from(data)
}

describe('buildLut', () => {
  it('is the identity for defaults', () => {
    const lut = buildLut(adj())
    for (let i = 0; i < 256; i++) expect(lut[i]).toBe(i)
  })
  it('inverts', () => {
    const lut = buildLut(adj({ invert: true }))
    expect([lut[0], lut[255], lut[100]]).toEqual([255, 0, 155])
  })
  it('brightness shifts by half the value range at most', () => {
    expect(buildLut(adj({ brightness: 1 }))[0]).toBe(128)
    expect(buildLut(adj({ brightness: -1 }))[255]).toBe(128)
    expect(buildLut(adj({ brightness: 0.2 }))[100]).toBe(126)
  })
  it('contrast pivots about mid-grey and clamps', () => {
    const lut = buildLut(adj({ contrast: 0.5 })) // slope 2
    expect(lut[128]).toBe(129) // 128/255 is just above 0.5
    expect(lut[64]).toBe(0)
    expect(lut[100]).toBe(73)
    expect(lut[200]).toBe(255)
    const flat = buildLut(adj({ contrast: -1 })) // slope 1/4
    expect(flat[0]).toBe(96)
    expect(flat[255]).toBe(159)
  })
  it('gamma > 1 brightens midtones and keeps the ends', () => {
    const lut = buildLut(adj({ gamma: 2 }))
    expect(lut[0]).toBe(0)
    expect(lut[255]).toBe(255)
    expect(lut[64]).toBe(128)
  })
  it('stretches a level range to the full scale', () => {
    const lut = buildLut(adj(), { lo: 50, hi: 150 })
    expect([lut[0], lut[50], lut[100], lut[150], lut[255]]).toEqual([0, 0, 128, 255, 255])
  })
})

describe('applyAdjust', () => {
  it('leaves pixels unchanged for defaults and keeps alpha', () => {
    expect(run({}, px(10, 20, 30, 40, 200, 100, 0, 255))).toEqual([10, 20, 30, 40, 200, 100, 0, 255])
  })
  it('shows a single channel as grey', () => {
    expect(run({ channel: 'red' }, px(10, 20, 30, 255))).toEqual([10, 10, 10, 255])
    expect(run({ channel: 'green' }, px(10, 20, 30, 255))).toEqual([20, 20, 20, 255])
    expect(run({ channel: 'blue', invert: true }, px(10, 20, 30, 255))).toEqual([225, 225, 225, 255])
  })
  it('greyscale uses Rec. 709 luma', () => {
    expect(run({ channel: 'luma' }, px(255, 0, 0, 255, 0, 255, 0, 255))).toEqual([54, 54, 54, 255, 182, 182, 182, 255])
  })
  it('saturation 0 is greyscale, 2 pushes away from grey', () => {
    expect(run({ saturation: 0 }, px(255, 0, 0, 255))).toEqual([54, 54, 54, 255])
    expect(run({ saturation: 2 }, px(150, 100, 100, 255))).toEqual([189, 89, 89, 255])
  })
  it('ignores saturation outside the colour view', () => {
    expect(run({ channel: 'green', saturation: 0 }, px(10, 20, 30, 255))).toEqual([20, 20, 20, 255])
  })
  it('processes only the requested pixel span', () => {
    const d = px(10, 10, 10, 255, 10, 10, 10, 255)
    const a = adj({ invert: true })
    applyAdjust(d, channelMatrix(a), buildLut(a), 1, 2)
    expect(Array.from(d)).toEqual([10, 10, 10, 255, 245, 245, 245, 255])
  })
})

describe('auto contrast', () => {
  it('finds the clipped percentiles', () => {
    const data = new Uint8ClampedArray(1000 * 4)
    for (let i = 0; i < 1000; i++) {
      const v = 40 + Math.floor((i / 1000) * 120) // 40..159
      data.set([v, v, v, 255], i * 4)
    }
    const r = percentileRange(histogram(data, channelMatrix(adj({ channel: 'luma' }))), 0.01)!
    expect(r.lo).toBeGreaterThanOrEqual(40)
    expect(r.lo).toBeLessThanOrEqual(42)
    expect(r.hi).toBeGreaterThanOrEqual(157)
    expect(r.hi).toBeLessThanOrEqual(159)
  })
  it('returns null for flat or empty images', () => {
    const flat = new Uint8ClampedArray(400).fill(120)
    expect(percentileRange(histogram(flat, channelMatrix(adj())))).toBeNull()
    expect(percentileRange(new Uint32Array(256))).toBeNull()
  })
  it('counts the selected channel only and skips transparent pixels', () => {
    const h = histogram(px(10, 20, 30, 255, 99, 99, 99, 0), channelMatrix(adj({ channel: 'blue' })))
    expect(h[30]).toBe(1)
    expect(h.reduce((s, v) => s + v, 0)).toBe(1)
  })
  it('strides large inputs', () => {
    const n = HISTOGRAM_MAX_SAMPLES * 3
    const h = histogram(new Uint8ClampedArray(n * 4).fill(255), channelMatrix(adj({ channel: 'red' })))
    expect(h[255]).toBe(HISTOGRAM_MAX_SAMPLES)
  })
})
