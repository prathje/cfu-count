import { describe, expect, it } from 'vitest'
import { createDetectorClient, DetectionCancelled, type WorkerLike } from './index.ts'
import { createWorkerHandler, type Decoder } from './worker-core.ts'
import type { FromWorker, ToWorker } from './protocol.ts'
import type { RgbaImage } from './types.ts'

/** Dark square plate with bright disks, drawn directly at the requested size. */
function render(w: number, h: number, scale: number, disks: { x: number; y: number; r: number }[]): RgbaImage {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const ox = (x + 0.5) / scale
      const oy = (y + 0.5) / scale
      const plate = ox > 60 && ox < 540 && oy > 50 && oy < 470
      let a = 0
      for (const d of disks) a = Math.max(a, Math.min(1, Math.max(0, (d.r + 1 - Math.hypot(ox - d.x, oy - d.y)) / 2)))
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
    async decode(_src, w, h) {
      log.push(`decode ${w}x${h}`)
      return render(w, h, w / 600, disks)
    },
    async crop(_src, sx, sy, sw, _sh, w, h) {
      log.push(`crop ${sx},${sy}`)
      const s = w / sw
      const full = render(Math.round(600 * s), Math.round(520 * s), s, disks)
      const out = new Uint8ClampedArray(w * h * 4)
      const ox = Math.round(sx * s)
      const oy = Math.round(sy * s)
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 4; c++) out[(y * w + x) * 4 + c] = full.data[((y + oy) * full.width + x + ox) * 4 + c] ?? 0
      return { width: w, height: h, data: out }
    },
  }
}

/** A WorkerLike whose messages go straight to the handler (async, like a real worker). */
function fakeWorker(decoder: Decoder): WorkerLike {
  const listeners: ((e: MessageEvent<FromWorker>) => void)[] = []
  const handle = createWorkerHandler(decoder, (m) => setTimeout(() => listeners.forEach((l) => l({ data: m } as MessageEvent<FromWorker>)), 0))
  return {
    postMessage: (m: ToWorker) => setTimeout(() => void handle(m), 0),
    addEventListener: (_t, fn) => listeners.push(fn),
    terminate: () => {},
  }
}

const request = (over = {}) => ({
  source: { kind: 'blob' as const, blob: new Blob([]) },
  originalWidth: 600,
  originalHeight: 520,
  imageId: 'img',
  targetGroupId: 'g',
  seeds: disks.slice(0, 3).map((d, i) => ({ annotationId: `s${i}`, imageId: 'img', x: d.x, y: d.y })),
  existing: disks.slice(0, 3).map((d, i) => ({ id: `s${i}`, x: d.x, y: d.y, groupId: 'g', origin: 'manual' as const })),
  settings: { method: 'log' as const },
  ...over,
})

describe('detector worker + client', () => {
  it('decodes in the worker, runs detection and reports progress', async () => {
    const log: string[] = []
    const client = createDetectorClient(fakeWorker(fakeDecoder(log)))
    const stages = new Set<string>()
    const r = await client.detect(request(), { onProgress: (p) => stages.add(p.stage) })
    expect(r.suggestions.length).toBe(2)
    expect(stages.has('done')).toBe(true)
    expect(log[0]).toBe('decode 600x520') // preliminary scale = 1 for a small image
    client.dispose()
  })
  it('crops patches for seeds from another image', async () => {
    const log: string[] = []
    const client = createDetectorClient(fakeWorker(fakeDecoder(log)))
    const r = await client.detect(
      request({
        seeds: [],
        existing: [],
        remoteSeeds: disks.slice(0, 3).map((d, i) => ({ annotationId: `r${i}`, imageId: 'ref', x: d.x, y: d.y, imageWidth: 600, imageHeight: 520 })),
        remoteSources: { ref: new Blob([]) },
      }),
    )
    expect(log.some((l) => l.startsWith('crop'))).toBe(true)
    expect(r.calibration.nUsable).toBeGreaterThan(0)
    expect(r.suggestions.length).toBe(5)
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
