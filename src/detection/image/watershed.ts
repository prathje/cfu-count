/**
 * Marker-controlled watershed by priority flooding (Meyer). Every pixel of
 * `within` reachable from a marker gets that marker's label; pixels are
 * processed in order of increasing `cost`. No explicit watershed lines.
 */
import type { Plane } from './plane.ts'

/** Minimal binary heap keyed by float priority with FIFO tie-breaking. */
class Heap {
  private keys: number[] = []
  private vals: number[] = []
  private order: number[] = []
  private counter = 0
  get size(): number {
    return this.vals.length
  }
  push(key: number, val: number): void {
    this.keys.push(key)
    this.vals.push(val)
    this.order.push(this.counter++)
    this.up(this.vals.length - 1)
  }
  pop(): number {
    const top = this.vals[0]
    const lk = this.keys.pop()!
    const lv = this.vals.pop()!
    const lo = this.order.pop()!
    if (this.vals.length) {
      this.keys[0] = lk
      this.vals[0] = lv
      this.order[0] = lo
      this.down(0)
    }
    return top
  }
  private less(a: number, b: number): boolean {
    return this.keys[a] < this.keys[b] || (this.keys[a] === this.keys[b] && this.order[a] < this.order[b])
  }
  private swap(a: number, b: number): void {
    ;[this.keys[a], this.keys[b]] = [this.keys[b], this.keys[a]]
    ;[this.vals[a], this.vals[b]] = [this.vals[b], this.vals[a]]
    ;[this.order[a], this.order[b]] = [this.order[b], this.order[a]]
  }
  private up(i: number): void {
    while (i > 0) {
      const p = (i - 1) >> 1
      if (!this.less(i, p)) break
      this.swap(i, p)
      i = p
    }
  }
  private down(i: number): void {
    const n = this.vals.length
    for (;;) {
      const l = 2 * i + 1
      const r = l + 1
      let m = i
      if (l < n && this.less(l, m)) m = l
      if (r < n && this.less(r, m)) m = r
      if (m === i) break
      this.swap(i, m)
      i = m
    }
  }
}

/**
 * @param cost   flooding priority (e.g. −distance transform)
 * @param markers  labels > 0 for seed pixels, 0 elsewhere (modified copy is returned)
 * @param within  pixels allowed to be labelled
 */
export function watershed(cost: Plane, markers: Int32Array, within: Uint8Array): Int32Array {
  const { width: w, height: h } = cost
  const labels = markers.slice()
  const heap = new Heap()
  const queued = new Uint8Array(w * h)
  const pushNeighbours = (i: number) => {
    const x = i % w
    const y = (i / w) | 0
    const ns = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]
    for (const j of ns) {
      if (j < 0 || queued[j] || labels[j] || !within[j]) continue
      queued[j] = 1
      heap.push(cost.data[j], j)
    }
  }
  for (let i = 0; i < labels.length; i++) if (labels[i]) pushNeighbours(i)
  while (heap.size) {
    const i = heap.pop()
    // take the label of the lowest-cost labelled neighbour
    const x = i % w
    const y = (i / w) | 0
    let best = 0
    let bestCost = Infinity
    const ns = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]
    for (const j of ns) {
      if (j >= 0 && labels[j] && cost.data[j] < bestCost) {
        bestCost = cost.data[j]
        best = labels[j]
      }
    }
    labels[i] = best
    pushNeighbours(i)
  }
  return labels
}
