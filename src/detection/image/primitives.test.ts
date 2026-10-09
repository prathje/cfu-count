import { describe, expect, it } from 'vitest'
import { makeMask, makePlane, sampleBilinear, type Mask, type Plane } from './plane.ts'
import { rgbToLab, toLab } from './color.ts'
import { boxBlur, boxRadiiForGauss, gaussianBlur, gaussianKernel, medianFilter, normalizedBlur, resizeArea } from './filters.ts'
import { dilate, erode, whiteTopHat } from './morphology.ts'
import { distanceTransform } from './distance.ts'
import { fillHoles, labelComponents } from './components.ts'
import { adaptiveThreshold, mad, median, otsuThreshold, quantile } from './threshold.ts'
import { detectBlobsLoG, localMaxima, logResponse, nmsCircles } from './blobs.ts'
import { arcSpan, boundaryMask, concavePoints, fitCircleKasa, refineCircle, splitArcs, traceAllOuterContours } from './contour.ts'
import { houghCircle, ransacCircle } from './hough.ts'
import { watershed } from './watershed.ts'

/** Plane with value 1 inside the given disks (anti-aliasing free), 0 elsewhere. */
function disks(w: number, h: number, ds: { x: number; y: number; r: number }[], fg = 1, bg = 0): Plane {
  const p = makePlane(w, h, bg)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (const d of ds) if (Math.hypot(x + 0.5 - d.x, y + 0.5 - d.y) <= d.r) p.data[y * w + x] = fg
  return p
}
const toMask = (p: Plane, t = 0.5): Mask => {
  const m = makeMask(p.width, p.height)
  for (let i = 0; i < m.data.length; i++) m.data[i] = p.data[i] > t ? 1 : 0
  return m
}
const lcg = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)

describe('plane', () => {
  it('samples bilinearly between pixel centres', () => {
    const p = makePlane(2, 1)
    p.data.set([0, 10])
    expect(sampleBilinear(p, 0.5, 0.5)).toBeCloseTo(0)
    expect(sampleBilinear(p, 1.0, 0.5)).toBeCloseTo(5)
    expect(sampleBilinear(p, 1.5, 0.5)).toBeCloseTo(10)
  })
})

describe('color', () => {
  it('maps white, black and mid-grey to the expected Lab', () => {
    const [Lw, aw, bw] = rgbToLab(255, 255, 255)
    expect(Lw).toBeCloseTo(100, 1)
    expect(Math.abs(aw)).toBeLessThan(0.1)
    expect(Math.abs(bw)).toBeLessThan(0.1)
    expect(rgbToLab(0, 0, 0)[0]).toBeCloseTo(0, 3)
    expect(rgbToLab(119, 119, 119)[0]).toBeCloseTo(50, 0)
  })
  it('has positive a for red and negative b for blue', () => {
    expect(rgbToLab(255, 0, 0)[1]).toBeGreaterThan(70)
    expect(rgbToLab(0, 0, 255)[2]).toBeLessThan(-100)
  })
  it('converts whole images consistently with the scalar function', () => {
    const img = { width: 2, height: 1, data: new Uint8ClampedArray([10, 200, 30, 255, 10, 200, 30, 255]) }
    const lab = toLab(img)
    const ref = rgbToLab(10, 200, 30)
    expect(lab.L.data[1]).toBeCloseTo(ref[0], 4)
    expect(lab.a.data[0]).toBeCloseTo(ref[1], 4)
  })
})

