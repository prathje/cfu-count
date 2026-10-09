/**
 * Canvas 2D drawing for the two viewport layers. Pure functions of their inputs
 * (plus the canvas context): no DOM queries, no state.
 */
import type { Annotation, AnnotationGroup, ID } from '../model/types'
import type { ViewState } from './api'
import type { Size } from './transform'
import { OccupancyGrid, markerBox, placeLabel } from './label-layout'
import { displayRadius } from './marker-size'

// ---------------------------------------------------------------------------
// Backing store sizing
// ---------------------------------------------------------------------------

/**
 * Per-layer backing-store cap in device pixels. iOS Safari limited a single
 * canvas to 16,777,216 px (4096 x 4096) until WebKit raised it to 8192 x 8192
 * (2024), and older iOS also capped TOTAL canvas memory per page (the "Total
 * canvas memory use exceeds the maximum limit" error); newer WebKit removed that
 * cap, so exceeding memory now risks the tab being killed instead. See
 * docs/research/input-interactions.md. Two full-screen layers on a 13" iPad Pro
 * at DPR 2 are ~5.7 MP each, under this cap; larger desktop windows get a
 * reduced effective DPR instead of a huge buffer.
 */
export const MAX_LAYER_PIXELS = 8 * 1024 * 1024
export const MAX_DPR = 3

export function effectiveDpr(cssSize: Size, deviceDpr: number): number {
  const dpr = Math.min(MAX_DPR, Math.max(1, deviceDpr || 1))
  const area = Math.max(1, cssSize.width * cssSize.height)
  return Math.min(dpr, Math.sqrt(MAX_LAYER_PIXELS / area))
}

// ---------------------------------------------------------------------------
// Image layer
// ---------------------------------------------------------------------------

/** Anything drawImage accepts that also knows its pixel size. */
export type ImageSourceLike = CanvasImageSource & { width: number; height: number }

/** One mipmap level of the displayed image. */
export interface PyramidLevel {
  source: ImageSourceLike
  /** Level px per original image px (1, 0.5, 0.25, ...). */
  scale: number
}

/** Smallest level that still has at least `needed` level px per image px. */
export function pickLevel(levels: readonly PyramidLevel[], needed: number): PyramidLevel {
  let best = levels[0]
  for (const l of levels) if (l.scale >= needed && l.scale < best.scale) best = l
  return best
}

/** Above this many screen CSS px per image px, show crisp pixels (no smoothing). */
export const PIXELATED_ABOVE_SCALE = 4

export function drawImageLayer(
  ctx: CanvasRenderingContext2D,
  levels: readonly PyramidLevel[],
  imageSize: Size,
  view: ViewState,
  viewport: Size,
  dpr: number,
) {
  const canvas = ctx.canvas
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  if (levels.length === 0) return

  const level = pickLevel(levels, view.scale * dpr)
  // Visible part of the image, in image px, clipped to the image.
  const x0 = Math.max(0, Math.floor(view.offsetX))
  const y0 = Math.max(0, Math.floor(view.offsetY))
  const x1 = Math.min(imageSize.width, Math.ceil(view.offsetX + viewport.width / view.scale))
  const y1 = Math.min(imageSize.height, Math.ceil(view.offsetY + viewport.height / view.scale))
  if (x1 <= x0 || y1 <= y0) return

  const k = view.scale * dpr
  ctx.setTransform(k, 0, 0, k, -view.offsetX * k, -view.offsetY * k)
  ctx.imageSmoothingEnabled = view.scale < PIXELATED_ABOVE_SCALE
  ctx.imageSmoothingQuality = 'high'
  const ls = level.scale
  // Clamp the source rect to the level's actual pixel size (rounding of odd sizes).
  const sx = x0 * ls
  const sy = y0 * ls
  const sw = Math.min(level.source.width - sx, (x1 - x0) * ls)
  const sh = Math.min(level.source.height - sy, (y1 - y0) * ls)
  if (sw <= 0 || sh <= 0) return
  ctx.drawImage(level.source, sx, sy, sw, sh, x0, y0, sw / ls, sh / ls)
}

/**
 * Build a halving mipmap pyramid for large images (long side > 2048 px) so low
 * zoom levels draw from a small bitmap instead of resampling 12-24 MP every
 * frame. Each level is produced from the previous one at half size with
 * high-quality smoothing (repeated halving avoids aliasing), converted to an
 * ImageBitmap and its scratch canvas released immediately to keep Safari's
 * canvas memory total low. Total extra memory is ~1/3 of the original.
 */
