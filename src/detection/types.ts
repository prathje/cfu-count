/**
 * Public types of the colony detector (src/detection). Framework-free; safe to
 * import from the UI, the editor state, the Worker and node scripts.
 *
 * Coordinate conventions
 * - Everything crossing this API (seeds, existing annotations, ROI,
 *   suggestions, clusters) is in ORIGINAL image pixels of the analysed image,
 *   same convention as src/model/types.ts (pixel centres at +0.5).
 * - Internally the detector works on an ANALYSIS image: the original scaled by
 *   `scale` (analysis px per original px, ≤ 1).
 */
import type { AnnotationOrigin, DetectionRun, DetectionSeed, ID, SeedQuality } from '../model/types.ts'
import type { RgbaImage } from './image/plane.ts'

export type { RgbaImage } from './image/plane.ts'

/** Which detector to run. 'fitter' is the mainline (H); the others are baselines. */
export type DetectMethod = 'fitter' | 'watershed' | 'log'

/** Region of interest in original-image px (same shape as DetectionRun.roi). */
export type Roi = NonNullable<DetectionRun['roi']>

/**
 * A crop around a seed that lies on ANOTHER image (reference plate). The
 * caller decodes that image, crops a window around the seed (≥ ~8× the colony
 * radius on each side is plenty; 256–384 px at analysis scale is typical) and
 * scales it to roughly the same analysis scale as the target image.
 */
export interface SeedPatch {
  image: RgbaImage
  /** Patch px per ORIGINAL px of the seed's own image. */
  scale: number
  /** Original-image coordinates (of the seed's image) of the patch's top-left corner. */
  originX: number
  originY: number
}

/** One calibration example: a manual annotation of the target group. */
export interface SeedInput {
  annotationId: ID
  /** Image the seed was placed on. */
  imageId: ID
  /** Original-image coordinates on its own image. */
  x: number
  y: number
  /** Required when `imageId` differs from the analysed image; ignored otherwise. */
  patch?: SeedPatch
}

/** Existing annotation of ANY group (hidden ones too): fixed colony in fits and duplicate checks. */
export interface ExistingAnnotation {
  id: ID
  x: number
  y: number
  groupId: ID
  origin: AnnotationOrigin
  /** Known colony radius in original px (Annotation.geometry.r), if any. */
  r?: number
}

export interface DetectSettings {
  method: DetectMethod
  /** 0..1 (default 0.5). Higher = more suggestions (lower mask threshold and count penalty). */
  sensitivity: number
  /** Multiplier on the seed-derived log-radius spread (default 1). */
  priorWidth: number
  /** Auto-ROI rim exclusion as a fraction of the plate's equivalent diameter (default 0.025). */
  edgeMarginFrac: number
  /** Clusters whose area exceeds kMax typical colonies are returned as 'too-large' without a fit (default 400). */
  kMax: number
  /**
   * Fitter: a group is flagged for review when its RELATIVE objective gap (evidence
   * per contested colony, see ClusterResult.relativeGap) is below this (default 0.1).
   * A runner-up of "no colony" (K = 0) never makes a review region.
   */
  reviewGap: number
  /** Floor for the log-radius spread s (default 0.25, i.e. ±25 %). */
  sMin: number
  /** Below this many usable seeds the calibration is reported as tentative (default 3). */
  minUsableSeeds: number
  /**
   * Fitter objective variant: 'tuned' (default; see fitter.ts) or 'brief' (the
   * product owner's formula: L_mask + α L_boundary + β Σ((log r − μ)/s)² + λ K).
   */
  objective?: 'tuned' | 'brief'
  /** Advanced (evaluation/tuning): override fitter objective weights. */
  fitWeights?: Partial<{ alpha: number; beta: number; gamma: number; lambda: number; wFP: number; huber: number; omega: number; oversize: number; undersize: number; areaCount: number }>
}

export interface DetectInput {
  /** RGBA pixels of the analysed image at analysis scale. */
  image: RgbaImage
  /** Analysis px per original px (e.g. 0.25). */
  scale: number
  /** Original (oriented) size, to clamp results and to fill the run record. */
  originalWidth: number
  originalHeight: number
  imageId: ID
  targetGroupId: ID
  seeds: SeedInput[]
  existing: ExistingAnnotation[]
  /** User-supplied ROI (original px). Absent → auto-detect the plate. */
  roi?: Roi
  /**
   * When `image` is a crop of the original: original-px position of the crop's
   * top-left corner. Seeds/existing/ROI/results stay in full-image coordinates.
   */
  origin?: { x: number; y: number }
  /** ImageRecord.fingerprint of the analysed bytes: part of every cache key, copied into the run record. */
  imageFingerprint?: string
  settings?: Partial<DetectSettings>
  /** Optional run id (otherwise generated). */
  runId?: ID
  /** Return the analysis-scale cluster label raster (evaluation, cluster highlighting). */
  includeClusterLabels?: boolean
}

