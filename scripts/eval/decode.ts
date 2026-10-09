/**
 * Node-only image decoding for the evaluation harness (sharp/libvips).
 * EXIF orientation is applied (`rotate()`), matching ImageRecord.width/height.
 * Never imported from src/ — sharp must not reach the browser bundle.
 */
import sharp from 'sharp'
import { chooseAnalysisScale } from '../../src/detection/scale.ts'
import type { RgbaImage } from '../../src/detection/types.ts'

export interface Decoded {
  image: RgbaImage
  scale: number
  originalWidth: number
  originalHeight: number
}

export async function originalSize(input: string | Buffer): Promise<{ width: number; height: number }> {
  const m = await sharp(input).rotate().metadata()
  // metadata() reports pre-rotation size; autoOrient swaps for orientations 5–8
  const swap = (m.orientation ?? 1) >= 5
  return { width: swap ? m.height! : m.width!, height: swap ? m.width! : m.height! }
}

/** Decode at `scale` (analysis px per original px) to RGBA. */
export async function decodeAt(input: string | Buffer, scale: number): Promise<Decoded> {
  const { width, height } = await originalSize(input)
  const W = Math.max(1, Math.round(width * scale))
  const H = Math.max(1, Math.round(height * scale))
  const { data, info } = await sharp(input).rotate().resize(W, H, { kernel: 'linear', fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return {
    image: { width: info.width, height: info.height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length) },
    scale: info.width / width,
    originalWidth: width,
    originalHeight: height,
  }
}

/** Decode with the app's preliminary rule (long side 2048) or a given scale. */
export async function decodeForAnalysis(input: string | Buffer, opts: { scale?: number; minRadiusOriginal?: number } = {}): Promise<Decoded> {
  const size = await originalSize(input)
  const scale = opts.scale ?? chooseAnalysisScale({ ...size, minRadiusOriginal: opts.minRadiusOriginal }).scale
  return decodeAt(input, scale)
}

/** RGBA crop around an original-px point at a given scale (for cross-plate seed patches). */
export async function cropPatch(input: string | Buffer, cx: number, cy: number, halfOriginal: number, scale: number): Promise<{ image: RgbaImage; originX: number; originY: number; scale: number }> {
  const size = await originalSize(input)
  const x0 = Math.max(0, Math.round(cx - halfOriginal))
  const y0 = Math.max(0, Math.round(cy - halfOriginal))
  const x1 = Math.min(size.width, Math.round(cx + halfOriginal))
  const y1 = Math.min(size.height, Math.round(cy + halfOriginal))
  const W = Math.max(1, Math.round((x1 - x0) * scale))
  const H = Math.max(1, Math.round((y1 - y0) * scale))
  const { data, info } = await sharp(input)
    .rotate()
    .extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 })
    .resize(W, H, { kernel: 'linear', fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return { image: { width: info.width, height: info.height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length) }, originX: x0, originY: y0, scale: info.width / (x1 - x0) }
}
