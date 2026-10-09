import { describe, expect, it } from 'vitest'
import { contrastOutline, effectiveDpr, luminance, MAX_LAYER_PIXELS, pickLevel, regionDimPath, regionScreenPath, type PyramidLevel } from './render'

describe('effectiveDpr', () => {
  it('uses the device DPR when the backing store is small enough', () => {
    expect(effectiveDpr({ width: 1366, height: 1024 }, 2)).toBe(2)
  })
  it('caps the backing store area', () => {
    const size = { width: 3000, height: 2000 }
    const d = effectiveDpr(size, 2)
    expect(d).toBeLessThan(2)
    expect(size.width * d * size.height * d).toBeLessThanOrEqual(MAX_LAYER_PIXELS + 1)
  })
  it('caps very high DPR and handles missing DPR', () => {
    expect(effectiveDpr({ width: 100, height: 100 }, 5)).toBe(3)
    expect(effectiveDpr({ width: 100, height: 100 }, 0)).toBe(1)
  })
})

describe('pickLevel', () => {
  const src = { width: 1, height: 1 } as unknown as PyramidLevel['source']
  const levels: PyramidLevel[] = [1, 0.5, 0.25, 0.125].map((scale) => ({ source: src, scale }))
  it('picks the smallest level with enough resolution', () => {
    expect(pickLevel(levels, 0.2).scale).toBe(0.25)
    expect(pickLevel(levels, 0.25).scale).toBe(0.25)
    expect(pickLevel(levels, 0.01).scale).toBe(0.125)
    expect(pickLevel(levels, 3).scale).toBe(1)
  })
})

describe('marker contrast', () => {
  it('computes luminance', () => {
    expect(luminance('#000')).toBe(0)
    expect(luminance('#ffffff')).toBeCloseTo(1)
    expect(luminance('nonsense')).toBe(0.5)
  })
  it('outlines light colours dark and dark colours light', () => {
    expect(contrastOutline('#ffe14d')).toMatch(/^rgba\(0,0,0/)
    expect(contrastOutline('#1f3fbf')).toMatch(/^rgba\(255,255,255/)
  })
})

describe('region paths', () => {
  const view = { scale: 2, offsetX: 10, offsetY: 20 }
  const tri = [
    { x: 10, y: 20 },
    { x: 20, y: 20 },
    { x: 15, y: 30.04 },
  ]
  it('maps image px to screen px', () => {
    expect(regionScreenPath(tri, view)).toBe('M0 0L20 0L10 20.1Z')
    expect(regionScreenPath(tri, view, false)).toBe('M0 0L20 0L10 20.1')
    expect(regionScreenPath(tri.slice(0, 1), view)).toBe('')
  })
  it('dims outside with an outer frame plus the polygon (evenodd)', () => {
    expect(regionDimPath(tri, view, { width: 100, height: 50 })).toBe('M-4 -4H104V54H-4ZM0 0L20 0L10 20.1Z')
    expect(regionDimPath([], view, { width: 100, height: 50 })).toBe('')
  })
})
