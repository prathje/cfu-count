/**
 * Detection evaluation harness (node only).
 *
 *   npm run eval -- --images test_images --seeds scripts/eval/agent-seeds.json
 *   npm run eval -- --gt project.zip --seeds gt:5 --resample 10
 *
 * Options
 *   --images <dir>        local images (jpg/jpeg/png); optional with --gt if the zip contains images
 *   --gt <zip>            project export with fully annotated plates (ground truth)
 *   --gt-group <name|id>  only this annotation group is GT (default: all confirmed annotations)
 *   --seeds <spec>        <file.json> | gt:<k>[:random|largest] | auto | none   (default: auto)
 *   --seed-jitter <px>    random click error added to seeds (original px)
 *   --resample <n>        seed-sensitivity runs per image (random subsets of the seed pool)
 *   --resample-k <k>      seeds per resampled run (default: min(4, pool))
 *   --methods <list>      fitter,watershed,log (default all)
 *   --sensitivity <0..1>  detector sensitivity (default 0.5)
 *   --only <names>        comma-separated substrings of image names
 *   --single-pass         skip the second pass at the seed-derived analysis scale
 *   --target-r <px>       typical colony radius at analysis scale for the second pass (default 8)
 *   --weights k=v,...     fitter weight overrides (alpha, beta, gamma, lambda, wFP, huber)
 *   --no-overlays         skip overlay images
 *   --out <dir>           output directory (default .eval-out/<timestamp>)
 *
 * Writes report.json, report.md and overlay JPEGs. Never writes outside --out.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { detect, chooseAnalysisScale } from '../../src/detection/index.ts'
import type { DetectMethod, DetectResult, ExistingAnnotation, SeedInput } from '../../src/detection/types.ts'
import { parseArgs } from './args.ts'
import { cropPatch, decodeAt, originalSize } from './decode.ts'
import { findGt, loadGtZip, type GtImage } from './gt.ts'
import { centreError, duplicateRate, matchPoints, perClusterCountError, prf, rng, sample, spread, type Pt } from './metrics.ts'
import { renderOverlay } from './overlay.ts'

const args = parseArgs(process.argv.slice(2))
const methods = String(args.methods ?? 'fitter,watershed,log').split(',') as DetectMethod[]
const sensitivity = Number(args.sensitivity ?? 0.5)
const outDir = String(args.out ?? join('.eval-out', new Date().toISOString().replace(/[:.]/g, '-')))
const overlays = !args['no-overlays']
const twoPass = !args['single-pass']
const jitter = Number(args['seed-jitter'] ?? 0)
const resampleN = Number(args.resample ?? 0)
const seedSpec = String(args.seeds ?? 'auto')
const targetR = Number(args['target-r'] ?? 8)
/** --weights beta=1,huber=2 (fitter tuning) */
const fitWeights = args.weights ? Object.fromEntries(String(args.weights).split(',').map((kv) => [kv.split('=')[0], Number(kv.split('=')[1])])) : undefined
mkdirSync(outDir, { recursive: true })

interface Item {
  name: string
  bytes: Buffer
  gt?: GtImage
}

// ---------------------------------------------------------------- inputs
const items: Item[] = []
const gtAll = args.gt ? loadGtZip(String(args.gt), args['gt-group'] ? String(args['gt-group']) : undefined) : undefined
if (args.images) {
  const dir = String(args.images)
  for (const f of readdirSync(dir).sort()) {
    if (!/\.(jpe?g|png)$/i.test(f)) continue
    const bytes = readFileSync(join(dir, f))
    items.push({ name: f, bytes, gt: gtAll ? findGt(gtAll, f, bytes) : undefined })
  }
} else if (gtAll) {
  for (const g of gtAll) if (g.bytes) items.push({ name: g.name, bytes: Buffer.from(g.bytes), gt: g })
}
const only = args.only ? String(args.only).split(',') : null
const selected = items.filter((it) => !only || only.some((o) => it.name.includes(o)))
if (!selected.length) {
  console.error('No images. Use --images <dir> and/or --gt <zip>.')
  process.exit(1)
}

