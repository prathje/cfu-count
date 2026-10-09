/**
 * Boundary extraction, Moore-neighbour contour tracing, concave-point
 * splitting and algebraic/geometric circle fits to contour arcs.
 */
import type { Mask } from './plane.ts'

export interface Pt {
  x: number
  y: number
}

/** Foreground pixels with at least one 4-neighbour outside the mask (or the raster). */
export function boundaryMask(mask: Mask): Mask {
  const { width: w, height: h, data } = mask
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (!data[i]) continue
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || !data[i - 1] || !data[i + 1] || !data[i - w] || !data[i + w]) out[i] = 1
    }
  }
  return { width: w, height: h, data: out }
}

// Moore neighbourhood in clockwise order starting West (image y down).
const DX = [-1, -1, 0, 1, 1, 1, 0, -1]
const DY = [0, -1, -1, -1, 0, 1, 1, 1]

/**
 * Trace the outer boundary of the component containing `start`, which must be
 * a foreground pixel whose west neighbour is background (e.g. the first pixel
 * of the component in raster order). Returns pixel-centre points in order.
 */
export function traceBoundary(mask: Mask, start: number, maxSteps = 1_000_000): Pt[] {
  const { width: w, height: h, data } = mask
  const fg = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && data[y * w + x] !== 0
  const sx = start % w
  const sy = (start / w) | 0
  const pts: Pt[] = [{ x: sx + 0.5, y: sy + 0.5 }]
  let cx = sx
  let cy = sy
  let back = 0 // direction index pointing to the background pixel we came from (West)
  let firstMove = -1
  for (let step = 0; step < maxSteps; step++) {
    let found = -1
    for (let k = 1; k <= 8; k++) {
      const d = (back + k) % 8
      if (fg(cx + DX[d], cy + DY[d])) {
        found = d
        break
      }
    }
    if (found < 0) return pts // isolated pixel
    const nx = cx + DX[found]
    const ny = cy + DY[found]
    if (cx === sx && cy === sy && firstMove === found && step > 0) break
    if (step === 0) firstMove = found
    // new backtrack: the neighbour checked just before `found`, expressed from the new pixel
    const prev = (found + 7) % 8
    const bx = cx + DX[prev] - nx
    const by = cy + DY[prev] - ny
    back = dirIndex(bx, by)
    cx = nx
    cy = ny
    if (cx === sx && cy === sy) {
      // continue once more to check Jacob's criterion on the next move
      continue
    }
    pts.push({ x: cx + 0.5, y: cy + 0.5 })
  }
  return pts
}

function dirIndex(dx: number, dy: number): number {
  for (let d = 0; d < 8; d++) if (DX[d] === dx && DY[d] === dy) return d
  return 0
}

/** Outer contours of every component in the mask (min `minLength` points). */
export function traceAllOuterContours(mask: Mask, minLength = 3): Pt[][] {
  const { width: w, height: h, data } = mask
  const visited = new Uint8Array(w * h)
  const contours: Pt[][] = []
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (!data[i] || visited[i] || (x > 0 && data[i - 1])) continue
      const c = traceBoundary(mask, i)
      for (const p of c) visited[Math.floor(p.y) * w + Math.floor(p.x)] = 1
      if (c.length >= minLength) contours.push(c)
    }
  }
  return contours
}

/**
 * Indices of concave contour points: the chord midpoint between p[i−k] and
 * p[i+k] lies outside the mask (the boundary bends inwards there), and the
 * point is the deepest such point in its run.
 */
export function concavePoints(contour: Pt[], mask: Mask, k: number): number[] {
  const n = contour.length
  if (n < 2 * k + 1) return []
  const { width: w, height: h, data } = mask
  const depth = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const a = contour[(i - k + n) % n]
    const b = contour[(i + k) % n]
    const mx = (a.x + b.x) / 2
    const my = (a.y + b.y) / 2
    const xi = Math.floor(mx)
    const yi = Math.floor(my)
    const inside = xi >= 0 && yi >= 0 && xi < w && yi < h && data[yi * w + xi] !== 0
    if (!inside) depth[i] = Math.hypot(contour[i].x - mx, contour[i].y - my)
  }
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    if (depth[i] <= 0.75) continue
    let best = true
    for (let j = -k; j <= k; j++) {
      if (j === 0) continue
      const dj = depth[(i + j + n) % n]
      if (dj > depth[i] || (dj === depth[i] && j < 0)) {
        best = false
        break
      }
    }
    if (best) out.push(i)
  }
  return out
}

