/**
 * Small planar-geometry helpers: convex hull, polygon area and rasterisation
 * of polygons / circles / rectangles into masks.
 */
import { makeMask, type Mask } from './plane.ts'
import type { Pt } from './contour.ts'

/** Andrew's monotone chain. Returns the hull counter-clockwise (in y-down coordinates: clockwise on screen), no repeated first point. */
export function convexHull(points: Pt[]): Pt[] {
  const pts = points.slice().sort((a, b) => a.x - b.x || a.y - b.y)
  if (pts.length < 3) return pts
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const lower: Pt[] = []
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper: Pt[] = []
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
    upper.push(p)
  }
  upper.pop()
  lower.pop()
  return lower.concat(upper)
}

/** Absolute polygon area (shoelace). */
export function polygonArea(poly: Pt[]): number {
  let a = 0
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]
    const q = poly[(i + 1) % poly.length]
    a += p.x * q.y - q.x * p.y
  }
  return Math.abs(a) / 2
}

/** Rasterise a simple polygon (even–odd rule, pixel centres) into a new mask. */
export function rasterizePolygon(poly: Pt[], width: number, height: number): Mask {
  const m = makeMask(width, height)
  if (poly.length < 3) return m
  const xs: number[] = []
  for (let y = 0; y < height; y++) {
    const cy = y + 0.5
    xs.length = 0
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]
      const b = poly[(i + 1) % poly.length]
      if ((a.y <= cy && b.y > cy) || (b.y <= cy && a.y > cy)) xs.push(a.x + ((cy - a.y) / (b.y - a.y)) * (b.x - a.x))
    }
    xs.sort((p, q) => p - q)
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.max(0, Math.ceil(xs[k] - 0.5))
      const x1 = Math.min(width - 1, Math.floor(xs[k + 1] - 0.5))
      for (let x = x0; x <= x1; x++) m.data[y * width + x] = 1
    }
  }
  return m
}

export function rasterizeCircle(cx: number, cy: number, r: number, width: number, height: number): Mask {
  const m = makeMask(width, height)
  const r2 = r * r
  for (let y = Math.max(0, Math.floor(cy - r)); y < Math.min(height, Math.ceil(cy + r) + 1); y++) {
    for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(width, Math.ceil(cx + r) + 1); x++) {
      const dx = x + 0.5 - cx
      const dy = y + 0.5 - cy
      if (dx * dx + dy * dy <= r2) m.data[y * width + x] = 1
    }
  }
  return m
}

export function rasterizeRect(x: number, y: number, w: number, h: number, width: number, height: number): Mask {
  const m = makeMask(width, height)
  for (let yy = Math.max(0, Math.ceil(y - 0.5)); yy < Math.min(height, Math.floor(y + h - 0.5) + 1); yy++) {
    for (let xx = Math.max(0, Math.ceil(x - 0.5)); xx < Math.min(width, Math.floor(x + w - 0.5) + 1); xx++) m.data[yy * width + xx] = 1
  }
  return m
}

/** Douglas–Peucker simplification of an open or closed polyline. */
export function simplifyPolyline(pts: Pt[], tol: number): Pt[] {
  if (pts.length <= 2) return pts.slice()
  const keep = new Uint8Array(pts.length)
  keep[0] = keep[pts.length - 1] = 1
  const stack: [number, number][] = [[0, pts.length - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()!
    let best = -1
    let bestD = tol
    const A = pts[a]
    const B = pts[b]
    const len = Math.hypot(B.x - A.x, B.y - A.y)
    for (let i = a + 1; i < b; i++) {
      const P = pts[i]
      // closed loops have A === B: fall back to the distance from A
      const d = len < 1e-9 ? Math.hypot(P.x - A.x, P.y - A.y) : Math.abs((B.x - A.x) * (A.y - P.y) - (A.x - P.x) * (B.y - A.y)) / len
      if (d > bestD) {
        bestD = d
        best = i
      }
    }
    if (best >= 0) {
      keep[best] = 1
      stack.push([a, best], [best, b])
    }
  }
  return pts.filter((_, i) => keep[i])
}
