import { describe, expect, it } from 'vitest'
import {
  measureLocalColonies,
  measureSeed,
  priorsForClusters,
  radiusPrior,
  seedQuality,
  seedWeight,
  sizeSpreadNote,
  TOUCHING_WEIGHT,
  weightedMedian,
  type LocalColony,
} from './calibrate.ts'
import { detect } from './index.ts'
import { makePlane, type Plane, type RgbaImage } from './image/plane.ts'

interface Disk {
  x: number
  y: number
  r: number
}

/**
 * Colony profile: a soft edge (falling to 0 over `soft` px around the rim) times a gentle dome
 * (25 % dimmer at the rim, like real colonies), so touching or slightly overlapping colonies
 * are separated by darker seams.
 */
const dome = (d: number, r: number, soft = 1.5) => Math.min(1, Math.max(0, (r + 0.5 * soft - d) / soft)) * (1 - 0.25 * Math.min(1, d / r) ** 2)
/** Flat-topped disk (no shading): overlapping ones merge without a seam. */
const flat = (d: number, r: number, soft = 1.5) => Math.min(1, Math.max(0, (r + 0.5 * soft - d) / soft))

function plane(w: number, h: number, disks: Disk[], amp = 50): Plane {
  const F = makePlane(w, h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let a = 0
      for (const c of disks) a = Math.max(a, dome(Math.hypot(x + 0.5 - c.x, y + 0.5 - c.y), c.r))
      F.data[y * w + x] = a * amp + (((x * 7919 + y * 104729) % 5) - 2) * 0.3
    }
  return F
}

/** Hex-packed streak: `rows` × `cols` disks of radius r at centre spacing `sp`. */
function streak(x0: number, y0: number, rows: number, cols: number, r: number, sp: number): Disk[] {
  const out: Disk[] = []
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) out.push({ x: x0 + i * sp + (j % 2 ? sp / 2 : 0), y: y0 + j * sp * 0.866, r })
  return out
}

describe('seed radius: first boundary, not the cluster', () => {
  const R = 8
  for (const [label, sp] of [
    ['touching (seam ≈ 2 px, deep)', 2 * R],
    ['slightly overlapping (shallow seam)', 1.85 * R],
    ['overlapping (very shallow seam)', 1.7 * R],
  ] as const) {
    it(`measures a seed inside a dense streak within ±20 % — ${label}`, () => {
      const disks = streak(20, 20, 7, 12, R, sp)
      const F = plane(240, 140, disks)
      // interior colonies, clicked 1.5 px off centre
      for (const c of [disks[3 * 12 + 4], disks[2 * 12 + 6], disks[4 * 12 + 7]]) {
        const m = measureSeed({ F, noise: 0.5, rMax: 60 }, c.x + 1.5, c.y - 1)
        expect(m.r).not.toBeNull()
        expect(Math.abs(m.r! - R) / R).toBeLessThan(0.2)
        // re-centred on the colony, not on the cluster
        expect(Math.hypot(m.cx - c.x, m.cy - c.y)).toBeLessThan(0.3 * R)
        // usable: 'ok' when the seam is as deep as a free edge, else 'touching' at a lower weight
        const q = seedQuality(m)
        expect(['ok', 'touching']).toContain(q.quality)
        expect(seedWeight(m)).toBe(q.quality === 'ok' ? 1 : TOUCHING_WEIGHT)
      }
    })
  }

  it('keeps an isolated colony "ok" with full weight', () => {
    const F = plane(60, 60, [{ x: 30, y: 30, r: 10 }])
    const m = measureSeed({ F, noise: 0.5, rMax: 25 }, 31, 29)
    expect(Math.abs(m.r! - 10)).toBeLessThan(1)
    expect(seedQuality(m).quality).toBe('ok')
    expect(seedWeight(m)).toBe(1)
  })

  it('re-centres a click far off the centre of a large flat colony', () => {
    const F = makePlane(80, 80)
    for (let y = 0; y < 80; y++) for (let x = 0; x < 80; x++) F.data[y * 80 + x] = flat(Math.hypot(x + 0.5 - 40, y + 0.5 - 40), 18) * 30 + (((x * 7919 + y * 104729) % 7) - 3) * 0.5
    for (const [dx, dy] of [[10, 3], [-13, 0], [0, 14]]) {
      const m = measureSeed({ F, noise: 1.5, rMax: 44 }, 40 + dx, 40 + dy)
      expect(Math.abs(m.r! - 18)).toBeLessThan(1.5)
      expect(Math.hypot(m.cx - 40, m.cy - 40)).toBeLessThan(1)
      expect(seedQuality(m).quality).toBe('ok')
    }
  })

  it('does not measure the whole blob when a neighbour merges without a seam', () => {
    // union of two overlapping disks (one plateau, no seam between them)
    const F = makePlane(80, 50)
    for (let y = 0; y < 50; y++)
      for (let x = 0; x < 80; x++) {
        const d = Math.min(Math.hypot(x + 0.5 - 33, y + 0.5 - 25), Math.hypot(x + 0.5 - 47, y + 0.5 - 25))
        F.data[y * 80 + x] = flat(d, 10) * 50
      }
    const m = measureSeed({ F, noise: 0.5, rMax: 40 }, 33, 25)
    if (m.r !== null) expect(m.r).toBeLessThan(15)
  })
})

