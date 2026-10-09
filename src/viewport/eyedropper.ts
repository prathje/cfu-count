/**
 * Eyedropper for the centre-contrast view: reads ORIGINAL image pixels (never
 * the display-adjusted copies) around an image-px point through a scratch
 * canvas, then uses the pure helpers in centre-contrast.ts.
 */
import { estimateRim, patchMean, type Rgb } from './centre-contrast'
import type { ImageSourceLike } from './render'

/** Patch half-size in image px (7×7 at full resolution). */
export const PICK_PATCH_RADIUS = 3
/** Half-size of the window searched for the colony edge, in image px. */
export const PICK_WINDOW_RADIUS = 320
/** The window is read at most this many px across (larger windows are downsampled). */
const WINDOW_MAX_PX = 400

export interface CentrePick {
  centre: Rgb
  /** Estimated rest-of-the-disc colour (falls back to the window's mean colour). */
  rim: Rgb
  /** Estimated colony radius in image px; null when no edge was found. */
  radius: number | null
}

function sourceWidth(s: ImageSourceLike): number {
  return typeof HTMLImageElement !== 'undefined' && s instanceof HTMLImageElement ? s.naturalWidth : s.width
}
function sourceHeight(s: ImageSourceLike): number {
  return typeof HTMLImageElement !== 'undefined' && s instanceof HTMLImageElement ? s.naturalHeight : s.height
}

/** Pixels of the image-px square [x ± half] (clipped), downsampled to at most WINDOW_MAX_PX across. */
function readWindow(source: ImageSourceLike, imageWidth: number, x: number, y: number, half: number) {
  const s = sourceWidth(source) / imageWidth // source px per image px
  const sw = sourceWidth(source)
  const sh = sourceHeight(source)
  const sx0 = Math.max(0, Math.floor((x - half) * s))
  const sy0 = Math.max(0, Math.floor((y - half) * s))
  const sx1 = Math.min(sw, Math.ceil((x + half) * s))
  const sy1 = Math.min(sh, Math.ceil((y + half) * s))
  if (sx1 <= sx0 || sy1 <= sy0) return null
  const k = Math.min(1, WINDOW_MAX_PX / Math.max(sx1 - sx0, sy1 - sy0)) // window px per source px
  const w = Math.max(1, Math.round((sx1 - sx0) * k))
  const h = Math.max(1, Math.round((sy1 - sy0) * k))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  try {
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(source, sx0, sy0, sx1 - sx0, sy1 - sy0, 0, 0, w, h)
    const data = ctx.getImageData(0, 0, w, h).data
    const perImage = s * ((w / (sx1 - sx0) + h / (sy1 - sy0)) / 2) // window px per image px
    return { data, w, h, cx: (x * s - sx0) * (w / (sx1 - sx0)), cy: (y * s - sy0) * (h / (sy1 - sy0)), perImage }
  } finally {
    canvas.width = canvas.height = 0
  }
}

/** Mean colour of a small patch at image point (x, y). */
export function sampleColour(source: ImageSourceLike, imageWidth: number, x: number, y: number): Rgb | null {
  const win = readWindow(source, imageWidth, x, y, PICK_PATCH_RADIUS + 1)
  if (!win) return null
  return patchMean(win.data, win.w, win.h, win.cx, win.cy, Math.max(0, Math.round(PICK_PATCH_RADIUS * win.perImage)))
}

/** Centre colour at (x, y) plus an automatic rim estimate from the colony around it. */
export function sampleCentre(source: ImageSourceLike, imageWidth: number, x: number, y: number): CentrePick | null {
  const centre = sampleColour(source, imageWidth, x, y)
  if (!centre) return null
  const win = readWindow(source, imageWidth, x, y, PICK_WINDOW_RADIUS)
  if (!win) return { centre, rim: centre, radius: null }
  const est = estimateRim(win.data, win.w, win.h, win.cx, win.cy, centre)
  if (est) return { centre, rim: est.rim, radius: est.radius / win.perImage }
  const mean = patchMean(win.data, win.w, win.h, win.w / 2, win.h / 2, Math.max(win.w, win.h)) ?? centre
  return { centre, rim: mean, radius: null }
}
