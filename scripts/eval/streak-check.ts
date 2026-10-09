/**
 * Seed-calibration check on the two plates with the product owner's region
 * counts (docs/research/detection-results.md, "Reference counts"). Node only;
 * needs the local test images (never committed).
 *
 *   node scripts/eval/streak-check.ts [--images test_images] [--out .eval-out/streak-check]
 *
 * Runs scripts/eval/run.ts (the real worker path) per case and checks:
 *  - every seed inside the streak gets a radius (no "0 usable", no seed
 *    measuring the whole streak: radius < 3 × the median seed radius);
 *  - the count inside the owner's region (suggestions + seeds) is within
 *    `tol` of the owner's count. The tolerance is loose on purpose: the owner's
 *    counts are approximate region totals, not per-colony ground truth.
 * Exits 1 if a check fails. Writes zoomed overlays of each region to --out.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from './args.ts'

const args = parseArgs(process.argv.slice(2))
const images = String(args.images ?? 'test_images')
const out = String(args.out ?? join('.eval-out', 'streak-check'))

interface Case {
  name: string
  only: string
  seeds: string
  /** Owner's region, original px [x, y, w, h] (1250: our reading of "upper-left streak/area"). */
  box: [number, number, number, number]
  owner: number
  /** Allowed relative deviation of the region count from the owner's count; null = report only. */
  tol: number | null
}

const cases: Case[] = [
  { name: '1247 streak seeds', only: '1247', seeds: 'scripts/eval/streak-seeds.json', box: [1960, 500, 1020, 1400], owner: 170, tol: 0.25 },
  // seeds only on large isolated colonies: nothing tells the detector that the streak's colonies are
  // smaller (automatic local sizes proved unreliable); report only, see detection-results.md §SC
  { name: '1247 isolated seeds', only: '1247', seeds: 'scripts/eval/isolated-seeds-1247.json', box: [1960, 500, 1020, 1400], owner: 170, tol: null },
  { name: '1250 agent seeds (isolated)', only: '1250', seeds: 'scripts/eval/agent-seeds.json', box: [2050, 350, 1100, 1700], owner: 136, tol: null },
  { name: '1250 streak seeds', only: '1250', seeds: 'scripts/eval/streak-seeds.json', box: [2050, 350, 1100, 1700], owner: 136, tol: 0.25 },
]

let failed = 0
const rows: string[] = ['| case | usable seeds | seed radii px | region count (owner) | plate total | in review | check |', '|---|---|---|---|---|---|---|']
for (const [i, c] of cases.entries()) {
  const dir = join(out, `case${i}`)
  const r = spawnSync(process.execPath, ['scripts/eval/run.ts', '--images', images, '--only', c.only, '--seeds', c.seeds, '--methods', 'fitter', '--count-box', c.box.join(','), '--out', dir], { encoding: 'utf8' })
  if (r.status !== 0) {
    console.error(r.stderr)
    process.exit(2)
  }
  const rep = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'))
  const img = rep.images[0]
  const m = img.methods[0]
  const box = m.boxes[0]
  const seeds = img.calibration.seeds as { radiusPx: number | null; x: number; y: number }[]
  const inBox = seeds.filter((s) => s.x >= c.box[0] && s.y >= c.box[1] && s.x < c.box[0] + c.box[2] && s.y < c.box[1] + c.box[3])
  const radii = inBox.map((s) => s.radiusPx).filter((v): v is number => v !== null)
  const med = radii.length ? radii.slice().sort((a, b) => a - b)[Math.floor(radii.length / 2)] : NaN
  const problems: string[] = []
  if (inBox.length && radii.length < inBox.length) problems.push('a seed in the streak has no radius')
  if (radii.some((v) => v > 3 * med)) problems.push('a seed measured the streak, not its colony')
  const dev = (box.total - c.owner) / c.owner
  if (c.tol !== null && Math.abs(dev) > c.tol) problems.push(`region count ${box.total} is ${Math.round(dev * 100)} % off the owner's ${c.owner}`)
  if (c.tol !== null && img.calibration.nUsable < 2) problems.push('fewer than 2 usable seeds')
  failed += problems.length ? 1 : 0
  rows.push(
    `| ${c.name} | ${img.calibration.nUsable}/${img.calibration.nTotal} | ${radii.map((v) => Math.round(v)).join(', ') || '–'} | ${box.total} (${c.owner}, ${dev >= 0 ? '+' : ''}${Math.round(dev * 100)} %) | ${m.count + img.seeds} | ${Math.round(m.review.share * 100)} % | ${problems.length ? 'FAIL: ' + problems.join('; ') : c.tol === null ? 'report only' : 'ok'} |`,
  )
}
console.log(rows.join('\n'))
console.log(`\nOverlays: ${out}/case*/*-box0.jpg`)
process.exit(failed ? 1 : 0)