/** Cluster label raster at analysis scale: label L belongs to clusterId `c${L}`; 0 = none. */
export interface ClusterLabels {
  width: number
  height: number
  /** Analysis px per original px. */
  scale: number
  labels: Int32Array
  /** Original-px position of the raster's top-left (crop analysis); absent = (0, 0). */
  origin?: { x: number; y: number }
}

export type SuggestionStatus = 'ok' | 'review'

/** One proposed colony. Pending: never an Annotation until the user accepts it. */
export interface Suggestion {
  /** Original-image px. */
  x: number
  y: number
  /** Fitted colony radius in original px (→ Annotation.geometry.r on accept). */
  r: number
  /**
   * Method-specific support score, NOT a probability. Fitter: the relative gap of the
   * colony's group (see ClusterResult.relativeGap). Null when not meaningful.
   */
  score: number | null
  clusterId: string
  status: SuggestionStatus
}

export type ClusterStatus = 'ok' | 'review' | 'too-large'

/** A connected foreground region and how it was explained. */
export interface ClusterResult {
  clusterId: string
  /** Bounding box in original px: [x, y, w, h]. */
  bbox: [number, number, number, number]
  /** Foreground area in original px². */
  area: number
  /** Existing annotation IDs treated as fixed colonies inside this cluster. */
  fixedIds: ID[]
  /** New colonies proposed (excludes fixed ones). */
  chosenK: number
  runnerUpK: number | null
  /** J(runner-up) − J(chosen) in units of one typical colony; null if not computed. */
  objectiveGap: number | null
  /**
   * Fitter: objectiveGap divided by the contested area (colonies that differ
   * between the chosen and the runner-up explanation, in typical-colony units).
   * The review flag uses this; it is a diagnostic, not a probability.
   */
  relativeGap?: number | null
  status: ClusterStatus
  /** For review clusters: the runner-up explanation (new colonies only), so the UI can offer "2 or 3?". */
  alternative?: { k: number; colonies: { x: number; y: number; r: number }[] }
}

export interface SeedReport extends DetectionSeed {
  /** Seed centre after local re-centring (original px of its own image); the annotation is never moved. */
  fitX: number
  fitY: number
  /** Peak background-normalised contrast (units of noise σ). */
  snr: number
  /** Short explanation for a non-ok quality. */
  note?: string
}

export interface RadiusPrior {
  /** Median log radius (original px). */
  mu: number
  /** Robust spread of log radius, after the floor and small-sample inflation. */
  s: number
  sMin: number
  /** Number of seeds used. */
  n: number
  /** exp(mu): typical radius in original px. */
  rMedian: number
  /** Range covering ±2 s (original px). */
  rRange: [number, number]
}

export interface RobustRange {
  median: number
  /** Robust scale (scaled MAD with a floor). */
  scale: number
}

export interface CalibrationReport {
  seeds: SeedReport[]
  nTotal: number
  nUsable: number
  /** Null when no seed was usable (defaults were used instead). */
  prior: RadiusPrior | null
  /** Per-feature robust ranges: contrast, L, a, b, edge sharpness, circularity. */
  appearance: Record<string, RobustRange>
  /** +1: colonies brighter than agar along the chosen colour axis; −1: darker. */
  polarity: 1 | -1
  /** Unit Lab direction the contrast plane projects onto. */
  colorAxis: [number, number, number]
  /** e.g. "8 manual examples; 6 usable for size estimation". */
  summary: string
  tentative: boolean
  warnings: string[]
}

export interface RoiReport {
  source: 'user' | 'auto' | 'fallback'
  /** Plate outline (convex hull) in original px, before the edge margin. */
  outline: { x: number; y: number }[]
  shape: 'round' | 'square' | 'other' | 'user'
  /** Rim band excluded inside the outline (original px). */
  marginPx: number
  /** Analysed area in original px². */
  area: number
}

export interface DetectResult {
  method: DetectMethod
  suggestions: Suggestion[]
  clusters: ClusterResult[]
  calibration: CalibrationReport
  roi: RoiReport
  /**
   * Ready-to-store run record. The caller must fill `imageFingerprint` and
   * `seedImageFingerprints` (left empty here) before persisting it with the
   * accepted annotations.
   */
  run: DetectionRun
  timingsMs: Record<string, number>
  /** Approximate peak bytes held in rasters during the run. */
  peakRasterBytes: number
  /** Present when `includeClusterLabels` was set. */
  clusterLabels?: ClusterLabels
}

export interface DetectProgress {
  stage: 'prepare' | 'roi' | 'calibrate' | 'mask' | 'candidates' | 'fit' | 'done'
  /** 0..1 within the whole run. */
  fraction: number
}

export type ProgressFn = (p: DetectProgress) => void

export type { DetectionRun, DetectionSeed, SeedQuality }
