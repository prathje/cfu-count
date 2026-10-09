/**
 * Main-thread client for the detection Worker.
 *
 *   const detector = createDetectorClient()
 *   const result = await detector.detect(request, { onProgress, signal })
 *   detector.dispose()
 *
 * One long-lived worker keeps decoded/prepared planes of the last image, so
 * re-running with a different sensitivity is cheap. Starting a new detect()
 * cancels the one in flight (slider drags). Aborting `signal` rejects with
 * DetectionCancelled.
 */
import { DetectionCancelled } from './detect.ts'
import type { DetectRequest, FromWorker, ToWorker } from './protocol.ts'
import type { DetectProgress, DetectResult } from './types.ts'

/** The subset of Worker the client needs (lets tests pass a fake). */
export interface WorkerLike {
  postMessage(m: ToWorker, transfer?: Transferable[]): void
  addEventListener(type: 'message', fn: (e: MessageEvent<FromWorker>) => void): void
  terminate(): void
}

export class DetectorError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'DetectorError'
    this.code = code
  }
}

export interface DetectorClient {
  detect(request: DetectRequest, opts?: { onProgress?: (p: DetectProgress) => void; signal?: AbortSignal }): Promise<DetectResult>
  /** Drop cached planes (e.g. when the user leaves the image). */
  clearCache(): void
  dispose(): void
}

export function createDetectorClient(worker: WorkerLike = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike): DetectorClient {
  let nextId = 1
  let current: number | null = null
  const pending = new Map<number, { resolve: (r: DetectResult) => void; reject: (e: unknown) => void; onProgress?: (p: DetectProgress) => void }>()
  worker.addEventListener('message', (e) => {
    const m = e.data
    const p = pending.get(m.id)
    if (!p) return
    if (m.type === 'progress') {
      p.onProgress?.(m.progress)
      return
    }
    pending.delete(m.id)
    if (current === m.id) current = null
    if (m.type === 'result') p.resolve(m.result)
    else if (m.type === 'cancelled') p.reject(new DetectionCancelled())
    else p.reject(new DetectorError(m.code, m.message))
  })
  return {
    detect(request, opts = {}) {
      if (current !== null) worker.postMessage({ type: 'cancel', id: current })
      const id = nextId++
      current = id
      return new Promise<DetectResult>((resolve, reject) => {
        pending.set(id, { resolve, reject, onProgress: opts.onProgress })
        if (opts.signal) {
          if (opts.signal.aborted) {
            pending.delete(id)
            reject(new DetectionCancelled())
            return
          }
          opts.signal.addEventListener('abort', () => worker.postMessage({ type: 'cancel', id }), { once: true })
        }
        const transfer: Transferable[] = []
        if (request.source.kind === 'bitmap') transfer.push(request.source.bitmap)
        if (request.source.kind === 'rgba') transfer.push(request.source.data.buffer as ArrayBuffer)
        worker.postMessage({ type: 'detect', id, request }, transfer)
      })
    },
    clearCache() {
      worker.postMessage({ type: 'clear-cache' })
    },
    dispose() {
      for (const p of pending.values()) p.reject(new DetectionCancelled())
      pending.clear()
      worker.terminate()
    },
  }
}
