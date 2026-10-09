import { describe, expect, it } from 'vitest'
import { createDetectorClient, DetectionCancelled, DetectorError, type WorkerLike } from './index.ts'
import { createWorkerHandler, DecodeError, errorCode, type Decoder } from './worker-core.ts'
import type { DetectRequest, FromWorker, ToWorker } from './protocol.ts'
import type { RgbaImage } from './types.ts'

/** Dark square plate with bright disks, rendered for the requested (cropped) window and size. */
function render(w: number, h: number, scale: number, disks: { x: number; y: number; r: number }[], ox = 0, oy = 0): RgbaImage {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const px = ox + (x + 0.5) / scale
      const py = oy + (y + 0.5) / scale
      const plate = px > 60 && px < 540 && py > 50 && py < 470
      let a = 0
      for (const d of disks) a = Math.max(a, Math.min(1, Math.max(0, (d.r + 1 - Math.hypot(px - d.x, py - d.y)) / 2)))
      const v = plate ? 70 + a * 120 : 235
      const i = (y * w + x) * 4
      data[i] = data[i + 1] = v
      data[i + 2] = plate ? 75 + a * 60 : 235
      data[i + 3] = 255
    }
  return { width: w, height: h, data }
}

const disks = [
  { x: 180, y: 160, r: 16 },
  { x: 280, y: 160, r: 16 },
  { x: 380, y: 160, r: 16 },
  { x: 180, y: 300, r: 16 },
  { x: 300, y: 330, r: 16 },
]

function fakeDecoder(log: string[]): Decoder {
  return {
    async decode(_src, w, h, crop) {
      log.push(crop ? `decode ${w}x${h} crop ${crop.x},${crop.y}` : `decode ${w}x${h}`)
      const sw = crop ? crop.w : 600
      return render(w, h, w / sw, disks, crop?.x ?? 0, crop?.y ?? 0)
    },
  }
}

/** A WorkerLike whose messages go straight to the handler (async, like a real worker). */
function fakeWorker(decoder: Decoder): WorkerLike {
  const listeners: ((e: MessageEvent<FromWorker>) => void)[] = []
  const handle = createWorkerHandler(decoder, (m) => setTimeout(() => listeners.forEach((l) => l({ data: m } as MessageEvent<FromWorker>)), 0))
  return {
    postMessage: (m: ToWorker) => setTimeout(() => void handle(m), 0),
    addEventListener: (t: string, fn: (e: never) => void) => void (t === 'message' && listeners.push(fn as (e: MessageEvent<FromWorker>) => void)),
    terminate: () => {},
  }
}

const request = (over: Partial<DetectRequest> = {}): DetectRequest => ({
  source: { kind: 'blob' as const, blob: new Blob([]) },
  originalWidth: 600,
  originalHeight: 520,
  imageId: 'img',
  imageFingerprint: 'fp1',
  targetGroupId: 'g',
  seeds: disks.slice(0, 3).map((d, i) => ({ annotationId: `s${i}`, imageId: 'img', x: d.x, y: d.y })),
  existing: disks.slice(0, 3).map((d, i) => ({ id: `s${i}`, x: d.x, y: d.y, groupId: 'g', origin: 'manual' as const })),
  settings: { method: 'log' as const },
  ...over,
})

