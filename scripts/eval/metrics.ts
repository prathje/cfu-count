/**
 * Evaluation metrics (pure; unit-tested in metrics.test.ts).
 * All coordinates in original image px.
 */

export interface Pt {
  x: number
  y: number
}

export interface MatchResult {
  /** [predIndex, gtIndex, distance] */
  pairs: [number, number, number][]
  tp: number
  fp: number
  fn: number
  unmatchedPred: number[]
  unmatchedGt: number[]
}

/**
 * Greedy one-to-one matching by increasing distance within `radius`
 * (equivalent to Hungarian at colony densities where match discs rarely overlap).
 */
export function matchPoints(pred: Pt[], gt: Pt[], radius: number): MatchResult {
  const cand: [number, number, number][] = []
  const cell = Math.max(radius, 1e-6)
  const grid = new Map<string, number[]>()
  gt.forEach((g, j) => {
    const k = `${Math.floor(g.x / cell)},${Math.floor(g.y / cell)}`
    const l = grid.get(k)
    if (l) l.push(j)
    else grid.set(k, [j])
  })
  pred.forEach((p, i) => {
    const gx = Math.floor(p.x / cell)
    const gy = Math.floor(p.y / cell)
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++)
        for (const j of grid.get(`${gx + dx},${gy + dy}`) ?? []) {
          const d = Math.hypot(p.x - gt[j].x, p.y - gt[j].y)
          if (d <= radius) cand.push([i, j, d])
        }
  })
  cand.sort((a, b) => a[2] - b[2])
  const usedP = new Uint8Array(pred.length)
  const usedG = new Uint8Array(gt.length)
  const pairs: [number, number, number][] = []
  for (const c of cand) {
    if (usedP[c[0]] || usedG[c[1]]) continue
    usedP[c[0]] = usedG[c[1]] = 1
    pairs.push(c)
  }
  const unmatchedPred = pred.map((_, i) => i).filter((i) => !usedP[i])
  const unmatchedGt = gt.map((_, j) => j).filter((j) => !usedG[j])
  return { pairs, tp: pairs.length, fp: unmatchedPred.length, fn: unmatchedGt.length, unmatchedPred, unmatchedGt }
}

export interface Prf {
  precision: number
  recall: number
  f1: number
}

export function prf(tp: number, fp: number, fn: number): Prf {
  const precision = tp + fp ? tp / (tp + fp) : 1
  const recall = tp + fn ? tp / (tp + fn) : 1
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0
  return { precision, recall, f1 }
}

/** Centre error of matched pairs: mean and median in px. */
export function centreError(m: MatchResult): { mean: number; median: number } {
  const d = m.pairs.map((p) => p[2]).sort((a, b) => a - b)
  if (!d.length) return { mean: NaN, median: NaN }
  return { mean: d.reduce((a, b) => a + b, 0) / d.length, median: d[Math.floor(d.length / 2)] }
}

/**
 * Duplicates: unmatched predictions lying within `radius` of a GT point that
 * IS matched (a second prediction on the same colony), as a fraction of all predictions.
 */
export function duplicateRate(pred: Pt[], gt: Pt[], m: MatchResult, radius: number): number {
  if (!pred.length) return 0
  const matchedGt = new Set(m.pairs.map((p) => p[1]))
  let dup = 0
  for (const i of m.unmatchedPred) {
    for (const j of matchedGt) {
      if (Math.hypot(pred[i].x - gt[j].x, pred[i].y - gt[j].y) <= radius) {
        dup++
        break
      }
    }
  }
  return dup / pred.length
}

export interface ClusterCountRow {
  bin: string
  clusters: number
  gtColonies: number
  meanAbsError: number
  exact: number
}

/** Size bins of GT colonies per cluster. */
export const CLUSTER_BINS: [string, number, number][] = [
  ['1', 1, 1],
  ['2', 2, 2],
  ['3-5', 3, 5],
  ['6-20', 6, 20],
  ['>20', 21, Infinity],
]

/**
 * Per-cluster count error. `gtLabel[j]` / `predLabel[i]` give the cluster
 * label (0 = outside any cluster). Clusters are binned by their GT count;
 * clusters with 0 GT colonies are reported in a '0' bin (pure false positives).
 */