// ---------------------------------------------------------------- seeds
interface SeedFile {
  images: Record<string, { seeds?: Pt[]; seedsFrom?: string }>
}
const seedFile: SeedFile | null = /\.json$/i.test(seedSpec) ? JSON.parse(readFileSync(seedSpec, 'utf8')) : null

interface SeedPlan {
  /** Seeds on this image (original px). */
  local: Pt[]
  /** Seeds on a reference image. */
  remote?: { item: Item; pts: Pt[] }
  source: string
}

async function seedPlan(it: Item, rand: () => number): Promise<SeedPlan> {
  if (seedSpec === 'none') return { local: [], source: 'none' }
  if (seedFile) {
    const e = seedFile.images[it.name]
    if (!e) return { local: [], source: 'file (no entry)' }
    if (e.seeds) return { local: e.seeds, source: 'file (agent-picked)' }
    if (e.seedsFrom) {
      const ref = items.find((x) => x.name === e.seedsFrom)
      const pts = seedFile.images[e.seedsFrom]?.seeds ?? []
      if (ref && pts.length) return { local: [], remote: { item: ref, pts }, source: `file, cross-plate from ${e.seedsFrom}` }
    }
    return { local: [], source: 'file (unresolved)' }
  }
  if (seedSpec.startsWith('gt:')) {
    if (!it.gt) return { local: [], source: 'gt (no GT for image)' }
    const [, kStr, mode = 'random'] = seedSpec.split(':')
    const k = Number(kStr)
    const pts = it.gt.points
    const chosen = mode === 'largest' && pts.some((p) => p.r) ? pts.slice().sort((a, b) => (b.r ?? 0) - (a.r ?? 0)).slice(0, k) : sample(pts, k, rand)
    return { local: chosen.map((p) => ({ x: p.x, y: p.y })), source: `gt ${mode} ${k}` }
  }
  // auto: strongest isolated LoG blobs (a heuristic stand-in for user clicks)
  const size = await originalSize(it.bytes)
  const dec = await decodeAt(it.bytes, chooseAnalysisScale(size).scale)
  const r = await detect({ image: dec.image, scale: dec.scale, originalWidth: size.width, originalHeight: size.height, imageId: it.name, targetGroupId: 'auto', seeds: [], existing: [], settings: { method: 'log', sensitivity: 0.6 } })
  const singles = new Map<string, number>()
  for (const s of r.suggestions) singles.set(s.clusterId, (singles.get(s.clusterId) ?? 0) + 1)
  const iso = r.suggestions.filter((s) => singles.get(s.clusterId) === 1).sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
  return { local: iso.slice(0, 7).map((s) => ({ x: s.x, y: s.y })), source: 'auto (isolated LoG blobs)' }
}

function jittered(p: Pt, rand: () => number): Pt {
  if (!jitter) return p
  const a = rand() * 2 * Math.PI
  const d = Math.sqrt(rand()) * jitter
  return { x: p.x + d * Math.cos(a), y: p.y + d * Math.sin(a) }
}

async function buildSeeds(it: Item, plan: SeedPlan, scale: number, rand: () => number): Promise<{ seeds: SeedInput[]; existing: ExistingAnnotation[] }> {
  const seeds: SeedInput[] = []
  const existing: ExistingAnnotation[] = []
  plan.local.forEach((p0, i) => {
    const p = jittered(p0, rand)
    seeds.push({ annotationId: `seed-${i}`, imageId: it.name, x: p.x, y: p.y })
    existing.push({ id: `seed-${i}`, x: p.x, y: p.y, groupId: 'target', origin: 'manual' })
  })
  if (plan.remote) {
    const size = await originalSize(plan.remote.item.bytes)
    const half = 0.05 * Math.max(size.width, size.height)
    for (let i = 0; i < plan.remote.pts.length; i++) {
      const p = jittered(plan.remote.pts[i], rand)
      const patch = await cropPatch(plan.remote.item.bytes, p.x, p.y, half, scale)
      seeds.push({ annotationId: `ref-seed-${i}`, imageId: plan.remote.item.name, x: p.x, y: p.y, patch })
    }
  }
  return { seeds, existing }
}

