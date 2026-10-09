/**
 * Versioned data contract (schema v1). This is the source of truth shared by
 * the editor state, storage adapters (IndexedDB / Google Drive) and the
 * project archive (zip) format. See docs/schema.md.
 *
 * Coordinates are in ORIGINAL IMAGE PIXELS of the image as displayed after
 * EXIF orientation is applied (`ImageRecord.width/height`). Origin (0,0) is the
 * top-left corner of the top-left pixel; pixel centres are at +0.5.
 */

export const SCHEMA_VERSION = 1 as const

export type ID = string
/** ISO-8601 timestamp string. */
export type Timestamp = string

export interface ImageGroup {
  id: ID
  name: string
}

/** Where the original image bytes live. The local IndexedDB cache is always keyed by ImageRecord.id. */
export type ImageSource =
  | { kind: 'local' }
  | {
      kind: 'drive'
      fileId: string
      /** Drive `version` (monotonic per file) or md5Checksum seen when the image was last read. */
      version?: string
      md5Checksum?: string
    }

export interface ImageRecord {
  id: ID
  /** Display label only; never used as identity. */
  name: string
  imageGroupId: ID | null
  /** Oriented (post-EXIF) pixel dimensions. Annotation coordinates refer to these. */
  width: number
  height: number
  mimeType: string
  byteSize: number
  /** SHA-256 hex of the original bytes; used to detect replaced images. */
  fingerprint: string
  source: ImageSource
  addedAt: Timestamp
  /**
   * Future extension: multiple photographs (colour filters) of one sample.
   * Unused in v1; coordinates are never shared across channels until alignment exists.
   */
  sampleId?: ID
  /**
   * Set by storage (never by the editor) when the source bytes no longer match the
   * image the annotations were made against, e.g. the Drive file was replaced.
   * The UI must warn before letting the user rely on existing coordinates.
   */
  sourceMismatch?: SourceMismatch
  /**
   * Display-only adjustment of how this image is shown in the viewport
   * (model/display.ts). Never changes image bytes, coordinates, counts or
   * detector input. Absent = unadjusted.
   */
  display?: ImageDisplayAdjust
  /**
   * Set when the user removed the image from the project (soft delete, editor-owned).
   * Nothing is erased: the record, its bytes and its annotation document stay, and
   * the image can be restored. Removed images are left out of the image list,
   * navigation, counts, summary.csv and reference-plate choices; their Drive file
   * is never re-imported by a folder scan (the record still references it).
   */
  deletedAt?: Timestamp
}

/**
 * Which colour information the viewport shows. `luma` = greyscale luminance (Rec. 709);
 * `centre` = centre contrast: grey by position between sampled rim and centre colours.
 */
export type DisplayChannel = 'rgb' | 'red' | 'green' | 'blue' | 'luma' | 'centre'

/** An sRGB colour, 0..255 per channel (may be fractional: a sampled mean). */
export type RgbColour = [number, number, number]

/** Colours sampled with the eyedropper for the `centre` channel view. */
export interface CentreSample {
  /** Mean colour of a small patch at a colony centre. */
  centre: RgbColour
  /** Rest-of-the-disc colour estimated automatically around the picked centre. */
  rim: RgbColour
  /** Rim colour the user picked; overrides `rim` when set. */
  pickedRim: RgbColour | null
}

/**
 * Display adjustment of one image (view setting, editor-owned, stored in project.json).
 * Ranges and defaults: model/display.ts.
 */
export interface ImageDisplayAdjust {
  /** -1..1; adds brightness/2 to the 0..1 value (0 = unchanged). */
  brightness: number
  /** -1..1; slope 2^(2·contrast) around mid-grey (0 = unchanged). */
  contrast: number
  /** 0.2..5; output = v^(1/gamma), > 1 brightens midtones (1 = unchanged). */
  gamma: number
  /** 0..3; 0 = grey, 1 = unchanged. Only applies to the `rgb` channel view. */
  saturation: number
  invert: boolean
  channel: DisplayChannel
  /** Stretch the 0.5 %–99.5 % percentiles of the displayed values to full range. */
  autoContrast: boolean
  /** Sampled colours for the `centre` channel; null until a centre is picked. */
  centre: CentreSample | null
  /** 2..16; steepness of the centre/rim split in the `centre` channel view. */
  separation: number
}

export interface SourceMismatch {
  detectedAt: Timestamp
  /** Human-readable explanation suitable for display. */
  message: string
  /** Drive md5Checksum of the current remote file, if known. */
  remoteMd5?: string
  /** Oriented dimensions of the current remote bytes, if they were decoded. */
  remoteWidth?: number
  remoteHeight?: number
}

export type MarkerRender = 'dot' | 'circle'

export interface AnnotationGroup {
  id: ID
  name: string
  /** CSS hex colour, e.g. "#e5484d". */
  color: string
  render: MarkerRender
  /** 0..1 */
  opacity: number
  /**
   * Display marker radius in CSS pixels (SCREEN space: constant on screen at any zoom).
   * This is NOT a measured colony radius.
   */
  size: number
  /** Show per-group sequence numbers next to markers. */
  labels: boolean
  /** Label font size in CSS px (screen space, like `size`). */
  labelSize: number
  hidden: boolean
  locked: boolean
}

export type AnnotationOrigin = 'manual' | 'automated'
export type ReviewStatus = 'unreviewed' | 'accepted' | 'rejected'