describe('detector worker + client', () => {
  it('decodes in the worker, crops to the plate, runs detection and reports progress', async () => {
    const log: string[] = []
    const client = createDetectorClient(fakeWorker(fakeDecoder(log)))
    const stages = new Set<string>()
    const r = await client.detect(request(), { onProgress: (p) => stages.add(p.stage) })
    expect(r.suggestions.length).toBe(2)
    for (const s of r.suggestions) expect(Math.min(...disks.map((d) => Math.hypot(d.x - s.x, d.y - s.y)))).toBeLessThan(3)
    expect(stages.has('done')).toBe(true)
    expect(log[0]).toBe('decode 600x520') // preliminary pass: whole frame
    expect(log.some((l) => l.includes('crop'))).toBe(true) // final pass: the plate only
    expect(r.run.imageFingerprint).toBe('fp1')
    expect((r.run.diagnostics!.analysis as { crop: unknown }).crop).not.toBeNull()
    client.dispose()
  })
  it('re-runs reuse the plan and the decoded image', async () => {
    const log: string[] = []
    const client = createDetectorClient(fakeWorker(fakeDecoder(log)))
    await client.detect(request({ settings: { method: 'fitter' } }))
    const n = log.length
    const r2 = await client.detect(request({ settings: { method: 'fitter', sensitivity: 0.7 } }))
    expect(log.length).toBe(n) // nothing decoded again
    expect((r2.run.diagnostics!.method as { reusedFit: boolean }).reusedFit).toBe(true)
    // changed bytes (fingerprint) are never served from the cache
    await client.detect(request({ imageFingerprint: 'fp2' }))
    expect(log.length).toBeGreaterThan(n)
    client.dispose()
  })
  it('decodes each reference image once for all its seeds', async () => {
    const log: string[] = []
    const client = createDetectorClient(fakeWorker(fakeDecoder(log)))
    const r = await client.detect(
      request({
        seeds: [],
        existing: [],
        remoteSeeds: disks.slice(0, 3).map((d, i) => ({ annotationId: `r${i}`, imageId: 'ref', x: d.x, y: d.y, imageWidth: 600, imageHeight: 520 })),
        remoteSources: { ref: new Blob([]) },
        analysis: { scale: 1 },
      }),
    )
    expect(log.filter((l) => l === 'decode 600x520').length).toBe(2) // the image itself + the reference, once
    expect(r.calibration.nUsable).toBeGreaterThan(0)
    expect(r.suggestions.length).toBe(5)
    client.dispose()
  })
  it('a changed reference fingerprint is never served from the calibration cache', async () => {
    const log: string[] = []
    const client = createDetectorClient(fakeWorker(fakeDecoder(log)))
    const remote = (fp: string) =>
      request({
        seeds: [],
        existing: [],
        remoteSeeds: disks.slice(0, 3).map((d, i) => ({ annotationId: `r${i}`, imageId: 'ref', x: d.x, y: d.y, imageWidth: 600, imageHeight: 520 })),
        remoteSources: { ref: new Blob([]) },
        remoteFingerprints: { ref: fp },
        analysis: { scale: 1 },
        settings: { method: 'fitter' },
      })
    await client.detect(remote('a'))
    const n = log.length
    const again = await client.detect(remote('a'))
    expect(log.length).toBe(n)
    expect((again.run.diagnostics!.method as { reusedFit: boolean }).reusedFit).toBe(true)
    const changed = await client.detect(remote('b'))
    expect(log.length).toBe(n + 1) // the reference is decoded again
    expect((changed.run.diagnostics!.method as { reusedFit: boolean }).reusedFit).toBe(false)
    client.dispose()
  })
  it('cancels via AbortSignal and when a newer request starts', async () => {
    const client = createDetectorClient(fakeWorker(fakeDecoder([])))
    const ac = new AbortController()
    const first = client.detect(request(), { signal: ac.signal })
    ac.abort()
    await expect(first).rejects.toBeInstanceOf(DetectionCancelled)
    const a = client.detect(request())
    const b = client.detect(request())
    await expect(a).rejects.toBeInstanceOf(DetectionCancelled)
    expect((await b).suggestions.length).toBe(2)
    client.dispose()
  })
})

