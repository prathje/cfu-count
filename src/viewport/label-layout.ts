/**
 * Number-label placement for the annotation layer, in screen space. Pure and
 * allocation-light: a uniform grid of occupied boxes (markers and already placed
 * labels). Each label tries four spots around its marker (upper-right, lower-right,
 * upper-left, lower-left) and takes the first that overlaps nothing; if all four
 * collide it falls back to upper-right, so every label is still drawn.
 * Cost is O(labels) with a handful of box tests each (only visible markers are fed in).
 */

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

const CELL = 32
const OFFSET = 1 << 12 // keeps negative screen coordinates (off-screen margin) in positive keys

export class OccupancyGrid {
  private cells = new Map<number, Box[]>()

  private key(cx: number, cy: number) {
    return (cx + OFFSET) * (OFFSET * 2) + (cy + OFFSET)
  }

  add(b: Box): void {
    const x0 = Math.floor(b.x / CELL)
    const x1 = Math.floor((b.x + b.w) / CELL)
    const y0 = Math.floor(b.y / CELL)
    const y1 = Math.floor((b.y + b.h) / CELL)
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const k = this.key(cx, cy)
        const list = this.cells.get(k)
        if (list) list.push(b)
        else this.cells.set(k, [b])
      }
    }
  }

  /** True if `b` overlaps any stored box (touching edges do not count). */
  hits(b: Box): boolean {
    const x0 = Math.floor(b.x / CELL)
    const x1 = Math.floor((b.x + b.w) / CELL)
    const y0 = Math.floor(b.y / CELL)
    const y1 = Math.floor((b.y + b.h) / CELL)
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const list = this.cells.get(this.key(cx, cy))
        if (!list) continue
        for (const o of list) {
          if (b.x < o.x + o.w && o.x < b.x + b.w && b.y < o.y + o.h && o.y < b.y + b.h) return true
        }
      }
    }
    return false
  }
}

/** Box a marker of radius r occupies for label avoidance: its inscribed square (labels may tuck into the corners). */
export function markerBox(sx: number, sy: number, r: number): Box {
  const k = r * 0.72
  return { x: sx - k, y: sy - k, w: 2 * k, h: 2 * k }
}

/** The four candidate label boxes around a marker, in preference order. */
export function labelCandidates(sx: number, sy: number, r: number, w: number, h: number): Box[] {
  // Each box touches the marker diagonally (corner on the 45° point of the ring), tucked in by 2 px.
  const gap = r * 0.72 + 1
  const tuck = Math.min(2, h * 0.2)
  return [
    { x: sx + gap, y: sy - gap - h + tuck, w, h }, // upper-right (default)
    { x: sx + gap, y: sy + gap - tuck, w, h }, // lower-right
    { x: sx - gap - w, y: sy - gap - h + tuck, w, h }, // upper-left
    { x: sx - gap - w, y: sy + gap - tuck, w, h }, // lower-left
  ]
}

/** Choose a label box (first free candidate, else the default) and mark it occupied. */
export function placeLabel(grid: OccupancyGrid, sx: number, sy: number, r: number, w: number, h: number): Box {
  const candidates = labelCandidates(sx, sy, r, w, h)
  let chosen = candidates[0]
  for (const c of candidates) {
    if (!grid.hits(c)) {
      chosen = c
      break
    }
  }
  grid.add(chosen)
  return chosen
}
