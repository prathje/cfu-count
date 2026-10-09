import { describe, expect, it } from 'vitest'
import { centreError, duplicateRate, matchPoints, perClusterCountError, prf, rng, sample, spread } from './metrics.ts'

describe('matchPoints', () => {
  it('matches one-to-one by distance within the radius', () => {
    const gt = [{ x: 0, y: 0 }, { x: 10, y: 0 }]
    const pred = [{ x: 1, y: 0 }, { x: 0.5, y: 0 }, { x: 30, y: 0 }]
    const m = matchPoints(pred, gt, 3)
    expect(m.tp).toBe(1)
    expect(m.pairs[0][0]).toBe(1) // the closer prediction wins
    expect(m.fp).toBe(2)
    expect(m.fn).toBe(1)
    expect(duplicateRate(pred, gt, m, 3)).toBeCloseTo(1 / 3)
    expect(centreError(m).median).toBeCloseTo(0.5)
  })
  it('prf handles empty sets', () => {
    expect(prf(0, 0, 0)).toEqual({ precision: 1, recall: 1, f1: 1 })
    expect(prf(3, 1, 0).precision).toBeCloseTo(0.75)
  })
})

describe('perClusterCountError', () => {
  it('bins clusters by GT count and counts exact matches', () => {
    // cluster 1: 1 GT, 1 pred; cluster 2: 3 GT, 2 pred; cluster 3: 0 GT, 1 pred
    const r = perClusterCountError([1, 2, 2, 2, 0], [1, 2, 2, 3])
    const one = r.rows.find((x) => x.bin === '1')!
    const mid = r.rows.find((x) => x.bin === '3-5')!
    const zero = r.rows.find((x) => x.bin === '0')!
    expect(one.exact).toBe(1)
    expect(mid.meanAbsError).toBe(1)
    expect(zero.clusters).toBe(1)
    expect(r.gtOutsideClusters).toBe(1)
  })
})

describe('sampling helpers', () => {
  it('is deterministic and samples without replacement', () => {
    const a = sample([1, 2, 3, 4, 5], 3, rng(42))
    const b = sample([1, 2, 3, 4, 5], 3, rng(42))
    expect(a).toEqual(b)
    expect(new Set(a).size).toBe(3)
    expect(spread([1, 2, 3]).sd).toBeCloseTo(1)
  })
})