describe('detector lifecycle', () => {
  /** A worker that never answers but lets the test fire its events. */
  function silentWorker() {
    const handlers: Record<string, ((e: unknown) => void)[]> = {}
    const posted: ToWorker[] = []
    let terminated = false
    const worker: WorkerLike = {
      postMessage: (m: ToWorker) => void posted.push(m),
      addEventListener: (t: string, fn: (e: never) => void) => void (handlers[t] ??= []).push(fn as (e: unknown) => void),
      terminate: () => void (terminated = true),
    }
    return { worker, posted, fire: (t: string, e: unknown) => handlers[t]?.forEach((f) => f(e)), isTerminated: () => terminated }
  }

  it('rejects pending work when the worker fails and starts a fresh worker from the factory', async () => {
    const made: ReturnType<typeof silentWorker>[] = []
    const client = createDetectorClient(() => {
      const w = silentWorker()
      made.push(w)
      return w.worker
    })
    const p = client.detect(request())
    made[0].fire('error', { type: 'error', message: 'Uncaught SyntaxError' })
    await expect(p).rejects.toBeInstanceOf(DetectorError)
    expect(made[0].isTerminated()).toBe(true)
    void client.detect(request()).catch(() => {})
    expect(made.length).toBe(2)
    expect(made[1].posted.at(-1)?.type).toBe('detect')
    client.dispose()
  })
  it('a failed plain worker instance rejects later detects', async () => {
    const w = silentWorker()
    const client = createDetectorClient(w.worker)
    const p = client.detect(request())
    w.fire('messageerror', { type: 'messageerror' })
    await expect(p).rejects.toBeInstanceOf(DetectorError)
    await expect(client.detect(request())).rejects.toBeInstanceOf(DetectorError)
  })
  it('detect after dispose rejects instead of hanging', async () => {
    const client = createDetectorClient(silentWorker().worker)
    client.dispose()
    await expect(client.detect(request())).rejects.toBeInstanceOf(DetectionCancelled)
  })
  it('closes a transferred ImageBitmap source after the run', async () => {
    let closed = 0
    const bitmap = { width: 600, height: 520, close: () => void closed++ } as unknown as ImageBitmap
    const out: FromWorker[] = []
    const handle = createWorkerHandler(fakeDecoder([]), (m) => void out.push(m))
    await handle({ type: 'detect', id: 1, request: { ...request(), source: { kind: 'bitmap', bitmap } } })
    expect(out.at(-1)?.type).toBe('result')
    expect(closed).toBe(1)
  })
  it('stops between reference decodes once cancelled', async () => {
    const log: string[] = []
    const out: FromWorker[] = []
    const base = fakeDecoder(log)
    let handle: ReturnType<typeof createWorkerHandler>
    const decoder: Decoder = {
      async decode(...a) {
        const r = await base.decode(...a)
        if (log.length === 2) void handle({ type: 'cancel', id: 1 }) // after the first reference image
        return r
      },
    }
    handle = createWorkerHandler(decoder, (m) => void out.push(m))
    await handle({
      type: 'detect',
      id: 1,
      request: request({
        seeds: [],
        existing: [],
        analysis: { scale: 1 },
        remoteSeeds: ['a', 'b', 'c'].map((ref, i) => ({ annotationId: `r${i}`, imageId: ref, x: disks[i].x, y: disks[i].y, imageWidth: 600, imageHeight: 520 })),
        remoteSources: { a: new Blob([]), b: new Blob([]), c: new Blob([]) },
      }),
    })
    expect(out.at(-1)?.type).toBe('cancelled')
    expect(log.length).toBe(2)
  })
  it('maps typed errors to protocol codes', async () => {
    expect(errorCode(new DecodeError('x'))).toBe('decode-failed')
    expect(errorCode(new RangeError('Array buffer allocation failed'))).toBe('out-of-memory')
    expect(errorCode(new Error('decode image something'))).toBe('internal')
    const out: FromWorker[] = []
    const handle = createWorkerHandler({ decode: async () => Promise.reject(new DecodeError('bad jpeg')) }, (m) => void out.push(m))
    await handle({ type: 'detect', id: 7, request: request() })
    expect(out.at(-1)).toMatchObject({ type: 'error', code: 'decode-failed' })
  })
})
