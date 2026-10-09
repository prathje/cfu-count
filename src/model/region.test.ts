import { describe, expect, it } from 'vitest'
import { makeManualAnnotation } from './annotations'
import type { Annotation } from './types'
import {
  annotationsInRegion,
  finishRegion,
  pointInPolygon,
  polygonArea,
  polygonBounds,
  rectPolygon,
  regionTally,
  simplifyClosed,
  simplifyPath,
  MAX_REGION_POINTS,
} from './region'

const square = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 0, y: 10 },
]
// concave "U": the notch (4..6 × 0..6) is outside
const u = [
  { x: 0, y: 0 },
  { x: 4, y: 0 },
  { x: 4, y: 6 },
  { x: 6, y: 6 },
  { x: 6, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 0, y: 10 },
]

describe('pointInPolygon', () => {
  it('handles convex and concave polygons in either winding', () => {
    expect(pointInPolygon(5, 5, square)).toBe(true)
    expect(pointInPolygon(11, 5, square)).toBe(false)
    expect(pointInPolygon(-0.1, 5, square)).toBe(false)
    expect(pointInPolygon(5, 5, [...square].reverse())).toBe(true)
    expect(pointInPolygon(5, 3, u)).toBe(false)
    expect(pointInPolygon(5, 8, u)).toBe(true)
    expect(pointInPolygon(2, 3, u)).toBe(true)
  })
  it('is false for degenerate polygons', () => {
    expect(pointInPolygon(0, 0, [])).toBe(false)
    expect(pointInPolygon(1, 0, [{ x: 0, y: 0 }, { x: 2, y: 0 }])).toBe(false)
  })
})

describe('polygon helpers', () => {
  it('area and bounds', () => {
    expect(polygonArea(square)).toBe(100)
    expect(polygonArea(u)).toBe(88)
    expect(polygonBounds(u)).toEqual({ x: 0, y: 0, width: 10, height: 10 })
    expect(rectPolygon({ x: 5, y: 8 }, { x: 1, y: 2 })).toEqual([
      { x: 1, y: 2 },
      { x: 5, y: 2 },
      { x: 5, y: 8 },
      { x: 1, y: 8 },
    ])
  })
})

describe('simplifyPath (RDP)', () => {
  it('drops collinear and near-collinear points, keeps corners', () => {
    const line = Array.from({ length: 11 }, (_, i) => ({ x: i, y: i % 2 ? 0.2 : 0 }))
    expect(simplifyPath(line, 0.5)).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ])
    const corner = [
      { x: 0, y: 0 },
      { x: 5, y: 0.1 },
      { x: 10, y: 0 },
      { x: 10, y: 5 },
      { x: 10, y: 10 },
    ]
    expect(simplifyPath(corner, 0.5)).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ])
  })
  it('simplifies a densely sampled closed circle to a polygon that stays within tolerance', () => {
    const circle = Array.from({ length: 720 }, (_, i) => ({ x: 100 + 50 * Math.cos((i / 720) * 2 * Math.PI), y: 100 + 50 * Math.sin((i / 720) * 2 * Math.PI) }))
    const s = simplifyClosed(circle, 0.5)
    expect(s.length).toBeGreaterThan(12)
    expect(s.length).toBeLessThan(80)
    expect(polygonArea(s)).toBeGreaterThan(Math.PI * 50 * 50 * 0.98)
    // no duplicated closing point
    expect(s[0]).not.toEqual(s.at(-1))
  })
})

describe('finishRegion', () => {
  const base = { scale: 1, imageWidth: 1000, imageHeight: 800 }
  const loop = (cx: number, cy: number, r: number, n = 200) =>
    Array.from({ length: n }, (_, i) => ({ x: cx + r * Math.cos((i / n) * 2 * Math.PI), y: cy + r * Math.sin((i / n) * 2 * Math.PI) }))

  it('closes and simplifies a lasso in image coordinates', () => {
    const r = finishRegion({ ...base, points: loop(200, 200, 60), shape: 'lasso' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.polygon.length).toBeLessThan(60)
    expect(pointInPolygon(200, 200, r.polygon)).toBe(true)
  })
  it('builds a rectangle from the first and last point', () => {
    const r = finishRegion({ ...base, points: [{ x: 10, y: 20 }, { x: 50, y: 25 }, { x: 110, y: 90 }], shape: 'rect' })
    expect(r).toEqual({ ok: true, polygon: rectPolygon({ x: 10, y: 20 }, { x: 110, y: 90 }) })
  })
  it('refuses regions smaller than the on-screen minimum (scale-aware)', () => {
    expect(finishRegion({ ...base, points: loop(200, 200, 5), shape: 'lasso' })).toEqual({ ok: false, reason: 'too-small' })
    // the same 10 px loop is 40 screen px when zoomed in 4×
    expect(finishRegion({ ...base, scale: 4, points: loop(200, 200, 5), shape: 'lasso' }).ok).toBe(true)
    expect(finishRegion({ ...base, points: [{ x: 0, y: 0 }], shape: 'lasso' }).ok).toBe(false)
    // a thin flick: long but narrow
    expect(finishRegion({ ...base, points: [{ x: 0, y: 0 }, { x: 300, y: 4 }], shape: 'rect' }).ok).toBe(false)
  })
  it('clamps to the image and bounds the point count', () => {
    const r = finishRegion({ ...base, points: loop(0, 0, 100, 4000).map((p, i) => ({ x: p.x + (i % 2) * 3, y: p.y })), shape: 'lasso' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.polygon.every((p) => p.x >= 0 && p.y >= 0)).toBe(true)
    expect(r.polygon.length).toBeLessThanOrEqual(MAX_REGION_POINTS)
  })
})

describe('regionTally / annotationsInRegion', () => {
  const at = '2026-01-01T00:00:00.000Z'
  const mk = (id: string, x: number, y: number, groupId = 'g1', extra: Partial<Annotation> = {}): Annotation => ({ ...makeManualAnnotation(x, y, groupId, id, at), ...extra })
  const list = [
    mk('a', 2, 2),
    mk('b', 5, 3), // in the U notch: outside
    mk('c', 8, 8, 'g1', { origin: 'automated', reviewStatus: 'unreviewed', lastEditSource: 'automated' }),
    mk('d', 9, 9, 'g2'),
    mk('e', 20, 20),
  ]
  it('selects by centre', () => {
    expect(annotationsInRegion(list, u).map((a) => a.id)).toEqual(['a', 'c', 'd'])
  })
  it('splits the active group by origin and counts confirmed marks of all groups', () => {
    expect(regionTally(list, u, 'g1')).toEqual({ group: { total: 2, manual: 1, automated: 1 }, groupConfirmed: 1, allConfirmed: 2 })
    expect(regionTally(list, u, null).group.total).toBe(0)
  })
})
