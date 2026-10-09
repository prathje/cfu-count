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
 *
 * Failure handling: if the worker script fails to load or the worker crashes
 * ('error'), or a reply cannot be deserialised ('messageerror'), every pending
 * detect() rejects with DetectorError('internal'). With the default factory a
 * fresh worker is started on the next detect(); with a plain instance later
 * calls reject. detect() after dispose() rejects with DetectionCancelled.
 */
import { DetectionCancelled } from './detect.ts'
import type { DetectRequest, FromWorker, ToWorker } from './protocol.ts'
import type { DetectProgress, DetectResult } from './types.ts'

/** The subset of Worker the client needs (lets tests pass a fake). */
export interface WorkerLike {
  postMessage(m: ToWorker, transfer?: Transferable[]): void
  addEventListener(type: 'message', fn: (e: MessageEvent<FromWorker>) => void): void
  /** Optional for fakes: script load failure / crash, and undecodable replies. */
  addEventListener(type: 'error' | 'messageerror', fn: (e: Event) => void): void
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

const defaultWorker = (): WorkerLike => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike

interface Pending {
  resolve: (r: DetectResult) => void
  reject: (e: unknown) => void
  onProgress?: (p: DetectProgress) => void
}

/**
 * @param worker a worker factory (default: the bundled module worker) or a
 *   single instance (tests). Only a factory allows a restart after a failure.
 */
export function createDetectorClient(worker: WorkerLike | (() => WorkerLike) = defaultWorker): DetectorClient {
  const factory = typeof worker === 'function' ? worker : null
  let instance: WorkerLike | null = null
  let broken = false
  let disposed = false
  let nextId = 1
  let current: number | null = null
  const pending = new Map<number, Pending>()

  const onMessage = (e: MessageEvent<FromWorker>) => {
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
  }

  const onFailure = (source: WorkerLike, e: Event) => {
    if (source !== instance) return // a worker we already replaced
    const message = (e as ErrorEvent).message || (e.type === 'messageerror' ? 'A detector reply could not be read.' : 'The detector stopped unexpectedly.')
    for (const p of pending.values()) p.reject(new DetectorError('internal', message))
    pending.clear()
    current = null
    source.terminate()
    instance = null
    broken = true
  }

  const ensureWorker = (): WorkerLike | null => {
    if (instance) return instance
    if (broken && !factory) return null
    const w = factory ? factory() : (worker as WorkerLike)
    w.addEventListener('message', onMessage)
    w.addEventListener('error', (e) => onFailure(w, e))
    w.addEventListener('messageerror', (e) => onFailure(w, e))
    instance = w
    broken = false
    return w
  }
  if (!factory) ensureWorker()

  return {
    detect(request, opts = {}) {
      if (disposed) return Promise.reject(new DetectionCancelled())
      const w = ensureWorker()
      if (!w) return Promise.reject(new DetectorError('internal', 'The detector stopped unexpectedly. Reload the page to try again.'))
      if (current !== null) w.postMessage({ type: 'cancel', id: current })
      const id = nextId++
      current = id
      return new Promise<DetectResult>((resolve, reject) => {
        if (opts.signal?.aborted) {
          current = null
          reject(new DetectionCancelled())
          return
        }
        pending.set(id, { resolve, reject, onProgress: opts.onProgress })
        opts.signal?.addEventListener('abort', () => pending.has(id) && instance?.postMessage({ type: 'cancel', id }), { once: true })
        const transfer: Transferable[] = []
        if (request.source.kind === 'bitmap') transfer.push(request.source.bitmap)
        if (request.source.kind === 'rgba') transfer.push(request.source.data.buffer as ArrayBuffer)
        w.postMessage({ type: 'detect', id, request }, transfer)
      })
    },
    clearCache() {
      instance?.postMessage({ type: 'clear-cache' })
    },
    dispose() {
      disposed = true
      for (const p of pending.values()) p.reject(new DetectionCancelled())
      pending.clear()
      instance?.terminate()
      instance = null
    },
  }
}
