/**
 * Runs display-adjust pixel work: in a worker with OffscreenCanvas when the
 * browser supports it (Safari 16.4+, Chrome, Firefox), else on the main thread
 * in chunks that yield between slices. Results are ImageBitmaps (GPU-friendly,
 * no canvas backing store kept alive), or a canvas where createImageBitmap is
 * missing.
 */
import { applyAdjust, histogram, type Matrix3 } from './image-adjust'
import type { WorkerReply, WorkerRequest } from './adjust-protocol'
import type { ImageSourceLike } from './render'

/** A source-pixel rectangle. */
export interface PixelRect {
  x: number
  y: number
  w: number
  h: number
}

export interface AdjustProcessor {
  /** Adjusted copy of `rect` of `source` (source pixels). */
  adjust(source: ImageSourceLike, rect: PixelRect, matrix: Matrix3, lut: Uint8ClampedArray): Promise<ImageSourceLike>
  /** Histogram of the matrix outputs over the whole `source`. */
  histogram(source: ImageSourceLike, matrix: Matrix3): Promise<Uint32Array>
  /** 'worker' | 'main' (diagnostics; 'main' after a worker failure too). */
  mode(): 'worker' | 'main'
  dispose(): void
}

/** Pixels processed between yields on the main-thread path (~5–10 ms per slice). */
const MAIN_CHUNK_PX = 1 << 18

const nextTick = () => new Promise<void>((r) => setTimeout(r, 0))

export function createAdjustProcessor(): AdjustProcessor {
  let worker: Worker | null = null
  let useWorker = typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap === 'function'
  let seq = 0
  let disposed = false
  const pending = new Map<number, { resolve(r: WorkerReply): void; reject(e: unknown): void }>()

  function getWorker(): Worker | null {
    if (!useWorker) return null
    if (worker) return worker
    try {
      worker = new Worker(new URL('./adjust.worker.ts', import.meta.url), { type: 'module' })
    } catch {
      useWorker = false
      return null
    }
    worker.onmessage = (e: MessageEvent<WorkerReply>) => {
      const p = pending.get(e.data.id)
      pending.delete(e.data.id)
      p?.resolve(e.data)
    }
    worker.onerror = (e) => {
      // Script failed to load or crashed: fail over to the main thread for good.
      e.preventDefault()
      useWorker = false
      worker?.terminate()
      worker = null
      for (const p of pending.values()) p.reject(new Error('adjust worker failed'))
      pending.clear()
    }
    return worker
  }

  async function viaWorker(w: Worker, source: ImageSourceLike, rect: PixelRect, build: (id: number, bitmap: ImageBitmap) => WorkerRequest): Promise<WorkerReply> {
    const bitmap = await createImageBitmap(source, rect.x, rect.y, rect.w, rect.h)
    const id = ++seq
    return new Promise<WorkerReply>((resolve, reject) => {
      pending.set(id, { resolve, reject })
      w.postMessage(build(id, bitmap), [bitmap])
    })
  }

  /** Main-thread path: read pixels from a scratch canvas. The caller releases it. */
  function readPixels(source: ImageSourceLike, rect: PixelRect) {
    const canvas = document.createElement('canvas')
    canvas.width = rect.w
    canvas.height = rect.h
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('Canvas 2D unavailable')
    ctx.drawImage(source, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h)
    return { canvas, ctx, image: ctx.getImageData(0, 0, rect.w, rect.h) }
  }

  async function adjustMain(source: ImageSourceLike, rect: PixelRect, matrix: Matrix3, lut: Uint8ClampedArray): Promise<ImageSourceLike> {
    const { canvas, ctx, image } = readPixels(source, rect)
    const total = rect.w * rect.h
    for (let start = 0; start < total; start += MAIN_CHUNK_PX) {
      applyAdjust(image.data, matrix, lut, start, start + MAIN_CHUNK_PX)
      if (start + MAIN_CHUNK_PX < total) await nextTick()
    }
    ctx.putImageData(image, 0, 0)
    if (typeof createImageBitmap !== 'function') return canvas
    try {
      return await createImageBitmap(canvas)
    } finally {
      canvas.width = canvas.height = 0 // release the backing store (Safari canvas memory)
    }
  }

  const whole = (s: ImageSourceLike): PixelRect => ({ x: 0, y: 0, w: s.width, h: s.height })

  return {
    async adjust(source, rect, matrix, lut) {
      const w = getWorker()
      if (w) {
        try {
          const reply = await viaWorker(w, source, rect, (id, bitmap) => ({ id, type: 'adjust', bitmap, matrix, lut }))
          if ('bitmap' in reply) return reply.bitmap
          useWorker = false // e.g. no OffscreenCanvas 2D inside workers
        } catch (err) {
          if (disposed) throw err // torn down: no main-thread fallback work
          useWorker = false
        }
      }
      return adjustMain(source, rect, matrix, lut)
    },
    async histogram(source, matrix) {
      const w = getWorker()
      if (w) {
        try {
          const reply = await viaWorker(w, source, whole(source), (id, bitmap) => ({ id, type: 'histogram', bitmap, matrix }))
          if ('hist' in reply) return reply.hist
          useWorker = false
        } catch (err) {
          if (disposed) throw err
          useWorker = false
        }
      }
      const { canvas, image } = readPixels(source, whole(source))
      canvas.width = canvas.height = 0
      return histogram(image.data, matrix)
    },
    mode: () => (useWorker ? 'worker' : 'main'),
    dispose() {
      disposed = true
      worker?.terminate()
      worker = null
      for (const p of pending.values()) p.reject(new Error('disposed'))
      pending.clear()
    },
  }
}
