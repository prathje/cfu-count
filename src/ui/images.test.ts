import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'solid-js'

const decodeImage = vi.fn()
vi.mock('../storage/images', () => ({ decodeImage: (b: Blob) => decodeImage(b) }))

const { createThumbnailCache } = await import('./images')

function stubBrowser() {
  let n = 0
  const revoked: string[] = []
  vi.stubGlobal('URL', { createObjectURL: () => `blob:${++n}`, revokeObjectURL: (u: string) => revoked.push(u) })
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage() {} }), toBlob: (cb: (b: Blob) => void) => cb(new Blob(['j'])) }
  vi.stubGlobal('document', { createElement: () => canvas })
  return { revoked }
}

const decoded = () => ({ source: {}, width: 200, height: 100, close: vi.fn() })
const flush = () => new Promise((r) => setTimeout(r, 0))

afterEach(() => {
  vi.unstubAllGlobals()
  decodeImage.mockReset()
})

describe('thumbnail cache', () => {
  it('retries a failed thumbnail (e.g. after Drive connects) and closes the decoded bitmap', async () => {
    stubBrowser()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let online = false
    const source = vi.fn(async () => {
      if (!online) throw new Error('Drive not connected')
      return new Blob(['x'])
    })
    await createRoot(async (dispose) => {
      const cache = createThumbnailCache(() => source)
      cache.request('i1')
      await flush()
      expect(cache.failed('i1')).toBe(true)
      expect(cache.url('i1')).toBeUndefined()
      online = true
      const d = decoded()
      decodeImage.mockResolvedValue(d)
      cache.retryFailed()
      await flush()
      expect(cache.url('i1')).toBe('blob:1')
      expect(cache.failed('i1')).toBe(false)
      expect(d.close).toHaveBeenCalledTimes(1)
      dispose()
    })
    warn.mockRestore()
  })

  it('closes the bitmap when drawing fails and does not leak a URL on re-request', async () => {
    stubBrowser()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await createRoot(async (dispose) => {
      const cache = createThumbnailCache(() => async () => new Blob(['x']))
      const broken = decoded()
      vi.stubGlobal('document', { createElement: () => ({ getContext: () => ({ drawImage() { throw new Error('draw failed') } }) }) })
      decodeImage.mockResolvedValueOnce(broken)
      cache.request('i1')
      await flush()
      expect(broken.close).toHaveBeenCalledTimes(1)
      expect(cache.failed('i1')).toBe(true)

      const { revoked } = stubBrowser()
      decodeImage.mockImplementation(async () => decoded())
      cache.request('i2')
      cache.forget('i2') // queued job still pending...
      cache.request('i2') // ...and requested again: two jobs, one URL kept
      await flush()
      await flush()
      expect(cache.url('i2')).toBe('blob:2')
      expect(revoked).toEqual(['blob:1'])
      dispose()
    })
    warn.mockRestore()
  })
})
