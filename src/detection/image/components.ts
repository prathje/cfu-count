/**
 * Connected-component labelling (two-pass with union–find) and per-component
 * statistics; hole filling.
 */
import type { Mask } from './plane.ts'

export interface ComponentStats {
  label: number
  area: number
  /** Inclusive bounding box in pixels. */
  minX: number
  minY: number
  maxX: number
  maxY: number
  /** Centroid in continuous coordinates (pixel centres at +0.5). */
  cx: number
  cy: number
}

export interface Labelling {
  width: number
  height: number
  /** 0 = background, 1..count = component label. */
  labels: Int32Array
  count: number
  stats: ComponentStats[]
}

function find(parent: Int32Array, a: number): number {
  while (parent[a] !== a) {
    parent[a] = parent[parent[a]]
    a = parent[a]
  }
  return a
}

/** Label non-zero pixels of `mask`. `connectivity` 8 (default) or 4. */
export function labelComponents(mask: Mask, connectivity: 4 | 8 = 8): Labelling {
  const { width: w, height: h, data } = mask
  const labels = new Int32Array(w * h)
  // provisional labels can reach ~n/2 in the worst case
  const parent = new Int32Array(Math.floor((w * h) / 2) + 2)
  let next = 1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (!data[i]) continue
      const ns: number[] = []
      if (x > 0 && labels[i - 1]) ns.push(labels[i - 1])
      if (y > 0) {
        if (labels[i - w]) ns.push(labels[i - w])
        if (connectivity === 8) {
          if (x > 0 && labels[i - w - 1]) ns.push(labels[i - w - 1])
          if (x < w - 1 && labels[i - w + 1]) ns.push(labels[i - w + 1])
        }
      }
      if (ns.length === 0) {
        parent[next] = next
        labels[i] = next++
      } else {
        let m = ns[0]
        for (const l of ns) if (l < m) m = l
        labels[i] = m
        for (const l of ns) {
          const ra = find(parent, l)
          const rb = find(parent, m)
          if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb)
        }
      }
    }
  }
  // compact labels
  const remap = new Int32Array(next)
  let count = 0
  for (let l = 1; l < next; l++) {
    const r = find(parent, l)
    if (r === l) remap[l] = ++count
  }
  for (let l = 1; l < next; l++) remap[l] = remap[find(parent, l)]
  const stats: ComponentStats[] = []
  for (let c = 1; c <= count; c++) stats.push({ label: c, area: 0, minX: w, minY: h, maxX: -1, maxY: -1, cx: 0, cy: 0 })
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (!labels[i]) continue
      const l = remap[labels[i]]
      labels[i] = l
      const s = stats[l - 1]
      s.area++
      s.cx += x + 0.5
      s.cy += y + 0.5
      if (x < s.minX) s.minX = x
      if (x > s.maxX) s.maxX = x
      if (y < s.minY) s.minY = y
      if (y > s.maxY) s.maxY = y
    }
  }
  for (const s of stats) {
    s.cx /= s.area
    s.cy /= s.area
  }
  return { width: w, height: h, labels, count, stats }
}

/** Fill holes: background regions not 4-connected to the raster border become foreground. */
export function fillHoles(mask: Mask): Mask {
  const { width: w, height: h, data } = mask
  const outside = new Uint8Array(w * h)
  const stack: number[] = []
  const push = (i: number) => {
    if (!data[i] && !outside[i]) {
      outside[i] = 1
      stack.push(i)
    }
  }
  for (let x = 0; x < w; x++) {
    push(x)
    push((h - 1) * w + x)
  }
  for (let y = 0; y < h; y++) {
    push(y * w)
    push(y * w + w - 1)
  }
  while (stack.length) {
    const i = stack.pop()!
    const x = i % w
    const y = (i / w) | 0
    if (x > 0) push(i - 1)
    if (x < w - 1) push(i + 1)
    if (y > 0) push(i - w)
    if (y < h - 1) push(i + w)
  }
  const out = new Uint8Array(w * h)
  for (let i = 0; i < out.length; i++) out[i] = outside[i] ? 0 : 1
  return { width: w, height: h, data: out }
}

/** Mask of a single component label. */
export function componentMask(l: Labelling, label: number): Mask {
  const out = new Uint8Array(l.width * l.height)
  for (let i = 0; i < out.length; i++) out[i] = l.labels[i] === label ? 1 : 0
  return { width: l.width, height: l.height, data: out }
}