describe('size prior from mixed examples', () => {
  it('weights touching seeds less and reports a size spread in plain words', () => {
    const p = radiusPrior([10, 30], 0.25, [1, TOUCHING_WEIGHT])!
    expect(p.rMedian).toBeCloseTo(10)
    expect(weightedMedian([1, 2, 3, 4], [1, 1, 1, 1])).toBeCloseTo(2.5)
    expect(sizeSpreadNote([30, 32, 70])).toMatch(/vary in size \(radius 30–70 px\)/)
    expect(sizeSpreadNote([30, 40])).toBeNull()
  })
})

describe('local size per cluster', () => {
  const prior = (r: number, s = 0.3) => ({ logR: Math.log(r), s, rMed: r, rLo: r * Math.exp(-2 * s), rHi: r * Math.exp(2 * s) })

  it('measures the colonies of a streak automatically at about their true size', () => {
    const disks = streak(20, 20, 6, 12, 8, 16)
    const F = plane(240, 120, disks)
    const within = new Uint8Array(F.data.length)
    for (let i = 0; i < within.length; i++) within[i] = F.data[i] > 15 ? 1 : 0
    const cols = measureLocalColonies(F, within, 0.5, { rMin: 4, rMax: 60, threshold: 15 })
    expect(cols.length).toBeGreaterThan(0.6 * disks.length)
    const med = weightedMedian(
      cols.map((c) => c.r),
      cols.map(() => 1),
    )
    expect(Math.abs(med - 8) / 8).toBeLessThan(0.2)
  })

  it('adapts per cluster to marks and to round isolated colonies, never down from automatic measurements', () => {
    const many = (r: number, n: number, weight = TOUCHING_WEIGHT, cv = 0.02): LocalColony[] => Array.from({ length: n }, (_, i) => ({ x: i, y: 0, r, weight, cv }))
    const A = (r: number, k: number) => k * Math.PI * r * r
    // small automatic measurements in a streak do NOT shrink the prior (they are biased both ways)
    expect(priorsForClusters(prior(20), [{ area: A(20, 30), cols: many(9, 30), marks: [] }])[0].adapted).toBe(false)
    // marks inside the streak do; and a second, unmarked streak follows them
    const [a, b] = priorsForClusters(prior(20), [
      { area: A(20, 30), cols: many(12, 30), marks: [9, 10, 9] },
      { area: A(20, 30), cols: many(14, 30), marks: [] },
    ])
    expect(a.rMed).toBeLessThan(13)
    expect(b.rMed).toBeCloseTo(a.rMed)
    // one clean, round big colony (30) under a small prior (12): grows towards it
    const [up] = priorsForClusters(prior(12), [{ area: A(30, 1), cols: many(30, 1, 1), marks: [] }])
    expect(up.adapted).toBe(true)
    expect(up.rMed).toBeGreaterThan(20)
    // ... but not for a roughly round clump (cv 0.1: overlapping colonies without seams)
    expect(priorsForClusters(prior(12), [{ area: A(30, 1), cols: many(30, 1, 1, 0.1), marks: [] }])[0].adapted).toBe(false)
    // nor for a streak with a few round lobes among many touching colonies
    expect(priorsForClusters(prior(12), [{ area: A(12, 40), cols: [...many(25, 3, 1), ...many(14, 30)], marks: [] }])[0].adapted).toBe(false)
    // representative marks: unchanged
    expect(priorsForClusters(prior(10), [{ area: A(10, 40), cols: [], marks: [10.5, 9.8] }])[0].adapted).toBe(false)
  })


})