export async function buildPyramid(
  source: ImageSourceLike,
  signal: { aborted: boolean },
): Promise<PyramidLevel[]> {
  const levels: PyramidLevel[] = [{ source, scale: 1 }]
  const long = Math.max(source.width, source.height)
  if (long <= 2048 || typeof createImageBitmap !== 'function') return levels
  let prev: ImageSourceLike = source
  let scale = 1
  while (Math.max(prev.width, prev.height) > 1024) {
    await new Promise((r) => setTimeout(r, 0)) // yield to input/rendering between levels
    if (signal.aborted) break
    scale /= 2
    const w = Math.max(1, Math.round(source.width * scale))
    const h = Math.max(1, Math.round(source.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const c = canvas.getContext('2d')
    if (!c) break
    c.imageSmoothingEnabled = true
    c.imageSmoothingQuality = 'high'
    c.drawImage(prev, 0, 0, w, h)
    let bitmap: ImageBitmap
    try {
      bitmap = await createImageBitmap(canvas)
    } catch {
      break
    } finally {
      canvas.width = 0
      canvas.height = 0
    }
    if (signal.aborted) {
      bitmap.close()
      break
    }
    // ImageBitmap is in level pixels; scale is the exact ratio used above.
    levels.push({ source: bitmap, scale: w / source.width })
    prev = bitmap
  }
  return levels
}

export function disposePyramid(levels: readonly PyramidLevel[]) {
  for (let i = 1; i < levels.length; i++) {
    const s = levels[i].source
    if (typeof ImageBitmap !== 'undefined' && s instanceof ImageBitmap) s.close()
  }
}

// ---------------------------------------------------------------------------
// Annotation layer
// ---------------------------------------------------------------------------

/** Relative luminance (0..1) of a #rgb / #rrggbb colour; 0.5 if unparsable. */
export function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return 0.5
  let h = m[1]
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const ch = [0, 2, 4].map((i) => {
    const v = parseInt(h.slice(i, i + 2), 16) / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2]
}

/** Outline colour that contrasts with the marker colour (dark for light colours, white for dark). */
export function contrastOutline(hex: string): string {
  return luminance(hex) > 0.4 ? 'rgba(0,0,0,0.8)' : 'rgba(255,255,255,0.92)'
}

/** A pre-rendered marker bitmap at device resolution. */
export interface MarkerSprite {
  canvas: CanvasImageSource
  /** Width/height in CSS px. */
  cssSize: number
  /** Width/height of the bitmap in device px (ceil(cssSize * dpr)). */
  devicePx: number
}

const spriteCache = new Map<string, MarkerSprite>()
const SPRITE_CACHE_MAX = 64

function makeCanvas(w: number, h: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h)
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

/**
 * Marker bitmap for a group style: dot = colour fill + thin contrasting outline;
 * circle = colour ring over a slightly wider contrasting ring. The contrasting
 * outline keeps markers legible on both light agar and dark plates. The active
 * group gets a slightly heavier outline. Opacity is applied at draw time.
 */
export function markerSprite(
  g: Pick<AnnotationGroup, 'color' | 'render' | 'size'>,
  active: boolean,
  dpr: number,
): MarkerSprite {
  const key = `${g.color}|${g.render}|${g.size}|${active ? 1 : 0}|${dpr}`
  const hit = spriteCache.get(key)
  if (hit) return hit
  const r = Math.max(1, g.size)
  const outline = contrastOutline(g.color)
  const ring = Math.max(1.5, Math.min(3, r * 0.3))
  const outer = g.render === 'dot' ? (active ? 1.5 : 1) : ring + (active ? 2.5 : 2)
  const cssSize = Math.ceil(2 * r + outer + 2)
  const px = Math.max(1, Math.ceil(cssSize * dpr))
  const canvas = makeCanvas(px, px)
  const c = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
  if (c) {
    // Draw centred in the device-pixel bitmap so integer blits stay centred.
    c.setTransform(dpr, 0, 0, dpr, 0, 0)
    c.beginPath()
    c.arc(px / 2 / dpr, px / 2 / dpr, r, 0, Math.PI * 2)
    if (g.render === 'dot') {
      c.fillStyle = g.color
      c.fill()
      c.strokeStyle = outline
      c.lineWidth = outer
      c.stroke()
    } else {
      c.strokeStyle = outline
      c.lineWidth = outer
      c.stroke()
      c.strokeStyle = g.color
      c.lineWidth = ring
      c.stroke()
    }
  }
  if (spriteCache.size >= SPRITE_CACHE_MAX) spriteCache.clear()
  const sprite = { canvas, cssSize, devicePx: px }
  spriteCache.set(key, sprite)
  return sprite
}

/** Label font size bounds (CSS px). */
export const LABEL_SIZE_MIN = 8
export const LABEL_SIZE_MAX = 32
export const LABEL_SIZE_DEFAULT = 12

/** Clamp a group's labelSize (missing/invalid -> default). */
export function labelFontPx(labelSize: number | undefined): number {
  if (typeof labelSize !== 'number' || !Number.isFinite(labelSize)) return LABEL_SIZE_DEFAULT
  return Math.min(LABEL_SIZE_MAX, Math.max(LABEL_SIZE_MIN, labelSize))
}

export function labelFont(px: number): string {
  return `600 ${px}px system-ui, -apple-system, "Segoe UI", sans-serif`
}

/** Counts from one annotation-layer draw (for diagnostics). */
export interface AnnotationDrawStats {
  drawn: number
  labels: number
}

/** Approximate label box width for an n-digit number (tabular digits), cached per font size. */
const digitWidth = new Map<number, number>()
function labelWidth(ctx: CanvasRenderingContext2D, fontPx: number, digits: number): number {
  let w = digitWidth.get(fontPx)
  if (w === undefined) {
    w = ctx.measureText('0000000000').width / 10 || fontPx * 0.62
    digitWidth.set(fontPx, w)
  }
  return w * digits
}

/**
 * Draw all visible markers, then their number labels. Groups are drawn in display
 * order with the active group last (on top, slightly heavier outline). Markers are
 * cached sprites blitted per point. Labels go on top of every marker and are placed
 * around their marker to avoid other markers and labels (label-layout.ts). The
 * displayed radius follows displayRadius() (shrinks only when zoomed far out).
 */
export function drawAnnotationLayer(
  ctx: CanvasRenderingContext2D,
  annotations: readonly Annotation[],
  groups: readonly AnnotationGroup[],
  activeGroupId: ID | null,
  view: ViewState,
  viewport: Size,
  dpr: number,
): AnnotationDrawStats {
  const canvas = ctx.canvas
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  const stats: AnnotationDrawStats = { drawn: 0, labels: 0 }

  // Bucket screen positions per visible group, keeping per-group sequence numbers.
  const buckets = new Map<ID, { xs: number[]; ys: number[]; seq: number[] }>()
  const counters = new Map<ID, number>()
  const byId = new Map<ID, AnnotationGroup>()
  for (const g of groups) {
    byId.set(g.id, g)
    if (!g.hidden) buckets.set(g.id, { xs: [], ys: [], seq: [] })
  }
  const { scale, offsetX, offsetY } = view
  const margin = 80 // marker radius + label extent, CSS px
  const maxX = viewport.width + margin
  const maxY = viewport.height + margin
  for (let i = 0; i < annotations.length; i++) {
    const a = annotations[i]
    const n = (counters.get(a.groupId) ?? 0) + 1
    counters.set(a.groupId, n)
    const b = buckets.get(a.groupId)
    if (!b) continue
    const sx = (a.x - offsetX) * scale
    const sy = (a.y - offsetY) * scale
    if (sx < -margin || sy < -margin || sx > maxX || sy > maxY) continue
    b.xs.push(sx)
    b.ys.push(sy)
    b.seq.push(n)
  }

  const order = groups.filter((g) => !g.hidden && g.id !== activeGroupId)
  const active = activeGroupId ? byId.get(activeGroupId) : undefined
  if (active && !active.hidden) order.push(active)
  const anyLabels = order.some((g) => g.labels && buckets.get(g.id)!.xs.length > 0)
  const grid = anyLabels ? new OccupancyGrid() : null

  // Pass 1: markers.
  ctx.lineJoin = 'round'
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  for (const g of order) {
    const b = buckets.get(g.id)!
    const count = b.xs.length
    if (count === 0) continue
    stats.drawn += count
    const r = displayRadius(Math.max(1, g.size), scale)
    ctx.globalAlpha = Math.max(0, Math.min(1, g.opacity))
    // One cached sprite per style; drawImage per marker. A single path with
    // thousands of arc sub-paths is cheap to record but expensive to rasterise
    // (measured in headless Chrome), while sprite blits stay O(n) and tiny.
    // Blit unscaled at whole device pixels (identity transform, 3-argument
    // drawImage): ~3x cheaper per call than scaled blits in Chrome. Snapping
    // moves a marker by at most half a device pixel.
    const sprite = markerSprite({ color: g.color, render: g.render, size: r }, g.id === activeGroupId, dpr)
    const halfPx = sprite.devicePx / 2
    for (let i = 0; i < count; i++) {
      ctx.drawImage(sprite.canvas, Math.round(b.xs[i] * dpr - halfPx), Math.round(b.ys[i] * dpr - halfPx))
      if (grid) grid.add(markerBox(b.xs[i], b.ys[i], r))
    }
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

  // Pass 2: labels, above every marker, placed to avoid markers and each other.
  if (grid) {
    ctx.globalAlpha = 1
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    ctx.strokeStyle = 'rgba(0,0,0,0.85)'
    ctx.fillStyle = '#fff'
    for (const g of order) {
      if (!g.labels) continue
      const b = buckets.get(g.id)!
      const count = b.xs.length
      if (count === 0) continue
      const r = displayRadius(Math.max(1, g.size), scale)
      const fontPx = labelFontPx(g.labelSize)
      ctx.font = labelFont(fontPx)
      ctx.lineWidth = Math.max(2.5, fontPx * 0.25)
      const h = fontPx * 1.05
      for (let i = 0; i < count; i++) {
        const sx = b.xs[i]
        const sy = b.ys[i]
        if (sx < -margin || sy < -margin || sx > viewport.width || sy > viewport.height + margin) continue
        const text = String(b.seq[i])
        const box = placeLabel(grid, sx, sy, r, labelWidth(ctx, fontPx, text.length), h)
        const ty = box.y + h / 2
        ctx.strokeText(text, box.x, ty)
        ctx.fillText(text, box.x, ty)
        stats.labels++
      }
    }
  }
  ctx.globalAlpha = 1
  return stats
}
