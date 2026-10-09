import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_DISPLAY } from '../model/display'
import type { ImageDisplayAdjust } from '../model/types'
import type { AdjustProcessor, PixelRect } from './adjust-processor'
import { AdjustedLayer, SETTLE_MS, TILE_PX } from './adjusted-layer'
import type { ImageSourceLike, PyramidLevel } from './render'

const src = (w: number, h: number, name: string) => ({ width: w, height: h, name }) as unknown as ImageSourceLike
const flush = () => new Promise((r) => setTimeout(r, 0))

function setup(levels: PyramidLevel[]) {
  let t = 0
  const calls: { name: string; rect?: PixelRect; kind: string }[] = []
  const freed: unknown[] = []
  const processor: AdjustProcessor = {
    adjust: vi.fn(async (s, rect) => {
      calls.push({ name: (s as unknown as { name: string }).name, rect, kind: 'adjust' })
      return src(rect.w, rect.h, `adj-${(s as unknown as { name: string }).name}-${rect.x},${rect.y}`)
    }),
    histogram: vi.fn(async (s) => {
      calls.push({ name: (s as unknown as { name: string }).name, kind: 'histogram' })
      const h = new Uint32Array(256)
      h[40] = 100
      h[200] = 100
      return h
    }),
    mode: () => 'main',
    dispose: vi.fn(),
  }
  const onChange = vi.fn()
  const layer = new AdjustedLayer({ onChange, createProcessor: () => processor, now: () => t, release: (s) => freed.push(s) })
  layer.setLevels(levels)
  return { layer, calls, freed, onChange, processor, advance: (ms: number) => (t += ms) }
}

const adj = (p: Partial<ImageDisplayAdjust>): ImageDisplayAdjust => ({ ...DEFAULT_DISPLAY, ...p })
const whole = { x0: 0, y0: 0, x1: 1e9, y1: 1e9 }

describe('AdjustedLayer', () => {
  it('is inactive for default settings', () => {
    const { layer } = setup([{ source: src(800, 600, 'L0'), scale: 1 }])
    layer.setAdjust(adj({}))
    expect(layer.active()).toBe(false)
    expect(layer.drawable(1, whole)).toBeNull()
  })

  it('processes the needed level, then reuses it on pan/zoom', async () => {
    const { layer, calls, onChange } = setup([{ source: src(800, 600, 'L0'), scale: 1 }])
    layer.setAdjust(adj({ invert: true }))
    expect(layer.drawable(1, whole)).toBeNull() // nothing yet: draw the original
    await flush()
    expect(onChange).toHaveBeenCalled()
    const d = layer.drawable(1, whole)!
    expect(d.levels).toHaveLength(1)
    expect((d.levels[0].source as unknown as { name: string }).name).toBe('adj-L0-0,0')
    layer.drawable(2, { x0: 10, y0: 10, x1: 20, y1: 20 })
    await flush()
    expect(calls).toHaveLength(1)
  })

  it('computes the auto-contrast histogram on the coarsest level first', async () => {
    const levels = [
      { source: src(2000, 1500, 'L0'), scale: 1 },
      { source: src(1000, 750, 'L1'), scale: 0.5 },
    ]
    const { layer, calls, advance } = setup(levels)
    layer.setAdjust(adj({ autoContrast: true, channel: 'green' }))
    layer.drawable(1, whole)
    await flush()
    await flush()
    // histogram + quick preview of the coarsest level; the 3 MP level waits for settle
    expect(calls.map((c) => `${c.kind}:${c.name}`)).toEqual(['histogram:L1', 'adjust:L1'])
    advance(SETTLE_MS)
    layer.drawable(1, whole)
    await flush()
    expect(calls.map((c) => c.name)).toEqual(['L1', 'L1', 'L0'])
  })

  it('keeps showing the previous settings until the new ones have pixels', async () => {
    const { layer, freed } = setup([{ source: src(800, 600, 'L0'), scale: 1 }])
    layer.setAdjust(adj({ invert: true }))
    layer.drawable(1, whole)
    await flush()
    layer.setAdjust(adj({ gamma: 2 }))
    const d = layer.drawable(1, whole)!
    expect((d.levels[0].source as unknown as { name: string }).name).toBe('adj-L0-0,0')
    await flush()
    expect(freed).toHaveLength(1) // the stale result was released once replaced
  })

  it('tiles very large levels, only around the visible region, over the base level', async () => {
    const levels = [
      { source: src(6016, 4016, 'L0'), scale: 1 },
      { source: src(3008, 2008, 'L1'), scale: 0.5 },
      { source: src(752, 502, 'L3'), scale: 0.125 },
    ]
    const { layer, calls, advance } = setup(levels)
    layer.setAdjust(adj({ contrast: 0.5 }))
    advance(SETTLE_MS)
    const view = { x0: 100, y0: 100, x1: 600, y1: 500 }
    for (let i = 0; i < 8; i++) {
      layer.drawable(2, view)
      await flush()
    }
    const names = calls.map((c) => c.name)
    expect(names.slice(0, 2)).toEqual(['L3', 'L1'])
    const tiles = calls.filter((c) => c.name === 'L0')
    expect(tiles.length).toBe(1) // 100..600 x 100..500 sits in tile (0,0)
    expect(tiles[0].rect).toEqual({ x: 0, y: 0, w: TILE_PX, h: TILE_PX })
    expect(calls.some((c) => c.name === 'L0' && c.rect!.w === 6016)).toBe(false)
    const d = layer.drawable(2, view)!
    expect(d.tiles).toHaveLength(1)
    expect(d.levels.map((l) => l.scale)).toEqual([0.5, 0.125])
  })

  it('skips full-resolution tiles when too much is visible', async () => {
    const levels = [
      { source: src(8000, 6000, 'L0'), scale: 1 },
      { source: src(2000, 1500, 'L1'), scale: 0.25 },
    ]
    const { layer, calls, advance } = setup(levels)
    layer.setAdjust(adj({ contrast: 0.5 }))
    advance(SETTLE_MS)
    for (let i = 0; i < 4; i++) {
      layer.drawable(1, { x0: 0, y0: 0, x1: 8000, y1: 6000 })
      await flush()
    }
    expect(calls.map((c) => c.name)).toEqual(['L1'])
  })

  it('drops results for a different image', async () => {
    const { layer, freed } = setup([{ source: src(800, 600, 'A'), scale: 1 }])
    layer.setAdjust(adj({ invert: true }))
    layer.drawable(1, whole)
    await flush()
    layer.setLevels([{ source: src(800, 600, 'B'), scale: 1 }])
    expect(freed).toHaveLength(1)
    expect(layer.drawable(1, whole)).toBeNull()
  })
})
