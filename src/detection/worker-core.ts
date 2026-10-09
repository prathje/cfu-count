/**
 * Worker-side request handling, independent of the global `self` so it can be
 * unit-tested with a fake decoder. One request runs at a time per worker; a
 * new request does not cancel the previous one (the client does that).
 *
 * Resolution plan (iPad-friendly):
 *  1. Pass 1: decode the whole frame at the preliminary scale (long side
 *     2048), find the plate and calibrate the seeds.
 *  2. Final pass: decode only the PLATE (ROI bounding box + 4 %) at the scale
 *     that gives a typical colony `targetTypicalRadius` px (default 8) and the
 *     smallest expected colony ≥ 4 px. No pixel cap (product decision: best
 *     resolution, also on iPad); memory is bounded by the plate crop, by
 *     per-cluster processing (fitter candidates are computed on cluster
 *     patches) and by small LRU caches. `analysis.maxPixels` is an override.
 *  The plan is memoised per image + seeds, so slider re-runs skip pass 1, and
 *  decoded images, prepared planes, calibration and the fitter's tables are
 *  cached (bounded) so a re-run re-scores instead of refitting.
 */
import { DEFAULT_SETTINGS, detect, DetectionCancelled, DetectorCache } from './detect.ts'
import { chooseAnalysisScale } from './scale.ts'
import type { DetectRequest, ErrorCode, FromWorker, ToWorker } from './protocol.ts'
import type { RgbaImage, SeedInput, SeedPatch } from './types.ts'

/** Decoding failed (unsupported/corrupt image, or the browser refused). */
export class DecodeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DecodeError'
  }
}

export interface CropRect {
  x: number
  y: number
  w: number
  h: number
}

export interface Decoder {
  /** Decode `source` (oriented), optionally only the original-px `crop`, resized to w×h RGBA. Throws DecodeError. */
  decode(source: Blob | ImageBitmap, w: number, h: number, crop?: CropRect): Promise<RgbaImage>
}

interface Plan {
  scale: number
  crop: CropRect | null
  /** Typical colony radius at analysis scale, if known. */
  typicalRadiusPx: number | null
  /** Why the scale is what it is. */
  note: string
}

/** Tiny LRU map. */
class Lru<V> {
  private m = new Map<string, V>()
  private readonly cap: number
  constructor(cap: number) {
    this.cap = cap
  }
  get(k: string): V | undefined {
    const v = this.m.get(k)
    if (v !== undefined) {
      this.m.delete(k)
      this.m.set(k, v)
    }
    return v
  }
  set(k: string, v: V): void {
    this.m.delete(k)
    this.m.set(k, v)
    while (this.m.size > this.cap) this.m.delete(this.m.keys().next().value!)
  }
  clear(): void {
    this.m.clear()
  }
}

