/**
 * Nearest-point queries over annotations in image coordinates, behind a small
 * interface so the strategy can change without touching callers.
 *
 * Two implementations:
 *  - LinearIndex: no build cost, O(n) per query.
 *  - GridIndex: uniform grid, O(n) build, ~O(1) per query for bounded radii.
 * createPointIndex() picks one by size; see spatial-index.test.ts for the
 * benchmark that set GRID_THRESHOLD.
 */
import type { Annotation } from '../model/types'

/** Result of a nearest-point query. */
export interface HitResult {
  annotation: Annotation
  /** Euclidean distance in image px. */
  distance: number
}

/** Read-only nearest-neighbour query over a fixed set of annotations. */
export interface PointIndex {
  /**
   * Nearest annotation to (x, y) within `radius` image px that passes `filter`.
   * Ties resolve to the later annotation in the source array (drawn on top).
   */
  nearest(x: number, y: number, radius: number, filter?: (a: Annotation) => boolean): HitResult | null
}

/** Below this many points a linear scan is used (no build cost on every edit). */
export const GRID_THRESHOLD = 2000

export function createPointIndex(points: readonly Annotation[]): PointIndex {
  return points.length < GRID_THRESHOLD ? new LinearIndex(points) : new GridIndex(points)
}

export class LinearIndex implements PointIndex {
  private readonly points: readonly Annotation[]
  constructor(points: readonly Annotation[]) {
    this.points = points
  }

  nearest(x: number, y: number, radius: number, filter?: (a: Annotation) => boolean): HitResult | null {
    const pts = this.points
    let best: Annotation | null = null
    let bestD2 = radius * radius
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]
      const dx = a.x - x
      if (dx > radius || dx < -radius) continue
      const dy = a.y - y
      if (dy > radius || dy < -radius) continue
      const d2 = dx * dx + dy * dy
      if (d2 <= bestD2 && (!filter || filter(a))) {
        best = a
        bestD2 = d2
      }
    }
    return best ? { annotation: best, distance: Math.sqrt(bestD2) } : null
  }
}

export class GridIndex implements PointIndex {
  private readonly points: readonly Annotation[]
  private readonly cell: number
  private readonly minX: number
  private readonly minY: number
  private readonly cols: number
  private readonly rows: number
  /** CSR layout: indices of points per cell, cell c occupies [starts[c], starts[c+1]). */
  private readonly starts: Uint32Array
  private readonly items: Uint32Array

  constructor(points: readonly Annotation[], cellSize = 64) {
    this.points = points
    this.cell = cellSize
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const p of points) {
      if (p.x < minX) minX = p.x
      if (p.y < minY) minY = p.y
      if (p.x > maxX) maxX = p.x
      if (p.y > maxY) maxY = p.y
    }
    if (points.length === 0) minX = minY = maxX = maxY = 0
    this.minX = minX
    this.minY = minY
    this.cols = Math.max(1, Math.floor((maxX - minX) / cellSize) + 1)
    this.rows = Math.max(1, Math.floor((maxY - minY) / cellSize) + 1)
    const n = this.cols * this.rows
    const cellOf = new Uint32Array(points.length)
    const counts = new Uint32Array(n + 1)
    for (let i = 0; i < points.length; i++) {
      const c = this.cellIndex(points[i].x, points[i].y)
      cellOf[i] = c
      counts[c + 1]++
    }
    for (let c = 0; c < n; c++) counts[c + 1] += counts[c]
    this.starts = counts.slice()
    const fill = counts // reuse as write cursor
    this.items = new Uint32Array(points.length)
    // Ascending i within each cell keeps the "later wins ties" rule cheap.
    for (let i = 0; i < points.length; i++) this.items[fill[cellOf[i]]++] = i
  }

  private cellIndex(x: number, y: number): number {
    const cx = Math.min(this.cols - 1, Math.max(0, Math.floor((x - this.minX) / this.cell)))
    const cy = Math.min(this.rows - 1, Math.max(0, Math.floor((y - this.minY) / this.cell)))
    return cy * this.cols + cx
  }

  nearest(x: number, y: number, radius: number, filter?: (a: Annotation) => boolean): HitResult | null {
    const c0x = Math.max(0, Math.floor((x - radius - this.minX) / this.cell))
    const c1x = Math.min(this.cols - 1, Math.floor((x + radius - this.minX) / this.cell))
    const c0y = Math.max(0, Math.floor((y - radius - this.minY) / this.cell))
    const c1y = Math.min(this.rows - 1, Math.floor((y + radius - this.minY) / this.cell))
    let bestIdx = -1
    let bestD2 = radius * radius
    for (let cy = c0y; cy <= c1y; cy++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        const c = cy * this.cols + cx
        for (let k = this.starts[c]; k < this.starts[c + 1]; k++) {
          const i = this.items[k]
          const a = this.points[i]
          const dx = a.x - x
          const dy = a.y - y
          const d2 = dx * dx + dy * dy
          if ((d2 < bestD2 || (d2 === bestD2 && i > bestIdx)) && (!filter || filter(a))) {
            bestIdx = i
            bestD2 = d2
          }
        }
      }
    }
    return bestIdx >= 0 ? { annotation: this.points[bestIdx], distance: Math.sqrt(bestD2) } : null
  }
}
