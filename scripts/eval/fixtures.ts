/**
 * Synthetic cluster fixtures for the fitter (node only, no images needed):
 * chains of 2–6, a triangle, a square, a pentagon ring and a 2×3 grid at
 * 0–40 % overlap, rendered like clusters.test.ts (soft edges, rim dimming,
 * pseudo-noise) with four isolated seeds.
 *
 *   node scripts/eval/fixtures.ts [--objective tuned|brief] [--sensitivity 0.5]
 *
 * Prints one line per layout: found/true count per overlap, '*' = review region,
 * '!' = a true colony without a suggestion within half a radius.
 */
import { detect } from '../../src/detection/index.ts'
import type { DetectInput, RgbaImage } from '../../src/detection/types.ts'
import { parseArgs } from './args.ts'

const args = parseArgs(process.argv.slice(2))
const objective = (args.objective as 'tuned' | 'brief' | undefined) ?? undefined
const sensitivity = Number(args.sensitivity ?? 0.5)
const R = 10
const W = 300
const H = 300
type Disk = { x: number; y: number; r: number }
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
          const t = Math.min(1, Math.max(0, (c.r - d) / (2 * edge) + 0.5))
          a = Math.max(a, t * (1 - 0.15 * Math.min(1, d / c.r) ** 2))
        }
      const n = 3 * noise(x, y)
      const i = (y * W + x) * 4
      if (!inPlate) data[i] = data[i + 1] = data[i + 2] = 235
      else {
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
  { x: 255, y: 45, r: R },
  { x: 45, y: 255, r: R },
  { x: 255, y: 255, r: R },
]

const ring = (k: number, d: number): Disk[] => {
  const rad = d / (2 * Math.sin(Math.PI / k))
  return Array.from({ length: k }, (_, i) => ({ x: 150 + rad * Math.cos((2 * Math.PI * i) / k - Math.PI / 2), y: 150 + rad * Math.sin((2 * Math.PI * i) / k - Math.PI / 2), r: R }))
}
const LAYOUTS: Record<string, (d: number) => Disk[]> = {
  chain2: (d) => [-0.5, 0.5].map((k) => ({ x: 150 + k * d, y: 150, r: R })),
  chain3: (d) => [-1, 0, 1].map((k) => ({ x: 150 + k * d, y: 150, r: R })),
  chain4: (d) => [-1.5, -0.5, 0.5, 1.5].map((k) => ({ x: 150 + k * d * 0.95, y: 150 + k * d * 0.3, r: R })),
  chain5: (d) => [-2, -1, 0, 1, 2].map((k) => ({ x: 150 + k * d, y: 150 + (k % 2) * 0.3 * d, r: R })),
  chain6: (d) => [-2.5, -1.5, -0.5, 0.5, 1.5, 2.5].map((k) => ({ x: 150 + k * d * 0.95, y: 150 + k * d * 0.3, r: R })),
  triangle: (d) => ring(3, d),
  square: (d) => ring(4, d),
  pentagon: (d) => ring(5, d),
  grid2x3: (d) => [-1, 0, 1].flatMap((a) => [-0.5, 0.5].map((b) => ({ x: 150 + a * d, y: 150 + b * d, r: R }))),
}
const OVERLAPS = [0, 0.1, 0.2, 0.3, 0.4]

function input(cluster: Disk[]): DetectInput {
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
    settings: { method: 'fitter', sensitivity, ...(objective ? { objective } : {}) },
  }
}

let exact = 0
let total = 0
let review = 0
let missed = 0
console.log(`objective ${objective ?? 'default'}, sensitivity ${sensitivity}; cells = found/true (* review, ! missed colony)`)
console.log(['layout', ...OVERLAPS.map((o) => `${o * 100}%`)].join('\t'))
for (const [name, f] of Object.entries(LAYOUTS)) {
  const cells: string[] = []
  for (const ov of OVERLAPS) {
    const cluster = f(2 * R * (1 - ov))
    const r = await detect(input(cluster))
    const found = r.suggestions
    const miss = cluster.some((c) => !found.some((s) => Math.hypot(s.x - c.x, s.y - c.y) < 0.5 * R))
    const inReview = found.some((s) => s.status === 'review') || r.clusters.some((c) => c.status === 'review')
    total++
    if (found.length === cluster.length) exact++
    if (inReview) review++
    if (miss) missed++
    cells.push(`${found.length}/${cluster.length}${inReview ? '*' : ''}${miss ? '!' : ''}`)
  }
  console.log([name, ...cells].join('\t'))
}
console.log(`exact count ${exact}/${total}; review ${review}/${total}; with a missed colony ${missed}/${total}`)