// ---------------------------------------------------------------- run
interface MethodRecord {
  method: DetectMethod
  count: number
  reviewSuggestions: number
  clusters: number
  reviewClusters: number
  tooLarge: number
  ms: number
  timings: Record<string, number>
  peakRasterMB: number
  gt?: Record<string, unknown>
}
interface ImageRecord {
  name: string
  size: { width: number; height: number }
  seedSource: string
  seeds: number
  calibration: DetectResult['calibration'] & { seeds: unknown }
  roi: { source: string; shape: string; marginPx: number }
  pass1Ms: number
  scale: number
  methods: MethodRecord[]
  agreement: Record<string, number>
  resample?: Record<string, unknown>
}

const records: ImageRecord[] = []
for (const it of selected) {
  const rand = rng(1234)
  const size = await originalSize(it.bytes)
  const plan = await seedPlan(it, rand)
  // pass 1: preliminary scale, calibration only (cheapest method)
  let scale = chooseAnalysisScale(size).scale
  let dec = await decodeAt(it.bytes, scale)
  const t1 = performance.now()
  let s1 = await buildSeeds(it, plan, scale, rng(99))
  const pass1 = await detect({ image: dec.image, scale: dec.scale, originalWidth: size.width, originalHeight: size.height, imageId: it.name, targetGroupId: 'target', seeds: s1.seeds, existing: s1.existing, settings: { method: 'log', sensitivity } })
  const pass1Ms = performance.now() - t1
  const prior = pass1.calibration.prior
  if (twoPass && prior) {
    const s2 = chooseAnalysisScale({ ...size, minRadiusOriginal: prior.rRange[0], typicalRadiusOriginal: prior.rMedian, targetTypicalRadius: targetR }).scale
    if (Math.abs(s2 - scale) / scale > 0.15) {
      scale = s2
      dec = await decodeAt(it.bytes, scale)
      s1 = await buildSeeds(it, plan, dec.scale, rng(99))
    }
  }
  const results = new Map<DetectMethod, DetectResult>()
  const rec: ImageRecord = {
    name: it.name,
    size,
    seedSource: plan.source,
    seeds: s1.seeds.length,
    calibration: pass1.calibration,
    roi: { source: pass1.roi.source, shape: pass1.roi.shape, marginPx: Math.round(pass1.roi.marginPx) },
    pass1Ms: Math.round(pass1Ms),
    scale: Math.round(dec.scale * 1e4) / 1e4,
    methods: [],
    agreement: {},
  }
  for (const m of methods) {
    const t = performance.now()
    const r = await detect({
      image: dec.image,
      scale: dec.scale,
      originalWidth: size.width,
      originalHeight: size.height,
      imageId: it.name,
      targetGroupId: 'target',
      seeds: s1.seeds,
      existing: s1.existing,
      settings: { method: m, sensitivity, fitWeights },
      includeClusterLabels: !!it.gt,
    })
    const ms = performance.now() - t
    results.set(m, r)
    rec.calibration = r.calibration
    const mr: MethodRecord = {
      method: m,
      count: r.suggestions.length,
      reviewSuggestions: r.suggestions.filter((s) => s.status === 'review').length,
      clusters: r.clusters.length,
      reviewClusters: r.clusters.filter((c) => c.status === 'review').length,
      tooLarge: r.clusters.filter((c) => c.status === 'too-large').length,
      ms: Math.round(ms),
      timings: Object.fromEntries(Object.entries(r.timingsMs).map(([k, v]) => [k, Math.round(v)])),
      peakRasterMB: Math.round(r.peakRasterBytes / 1e5) / 10,
    }
    if (it.gt) mr.gt = gtMetrics(it.gt, s1.existing, r)
    rec.methods.push(mr)
    if (overlays) {
      const title = `${it.name} · ${m} · ${r.suggestions.length} suggested · ${r.calibration.summary}`
      await renderOverlay(it.bytes, size, r, join(outDir, `${stem(it.name)}-${m}.jpg`), { title, gt: it.gt?.points })
      if (m === 'fitter') {
        const big = r.clusters.slice().sort((a, b) => b.area - a.area)[0]
        if (big) {
          const pad = 0.15 * Math.max(big.bbox[2], big.bbox[3])
          const crop: [number, number, number, number] = [
            Math.max(0, big.bbox[0] - pad),
            Math.max(0, big.bbox[1] - pad),
            Math.min(size.width, big.bbox[0] + big.bbox[2] + pad) - Math.max(0, big.bbox[0] - pad),
            Math.min(size.height, big.bbox[1] + big.bbox[3] + pad) - Math.max(0, big.bbox[1] - pad),
          ]
          await renderOverlay(it.bytes, size, r, join(outDir, `${stem(it.name)}-${m}-zoom.jpg`), { crop, longSide: 1400, gt: it.gt?.points })
        }
      }
    }
  }
  // inter-method agreement (no GT needed): F1 of matching at the typical radius
  const rMatch = rec.calibration.prior?.rMedian ?? 0.004 * Math.max(size.width, size.height)
  for (let a = 0; a < methods.length; a++)
    for (let b = a + 1; b < methods.length; b++) {
      const A = results.get(methods[a])!.suggestions
      const B = results.get(methods[b])!.suggestions
      const m = matchPoints(A, B, rMatch)
      rec.agreement[`${methods[a]}~${methods[b]}`] = round2(prf(m.tp, m.fp, m.fn).f1)
    }
  // seed-selection sensitivity
  const pool = plan.local.length ? plan.local : plan.remote?.pts ?? []
  if (resampleN > 0 && pool.length >= 2) {
    const k = Number(args['resample-k'] ?? Math.min(4, pool.length))
    const out: Record<string, unknown> = { k, runs: resampleN }
    for (const m of methods) {
      const counts: number[] = []
      const f1s: number[] = []
      for (let i = 0; i < resampleN; i++) {
        const rr = rng(1000 + i)
        const sub = sample(pool, k, rr)
        const sp: SeedPlan = plan.local.length ? { local: sub, source: 'resample' } : { local: [], remote: { item: plan.remote!.item, pts: sub }, source: 'resample' }
        const sd = await buildSeeds(it, sp, dec.scale, rr)
        const r = await detect({ image: dec.image, scale: dec.scale, originalWidth: size.width, originalHeight: size.height, imageId: it.name, targetGroupId: 'target', seeds: sd.seeds, existing: sd.existing, settings: { method: m, sensitivity } })
        counts.push(r.suggestions.length + sd.existing.length)
        if (it.gt) f1s.push((gtMetrics(it.gt, sd.existing, r).f1 as number) ?? NaN)
      }
      out[m] = { totalCount: roundAll(spread(counts)), ...(f1s.length ? { f1: roundAll(spread(f1s)) } : {}) }
    }
    rec.resample = out
  }
  records.push(rec)
  const line = rec.methods.map((m) => `${m.method}=${m.count} (${m.ms} ms)`).join('  ')
  console.log(`${it.name}: ${rec.calibration.summary}; scale ${rec.scale}; ${line}`)
}

