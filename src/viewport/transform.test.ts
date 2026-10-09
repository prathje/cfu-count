import { describe, expect, it } from 'vitest'
import {
  classifyWheel,
  constrainView,
  fitScale,
  fitView,
  imageToScreen,
  MAX_SCALE,
  panBy,
  resizeView,
  scaleLimits,
  screenToImage,
  viewCenter,
  wheelDeltaToPixels,
  wheelZoomFactor,
  zoomAt,
  zoomToAt,
} from './transform'

const image = { width: 4000, height: 3000 }
const vp = { width: 1000, height: 800 }

describe('image <-> screen transform', () => {
  it('round-trips arbitrary points', () => {
    const view = { scale: 0.37, offsetX: 123.4, offsetY: -56.7 }
    for (const [x, y] of [[0, 0], [10.5, 20.25], [3999, 2999], [-5, 7000]]) {
      const s = imageToScreen(view, x, y)
      const p = screenToImage(view, s.x, s.y)
      expect(p.x).toBeCloseTo(x, 9)
      expect(p.y).toBeCloseTo(y, 9)
    }
  })

  it('maps the offset to the top-left corner', () => {
    const view = { scale: 2, offsetX: 100, offsetY: 50 }
    expect(imageToScreen(view, 100, 50)).toEqual({ x: 0, y: 0 })
    expect(imageToScreen(view, 101, 51)).toEqual({ x: 2, y: 2 })
  })
})

describe('fit', () => {
  it('contains the image with padding and centres it', () => {
    const v = fitView(image, vp, 24)
    expect(v.scale).toBeCloseTo(Math.min((1000 - 48) / 4000, (800 - 48) / 3000))
    const c = viewCenter(v, vp)
    expect(c.x).toBeCloseTo(2000)
    expect(c.y).toBeCloseTo(1500)
    const tl = imageToScreen(v, 0, 0)
    const br = imageToScreen(v, 4000, 3000)
    expect(tl.x).toBeGreaterThanOrEqual(23.99)
    expect(tl.y).toBeGreaterThanOrEqual(23.99)
    expect(br.x).toBeLessThanOrEqual(1000 - 23.99)
    expect(br.y).toBeLessThanOrEqual(800 - 23.99)
  })

  it('fits within the area not covered by insets (toolbar/footer)', () => {
    const insets = { top: 56, right: 0, bottom: 48, left: 0 }
    const v = fitView(image, vp, 24, insets)
    const tl = imageToScreen(v, 0, 0)
    const br = imageToScreen(v, 4000, 3000)
    expect(tl.y).toBeGreaterThanOrEqual(56 + 23.99)
    expect(br.y).toBeLessThanOrEqual(800 - 48 - 23.99)
    // centred in the uncovered band
    expect((tl.y + br.y) / 2).toBeCloseTo(56 + (800 - 56 - 48) / 2)
    expect((tl.x + br.x) / 2).toBeCloseTo(500)
    expect(v.scale).toBeLessThan(fitView(image, vp, 24).scale)
  })

  it('survives insets larger than the viewport', () => {
    const v = fitView(image, vp, 24, { top: 900, right: 900, bottom: 900, left: 900 })
    expect(Number.isFinite(v.scale) && v.scale > 0).toBe(true)
  })

  it('limits padding on tiny viewports', () => {
    expect(fitScale(image, { width: 40, height: 40 }, 24)).toBeGreaterThan(0)
  })
})

describe('zoom', () => {
  const limits = scaleLimits(image, vp)

  it('keeps the image point under the anchor fixed', () => {
    const view = fitView(image, vp)
    const before = screenToImage(view, 321, 654)
    const z = zoomAt(view, 321, 654, 3, limits)
    expect(z.scale).toBeCloseTo(view.scale * 3)
    const after = screenToImage(z, 321, 654)
    expect(after.x).toBeCloseTo(before.x, 9)
    expect(after.y).toBeCloseTo(before.y, 9)
  })

  it('clamps scale but still anchors', () => {
    const view = fitView(image, vp)
    const z = zoomAt(view, 10, 10, 1e6, limits)
    expect(z.scale).toBe(MAX_SCALE)
    const a = screenToImage(view, 10, 10)
    const b = screenToImage(z, 10, 10)
    expect(b.x).toBeCloseTo(a.x, 9)
    const out = zoomAt(view, 10, 10, 1e-6, limits)
    expect(out.scale).toBeCloseTo(fitScale(image, vp) * 0.5)
  })

  it('zoomToAt sets an absolute scale', () => {
    expect(zoomToAt(fitView(image, vp), 500, 400, 2, limits).scale).toBe(2)
  })
})