export interface DetectorProvenance {
  name: string
  version: string
  runId: string
  params?: Record<string, unknown>
  /** null = detector does not produce a meaningful confidence (distinct from 0). */
  confidence: number | null
}

export interface Annotation {
  id: ID
  /** Point geometry in original-image coordinates (see file header). */
  x: number
  y: number
  groupId: ID
  /** Immutable. Never inferred from tool/group/colour; never rewritten on edit/accept. */
  origin: AnnotationOrigin
  createdAt: Timestamp
  updatedAt: Timestamp
  /** Manual annotations are created as 'accepted'; automated ones start 'unreviewed'. */
  reviewStatus: ReviewStatus
  reviewedAt?: Timestamp
  lastEditSource: AnnotationOrigin
  /** True once a person moved/changed an automated annotation. */
  manuallyAdjusted: boolean
  /** Automated annotations only. `detector.runId` references ImageAnnotations.detectionRuns. */
  detector?: DetectorProvenance
  /**
   * Inferred colony extent in original-image px (fitted by a detector or estimated
   * for a seed). Distinct from AnnotationGroup.size, which is display-only.
   * Setting it never changes origin / lastEditSource / manuallyAdjusted.
   */
  geometry?: AnnotationGeometry
}

export interface AnnotationGeometry {
  kind: 'circle'
  /** Radius in original-image px. */
  r: number
  /** 0..1 fit quality, if the method produces one. */
  quality?: number
  source: 'fit' | 'seed-estimate'
}

export type SeedQuality = 'ok' | 'touching' | 'edge' | 'glare' | 'weak'

/** Snapshot of one example colony used to calibrate a run (coordinates copied for reproducibility). */
export interface DetectionSeed {
  annotationId: ID
  /** Image the seed was taken from; may be another plate (reference plate) in the project. */
  imageId: ID
  x: number
  y: number
  radiusPx: number | null
  quality: SeedQuality
}

/**
 * Record of one reviewed automated detection run on this image, stored in the
 * image's annotation document. Two kinds:
 *  - an accept run: referenced by the annotations it added (`detector.runId`);
 *    `negatives` = suggestions rejected in the accepted scope;
 *  - a reject-only run: no annotation refers to it (zero accepted); `negatives` =
 *    suggestions the user rejected without accepting them (diagnostics.accepted = 0).
 * Runs are an audit trail: deleting the target group keeps them (targetGroupId may
 * dangle). Negatives are never used to suppress later suggestions. Pending
 * (undecided) suggestions are never stored here.
 */
export interface DetectionRun {
  runId: ID
  method: string
  version: string
  createdAt: Timestamp
  /** Fingerprint of the image analysed (must equal ImageAnnotations.imageFingerprint). */
  imageFingerprint: string
  /** Fingerprints of other images seeds were drawn from, keyed by imageId. */
  seedImageFingerprints?: Record<ID, string>
  /** Analysis resolution relative to the original image (e.g. 0.5). */
  analysisScale: number
  targetGroupId: ID
  /**
   * Region analysed, in original-image coordinates; absent = whole image. A
   * `polygon` is a user-drawn selection (closed, ≥ 3 points): the detector searched
   * the auto-detected plate inside it and kept colonies whose centre lies inside.
   */
  roi?:
    | { kind: 'circle'; cx: number; cy: number; r: number }
    | { kind: 'rect'; x: number; y: number; w: number; h: number }
    | { kind: 'polygon'; points: { x: number; y: number }[] }
  seeds: DetectionSeed[]
  /** Learned priors (e.g. log-radius mu/s, appearance ranges); method-specific. */
  prior: Record<string, unknown>
  /** User-adjustable and fixed settings for the run; method-specific. */
  settings: Record<string, unknown>
  /** Human-rejected suggestions recorded as negatives (image coordinates). Audit/training data, not a filter. */
  negatives?: { x: number; y: number }[]
  /** Summary diagnostics (cluster counts, review flags, timings). */
  diagnostics?: Record<string, unknown>
}

/** One document per image: annotations/<imageId>.json */
export interface ImageAnnotations {
  schemaVersion: typeof SCHEMA_VERSION
  projectId: ID
  imageId: ID
  /** Fingerprint + size of the image these coordinates were made against. */
  imageFingerprint: string
  width: number
  height: number
  /** Snapshot of project annotation groups at save time (self-contained document). */
  groups: AnnotationGroup[]
  annotations: Annotation[]
  /** Reviewed detection runs: accepted (at least partly) or with recorded rejections. */
  detectionRuns: DetectionRun[]
  updatedAt: Timestamp
}

/**
 * Where the project lives besides this browser. Drive sync bookkeeping (output
 * file IDs, content tokens) is storage-internal and never part of the model.
 */
export type ProjectStorageLink =
  | { kind: 'local' }
  | {
      kind: 'drive'
      folderId: string
      folderName: string
      /** Signed-in account, for display. Local only: never written to Drive or exported. */
      account?: string
    }

/** project.json */
export interface Project {
  schemaVersion: typeof SCHEMA_VERSION
  id: ID
  name: string
  createdAt: Timestamp
  updatedAt: Timestamp
  imageGroups: ImageGroup[]
  images: ImageRecord[]
  /** Project-wide annotation groups (same set offered on every image). Order = display order. */
  annotationGroups: AnnotationGroup[]
  storage: ProjectStorageLink
  /** Incremented on each successful local save. Storage-owned. */
  revision: number
}
