/**
 * Display-adjust worker: receives an ImageBitmap (transferred), applies the
 * colour stage (channel matrix or colour LUT) + LUT on an OffscreenCanvas and transfers the adjusted bitmap
 * back, or returns a histogram. Keeps the per-pixel loop off the main thread.
 * Protocol: adjust-protocol.ts. Replies `{ id, error }` when OffscreenCanvas 2D
 * is unavailable, so the caller can fall back to the main thread.
 */
import { applyStage, stageHistogram } from './image-adjust'
import type { WorkerReply, WorkerRequest } from './adjust-protocol'

interface WorkerScope {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null
  postMessage(message: WorkerReply, transfer?: Transferable[]): void
}
const scope = self as unknown as WorkerScope

scope.onmessage = (e) => {
  const req = e.data
  const { bitmap } = req
  try {
    if (typeof OffscreenCanvas === 'undefined') throw new Error('OffscreenCanvas unavailable')
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = canvas.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | null
    if (!ctx) throw new Error('OffscreenCanvas 2D unavailable')
    ctx.drawImage(bitmap, 0, 0)
    bitmap.close()
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
    if (req.type === 'histogram') {
      const hist = stageHistogram(image.data, req.stage)
      canvas.width = canvas.height = 0
      scope.postMessage({ id: req.id, hist }, [hist.buffer])
      return
    }
    applyStage(image.data, req.stage, req.lut)
    ctx.putImageData(image, 0, 0)
    const out = canvas.transferToImageBitmap()
    scope.postMessage({ id: req.id, bitmap: out }, [out])
  } catch (err) {
    bitmap.close()
    scope.postMessage({ id: req.id, error: err instanceof Error ? err.message : String(err) })
  }
}