export function createWorkerHandler(decoder: Decoder, post: (m: FromWorker, transfer?: Transferable[]) => void) {
  const cache = new DetectorCache()
  const decoded = new Lru<RgbaImage>(2)
  const references = new Lru<RgbaImage>(2)
  const plans = new Lru<Plan>(8)
  const running = new Map<number, AbortController>()

  /** Identity of the analysed bytes: the fingerprint when given, else size/type of the blob (weaker; pass the fingerprint). */
  const imageKey = (req: DetectRequest) => {
    const src = req.source
    const weak = src.kind === 'blob' ? `${src.blob.size}:${src.blob.type}` : `${req.originalWidth}x${req.originalHeight}`
    return `${req.imageId}|${req.imageFingerprint ?? weak}`
  }

  async function imageAt(req: DetectRequest, scale: number, crop: CropRect | null): Promise<RgbaImage> {
    const src = req.source
    if (src.kind === 'rgba') return { width: src.width, height: src.height, data: src.data }
    const key = `${imageKey(req)}|${scale.toFixed(6)}|${crop ? [crop.x, crop.y, crop.w, crop.h].join(',') : 'full'}`
    const hit = decoded.get(key)
    if (hit) return hit
    const cw = crop ? crop.w : req.originalWidth
    const ch = crop ? crop.h : req.originalHeight
    const img = await decoder.decode(src.kind === 'blob' ? src.blob : src.bitmap, Math.max(1, Math.round(cw * scale)), Math.max(1, Math.round(ch * scale)), crop ?? undefined)
    decoded.set(key, img)
    return img
  }

  /** Each reference image is decoded ONCE per scale (cached, bounded); patches are cut in memory. */
  async function seedPatches(req: DetectRequest, scale: number, signal: AbortSignal): Promise<SeedInput[]> {
    const out: SeedInput[] = [...req.seeds]
    for (const s of req.remoteSeeds ?? []) {
      if (signal.aborted) throw new DetectionCancelled()
      const blob = req.remoteSources?.[s.imageId]
      if (!blob) {
        out.push(s)
        continue
      }
      const key = `${s.imageId}|${req.remoteFingerprints?.[s.imageId] ?? `${blob.size}:${blob.type}:${s.imageWidth}x${s.imageHeight}`}|${scale.toFixed(6)}`
      let ref = references.get(key)
      if (!ref) {
        ref = await decoder.decode(blob, Math.max(1, Math.round(s.imageWidth * scale)), Math.max(1, Math.round(s.imageHeight * scale)))
        references.set(key, ref)
        if (signal.aborted) throw new DetectionCancelled()
      }
      const k = ref.width / s.imageWidth
      const half = 0.05 * Math.max(s.imageWidth, s.imageHeight)
      const x0 = Math.max(0, Math.floor((s.x - half) * k))
      const y0 = Math.max(0, Math.floor((s.y - half) * k))
      const x1 = Math.min(ref.width, Math.ceil((s.x + half) * k))
      const y1 = Math.min(ref.height, Math.ceil((s.y + half) * k))
      const fp = req.remoteFingerprints?.[s.imageId]
      const patch: SeedPatch = { image: cutRgba(ref, x0, y0, x1 - x0, y1 - y0), scale: k, originX: x0 / k, originY: y0 / k, ...(fp ? { sourceFingerprint: fp } : {}) }
      out.push({ ...s, patch })
    }
    return out
  }

  function planKey(req: DetectRequest): string {
    const seeds = req.seeds.map((q) => [Math.round(q.x), Math.round(q.y)])
    const remote = (req.remoteSeeds ?? []).map((q) => [q.imageId, req.remoteFingerprints?.[q.imageId] ?? null, Math.round(q.x), Math.round(q.y)])
    return JSON.stringify([imageKey(req), seeds, remote, req.roi ?? null, req.analysis ?? null, req.settings?.edgeMarginFrac ?? null])
  }

  async function makePlan(req: DetectRequest, signal: AbortSignal): Promise<Plan> {
    const size = { width: req.originalWidth, height: req.originalHeight }
    if (req.source.kind === 'rgba') return { scale: req.source.scale, crop: null, typicalRadiusPx: null, note: 'given' }
    if (req.analysis?.scale) return { scale: req.analysis.scale, crop: null, typicalRadiusPx: null, note: 'given' }
    const key = planKey(req)
    const memo = plans.get(key)
    if (memo) return memo
    const budget = req.analysis?.maxPixels
    const target = req.analysis?.targetTypicalRadius ?? 8
    // pass 1: the whole frame at the preliminary scale (long side 2048)
    const s1 = chooseAnalysisScale({ ...size, maxPixels: budget }).scale
    const img = await imageAt(req, s1, null)
    if (signal.aborted) throw new DetectionCancelled()
    const settings = { ...DEFAULT_SETTINGS, ...req.settings }
    const prepInput = { image: img, scale: s1, roi: req.roi, imageId: req.imageId, imageFingerprint: req.imageFingerprint }
    const prep = cache.get(prepInput, settings)
    const cal = cache.calibration(prep, { seeds: await seedPatches(req, s1, signal), imageId: req.imageId }, settings)
    const prior = cal.report.prior
    let plan: Plan = { scale: s1, crop: null, typicalRadiusPx: prior ? prior.rMedian * s1 : null, note: 'preliminary (no usable seeds)' }
    if (prior) {
      // crop to the plate (or user ROI) bounding box, padded, then size for the colonies
      const xs = prep.roi.report.outline.map((p) => p.x)
      const ys = prep.roi.report.outline.map((p) => p.y)
      let crop: CropRect | null = null
      if (xs.length >= 3) {
        const pad = 0.04 * Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
        const x0 = Math.max(0, Math.floor(Math.min(...xs) - pad))
        const y0 = Math.max(0, Math.floor(Math.min(...ys) - pad))
        const x1 = Math.min(size.width, Math.ceil(Math.max(...xs) + pad))
        const y1 = Math.min(size.height, Math.ceil(Math.max(...ys) + pad))
        if ((x1 - x0) * (y1 - y0) < 0.95 * size.width * size.height) crop = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
      }
      const area = crop ?? { w: size.width, h: size.height }
      const want = { width: area.w, height: area.h, minRadiusOriginal: prior.rRange[0], typicalRadiusOriginal: prior.rMedian, targetTypicalRadius: target }
      const choice = chooseAnalysisScale({ ...want, maxPixels: budget })
      const r = prior.rMedian * choice.scale
      const note =
        r < target - 0.25
          ? `colonies only ${r.toFixed(1)} px (pixel override or full resolution reached): touching colonies may merge`
          : `typical colony ${r.toFixed(1)} px`
      // keep the preliminary image when it is already about right and covers everything
      if (!crop && Math.abs(choice.scale - s1) / s1 <= 0.15) plan = { scale: s1, crop: null, typicalRadiusPx: prior.rMedian * s1, note }
      else plan = { scale: choice.scale, crop, typicalRadiusPx: r, note }
    }
    plans.set(key, plan)
    return plan
  }

  async function run(id: number, req: DetectRequest): Promise<void> {
    const ac = new AbortController()
    running.set(id, ac)
    try {
      const plan = await makePlan(req, ac.signal)
      const image = await imageAt(req, plan.scale, plan.crop)
      if (ac.signal.aborted) throw new DetectionCancelled()
      const seeds = await seedPatches(req, plan.scale, ac.signal)
      const { source: _s, remoteSeeds: _r, remoteSources: _rs, remoteFingerprints: _rf, analysis: _a, ...rest } = req
      const result = await detect(
        { ...rest, image, scale: plan.scale, seeds, ...(plan.crop ? { origin: { x: plan.crop.x, y: plan.crop.y } } : {}) },
        (progress) => post({ type: 'progress', id, progress }),
        ac.signal,
        cache,
      )
      const diag = result.run.diagnostics ?? {}
      result.run.diagnostics = { ...diag, analysis: { ...(diag.analysis as object), crop: plan.crop, plan: plan.note } }
      post({ type: 'result', id, result }, result.clusterLabels ? [result.clusterLabels.labels.buffer as ArrayBuffer] : [])
    } catch (e) {
      if (e instanceof DetectionCancelled) post({ type: 'cancelled', id })
      else {
        const message = e instanceof Error ? e.message : String(e)
        post({ type: 'error', id, code: errorCode(e), message })
      }
    } finally {
      running.delete(id)
      // a transferred full-size bitmap is only decode input: free it now, not at GC
      if (req.source.kind === 'bitmap') req.source.bitmap.close()
    }
  }

  return function onMessage(msg: ToWorker): Promise<void> | void {
    if (msg.type === 'cancel') running.get(msg.id)?.abort()
    else if (msg.type === 'clear-cache') {
      cache.clear()
      decoded.clear()
      references.clear()
      plans.clear()
    } else return run(msg.id, msg.request)
  }
}

