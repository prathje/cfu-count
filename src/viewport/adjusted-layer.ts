/**
 * Cache of display-adjusted copies of the image pyramid (see model/display.ts).
 *
 * - Lazy: only what the current view needs is computed (the level that would be
 *   drawn, or for very large levels the visible 1024 px tiles over the next
 *   coarser level). Pan/zoom reuses cached results; new work happens only the
 *   first time a level or tile is needed.
 * - Responsive: after a settings change the coarsest level (<= 1024 px) is redone
 *   first as a quick preview, finer work waits until the settings stop changing
 *   (SETTLE_MS), and results of superseded settings are discarded.
 * - Bounded: one generation of results plus the previous one (shown until the
 *   new one has something to draw); full-resolution tiles are LRU-evicted past
 *   TILE_BUDGET_PX. Original image bytes are never touched.
 */
import type { ImageDisplayAdjust } from '../model/types'
import { displayKey, isDefaultDisplay } from '../model/display'
import { buildLut, channelMatrix, percentileRange, type LevelRange, type Matrix3 } from './image-adjust'
import type { AdjustProcessor, PixelRect } from './adjust-processor'
import { pickLevel, type ImageSourceLike, type PyramidLevel } from './render'

/** Tile edge in level pixels. */
export const TILE_PX = 1024
/** Levels with more pixels than this are processed as tiles, never whole (24 MP photo = 96 MB RGBA). */
export const TILE_LEVEL_MIN_PX = 8 * 1024 * 1024
/** Max adjusted full-resolution tile pixels kept (16 MP ≈ 64 MB of bitmaps). */
export const TILE_BUDGET_PX = 16 * 1024 * 1024
/** Finer work starts once settings have been unchanged this long (slider drags). */
export const SETTLE_MS = 150

/** Visible image region, in image px. */
export interface ImageRect {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** An adjusted tile: source sub-rectangle (tile px) drawn at an image-px rectangle. */
export interface ImageTile {
  source: ImageSourceLike
  sx: number
  sy: number
  sw: number
  sh: number
  x: number
  y: number
  w: number
  h: number
}

/** Extra source px processed around each tile, so neighbours can overlap (no seams). */
const TILE_PAD = 2
/** Overlap drawn into each neighbour, in level px: hides anti-aliased tile edges. */
const TILE_OVERLAP = 1

export interface AdjustedDrawable {
  /** Adjusted whole levels (finest first), possibly empty while only tiles exist. */
  levels: PyramidLevel[]
  /** Full-resolution tiles to draw over the level. */
  tiles: ImageTile[]
}

interface TileEntry {
  source: ImageSourceLike
  levelSource: ImageSourceLike
  rect: ImageTile
  px: number
  used: number
}

interface Generation {
  key: string
  adjust: ImageDisplayAdjust
  matrix: Matrix3
  matrixKey: string
  lut: Uint8ClampedArray | null
  whole: Map<ImageSourceLike, ImageSourceLike>
  tiles: Map<string, TileEntry>
  /** Job keys finished (or failed) in this generation. */
  done: Set<string>
}

type Job =
  | { key: string; kind: 'histogram'; level: PyramidLevel; quick: true }
  | { key: string; kind: 'level'; level: PyramidLevel; quick: boolean }
  | { key: string; kind: 'tile'; level: PyramidLevel; rect: PixelRect; cell: PixelRect; quick: false }

const pixels = (s: ImageSourceLike) => s.width * s.height

/** `r` grown by `by` px on each side, clamped to a W x H level. */
function expand(r: PixelRect, by: number, W: number, H: number): PixelRect {
  const x = Math.max(0, r.x - by)
  const y = Math.max(0, r.y - by)
  return { x, y, w: Math.min(W, r.x + r.w + by) - x, h: Math.min(H, r.y + r.h + by) - y }
}

function release(s: ImageSourceLike) {
  if (typeof ImageBitmap !== 'undefined' && s instanceof ImageBitmap) s.close()
  else if (typeof HTMLCanvasElement !== 'undefined' && s instanceof HTMLCanvasElement) s.width = s.height = 0
}

export interface AdjustedLayerOptions {
  /** Called when new adjusted pixels are ready to draw. */
  onChange(): void
  /** Creates the processor on first use (keeps the worker unloaded until needed). */
  createProcessor(): AdjustProcessor
  now?: () => number
  /** Free a result (default: ImageBitmap.close / zero canvas). */
  release?: (s: ImageSourceLike) => void
}

export class AdjustedLayer {
  private levels: readonly PyramidLevel[] = []
  private cur: Generation | null = null
  private stale: Generation | null = null
  private ranges = new Map<string, LevelRange | null>()
  private wants: Job[] = []
  private running = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private settleAt = 0
  private processor: AdjustProcessor | null = null
  private ids = new WeakMap<object, number>()
  private nextId = 1
  private tick = 0
  private disposed = false
  private readonly now: () => number
  private readonly free: (s: ImageSourceLike) => void