/** Synthetic photo: dark plate on foam, cream colonies as soft disks (touching ones form seams). */
function photo(w: number, h: number, colonies: Disk[]): RgbaImage {
  const data = new Uint8ClampedArray(w * h * 4)
  const px0 = w * 0.06, px1 = w * 0.94, py0 = h * 0.06, py1 = h * 0.94
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const inPlate = x >= px0 && x < px1 && y >= py0 && y < py1
      const rim = inPlate && Math.min(x - px0, px1 - x, y - py0, py1 - y) < 6
      let v: [number, number, number] = inPlate ? (rim ? [200, 190, 150] : [70, 72, 75]) : [235, 235, 235]
      if (inPlate && !rim) {
        let a = 0
        for (const c of colonies) {
          if (Math.abs(x - c.x) > c.r + 3 || Math.abs(y - c.y) > c.r + 3) continue
          a = Math.max(a, dome(Math.hypot(x + 0.5 - c.x, y + 0.5 - c.y), c.r, 2))
        }
        v = [v[0] + a * (190 - v[0]), v[1] + a * (180 - v[1]), v[2] + a * (130 - v[2])]
      }
      const n = ((x * 7919 + y * 104729) % 7) - 3
      data[i] = v[0] + n
      data[i + 1] = v[1] + n
      data[i + 2] = v[2] + n
      data[i + 3] = 255
    }
  return { width: w, height: h, data }
}

describe('detect() on a plate with a dense streak and large isolated colonies', () => {
  const W = 420
  const H = 300
  const small = streak(70, 60, 4, 10, 8, 16) // 40 touching colonies, r = 8
  const big: Disk[] = [
    { x: 90, y: 220, r: 18 },
    { x: 170, y: 225, r: 17 },
    { x: 260, y: 215, r: 19 },
    { x: 340, y: 230, r: 18 },
  ]
  const image = photo(W, H, [...small, ...big])
  const run = (seedPts: { x: number; y: number }[]) =>
    detect({
      image,
      scale: 1,
      originalWidth: W,
      originalHeight: H,
      imageId: 'img',
      targetGroupId: 'g',
      seeds: seedPts.map((p, i) => ({ annotationId: `s${i}`, imageId: 'img', x: p.x, y: p.y })),
      existing: seedPts.map((p, i) => ({ id: `s${i}`, x: p.x, y: p.y, groupId: 'g', origin: 'manual' as const })),
      settings: { method: 'fitter' },
    })
  const inStreak = (p: { x: number; y: number }) => p.y < 160
  const near = (p: { x: number; y: number }, d: Disk) => Math.hypot(p.x - d.x, p.y - d.y) < 0.6 * d.r

  it('seeds inside the streak: usable, streak counted within ±20 %, one circle per big colony', async () => {
    const seeds = [small[13], small[16], small[25]].map((d) => ({ x: d.x + 1, y: d.y - 1 }))
    const r = await run(seeds)
    expect(r.calibration.nUsable).toBe(3)
    for (const s of r.calibration.seeds) expect(Math.abs((s.radiusPx ?? 0) - 8) / 8).toBeLessThan(0.2)
    const streakCount = r.suggestions.filter(inStreak).length + seeds.length
    expect(Math.abs(streakCount - small.length) / small.length).toBeLessThanOrEqual(0.2)
    for (const d of big) expect(r.suggestions.filter((s) => Math.hypot(s.x - d.x, s.y - d.y) < d.r).length).toBe(1)
  })

  it('seeds of both kinds: each area is fitted with its own size', async () => {
    const seeds = [small[13], small[26], big[0], big[1]].map((d) => ({ x: d.x + 1, y: d.y - 1 }))
    const r = await run(seeds)
    expect(r.calibration.nUsable).toBe(4)
    expect(r.calibration.warnings.join(' ')).toMatch(/vary in size/)
    const streakCount = r.suggestions.filter(inStreak).length + 2
    expect(Math.abs(streakCount - small.length) / small.length).toBeLessThanOrEqual(0.2)
    for (const d of big.slice(2)) expect(r.suggestions.filter((s) => near(s, d)).length).toBe(1)
  })

})
