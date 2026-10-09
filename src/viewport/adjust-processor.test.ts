import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAdjustProcessor } from './adjust-processor'
import type { ImageSourceLike } from './render'

class FakeWorker {
  static last: FakeWorker | null = null
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: Event) => void) | null = null
  posted: unknown[] = []
  terminated = false
  constructor() {
    FakeWorker.last = this
  }
  postMessage(m: unknown) {
    this.posted.push(m)
  }
  terminate() {
    this.terminated = true
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('createAdjustProcessor', () => {
  it('does no main-thread fallback work for a job cut short by dispose()', async () => {
    const createElement = vi.fn(() => {
      throw new Error('main-thread fallback must not run')
    })
    vi.stubGlobal('Worker', FakeWorker)
    vi.stubGlobal('OffscreenCanvas', class {})
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ close() {} })))
    vi.stubGlobal('document', { createElement })
    const p = createAdjustProcessor()
    const source = { width: 4, height: 4 } as unknown as ImageSourceLike
    const job = p.adjust(source, { x: 0, y: 0, w: 4, h: 4 }, [1, 0, 0, 0, 1, 0, 0, 0, 1], new Uint8ClampedArray(256))
    await vi.waitFor(() => expect(FakeWorker.last?.posted).toHaveLength(1))
    p.dispose()
    await expect(job).rejects.toThrow('disposed')
    expect(FakeWorker.last!.terminated).toBe(true)
    expect(createElement).not.toHaveBeenCalled()
  })
})
