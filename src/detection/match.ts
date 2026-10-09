/**
 * Point matching between two sets of colony positions (pure). Shared by the
 * evaluation harness (scripts/eval) and the in-app "Compare with detector"
 * check, so both report the same numbers for the same inputs.
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
export function matchPoints(pred: readonly Pt[], gt: readonly Pt[], radius: number): MatchResult {
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