// ---------------------------------------------------------------- GT metrics
function gtMetrics(gt: GtImage, existing: ExistingAnnotation[], r: DetectResult): Record<string, unknown> {
  // GT points that coincide with seeds/existing are not scored (they were given to the detector)
  const rTyp = r.calibration.prior?.rMedian ?? median(gt.points.map((p) => p.r ?? NaN).filter(Number.isFinite)) ?? 20
  const given = matchPoints(existing, gt.points, 0.5 * rTyp)
  const givenGt = new Set(given.pairs.map((p) => p[1]))
  const gtPts = gt.points.filter((_, j) => !givenGt.has(j))
  const pred = r.suggestions
  const out: Record<string, unknown> = { gt: gtPts.length, pred: pred.length, countError: pred.length - gtPts.length, matchRadiusPx: round2(rTyp) }
  for (const f of [0.6, 1.0, 2.0]) {
    // radius = f × 0.5 × typical diameter = f × typical radius
    const m = matchPoints(pred, gtPts, f * rTyp)
    const p = prf(m.tp, m.fp, m.fn)
    out[`d${f}`] = { tp: m.tp, fp: m.fp, fn: m.fn, ...roundAll(p) }
    if (f === 1.0) {
      Object.assign(out, roundAll(p))
      out.centreErrorPx = roundAll(centreError(m))
      out.duplicateRate = round2(duplicateRate(pred, gtPts, m, rTyp))
    }
  }
  if (r.clusterLabels) {
    const L = r.clusterLabels
    const lab = (p: Pt) => {
      const x = Math.floor(p.x * L.scale)
      const y = Math.floor(p.y * L.scale)
      return x >= 0 && y >= 0 && x < L.width && y < L.height ? L.labels[y * L.width + x] : 0
    }
    const predLabel = pred.map((s) => (s.clusterId.startsWith('c') ? Number(s.clusterId.slice(1)) : 0))
    // existing colonies count towards their cluster on both sides
    out.perCluster = perClusterCountError(gtPts.map(lab), predLabel)
  }
  return out
}