  /** Diagnostics: last job durations in ms, keyed by kind. */
  readonly timings: { kind: string; px: number; ms: number }[] = []

  private readonly opts: AdjustedLayerOptions

  constructor(opts: AdjustedLayerOptions) {
    this.opts = opts
    this.now = opts.now ?? (() => performance.now())
    this.free = opts.release ?? release
  }

  /** True when adjustments are set (otherwise draw the original). */
  active(): boolean {
    return this.cur !== null
  }

  /** The original pyramid (finest first). Results for levels no longer present are dropped. */
  setLevels(levels: readonly PyramidLevel[]) {
    const prevBase = this.levels[0]?.source
    this.levels = levels
    const keep = new Set(levels.map((l) => l.source))
    for (const g of [this.cur, this.stale]) {
      if (!g) continue
      for (const [src, out] of g.whole) if (!keep.has(src)) (this.free(out), g.whole.delete(src))
      for (const [k, t] of g.tiles) if (!keep.has(t.levelSource)) (this.free(t.source), g.tiles.delete(k))
    }
    if (levels[0]?.source !== prevBase) {
      // A different image: histograms and results no longer apply.
      this.ranges.clear()
      this.dropStale()
      if (this.cur) {
        this.disposeGen(this.cur)
        this.cur = this.newGeneration(this.cur.adjust)
      }
    }
    this.wants = []
  }

  setAdjust(adjust: ImageDisplayAdjust | null | undefined) {
    if (!adjust || isDefaultDisplay(adjust)) {
      this.disposeGen(this.cur)
      this.dropStale()
      this.cur = null
      this.wants = []
      return
    }
    const key = displayKey(adjust)
    if (this.cur?.key === key) return
    if (this.cur && this.cur.whole.size > 0) {
      this.dropStale()
      this.stale = this.cur
    } else {
      this.disposeGen(this.cur)
    }
    this.cur = this.newGeneration(adjust)
    this.settleAt = this.now() + SETTLE_MS
    this.wants = []
  }

  /**
   * What to draw for a view needing `needed` level px per image px over `rect`;
   * null = nothing adjusted yet (draw the original). Queues any missing work.
   */
  drawable(needed: number, rect: ImageRect): AdjustedDrawable | null {
    const g = this.cur
    if (!g || this.levels.length === 0) return null
    const target = pickLevel(this.levels, needed)
    this.wants = this.plan(g, target, rect)
    this.pump()

    const show = g.whole.size > 0 || !this.stale ? g : this.stale
    const levels = this.levels.filter((l) => show.whole.has(l.source)).map((l) => ({ source: show.whole.get(l.source)!, scale: l.scale }))
    const tiles: ImageTile[] = []
    if (pixels(target.source) > TILE_LEVEL_MIN_PX) {
      const t = ++this.tick
      for (const e of show.tiles.values()) {
        if (e.levelSource !== target.source) continue
        const r = e.rect
        if (r.x >= rect.x1 || r.y >= rect.y1 || r.x + r.w <= rect.x0 || r.y + r.h <= rect.y0) continue
        e.used = t
        tiles.push(r)
      }
    }
    if (levels.length === 0 && tiles.length === 0) return null
    return { levels, tiles }
  }

