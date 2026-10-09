/**
 * Worker-side request handling, independent of the global `self` so it can be
 * unit-tested with a fake decoder. One request runs at a time per worker; a
 * new request does not cancel the previous one (the client does that).
 *
 * Two-pass resolution (iPad-friendly): decode at the preliminary scale
 * (long side 2048), calibrate, then — if the seed-derived scale differs by
 * more than 15 % — decode again at that scale. Decoded images and prepared
 * planes are cached for the last image so slider re-runs are cheap.
 */
import { calibrate, DEFAULT_SETTINGS, detect, DetectionCancelled, DetectorCache } from './detect.ts'
import { prepareImage } from './features.ts'
import { chooseAnalysisScale } from './scale.ts'
import type { DetectRequest, FromWorker, ToWorker } from './protocol.ts'
import type { RgbaImage, SeedInput, SeedPatch } from './types.ts'

export interface Decoder {
  /** Decode `source` resized to w×h (oriented), returning RGBA. */
  decode(source: Blob | ImageBitmap, w: number, h: number): Promise<RgbaImage>
  /** Decode the crop (sx, sy, sw, sh) of an encoded image, resized to w×h. */
  crop(source: Blob, sx: number, sy: number, sw: number, sh: number, w: number, h: number): Promise<RgbaImage>
}

export function createWorkerHandler(decoder: Decoder, post: (m: FromWorker, transfer?: Transferable[]) => void) {
  const cache = new DetectorCache()
  const decoded = new Map<string, RgbaImage>()
  const running = new Map<number, AbortController>()

  async function imageAt(req: DetectRequest, scale: number): Promise<RgbaImage> {
    const src = req.source
    if (src.kind === 'rgba') return { width: src.width, height: src.height, data: src.data }
    const key = `${req.imageId}@${scale.toFixed(5)}`
    const hit = decoded.get(key)
    if (hit) return hit
    const w = Math.max(1, Math.round(req.originalWidth * scale))
    const h = Math.max(1, Math.round(req.originalHeight * scale))
    const img = await decoder.decode(src.kind === 'blob' ? src.blob : src.bitmap, w, h)
    decoded.clear() // keep only the latest image to bound memory
    decoded.set(key, img)
    return img
  }

  async function seedPatches(req: DetectRequest, scale: number): Promise<SeedInput[]> {
    const out: SeedInput[] = [...req.seeds]
    for (const s of req.remoteSeeds ?? []) {
      const blob = req.remoteSources?.[s.imageId]
      if (!blob) {
        out.push(s)
        continue
      }
      const half = 0.05 * Math.max(s.imageWidth, s.imageHeight)
      const x0 = Math.max(0, Math.round(s.x - half))
      const y0 = Math.max(0, Math.round(s.y - half))
      const x1 = Math.min(s.imageWidth, Math.round(s.x + half))
      const y1 = Math.min(s.imageHeight, Math.round(s.y + half))
      const w = Math.max(1, Math.round((x1 - x0) * scale))
      const h = Math.max(1, Math.round((y1 - y0) * scale))
      const image = await decoder.crop(blob, x0, y0, x1 - x0, y1 - y0, w, h)
      const patch: SeedPatch = { image, scale: w / (x1 - x0), originX: x0, originY: y0 }
      out.push({ ...s, patch })
    }
    return out
  }

  async function run(id: number, req: DetectRequest): Promise<void> {
    const ac = new AbortController()
    running.set(id, ac)
    try {
      const size = { width: req.originalWidth, height: req.originalHeight }
      let scale: number
      if (req.source.kind === 'rgba') scale = req.source.scale
      else if (req.analysis?.scale) scale = req.analysis.scale
      else {
        // pass 1: preliminary scale, calibration only
        scale = chooseAnalysisScale({ ...size, maxPixels: req.analysis?.maxPixels }).scale
        const img = await imageAt(req, scale)
        if (ac.signal.aborted) throw new DetectionCancelled()
        const settings = { ...DEFAULT_SETTINGS, ...req.settings }
        const prep = prepareImage(img, scale, req.roi, settings.edgeMarginFrac)
        const cal = calibrate(prep, { seeds: await seedPatches(req, scale), imageId: req.imageId }, settings)
        const prior = cal.report.prior
        if (prior) {
          const s2 = chooseAnalysisScale({
            ...size,
            minRadiusOriginal: prior.rRange[0],
            typicalRadiusOriginal: prior.rMedian,
            targetTypicalRadius: req.analysis?.targetTypicalRadius,
            maxPixels: req.analysis?.maxPixels,
          }).scale
          if (Math.abs(s2 - scale) / scale > 0.15) scale = s2
        }
      }
      const image = await imageAt(req, scale)
      const seeds = await seedPatches(req, scale)
      const { source: _s, remoteSeeds: _r, remoteSources: _rs, analysis: _a, ...rest } = req
      const result = await detect({ ...rest, image, scale, seeds }, (progress) => post({ type: 'progress', id, progress }), ac.signal, cache)
      post({ type: 'result', id, result }, result.clusterLabels ? [result.clusterLabels.labels.buffer as ArrayBuffer] : [])
    } catch (e) {
      if (e instanceof DetectionCancelled) post({ type: 'cancelled', id })
      else {
        const message = e instanceof Error ? e.message : String(e)
        const code = /memory|allocation|RangeError/i.test(message) || e instanceof RangeError ? 'out-of-memory' : /decode|image/i.test(message) ? 'decode-failed' : 'internal'
        post({ type: 'error', id, code, message })
      }
    } finally {
      running.delete(id)
    }
  }

  return function onMessage(msg: ToWorker): Promise<void> | void {
    if (msg.type === 'cancel') running.get(msg.id)?.abort()
    else if (msg.type === 'clear-cache') {
      cache.clear()
      decoded.clear()
    } else return run(msg.id, msg.request)
  }
}

/** Browser decoder: createImageBitmap resize (Safari ≥ 15) + OffscreenCanvas 2D (Safari ≥ 16.4). */
export const browserDecoder: Decoder = {
  async decode(source, w, h) {
    const bmp = await createImageBitmap(source, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high', imageOrientation: 'from-image' })
    return drawToRgba(bmp, w, h)
  },
  async crop(source, sx, sy, sw, sh, w, h) {
    const bmp = await createImageBitmap(source, sx, sy, sw, sh, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high', imageOrientation: 'from-image' })
    return drawToRgba(bmp, w, h)
  },
}

function drawToRgba(bmp: ImageBitmap, w: number, h: number): RgbaImage {
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('decode failed: no 2D context in worker')
  ctx.drawImage(bmp, 0, 0, w, h)
  const data = ctx.getImageData(0, 0, w, h)
  bmp.close()
  // release the canvas backing store early (Safari keeps it otherwise)
  canvas.width = 0
  canvas.height = 0
  return { width: w, height: h, data: data.data }
}

