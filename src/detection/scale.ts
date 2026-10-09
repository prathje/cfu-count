/**
 * Choice of the analysis resolution.
 *
 * Two passes are expected in the app:
 *  1. Before seed radii are known, decode at a PRELIMINARY scale (long side
 *     `preliminaryLongSide`, default 2048 px) – enough to estimate seed radii
 *     of colonies ≥ ~10 original px on a 24 MP photo.
 *  2. Once the prior is known, `chooseAnalysisScale` picks the smallest scale
 *     at which the smallest expected colony still has a radius of
 *     `targetMinRadius` analysis px AND a typical colony `targetTypicalRadius`
 *     px (seams between touching colonies are only 1–2 px wide at r ≈ 6;
 *     separating them needs r ≈ 8–10). Product decision (2026-10-09): accuracy
 *     first — there is NO default pixel cap, also not on iPad. Memory is kept
 *     down by analysing only the plate (crop) and by per-cluster processing,
 *     not by downsampling. `maxPixels` remains as an explicit override.
 */

export interface ScaleRequest {
  width: number
  height: number
  /** Smallest expected colony radius in ORIGINAL px (e.g. exp(mu − 2 s)). */
  minRadiusOriginal?: number
  /** Desired radius in analysis px for that smallest colony (default 4). */
  targetMinRadius?: number
  /** Typical colony radius in ORIGINAL px (e.g. exp(mu)). */
  typicalRadiusOriginal?: number
  /** Desired analysis radius of a typical colony (default 8). */
  targetTypicalRadius?: number
  /** Optional pixel budget for the analysis image (default: none). */
  maxPixels?: number
  /** Never upsample (default max 1). */
  maxScale?: number
  /** Fallback long side when no radius is known (default 2048). */
  preliminaryLongSide?: number
}

export interface ScaleChoice {
  scale: number
  width: number
  height: number
  /** Why this scale was chosen. */
  reason: 'radius' | 'pixel-cap' | 'full-resolution' | 'preliminary'
}

export function chooseAnalysisScale(req: ScaleRequest): ScaleChoice {
  const maxPixels = req.maxPixels ?? Infinity
  const maxScale = req.maxScale ?? 1
  const capScale = Math.min(maxScale, Math.sqrt(maxPixels / (req.width * req.height)))
  let scale: number
  let reason: ScaleChoice['reason']
  if ((req.minRadiusOriginal && req.minRadiusOriginal > 0) || (req.typicalRadiusOriginal && req.typicalRadiusOriginal > 0)) {
    const a = req.minRadiusOriginal ? (req.targetMinRadius ?? 4) / req.minRadiusOriginal : 0
    const b = req.typicalRadiusOriginal ? (req.targetTypicalRadius ?? 8) / req.typicalRadiusOriginal : 0
    scale = Math.max(a, b)
    reason = 'radius'
  } else {
    scale = (req.preliminaryLongSide ?? 2048) / Math.max(req.width, req.height)
    reason = 'preliminary'
  }
  if (scale >= capScale) {
    reason = capScale >= maxScale ? 'full-resolution' : 'pixel-cap'
    scale = capScale
  }
  return { scale, width: Math.max(1, Math.round(req.width * scale)), height: Math.max(1, Math.round(req.height * scale)), reason }
}