// ---------------------------------------------------------------- report
const report = { createdAt: new Date().toISOString(), args, methods, sensitivity, maxRssMB: Math.round(process.resourceUsage().maxRSS / 1024), images: records }
writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 1))
writeFileSync(join(outDir, 'report.md'), markdown(records))
console.log(`\nWrote ${join(outDir, 'report.md')}`)

function markdown(rs: ImageRecord[]): string {
  const L: string[] = []
  L.push(`# Detection evaluation`, '', `Seeds: \`${seedSpec}\`${jitter ? `, jitter ${jitter} px` : ''}; sensitivity ${sensitivity}; methods ${methods.join(', ')}.`, '')
  L.push(`| image | seeds (usable) | r̃ px | scale | ${methods.map((m) => `${m} n`).join(' | ')} | fitter review cl. | ${methods.map((m) => `${m} ms`).join(' | ')} | agreement F1 |`)
  L.push(`|${'---|'.repeat(5 + 2 * methods.length + 1)}`)
  for (const r of rs) {
    const by = (m: DetectMethod) => r.methods.find((x) => x.method === m)
    L.push(
      `| ${r.name} | ${r.calibration.nTotal} (${r.calibration.nUsable}) | ${r.calibration.prior ? r.calibration.prior.rMedian.toFixed(1) : '–'} | ${r.scale} | ${methods.map((m) => by(m)?.count ?? '–').join(' | ')} | ${by('fitter')?.reviewClusters ?? '–'} | ${methods.map((m) => by(m)?.ms ?? '–').join(' | ')} | ${Object.entries(r.agreement).map(([k, v]) => `${k} ${v}`).join(', ')} |`,
    )
  }
  if (rs.some((r) => r.methods.some((m) => m.gt))) {
    L.push('', '## Ground truth', '', '| image | method | GT | pred | P | R | F1 | count err | centre err (median px) | dup rate |', '|---|---|---|---|---|---|---|---|---|---|')
    for (const r of rs)
      for (const m of r.methods) {
        const g = m.gt as Record<string, any> | undefined
        if (!g) continue
        L.push(`| ${r.name} | ${m.method} | ${g.gt} | ${g.pred} | ${g.precision} | ${g.recall} | ${g.f1} | ${g.countError} | ${g.centreErrorPx?.median ?? '–'} | ${g.duplicateRate} |`)
      }
  }
  if (rs.some((r) => r.resample)) {
    L.push('', '## Seed-selection sensitivity', '', '| image | method | total count mean ± sd (min–max) | F1 mean ± sd |', '|---|---|---|---|')
    for (const r of rs) {
      if (!r.resample) continue
      for (const m of methods) {
        const x = r.resample[m] as { totalCount: ReturnType<typeof spread>; f1?: ReturnType<typeof spread> } | undefined
        if (!x) continue
        L.push(`| ${r.name} | ${m} | ${x.totalCount.mean} ± ${x.totalCount.sd} (${x.totalCount.min}–${x.totalCount.max}) | ${x.f1 ? `${x.f1.mean} ± ${x.f1.sd}` : '–'} |`)
      }
    }
  }
  L.push('', `Peak process RSS: ${report.maxRssMB} MB (node, includes sharp/libvips decode).`)
  return L.join('\n') + '\n'
}

function stem(n: string): string {
  return basename(n).replace(/\..*$/, '')
}
function round2(v: number): number {
  return Math.round(v * 100) / 100
}
function roundAll<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, round2(v as number)])) as T
}
function median(xs: number[]): number | undefined {
  if (!xs.length) return undefined
  const a = xs.slice().sort((p, q) => p - q)
  return a[Math.floor(a.length / 2)]
}