/** Error class → protocol code (no guessing from message text). */
export function errorCode(e: unknown): ErrorCode {
  if (e instanceof DecodeError) return 'decode-failed'
  if (e instanceof RangeError) return 'out-of-memory' // typed-array / ArrayBuffer allocation failure
  return 'internal'
}

function cutRgba(src: RgbaImage, x0: number, y0: number, w: number, h: number): RgbaImage {
  const out = new Uint8ClampedArray(Math.max(0, w * h * 4))
  for (let y = 0; y < h; y++) out.set(src.data.subarray(((y + y0) * src.width + x0) * 4, ((y + y0) * src.width + x0 + w) * 4), y * w * 4)
  return { width: w, height: h, data: out }
}

/** Browser decoder: createImageBitmap resize (Safari ≥ 15) + OffscreenCanvas 2D (Safari ≥ 16.4). */
export const browserDecoder: Decoder = {
  async decode(source, w, h, crop) {
    let bmp: ImageBitmap
    try {
      const opts: ImageBitmapOptions = { resizeWidth: w, resizeHeight: h, resizeQuality: 'high', imageOrientation: 'from-image' }
      bmp = crop ? await createImageBitmap(source, crop.x, crop.y, crop.w, crop.h, opts) : await createImageBitmap(source, opts)
    } catch (e) {
      throw new DecodeError(e instanceof Error ? e.message : 'The image could not be decoded.')
    }
    const canvas = new OffscreenCanvas(w, h)
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) {
      bmp.close()
      throw new DecodeError('No 2D canvas is available in the worker.')
    }
    ctx.drawImage(bmp, 0, 0, w, h)
    const data = ctx.getImageData(0, 0, w, h)
    bmp.close()
    // release the canvas backing store early (Safari keeps it otherwise)
    canvas.width = 0
    canvas.height = 0
    return { width: w, height: h, data: data.data }
  },
}
