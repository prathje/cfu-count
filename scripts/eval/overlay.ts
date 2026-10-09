/**
 * Overlay rendering for visual inspection (node only, writes PNG/JPEG into
 * .eval-out/). Draws the ROI outline, seeds with their estimated radius and
 * quality, suggestions (green = ok, orange = review), review clusters and
 * too-large regions, and optional ground-truth points.
 */
import sharp from 'sharp'
import type { DetectResult } from '../../src/detection/types.ts'

export interface OverlayOptions {
  /** Output long side in px (default 1600). */
  longSide?: number
  /** Restrict to an original-px window [x, y, w, h]. */
  crop?: [number, number, number, number]
  gt?: { x: number; y: number }[]
  title?: string
}

const QUALITY_COLOUR: Record<string, string> = { ok: '#00e5ff', touching: '#ffd400', edge: '#ff4dd2', glare: '#ff2020', weak: '#b0b0b0' }

export async function renderOverlay(imagePath: string | Buffer, original: { width: number; height: number }, result: DetectResult, outPath: string, opts: OverlayOptions = {}): Promise<void> {
  const [cx, cy, cw, ch] = opts.crop ?? [0, 0, original.width, original.height]
  const long = opts.longSide ?? 1600
  const k = long / Math.max(cw, ch)
  const W = Math.round(cw * k)
  const H = Math.round(ch * k)
  const X = (x: number) => ((x - cx) * k).toFixed(1)
  const Y = (y: number) => ((y - cy) * k).toFixed(1)
  const R = (r: number) => Math.max(1, r * k).toFixed(1)
  const sw = Math.max(1, Math.min(3, 1200 / long + k * 2)).toFixed(1)
  const parts: string[] = []
  // ROI outline
  if (result.roi.outline.length) parts.push(`<polygon points="${result.roi.outline.map((p) => `${X(p.x)},${Y(p.y)}`).join(' ')}" fill="none" stroke="#ffe600" stroke-width="${sw}" stroke-dasharray="8 6"/>`)
  // clusters needing attention
  for (const c of result.clusters) {
    if (c.status === 'ok') continue
    const col = c.status === 'too-large' ? '#ff2020' : '#ff00ff'
    parts.push(`<rect x="${X(c.bbox[0])}" y="${Y(c.bbox[1])}" width="${(c.bbox[2] * k).toFixed(1)}" height="${(c.bbox[3] * k).toFixed(1)}" fill="none" stroke="${col}" stroke-width="${sw}" stroke-dasharray="4 3"/>`)
  }
  for (const s of result.suggestions) {
    const col = s.status === 'ok' ? '#39ff14' : '#ff9900'
    parts.push(`<circle cx="${X(s.x)}" cy="${Y(s.y)}" r="${R(s.r)}" fill="none" stroke="${col}" stroke-width="${sw}"/>`)
    parts.push(`<circle cx="${X(s.x)}" cy="${Y(s.y)}" r="${Math.max(1, 1.2 * Number(sw)).toFixed(1)}" fill="${col}"/>`)
  }
  for (const g of opts.gt ?? []) parts.push(`<circle cx="${X(g.x)}" cy="${Y(g.y)}" r="${(2.5 * Number(sw)).toFixed(1)}" fill="#ffffff" stroke="#000" stroke-width="1"/>`)
  for (const s of result.calibration.seeds) {
    const col = QUALITY_COLOUR[s.quality] ?? '#fff'
    const d = 6 * Number(sw)
    parts.push(`<path d="M${X(s.x)} ${(Number(Y(s.y)) - d).toFixed(1)}V${(Number(Y(s.y)) + d).toFixed(1)}M${(Number(X(s.x)) - d).toFixed(1)} ${Y(s.y)}H${(Number(X(s.x)) + d).toFixed(1)}" stroke="${col}" stroke-width="${sw}"/>`)
    if (s.radiusPx) parts.push(`<circle cx="${X(s.fitX)}" cy="${Y(s.fitY)}" r="${R(s.radiusPx)}" fill="none" stroke="${col}" stroke-width="${sw}" stroke-dasharray="3 2"/>`)
  }
  if (opts.title) parts.push(`<text x="10" y="28" font-family="Helvetica, Arial" font-size="22" fill="#fff" stroke="#000" stroke-width="0.6">${escapeXml(opts.title)}</text>`)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${parts.join('')}</svg>`
  const base = sharp(imagePath).rotate()
  const img = opts.crop ? base.extract({ left: Math.round(cx), top: Math.round(cy), width: Math.round(cw), height: Math.round(ch) }) : base
  await img
    .resize(W, H, { fit: 'fill' })
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 85 })
    .toFile(outPath)
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!)
}