  /** Pending job count (tests/diagnostics). */
  pendingJobs(): number {
    return this.cur ? this.wants.filter((j) => !this.cur!.done.has(j.key)).length : 0
  }

  dispose() {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.disposeGen(this.cur)
    this.dropStale()
    this.cur = null
    this.processor?.dispose()
    this.processor = null
  }

  // ------------------------------------------------------------------ internals

  private id(o: object): number {
    let id = this.ids.get(o)
    if (!id) this.ids.set(o, (id = this.nextId++))
    return id
  }

  private newGeneration(adjust: ImageDisplayAdjust): Generation {
    const matrix = channelMatrix(adjust)
    const matrixKey = matrix.join(',')
    const g: Generation = { key: displayKey(adjust), adjust, matrix, matrixKey, lut: null, whole: new Map(), tiles: new Map(), done: new Set() }
    this.updateLut(g)
    return g
  }

  /** The LUT needs the auto-contrast range first (if enabled). */
  private updateLut(g: Generation) {
    if (!g.adjust.autoContrast) g.lut = buildLut(g.adjust)
    else if (this.ranges.has(g.matrixKey)) g.lut = buildLut(g.adjust, this.ranges.get(g.matrixKey) ?? null)
  }

  private plan(g: Generation, target: PyramidLevel, rect: ImageRect): Job[] {
    const jobs: Job[] = []
    const coarsest = this.levels[this.levels.length - 1]
    const tiled = (l: PyramidLevel) => pixels(l.source) > TILE_LEVEL_MIN_PX
    const levelJob = (l: PyramidLevel, quick: boolean): Job => ({ key: `l:${this.id(l.source)}`, kind: 'level', level: l, quick })
    const coarseOk = !tiled(coarsest)
    if (g.adjust.autoContrast && !this.ranges.has(g.matrixKey)) {
      // Only a small level gives a cheap histogram; wait for the pyramid otherwise.
      if (!coarseOk) return []
      jobs.push({ key: `h:${this.id(coarsest.source)}:${g.matrixKey}`, kind: 'histogram', level: coarsest, quick: true })
    }
    // Quick preview: the coarsest level follows every change (also mid-drag); finer levels wait to settle.
    if (coarseOk && coarsest !== target) jobs.push(levelJob(coarsest, true))
    if (!tiled(target)) {
      jobs.push(levelJob(target, target === coarsest))
    } else {
      const base = this.levels.find((l) => !tiled(l))
      if (base && base !== coarsest) jobs.push(levelJob(base, false))
      jobs.push(...this.tileJobs(target, rect))
    }
    return jobs.filter((j) => !g.done.has(j.key))
  }

  private tileJobs(level: PyramidLevel, rect: ImageRect): Job[] {
    const ls = level.scale
    const W = level.source.width
    const H = level.source.height
    const tx0 = Math.max(0, Math.floor((rect.x0 * ls) / TILE_PX))
    const ty0 = Math.max(0, Math.floor((rect.y0 * ls) / TILE_PX))
    const tx1 = Math.min(Math.ceil(W / TILE_PX), Math.ceil((rect.x1 * ls) / TILE_PX))
    const ty1 = Math.min(Math.ceil(H / TILE_PX), Math.ceil((rect.y1 * ls) / TILE_PX))
    const jobs: (Job & { d: number })[] = []
    let px = 0
    const cx = ((rect.x0 + rect.x1) / 2) * ls
    const cy = ((rect.y0 + rect.y1) / 2) * ls
    const lid = this.id(level.source)
    for (let ty = ty0; ty < ty1; ty++) {
      for (let tx = tx0; tx < tx1; tx++) {
        const cell: PixelRect = { x: tx * TILE_PX, y: ty * TILE_PX, w: Math.min(TILE_PX, W - tx * TILE_PX), h: Math.min(TILE_PX, H - ty * TILE_PX) }
        const rect = expand(cell, TILE_PAD, W, H)
        px += rect.w * rect.h
        const d = Math.hypot(cell.x + cell.w / 2 - cx, cell.y + cell.h / 2 - cy)
        jobs.push({ key: `t:${lid}:${tx}:${ty}`, kind: 'tile', level, rect, cell, quick: false, d })
      }
    }
    // Too much visible at full resolution to keep within budget: the base level is sharp enough there.
    if (px > TILE_BUDGET_PX) return []
    return jobs.sort((a, b) => a.d - b.d)
  }