export function perClusterCountError(gtLabel: number[], predLabel: number[]): { rows: ClusterCountRow[]; gtOutsideClusters: number; predOutsideClusters: number } {
  const g = new Map<number, number>()
  const p = new Map<number, number>()
  let gtOut = 0
  let predOut = 0
  for (const l of gtLabel) l ? g.set(l, (g.get(l) ?? 0) + 1) : gtOut++
  for (const l of predLabel) l ? p.set(l, (p.get(l) ?? 0) + 1) : predOut++
  const labels = new Set([...g.keys(), ...p.keys()])
  const bins: ([string, number, number] | ['0', 0, 0])[] = [['0', 0, 0], ...CLUSTER_BINS]
  const rows: ClusterCountRow[] = bins.map(([bin]) => ({ bin, clusters: 0, gtColonies: 0, meanAbsError: 0, exact: 0 }))
  for (const l of labels) {
    const n = g.get(l) ?? 0
    const k = p.get(l) ?? 0
    const bi = bins.findIndex(([, lo, hi]) => n >= lo && n <= hi)
    const row = rows[bi]
    row.clusters++
    row.gtColonies += n
    row.meanAbsError += Math.abs(k - n)
    if (k === n) row.exact++
  }
  for (const r of rows) if (r.clusters) r.meanAbsError /= r.clusters
  return { rows: rows.filter((r) => r.clusters > 0), gtOutsideClusters: gtOut, predOutsideClusters: predOut }
}

/** Mean, SD, min, max of a sample. */
export function spread(xs: number[]): { mean: number; sd: number; min: number; max: number } {
  if (!xs.length) return { mean: NaN, sd: NaN, min: NaN, max: NaN }
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, xs.length - 1))
  return { mean, sd, min: Math.min(...xs), max: Math.max(...xs) }
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** k distinct items sampled without replacement. */
export function sample<T>(xs: T[], k: number, rand: () => number): T[] {
  const a = xs.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a.slice(0, Math.min(k, a.length))
}

/** Minimal shapes of detector output used by the audits (keeps metrics.ts free of src imports). */
export interface AuditSuggestion {
  clusterId: string
  status: string
}
export interface AuditCluster {
  clusterId: string
  status: string
  area: number
  chosenK: number
  fixedIds: string[]
  bbox: [number, number, number, number]
}

/**
 * Share of suggestions the review UI shows inside review regions. Same rule as
 * src/state/assist/review.ts: a cluster is a review region if its status is
 * 'review' or any of its suggestions is.
 */
export function reviewShare(suggestions: AuditSuggestion[], clusters: AuditCluster[]): { share: number; regions: number; largestRegion: number } {
  const ids = new Set(clusters.filter((c) => c.status === 'review').map((c) => c.clusterId))
  for (const s of suggestions) if (s.status === 'review') ids.add(s.clusterId)
  const per = new Map<string, number>()
  let n = 0
  for (const s of suggestions) {
    if (!ids.has(s.clusterId)) continue
    n++
    per.set(s.clusterId, (per.get(s.clusterId) ?? 0) + 1)
  }
  return { share: suggestions.length ? n / suggestions.length : 0, regions: ids.size, largestRegion: Math.max(0, ...per.values()) }
}

/**
 * Clusters whose foreground area implies more colonies than were placed
 * (new + fixed): area ≥ `factor` × count × π r̃². A heuristic for finding
 * under-split clusters without ground truth; inspect the crops.
 */
export function underSplitSuspects<T extends AuditCluster>(clusters: T[], rMedian: number, factor = 1.8): T[] {
  const a0 = Math.PI * rMedian * rMedian
  return clusters.filter((c) => c.status !== 'too-large' && c.area >= factor * Math.max(1, c.chosenK + c.fixedIds.length) * a0)
}

/**
 * Stricter under-split audit: clusters whose foreground area alone would hold
 * at least one more prior-sized colony than was placed (area ≥ (K + fixed + 1)
 * × π r̃²). Overlap only lowers a cluster's area, so these are hard to explain
 * without an extra colony (or oversized ones). Not ground truth.
 */
export function underSplitStrict<T extends AuditCluster>(clusters: T[], rMedian: number): T[] {
  const a0 = Math.PI * rMedian * rMedian
  return clusters.filter((c) => c.status !== 'too-large' && c.area >= (c.chosenK + c.fixedIds.length + 1) * a0)
}
