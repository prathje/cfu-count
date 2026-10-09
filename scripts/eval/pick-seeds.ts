/**
 * Helper for creating AGENT-PICKED seed files (not ground truth).
 *
 *   node scripts/eval/pick-seeds.ts <image> [--out .eval-out/pick] [--n 60]
 *
 * Runs the LoG detector without seeds (generic size guess) and renders the
 * strongest candidates with numbers onto an overview of the plate. A person
 * (or agent) then looks at the picture and writes the numbers of a few clear,
 * isolated colonies into a seeds JSON (see scripts/eval/seeds.ts for the
 * format); `--print 3,7,12` prints those candidates' coordinates.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import sharp from 'sharp'
import { detect } from '../../src/detection/index.ts'
import { decodeForAnalysis } from './decode.ts'
import { parseArgs } from './args.ts'

const args = parseArgs(process.argv.slice(2))
const image = args._[0]
if (!image) {
  console.error('usage: node scripts/eval/pick-seeds.ts <image> [--out dir] [--n 60] [--print 1,2,3]')
  process.exit(1)
}
const outDir = String(args.out ?? '.eval-out/pick')
mkdirSync(outDir, { recursive: true })
const dec = await decodeForAnalysis(image)
const res = await detect({
  image: dec.image,
  scale: dec.scale,
  originalWidth: dec.originalWidth,
  originalHeight: dec.originalHeight,
  imageId: 'pick',
  targetGroupId: 'pick',
  seeds: [],
  existing: [],
  settings: { method: 'log', sensitivity: 0.8 },
})
const n = Number(args.n ?? 60)
const cands = res.suggestions
  .slice()
  .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
  .slice(0, n)
  .sort((a, b) => a.y - b.y || a.x - b.x)
if (args.print) {
  const ids = String(args.print).split(',').map(Number)
  console.log(JSON.stringify(ids.map((i) => ({ x: Math.round(cands[i - 1].x), y: Math.round(cands[i - 1].y) }))))
  process.exit(0)
}
// overview of the ROI bounding box with numbered candidates
const xs = res.roi.outline.map((p) => p.x)
const ys = res.roi.outline.map((p) => p.y)
const bx = Math.max(0, Math.min(...xs))
const by = Math.max(0, Math.min(...ys))
const bw = Math.min(dec.originalWidth - bx, Math.max(...xs) - bx)
const bh = Math.min(dec.originalHeight - by, Math.max(...ys) - by)
const long = 1500
const k = long / Math.max(bw, bh)
const W = Math.round(bw * k)
const H = Math.round(bh * k)
const svg = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">`]
cands.forEach((c, i) => {
  const x = (c.x - bx) * k
  const y = (c.y - by) * k
  svg.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${Math.max(3, c.r * k).toFixed(1)}" fill="none" stroke="#ff00ff" stroke-width="1.5"/>`)
  svg.push(`<text x="${(x + c.r * k + 2).toFixed(1)}" y="${(y + 4).toFixed(1)}" font-family="Helvetica" font-size="13" fill="#ffff00" stroke="#000" stroke-width="0.4">${i + 1}</text>`)
})
svg.push('</svg>')
const out = join(outDir, basename(image).replace(/\..*$/, '') + '-candidates.jpg')
await sharp(image)
  .rotate()
  .extract({ left: Math.round(bx), top: Math.round(by), width: Math.round(bw), height: Math.round(bh) })
  .resize(W, H, { fit: 'fill' })
  .composite([{ input: Buffer.from(svg.join('')), top: 0, left: 0 }])
  .jpeg({ quality: 85 })
  .toFile(out)
writeFileSync(out.replace(/\.jpg$/, '.json'), JSON.stringify(cands.map((c, i) => ({ n: i + 1, x: Math.round(c.x), y: Math.round(c.y), r: Math.round(c.r) }))))
console.log(out)