describe('filters', () => {
  it('Gaussian kernel is normalised and symmetric', () => {
    const k = gaussianKernel(2)
    expect(k.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6)
    expect(k[0]).toBeCloseTo(k[k.length - 1], 8)
  })
  it('blur preserves a constant image and the mean of an impulse', () => {
    const c = gaussianBlur(makePlane(20, 20, 3), 2)
    expect(c.data[0]).toBeCloseTo(3, 5)
    const imp = makePlane(41, 41)
    imp.data[20 * 41 + 20] = 1
    const b = gaussianBlur(imp, 3)
    expect(b.data.reduce((a, v) => a + v, 0)).toBeCloseTo(1, 4)
    // variance of the blurred impulse ≈ σ²
    let v = 0
    for (let y = 0; y < 41; y++) for (let x = 0; x < 41; x++) v += b.data[y * 41 + x] * (x - 20) ** 2
    expect(v).toBeCloseTo(9, 0)
  })
  it('large-σ box approximation has the right variance', () => {
    const radii = boxRadiiForGauss(12, 3)
    const variance = radii.reduce((a, r) => a + ((2 * r + 1) ** 2 - 1) / 12, 0)
    expect(Math.sqrt(variance)).toBeCloseTo(12, 0)
    const imp = makePlane(201, 1)
    imp.data[100] = 1
    const b = gaussianBlur(imp, 12)
    // only the row direction matters for a 1-row image; columns are clamped (no change)
    expect(b.data.reduce((a, v) => a + v, 0)).toBeCloseTo(1, 3)
  })
  it('box blur averages a window', () => {
    const p = makePlane(5, 1)
    p.data.set([0, 0, 9, 0, 0])
    expect(boxBlur(p, 1).data[2]).toBeCloseTo(3)
    expect(boxBlur(p, 1).data[1]).toBeCloseTo(3)
  })
  it('normalised blur ignores masked-out pixels', () => {
    const p = makePlane(10, 10, 5)
    const w = new Uint8Array(100).fill(1)
    for (let i = 0; i < 50; i++) {
      p.data[i] = 1000
      w[i] = 0
    }
    const b = normalizedBlur(p, w, 3)
    expect(b.data[0]).toBeCloseTo(5, 3)
    expect(b.data[99]).toBeCloseTo(5, 3)
  })
  it('median removes an impulse', () => {
    const p = makePlane(5, 5, 1)
    p.data[12] = 100
    expect(medianFilter(p, 1).data[12]).toBe(1)
  })
  it('area resize averages blocks', () => {
    const p = makePlane(4, 2)
    p.data.set([1, 3, 5, 7, 1, 3, 5, 7])
    const r = resizeArea(p, 2, 1)
    expect(Array.from(r.data)).toEqual([2, 6])
  })
})

describe('morphology', () => {
  it('erode/dilate are running min/max', () => {
    const p = makePlane(7, 1)
    p.data.set([5, 1, 5, 5, 5, 9, 5])
    expect(Array.from(erode(p, 1).data)).toEqual([1, 1, 1, 5, 5, 5, 5])
    expect(Array.from(dilate(p, 1).data)).toEqual([5, 5, 5, 5, 9, 9, 9])
  })
  it('white top-hat removes a ramp but keeps a small bright spot', () => {
    const p = makePlane(40, 40)
    for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) p.data[y * 40 + x] = x * 0.5
    for (let y = 18; y <= 21; y++) for (let x = 18; x <= 21; x++) p.data[y * 40 + x] += 10
    const t = whiteTopHat(p, 4)
    expect(t.data[19 * 40 + 19]).toBeGreaterThan(8)
    expect(Math.abs(t.data[5 * 40 + 30])).toBeLessThan(2.5)
  })
})

describe('distance transform', () => {
  it('gives the distance to the nearest background pixel', () => {
    const m = toMask(disks(41, 41, [{ x: 20.5, y: 20.5, r: 10 }]))
    const d = distanceTransform(m)
    expect(d.data[20 * 41 + 20]).toBeGreaterThan(9.5)
    expect(d.data[20 * 41 + 20]).toBeLessThan(11.5)
    expect(d.data[0]).toBe(0)
  })
  it('treats the raster border as background', () => {
    const m = makeMask(5, 5, 1)
    const d = distanceTransform(m)
    expect(d.data[12]).toBe(3)
    expect(d.data[0]).toBe(1)
  })
})

