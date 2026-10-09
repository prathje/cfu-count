/**
 * Regression fixtures for under-splitting (field report: "a cluster of 3 just
 * became a single one"). Synthetic plates with touching clusters of 2–4
 * colonies at increasing overlap, soft edges and noise, run end to end through
 * detect() with four isolated seeds.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, detect } from './index.ts'
import type { DetectInput, DetectMethod, RgbaImage } from './types.ts'

interface Disk {
  x: number
  y: number
  r: number
}

const R = 10
const W = 260
const H = 260

/** Deterministic pseudo-noise in [-1, 1]. */
const noise = (x: number, y: number) => (((x * 73856093) ^ (y * 19349663)) % 1000) / 1000

function plate(colonies: Disk[], edge = 1.5): RgbaImage {
  const data = new Uint8ClampedArray(W * H * 4)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const inPlate = x >= 20 && x < W - 20 && y >= 20 && y < H - 20
      let a = 0
      if (inPlate)
        for (const c of colonies) {
          const d = Math.hypot(x + 0.5 - c.x, y + 0.5 - c.y)
          // soft edge of width ~2·edge, slightly dimmer towards the rim like real colonies
          const t = Math.min(1, Math.max(0, (c.r - d) / (2 * edge) + 0.5))
          a = Math.max(a, t * (1 - 0.15 * Math.min(1, d / c.r) ** 2))
        }
      const n = 3 * noise(x, y)
      const i = (y * W + x) * 4
      if (!inPlate) {
        data[i] = data[i + 1] = data[i + 2] = 235
      } else {
        data[i] = 70 + a * 120 + n
        data[i + 1] = 72 + a * 110 + n
        data[i + 2] = 75 + a * 55 + n
      }
      data[i + 3] = 255
    }
  return { width: W, height: H, data }
}

const seeds: Disk[] = [
  { x: 45, y: 45, r: R },
  { x: 215, y: 45, r: R },
  { x: 45, y: 215, r: R },
  { x: 215, y: 215, r: R },
]

/** Cluster layouts around (130, 130); `d` = centre distance between neighbours. */
function layout(kind: 'pair' | 'chain3' | 'triangle' | 'chain4' | 'square', d: number): Disk[] {
  const c = 130
  switch (kind) {
    case 'pair':
      return [{ x: c - d / 2, y: c, r: R }, { x: c + d / 2, y: c, r: R }]
    case 'chain3':
      return [-1, 0, 1].map((k) => ({ x: c + k * d, y: c, r: R }))
    case 'triangle':
      return [0, 1, 2].map((k) => ({ x: c + (d / Math.sqrt(3)) * Math.cos((k * 2 * Math.PI) / 3 - Math.PI / 2), y: c + (d / Math.sqrt(3)) * Math.sin((k * 2 * Math.PI) / 3 - Math.PI / 2), r: R }))
    case 'chain4':
      return [-1.5, -0.5, 0.5, 1.5].map((k) => ({ x: c + k * d * 0.95, y: c + k * d * 0.3, r: R }))
    case 'square':
      return [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([a, b]) => ({ x: c + (a * d) / 2, y: c + (b * d) / 2, r: R }))
  }
}

function input(cluster: Disk[], method: DetectMethod, objective: 'tuned' | 'brief' = 'tuned'): DetectInput {
  const s = seeds.map((d, i) => ({ annotationId: `s${i}`, imageId: 'img', x: d.x + 0.7, y: d.y - 0.6 }))
  return {
    image: plate([...seeds, ...cluster]),
    scale: 1,
    originalWidth: W,
    originalHeight: H,
    imageId: 'img',
    targetGroupId: 'g',
    seeds: s,
    existing: s.map((q) => ({ id: q.annotationId, x: q.x, y: q.y, groupId: 'g', origin: 'manual' as const })),
    settings: { method, objective },
  }
}

const OVERLAPS = [0, 0.15, 0.3, 0.4] // fraction of the diameter the disks overlap by
const KINDS = [
  ['pair', 2],
  ['chain3', 3],
  ['triangle', 3],
  ['chain4', 4],
  ['square', 4],
] as const

describe.each(['tuned', 'brief'] as const)('fitter (%s objective) splits touching clusters', (objective) => {
  for (const [kind, k] of KINDS)
    for (const ov of OVERLAPS) {
      it(`${kind} (K=${k}) at ${ov * 100}% overlap`, async () => {
        const cluster = layout(kind, 2 * R * (1 - ov))
        const r = await detect(input(cluster, 'fitter', objective))
        const found = r.suggestions
        expect(found.length).toBe(k)
        // every colony has a suggestion within half a radius
        for (const c of cluster) expect(Math.min(...found.map((s) => Math.hypot(s.x - c.x, s.y - c.y)))).toBeLessThan(0.5 * R)
        // a clear cluster (≤ 15 % overlap) is decided, not sent to review (default objective;
        // the 'brief' variant sometimes flags clear chains, see detection-results.md)
        if (ov <= 0.15 && objective === 'tuned') {
          const cl = r.clusters.find((q) => q.clusterId === found[0].clusterId)!
          expect(cl.status).toBe('ok')
          expect(found.every((s) => s.status === 'ok')).toBe(true)
        }
      })
    }
})

describe('a clear triple is decided with margin', () => {
  it.each([0, 0.15])('triangle at %s overlap: K=3, relative gap well above the review threshold', async (ov) => {
    const r = await detect(input(layout('triangle', 2 * R * (1 - ov)), 'fitter'))
    const ids = new Set(r.suggestions.map((s) => s.clusterId))
    const cls = r.clusters.filter((c) => ids.has(c.clusterId))
    expect(cls.reduce((a, c) => a + c.chosenK, 0)).toBe(3)
    for (const c of cls) expect(c.relativeGap ?? Infinity).toBeGreaterThan(5 * DEFAULT_SETTINGS.reviewGap)
  })
})

describe('watershed baseline splits touching clusters with a neck', () => {
  for (const [kind, k] of KINDS)
    it(`${kind} (K=${k}) at 15% overlap`, async () => {
      const r = await detect(input(layout(kind, 2 * R * 0.85), 'watershed'))
      expect(r.suggestions.length).toBe(k)
    })
})

describe('a single colony stays one', () => {
  it.each(['fitter', 'watershed'] as const)('%s', async (method) => {
    const r = await detect(input([{ x: 130, y: 130, r: R * 1.2 }], method))
    expect(r.suggestions.length).toBe(1)
  })
})

describe('review alternatives as a diff', () => {
  it('lists the circles the alternative adds and the primary ones it removes', async () => {
    // a 40 %-overlap triangle is the most ambiguous fixture; force review to see an alternative
    const inp = input(layout('triangle', 2 * R * 0.6), 'fitter')
    inp.settings = { ...inp.settings, reviewGap: 10 }
    const r = await detect(inp)
    const rc = r.clusters.find((c) => c.status === 'review' && c.alternative)!
    expect(rc).toBeTruthy()
    const alt = rc.alternative!
    const primary = r.suggestions.filter((s) => s.clusterId === rc.clusterId)
    // kept primary circles + added = the full alternative set
    expect(primary.length - alt.removed!.length + alt.added!.length).toBe(alt.colonies.length)
    expect(alt.k).toBe(alt.colonies.length)
  })
})