  private pump() {
    if (this.running || this.disposed) return
    const g = this.cur
    if (!g) return
    const job = this.wants.find((j) => !g.done.has(j.key))
    if (!job) return
    const wait = this.settleAt - this.now()
    if (!job.quick && wait > 0) {
      if (!this.timer) {
        this.timer = setTimeout(() => {
          this.timer = null
          this.pump()
        }, wait)
      }
      return
    }
    if (job.kind !== 'histogram' && !g.lut) return // waiting for the histogram
    this.running = true
    void this.execute(g, job).finally(() => {
      this.running = false
      this.pump()
    })
  }

  private async execute(g: Generation, job: Job) {
    this.processor ??= this.opts.createProcessor()
    const t0 = this.now()
    const src = job.level.source
    try {
      if (job.kind === 'histogram') {
        const hist = await this.processor.histogram(src, g.matrix)
        // The image changed meanwhile (setLevels cleared the ranges): this histogram no longer applies.
        if (this.disposed || !this.levels.some((l) => l.source === src)) return
        this.ranges.set(g.matrixKey, percentileRange(hist))
        for (const gen of [this.cur, this.stale]) if (gen && gen.matrixKey === g.matrixKey && !gen.lut) this.updateLut(gen)
        g.done.add(job.key)
        this.note('histogram', pixels(src), t0)
        return
      }
      const rect: PixelRect = job.kind === 'tile' ? job.rect : { x: 0, y: 0, w: src.width, h: src.height }
      const out = await this.processor.adjust(src, rect, g.matrix, g.lut!)
      if (this.disposed || g !== this.cur || !this.levels.some((l) => l.source === src)) {
        this.free(out)
        return
      }
      g.done.add(job.key)
      this.note(job.kind, rect.w * rect.h, t0)
      if (job.kind === 'level') {
        g.whole.set(src, out)
        this.dropStale()
      } else {
        const ls = job.level.scale
        const draw = expand(job.cell, TILE_OVERLAP, src.width, src.height)
        g.tiles.set(job.key, {
          source: out,
          levelSource: src,
          rect: {
            source: out,
            sx: draw.x - rect.x,
            sy: draw.y - rect.y,
            sw: draw.w,
            sh: draw.h,
            x: draw.x / ls,
            y: draw.y / ls,
            w: draw.w / ls,
            h: draw.h / ls,
          },
          px: rect.w * rect.h,
          used: this.tick,
        })
        this.evictTiles(g)
      }
      this.opts.onChange()
    } catch (err) {
      g.done.add(job.key) // don't retry in a loop; a settings change retries
      if (job.kind === 'histogram' && !this.disposed && this.levels.some((l) => l.source === src)) {
        this.ranges.set(g.matrixKey, null) // show without the stretch rather than nothing
        this.updateLut(g)
      }
      console.warn('Display adjustment failed', err)
    }
  }

  private note(kind: string, px: number, t0: number) {
    this.timings.push({ kind, px, ms: Math.round((this.now() - t0) * 10) / 10 })
    if (this.timings.length > 20) this.timings.shift()
  }

  private evictTiles(g: Generation) {
    let total = 0
    for (const t of g.tiles.values()) total += t.px
    if (total <= TILE_BUDGET_PX) return
    const lru = [...g.tiles.entries()].sort((a, b) => a[1].used - b[1].used)
    for (const [k, t] of lru) {
      if (total <= TILE_BUDGET_PX) break
      this.free(t.source)
      g.tiles.delete(k)
      g.done.delete(k)
      total -= t.px
    }
  }

  private dropStale() {
    this.disposeGen(this.stale)
    this.stale = null
  }

  private disposeGen(g: Generation | null) {
    if (!g) return
    for (const s of g.whole.values()) this.free(s)
    for (const t of g.tiles.values()) this.free(t.source)
    g.whole.clear()
    g.tiles.clear()
  }
}
