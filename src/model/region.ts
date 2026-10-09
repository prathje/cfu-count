/**
 * Selection regions (pure geometry). A region is a closed polygon in ORIGINAL
 * image coordinates (same convention as annotations). It is a working selection:
 * it never creates or changes annotations by itself, and only reaches stored
 * data as `DetectionRun.roi` ({ kind: 'polygon', points }) when suggestions
 * found inside it are accepted.
 */
import type { Annotation, ID } from './types'
import { isConfirmed } from './annotations'

export interface Pt {
  x: number
  y: number
}

/** A closed polygon (the last point connects back to the first), image px. */
export type RegionPolygon = readonly Pt[]

/** How a region is drawn: freehand loop or an axis-aligned rectangle. */
export type RegionShape = 'lasso' | 'rect'

/** Smallest region side, in SCREEN CSS px at the zoom it was drawn at. */
export const MIN_REGION_SCREEN_PX = 16
/** Simplification tolerance for a lasso, in screen CSS px. */
export const REGION_SIMPLIFY_SCREEN_PX = 1.5
/** A simplified region never keeps more points than this. */
export const MAX_REGION_POINTS = 400

/**
 * Even-odd point-in-polygon test (ray casting). Points exactly on an edge may
 * fall either way; colonies are counted by their centre, so this never matters
 * in practice.
 */
export function pointInPolygon(x: number, y: number, poly: RegionPolygon): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

/** Absolute area (shoelace). */
export function polygonArea(poly: RegionPolygon): number {
  let s = 0
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) s += (poly[j].x + poly[i].x) * (poly[j].y - poly[i].y)
  return Math.abs(s) / 2
}

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

export function polygonBounds(poly: RegionPolygon): Bounds {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const p of poly) {
    if (p.x < x0) x0 = p.x
    if (p.y < y0) y0 = p.y
    if (p.x > x1) x1 = p.x
    if (p.y > y1) y1 = p.y
  }
  return poly.length ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : { x: 0, y: 0, width: 0, height: 0 }
}

/** Perpendicular distance from p to segment ab. */
function segmentDistance(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y)
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

/** Ramer–Douglas–Peucker simplification of an open polyline (endpoints kept). */
export function simplifyPath(pts: readonly Pt[], tolerance: number): Pt[] {
  if (pts.length <= 2) return pts.map((p) => ({ x: p.x, y: p.y }))
  const keep = new Uint8Array(pts.length)
  keep[0] = keep[pts.length - 1] = 1
  const stack: [number, number][] = [[0, pts.length - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()!
    let best = -1
    let bestD = tolerance
    for (let i = a + 1; i < b; i++) {
      const d = segmentDistance(pts[i], pts[a], pts[b])
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
  const out: Pt[] = []
  pts.forEach((p, i) => keep[i] && out.push({ x: p.x, y: p.y }))
  return out
}

/**
 * Simplify a CLOSED loop: split at the point farthest from the first, simplify
 * both halves (so the start point is not special), drop the duplicate join and
 * a closing point equal to the first.
 */
export function simplifyClosed(pts: readonly Pt[], tolerance: number): Pt[] {
  const ring = pts.length > 1 && pts[0].x === pts.at(-1)!.x && pts[0].y === pts.at(-1)!.y ? pts.slice(0, -1) : pts.slice()
  if (ring.length <= 3) return ring.map((p) => ({ x: p.x, y: p.y }))
  let far = 0
  let farD = -1
  ring.forEach((p, i) => {
    const d = Math.hypot(p.x - ring[0].x, p.y - ring[0].y)
    if (d > farD) [far, farD] = [i, d]
  })
  const a = simplifyPath(ring.slice(0, far + 1), tolerance)
  const b = simplifyPath([...ring.slice(far), ring[0]], tolerance)
  return [...a, ...b.slice(1, -1)]
}

/** The rectangle spanned by two corners, as a polygon (clockwise in screen orientation). */
export function rectPolygon(a: Pt, b: Pt): Pt[] {
  const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x)
  const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y)
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ]
}

export interface FinishRegionInput {
  /** Raw pointer path in IMAGE px (lasso) — for 'rect' only the first and last point matter. */
  points: readonly Pt[]
  shape: RegionShape
  /** Screen CSS px per image px while drawing (tolerances are screen-based). */
  scale: number
  imageWidth: number
  imageHeight: number
}

export type FinishRegionResult = { ok: true; polygon: Pt[] } | { ok: false; reason: 'too-small' }

/**
 * Turn a drawn path into a stored region: rectangle or simplified closed loop,
 * clamped to the image, rounded to 0.1 px. Refuses regions smaller than
 * MIN_REGION_SCREEN_PX on screen in either direction (a stray tap or flick).
 */
export function finishRegion(i: FinishRegionInput): FinishRegionResult {
  if (i.points.length < 2) return { ok: false, reason: 'too-small' }
  const clamp = (p: Pt): Pt => ({
    x: Math.round(Math.min(Math.max(p.x, 0), i.imageWidth) * 10) / 10,
    y: Math.round(Math.min(Math.max(p.y, 0), i.imageHeight) * 10) / 10,
  })
  const minSide = MIN_REGION_SCREEN_PX / i.scale
  let poly: Pt[]
  if (i.shape === 'rect') poly = rectPolygon(i.points[0], i.points.at(-1)!).map(clamp)
  else {
    let tol = REGION_SIMPLIFY_SCREEN_PX / i.scale
    poly = simplifyClosed(i.points.map(clamp), tol)
    // very long loops: coarsen until the point budget holds
    while (poly.length > MAX_REGION_POINTS) {
      tol *= 1.6
      poly = simplifyClosed(i.points.map(clamp), tol)
    }
  }
  const b = polygonBounds(poly)
  if (poly.length < 3 || b.width < minSide || b.height < minSide || polygonArea(poly) < 0.25 * minSide * minSide) return { ok: false, reason: 'too-small' }
  return { ok: true, polygon: poly }
}

/** Annotations whose CENTRE lies inside the region (bounding-box prefilter). */
export function annotationsInRegion<T extends Pt>(list: readonly T[], poly: RegionPolygon): T[] {
  if (poly.length < 3) return []
  const b = polygonBounds(poly)
  return list.filter((a) => a.x >= b.x && a.x <= b.x + b.width && a.y >= b.y && a.y <= b.y + b.height && pointInPolygon(a.x, a.y, poly))
}

/** Counts inside a region for the region bar. */
export interface RegionTally {
  /** Stored annotations of the group (any origin / review state): what Clear removes. */
  group: { total: number; manual: number; automated: number }
  /** Confirmed annotations of the group (what the header counts). */
  groupConfirmed: number
  /** Confirmed annotations of all groups. */
  allConfirmed: number
}

export function regionTally(annotations: readonly Annotation[], poly: RegionPolygon, groupId: ID | null): RegionTally {
  const t: RegionTally = { group: { total: 0, manual: 0, automated: 0 }, groupConfirmed: 0, allConfirmed: 0 }
  for (const a of annotationsInRegion(annotations, poly)) {
    const confirmed = isConfirmed(a)
    if (confirmed) t.allConfirmed++
    if (a.groupId !== groupId) continue
    t.group.total++
    if (a.origin === 'manual') t.group.manual++
    else t.group.automated++
    if (confirmed) t.groupConfirmed++
  }
  return t
}
