import { describe, expect, it } from 'vitest'
import { matchPoints, prf } from './match.ts'

describe('matchPoints (shared by scripts/eval and Compare with detector)', () => {
  it('matches one-to-one, nearest pairs first, within the radius', () => {
    const gt = [{ x: 0, y: 0 }, { x: 10, y: 0 }]
    const pred = [{ x: 1, y: 0 }, { x: 0.5, y: 0 }, { x: 30, y: 0 }]
    const m = matchPoints(pred, gt, 3)
    expect(m.pairs).toEqual([[1, 0, 0.5]])
    expect(m.unmatchedPred).toEqual([0, 2])
    expect(m.unmatchedGt).toEqual([1])
    expect([m.tp, m.fp, m.fn]).toEqual([1, 2, 1])
  })
  it('a distance equal to the radius still matches; empty inputs are fine', () => {
    expect(matchPoints([{ x: 3, y: 4 }], [{ x: 0, y: 0 }], 5).tp).toBe(1)
    expect(matchPoints([], [{ x: 0, y: 0 }], 5)).toMatchObject({ tp: 0, fp: 0, fn: 1 })
    expect(matchPoints([{ x: 0, y: 0 }], [], 5)).toMatchObject({ tp: 0, fp: 1, fn: 0 })
  })
  it('resolves a crowded neighbourhood without double use', () => {
    const gt = [{ x: 0, y: 0 }, { x: 4, y: 0 }]
    const pred = [{ x: 2.1, y: 0 }, { x: 1.9, y: 0 }]
    const m = matchPoints(pred, gt, 3)
    expect(m.tp).toBe(2)
    expect(new Set(m.pairs.map((p) => p[1])).size).toBe(2)
  })
  it('prf', () => {
    expect(prf(0, 0, 0)).toEqual({ precision: 1, recall: 1, f1: 1 })
    const p = prf(8, 2, 2)
    expect(p.precision).toBeCloseTo(0.8)
    expect(p.f1).toBeCloseTo(0.8)
  })
})
