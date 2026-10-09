import { describe, expect, it } from 'vitest'
import { OccupancyGrid, labelCandidates, markerBox, placeLabel } from './label-layout'
import { displayRadius, FULL_SIZE_SCALE, MIN_DISPLAY_RADIUS } from './marker-size'

describe('displayRadius', () => {
  it('keeps the group size at normal zoom and is continuous at the threshold', () => {
    expect(displayRadius(6, 1)).toBe(6)
    expect(displayRadius(6, FULL_SIZE_SCALE)).toBe(6)
    expect(displayRadius(6, FULL_SIZE_SCALE * 0.98)).toBeCloseTo(6, 0)
  })
  it('shrinks smoothly when zoomed far out, never below the minimum or above the size', () => {
    const rs = [0.45, 0.35, 0.25, 0.19, 0.1, 0.02].map((s) => displayRadius(10, s))
    for (let i = 1; i < rs.length; i++) expect(rs[i]).toBeLessThanOrEqual(rs[i - 1])
    expect(Math.min(...rs)).toBe(MIN_DISPLAY_RADIUS)
    expect(displayRadius(3, 0.05)).toBe(3) // already small: untouched
    expect(displayRadius(6, 0.19)).toBeGreaterThanOrEqual(MIN_DISPLAY_RADIUS)
    expect(displayRadius(6, 0.19)).toBeLessThan(6)
  })
})

describe('label placement', () => {
  it('uses the upper-right spot when free', () => {
    const grid = new OccupancyGrid()
    grid.add(markerBox(100, 100, 6))
    const box = placeLabel(grid, 100, 100, 6, 14, 12)
    expect(box).toEqual(labelCandidates(100, 100, 6, 14, 12)[0])
    expect(box.x).toBeGreaterThan(100)
    expect(box.y + box.h).toBeLessThan(100)
  })
  it('moves a label to the next free quadrant when a neighbour occupies the default', () => {
    const grid = new OccupancyGrid()
    grid.add(markerBox(100, 100, 6))
    grid.add(markerBox(112, 90, 6)) // marker sitting where the default label would go
    const box = placeLabel(grid, 100, 100, 6, 14, 12)
    expect(box).not.toEqual(labelCandidates(100, 100, 6, 14, 12)[0])
    // a second label for the neighbour must not overlap the first label
    const other = placeLabel(grid, 112, 90, 6, 14, 12)
    const overlap = box.x < other.x + other.w && other.x < box.x + box.w && box.y < other.y + other.h && other.y < box.y + box.h
    expect(overlap).toBe(false)
  })
  it('falls back to the default spot when everything collides', () => {
    const grid = new OccupancyGrid()
    grid.add({ x: 0, y: 0, w: 200, h: 200 })
    expect(placeLabel(grid, 100, 100, 6, 14, 12)).toEqual(labelCandidates(100, 100, 6, 14, 12)[0])
  })
  it('handles negative (off-screen margin) coordinates', () => {
    const grid = new OccupancyGrid()
    grid.add({ x: -50, y: -50, w: 10, h: 10 })
    expect(grid.hits({ x: -45, y: -45, w: 2, h: 2 })).toBe(true)
    expect(grid.hits({ x: -30, y: -45, w: 2, h: 2 })).toBe(false)
  })
  it('places 5000 dense labels quickly', () => {
    const grid = new OccupancyGrid()
    const pts = Array.from({ length: 5000 }, (_, i) => [(i * 37) % 1400, ((i * 53) % 900) + (i % 7)])
    const t0 = performance.now()
    for (const [x, y] of pts) grid.add(markerBox(x, y, 6))
    for (const [x, y] of pts) placeLabel(grid, x, y, 6, 22, 12)
    const ms = performance.now() - t0
    expect(ms).toBeLessThan(250) // typically a few ms; generous bound for slow CI
  })
})