describe('components', () => {
  it('labels separate blobs with area and centroid', () => {
    const m = toMask(disks(60, 30, [{ x: 10, y: 15, r: 5 }, { x: 45, y: 15, r: 8 }]))
    const l = labelComponents(m)
    expect(l.count).toBe(2)
    const big = l.stats.find((s) => s.area > 150)!
    expect(big.cx).toBeCloseTo(45, 0)
    expect(big.area).toBeGreaterThan(Math.PI * 64 * 0.9)
  })
  it('joins diagonal neighbours only with 8-connectivity', () => {
    const m = makeMask(2, 2)
    m.data.set([1, 0, 0, 1])
    expect(labelComponents(m, 8).count).toBe(1)
    expect(labelComponents(m, 4).count).toBe(2)
  })
  it('fills holes', () => {
    const ring = disks(21, 21, [{ x: 10.5, y: 10.5, r: 8 }])
    const hole = disks(21, 21, [{ x: 10.5, y: 10.5, r: 3 }])
    const m = makeMask(21, 21)
    for (let i = 0; i < m.data.length; i++) m.data[i] = ring.data[i] && !hole.data[i] ? 1 : 0
    expect(m.data[10 * 21 + 10]).toBe(0)
    expect(fillHoles(m).data[10 * 21 + 10]).toBe(1)
    expect(fillHoles(m).data[0]).toBe(0)
  })
})

describe('threshold', () => {
  it('Otsu splits a bimodal distribution', () => {
    const v = new Float32Array(1000)
    const rnd = lcg(1)
    for (let i = 0; i < 1000; i++) v[i] = (i < 700 ? 20 : 80) + (rnd() - 0.5) * 10
    const t = otsuThreshold(v)
    expect(t).toBeGreaterThan(30)
    expect(t).toBeLessThan(70)
  })
  it('adaptive threshold finds a spot on a gradient', () => {
    const p = makePlane(30, 30)
    for (let i = 0; i < 900; i++) p.data[i] = (i % 30) * 2
    p.data[15 * 30 + 15] += 20
    const m = adaptiveThreshold(p, 3, 5)
    expect(m.data[15 * 30 + 15]).toBe(1)
    expect(m.data[15 * 30 + 5]).toBe(0)
  })
  it('robust statistics', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 2, 3])).toBe(2.5)
    expect(mad([1, 1, 1, 1, 100])).toBe(0)
    expect(quantile([0, 10], 0.25)).toBeCloseTo(2.5)
  })
})

describe('blobs', () => {
  it('LoG response peaks at σ = r/√2 at the blob centre', () => {
    const p = disks(61, 61, [{ x: 30.5, y: 30.5, r: 8 }])
    const vals = [3, 4, 5.66, 7, 9].map((s) => logResponse(p, s).data[30 * 61 + 30])
    const best = vals.indexOf(Math.max(...vals))
    expect(best).toBe(2)
  })
  it('local maxima handles plateaus once', () => {
    const p = makePlane(5, 1)
    p.data.set([0, 2, 2, 0, 1])
    const pk = localMaxima(p, 1, 0.5)
    expect(pk.map((q) => q.x)).toEqual([1.5, 4.5])
  })
  it('multi-scale LoG detects two blobs of different size', () => {
    const p = disks(120, 60, [{ x: 30, y: 30, r: 6 }, { x: 85, y: 30, r: 12 }])
    const { blobs } = detectBlobsLoG(p, [4, 6, 8, 10, 12, 14], 0.1)
    expect(blobs.length).toBe(2)
    const small = blobs.find((b) => b.x < 60)!
    const large = blobs.find((b) => b.x > 60)!
    expect(small.r).toBeLessThan(large.r)
    expect(Math.abs(large.r - 12)).toBeLessThanOrEqual(2)
  })
  it('NMS keeps the strongest of overlapping circles', () => {
    const kept = nmsCircles(
      [
        { x: 0, y: 0, r: 5, s: 1 },
        { x: 1, y: 0, r: 5, s: 2 },
        { x: 20, y: 0, r: 5, s: 0.5 },
      ],
      0.5,
      (c) => c.s,
    )
    expect(kept.map((k) => k.s)).toEqual([2, 0.5])
  })
})