describe('pan, constrain, resize', () => {
  it('pans content with the pointer', () => {
    const view = { scale: 2, offsetX: 100, offsetY: 100 }
    const p = imageToScreen(view, 150, 150)
    const moved = panBy(view, 30, -10)
    const q = imageToScreen(moved, 150, 150)
    expect(q.x - p.x).toBeCloseTo(30)
    expect(q.y - p.y).toBeCloseTo(-10)
  })

  it('keeps the viewport centre within the image', () => {
    const v = constrainView(panBy(fitView(image, vp), 1e6, 1e6), image, vp)
    const c = viewCenter(v, vp)
    expect(c.x).toBeCloseTo(0)
    expect(c.y).toBeCloseTo(0)
    const inside = fitView(image, vp)
    expect(constrainView(inside, image, vp)).toBe(inside)
  })

  it('preserves the centre image point and scale on resize / rotation', () => {
    const view = { scale: 1.3, offsetX: 700, offsetY: 900 }
    const c = viewCenter(view, vp)
    const rotated = { width: 800, height: 1000 }
    const r = resizeView(view, vp, rotated)
    expect(r.scale).toBe(1.3)
    const c2 = viewCenter(r, rotated)
    expect(c2.x).toBeCloseTo(c.x, 9)
    expect(c2.y).toBeCloseTo(c.y, 9)
  })
})

describe('wheel', () => {
  it('converts delta modes to pixels', () => {
    expect(wheelDeltaToPixels(3, 0, 800)).toBe(3)
    expect(wheelDeltaToPixels(3, 1, 800)).toBe(48)
    expect(wheelDeltaToPixels(1, 2, 800)).toBe(800)
  })

  it('classifies common devices', () => {
    // trackpad pinch in Chrome/Firefox/Safari 15+: ctrlKey wheel
    expect(classifyWheel({ deltaX: 0, deltaY: 2.5, deltaMode: 0, ctrlKey: true })).toBe('pinch')
    // Firefox notched wheel: line mode
    expect(classifyWheel({ deltaX: 0, deltaY: 3, deltaMode: 1, ctrlKey: false })).toBe('zoom')
    // Chrome/Windows notched wheel
    expect(classifyWheel({ deltaX: 0, deltaY: 100, deltaMode: 0, ctrlKey: false, wheelDeltaY: -120 })).toBe('zoom')
    // macOS trackpad scroll: wheelDeltaY = -3 * deltaY
    expect(classifyWheel({ deltaX: 0, deltaY: 4, deltaMode: 0, ctrlKey: false, wheelDeltaY: -12 })).toBe('pan')
    // diagonal / horizontal scroll
    expect(classifyWheel({ deltaX: 1, deltaY: 4, deltaMode: 0, ctrlKey: false })).toBe('pan')
    // fractional delta: smooth scrolling device
    expect(classifyWheel({ deltaX: 0, deltaY: 1.5, deltaMode: 0, ctrlKey: false })).toBe('pan')
    // continuing stream keeps its classification
    expect(classifyWheel({ deltaX: 0, deltaY: 100, deltaMode: 0, ctrlKey: false }, 'pan')).toBe('pan')
  })

  it('zoom factor direction and bounds', () => {
    expect(wheelZoomFactor(100, 'zoom')).toBeLessThan(1)
    expect(wheelZoomFactor(-100, 'zoom')).toBeGreaterThan(1)
    expect(wheelZoomFactor(1e9, 'pinch')).toBeCloseTo(Math.exp(-3))
  })
})