/** Split a closed contour at the given (sorted) indices into arcs. No cuts → one arc (the whole contour). */
export function splitArcs(contour: Pt[], cuts: number[]): Pt[][] {
  if (cuts.length === 0) return [contour]
  const arcs: Pt[][] = []
  const n = contour.length
  const sorted = cuts.slice().sort((a, b) => a - b)
  for (let c = 0; c < sorted.length; c++) {
    const a = sorted[c]
    const b = sorted[(c + 1) % sorted.length]
    const arc: Pt[] = []
    let i = a
    do {
      arc.push(contour[i])
      i = (i + 1) % n
    } while (i !== b && arc.length <= n)
    arc.push(contour[b])
    arcs.push(arc)
  }
  return arcs
}

export interface Circle {
  x: number
  y: number
  r: number
}

/** Kåsa algebraic circle fit (least squares on x²+y²+Dx+Ey+F=0). Null if degenerate. */
export function fitCircleKasa(pts: Pt[]): Circle | null {
  const n = pts.length
  if (n < 3) return null
  let mx = 0
  let my = 0
  for (const p of pts) {
    mx += p.x
    my += p.y
  }
  mx /= n
  my /= n
  // centred coordinates for numerical stability
  let suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0
  for (const p of pts) {
    const u = p.x - mx
    const v = p.y - my
    suu += u * u
    svv += v * v
    suv += u * v
    suuu += u * u * u
    svvv += v * v * v
    suvv += u * v * v
    svuu += v * u * u
  }
  const det = suu * svv - suv * suv
  if (Math.abs(det) < 1e-9) return null
  const b1 = 0.5 * (suuu + suvv)
  const b2 = 0.5 * (svvv + svuu)
  const uc = (b1 * svv - b2 * suv) / det
  const vc = (suu * b2 - suv * b1) / det
  const r = Math.sqrt(uc * uc + vc * vc + (suu + svv) / n)
  if (!Number.isFinite(r)) return null
  return { x: uc + mx, y: vc + my, r }
}

/** Geometric (orthogonal-distance) refinement by Gauss–Newton, starting from `init`. */
export function refineCircle(pts: Pt[], init: Circle, iterations = 10): Circle {
  let { x: a, y: b, r } = init
  for (let it = 0; it < iterations; it++) {
    // J^T J and J^T res for parameters (a, b, r)
    let j11 = 0, j12 = 0, j13 = 0, j22 = 0, j23 = 0, j33 = 0
    let g1 = 0, g2 = 0, g3 = 0
    for (const p of pts) {
      const dx = a - p.x
      const dy = b - p.y
      const d = Math.hypot(dx, dy) || 1e-9
      const res = d - r
      const ja = dx / d
      const jb = dy / d
      const jr = -1
      j11 += ja * ja; j12 += ja * jb; j13 += ja * jr
      j22 += jb * jb; j23 += jb * jr; j33 += jr * jr
      g1 += ja * res; g2 += jb * res; g3 += jr * res
    }
    // solve 3x3 (symmetric) by Cramer
    const det = j11 * (j22 * j33 - j23 * j23) - j12 * (j12 * j33 - j23 * j13) + j13 * (j12 * j23 - j22 * j13)
    if (Math.abs(det) < 1e-12) break
    const da = (g1 * (j22 * j33 - j23 * j23) - j12 * (g2 * j33 - j23 * g3) + j13 * (g2 * j23 - j22 * g3)) / det
    const db = (j11 * (g2 * j33 - j23 * g3) - g1 * (j12 * j33 - j23 * j13) + j13 * (j12 * g3 - g2 * j13)) / det
    const dr = (j11 * (j22 * g3 - g2 * j23) - j12 * (j12 * g3 - g2 * j13) + g1 * (j12 * j23 - j22 * j13)) / det
    a -= da
    b -= db
    r -= dr
    if (Math.abs(da) + Math.abs(db) + Math.abs(dr) < 1e-4) break
  }
  return { x: a, y: b, r: Math.abs(r) }
}

/** RMS orthogonal residual of points to a circle. */
export function circleResidual(pts: Pt[], c: Circle): number {
  let s = 0
  for (const p of pts) {
    const d = Math.hypot(p.x - c.x, p.y - c.y) - c.r
    s += d * d
  }
  return Math.sqrt(s / Math.max(1, pts.length))
}

/** Angle (radians, 0..2π) the arc subtends around a centre. */
export function arcSpan(pts: Pt[], c: Pt): number {
  if (pts.length < 2) return 0
  const angles = pts.map((p) => Math.atan2(p.y - c.y, p.x - c.x)).sort((a, b) => a - b)
  let maxGap = angles[0] + 2 * Math.PI - angles[angles.length - 1]
  for (let i = 1; i < angles.length; i++) maxGap = Math.max(maxGap, angles[i] - angles[i - 1])
  return 2 * Math.PI - maxGap
}
