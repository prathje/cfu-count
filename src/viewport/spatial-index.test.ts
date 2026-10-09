import { describe, expect, it } from 'vitest'
import { createPointIndex, GridIndex, LinearIndex, GRID_THRESHOLD } from './spatial-index'
import { ann, randomAnnotations, rng } from './test-fixtures'

describe('point index', () => {
  const pts = [ann('a', 10, 10), ann('b', 20, 10), ann('c', 20, 10, 'g2'), ann('d', 100, 100)]
  for (const [name, make] of [
    ['linear', (p: typeof pts) => new LinearIndex(p)],
    ['grid', (p: typeof pts) => new GridIndex(p, 16)],
  ] as const) {
    describe(name, () => {
      const idx = make(pts)
      it('finds the nearest within radius', () => {
        expect(idx.nearest(12, 10, 5)?.annotation.id).toBe('a')
        expect(idx.nearest(12, 10, 5)?.distance).toBeCloseTo(2)
      })
      it('returns null outside radius', () => {
        expect(idx.nearest(50, 50, 5)).toBeNull()
      })
      it('applies the filter', () => {
        expect(idx.nearest(19, 10, 5, (a) => a.groupId === 'g1')?.annotation.id).toBe('b')
      })
      it('ties resolve to the later annotation (drawn on top)', () => {
        expect(idx.nearest(20, 10, 5)?.annotation.id).toBe('c')
      })
      it('includes points exactly on the radius', () => {
        expect(idx.nearest(100, 105, 5)?.annotation.id).toBe('d')
      })
      it('handles an empty set', () => {
        expect(make([]).nearest(0, 0, 10)).toBeNull()
      })
    })
  }

  it('grid and linear agree on random queries', () => {
    const many = randomAnnotations(5000, 4000, 3000, 7, ['g1', 'g2'])
    const lin = new LinearIndex(many)
    const grid = new GridIndex(many)
    const r = rng(3)
    for (let i = 0; i < 2000; i++) {
      const x = r() * 4200 - 100
      const y = r() * 3200 - 100
      const rad = 1 + r() * 200
      const f = i % 2 ? undefined : (a: { groupId: string }) => a.groupId === 'g2'
      expect(grid.nearest(x, y, rad, f)?.annotation.id).toBe(lin.nearest(x, y, rad, f)?.annotation.id)
    }
  })

  it('createPointIndex picks by size', () => {
    expect(createPointIndex(randomAnnotations(10, 100, 100))).toBeInstanceOf(LinearIndex)
    expect(createPointIndex(randomAnnotations(GRID_THRESHOLD, 100, 100))).toBeInstanceOf(GridIndex)
  })
})

/**
 * Timing benchmark that justified the design (numbers printed for the record;
 * assertions are generous so CI noise does not fail the suite).
 * Usage pattern: hover queries happen per pointermove (~60-120 Hz) and the index
 * is rebuilt lazily once after each edit.
 */
describe('benchmark (10k points, 4000x3000 image)', () => {
  const pts = randomAnnotations(10_000, 4000, 3000, 11, ['g1', 'g2'])
  const queries = 2000
  const r = rng(5)
  const qs = Array.from({ length: queries }, () => [r() * 4000, r() * 3000, 20 + r() * 100] as const)

  function time(fn: () => void): number {
    const t0 = performance.now()
    fn()
    return performance.now() - t0
  }

  it('measures linear scan vs grid', () => {
    const lin = new LinearIndex(pts)
    let sink = 0
    const linMs = time(() => {
      for (const [x, y, rad] of qs) sink += lin.nearest(x, y, rad, (a) => a.groupId === 'g1') ? 1 : 0
    })
    let grid!: GridIndex
    const buildMs = time(() => {
      grid = new GridIndex(pts)
    })
    const gridMs = time(() => {
      for (const [x, y, rad] of qs) sink += grid.nearest(x, y, rad, (a) => a.groupId === 'g1') ? 1 : 0
    })
    const perLin = (linMs / queries) * 1000
    const perGrid = (gridMs / queries) * 1000
    console.log(
      `[bench] 10k pts: linear ${perLin.toFixed(1)} us/query; grid build ${buildMs.toFixed(2)} ms, ` +
        `${perGrid.toFixed(2)} us/query (sink ${sink})`,
    )
    // A single linear query at 10k must stay well under one frame.
    expect(perLin).toBeLessThan(2000)
    expect(buildMs).toBeLessThan(100)
  })
})