describe('contours and circle fits', () => {
  it('boundary mask is the 1-px rim', () => {
    const m = makeMask(5, 5, 1)
    const b = boundaryMask(m)
    expect(b.data.reduce((a, v) => a + v, 0)).toBe(16)
  })
  it('traces a closed outer contour around a disk', () => {
    const m = toMask(disks(40, 40, [{ x: 20, y: 20, r: 10 }]))
    const cs = traceAllOuterContours(m)
    expect(cs.length).toBe(1)
    const c = fitCircleKasa(cs[0])!
    expect(c.x).toBeCloseTo(20, 0)
    expect(c.r).toBeGreaterThan(8.5)
    expect(c.r).toBeLessThan(10.5)
    // every contour point is a boundary pixel
    const b = boundaryMask(m)
    for (const p of cs[0]) expect(b.data[Math.floor(p.y) * 40 + Math.floor(p.x)]).toBe(1)
  })
  it('finds the two concave points of a two-disk union and splits arcs', () => {
    const m = toMask(disks(60, 40, [{ x: 20, y: 20, r: 10 }, { x: 36, y: 20, r: 10 }]))
    const c = traceAllOuterContours(m)[0]
    const cuts = concavePoints(c, m, 5)
    expect(cuts.length).toBe(2)
    const arcs = splitArcs(c, cuts)
    expect(arcs.length).toBe(2)
    const fits = arcs.map((a) => refineCircle(a, fitCircleKasa(a)!)).sort((a, b) => a.x - b.x)
    expect(fits[0].x).toBeCloseTo(20, 0)
    expect(fits[1].x).toBeCloseTo(36, 0)
    for (const a of arcs) expect(arcSpan(a, refineCircle(a, fitCircleKasa(a)!))).toBeGreaterThan(Math.PI)
  })
  it('Kåsa + geometric refinement recover an exact circle from a partial arc', () => {
    const pts = Array.from({ length: 30 }, (_, i) => {
      const t = (i / 29) * Math.PI
      return { x: 5 + 7 * Math.cos(t), y: -3 + 7 * Math.sin(t) }
    })
    const c = refineCircle(pts, fitCircleKasa(pts)!)
    expect(c.x).toBeCloseTo(5, 4)
    expect(c.y).toBeCloseTo(-3, 4)
    expect(c.r).toBeCloseTo(7, 4)
  })
})

describe('hough', () => {
  it('finds a bright disk on a dark background', () => {
    const p = disks(120, 100, [{ x: 58, y: 47, r: 35 }], 200, 50)
    const c = houghCircle(p, { rMin: 20, rMax: 45 })!
    expect(Math.abs(c.x - 58)).toBeLessThan(2)
    expect(Math.abs(c.y - 47)).toBeLessThan(2)
    expect(Math.abs(c.r - 35)).toBeLessThan(2.5)
    expect(c.support).toBeGreaterThan(0.8)
  })
  it('RANSAC ignores outliers', () => {
    const rnd = lcg(7)
    const pts = Array.from({ length: 60 }, (_, i) => ({ x: 10 * Math.cos(i / 10), y: 10 * Math.sin(i / 10) }))
    for (let i = 0; i < 20; i++) pts.push({ x: rnd() * 40 - 20, y: rnd() * 40 - 20 })
    const c = ransacCircle(pts, 0.5, 300, rnd)!
    expect(c.r).toBeCloseTo(10, 1)
    expect(c.inliers).toBeGreaterThanOrEqual(60)
  })
})

describe('watershed', () => {
  it('splits two touching disks along the neck using DT markers', () => {
    const m = toMask(disks(60, 40, [{ x: 20, y: 20, r: 10 }, { x: 36, y: 20, r: 10 }]))
    const d = distanceTransform(m)
    const cost = makePlane(60, 40)
    for (let i = 0; i < cost.data.length; i++) cost.data[i] = -d.data[i]
    const markers = new Int32Array(60 * 40)
    markers[20 * 60 + 19] = 1
    markers[20 * 60 + 36] = 2
    const lab = watershed(cost, markers, m.data)
    expect(lab[20 * 60 + 12]).toBe(1)
    expect(lab[20 * 60 + 44]).toBe(2)
    let a1 = 0, a2 = 0, un = 0
    for (let i = 0; i < lab.length; i++) {
      if (!m.data[i]) continue
      if (lab[i] === 1) a1++
      else if (lab[i] === 2) a2++
      else un++
    }
    expect(un).toBe(0)
    expect(Math.abs(a1 - a2) / (a1 + a2)).toBeLessThan(0.1)
  })
})

describe('nmsCircles at scale', () => {
  it('handles more candidates than the engine argument limit', () => {
    const items = Array.from({ length: 300_000 }, (_, i) => ({ x: (i % 1000) * 3, y: Math.floor(i / 1000) * 3, r: i === 7 ? 1.2 : 1 }))
    expect(nmsCircles(items, 0.5, () => 1).length).toBe(300_000)
  })
})
