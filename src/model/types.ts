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
 * Record of one automated detection run on this image. Stored in the image's
 * annotation document; only runs referenced by at least one kept annotation
 * need to be retained. Pending (unaccepted) suggestions are never stored here.
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
  /** Region analysed, in original-image coordinates; absent = whole image. */
  roi?: { kind: 'circle'; cx: number; cy: number; r: number } | { kind: 'rect'; x: number; y: number; w: number; h: number }
  seeds: DetectionSeed[]
  /** Learned priors (e.g. log-radius mu/s, appearance ranges); method-specific. */
  prior: Record<string, unknown>
  /** User-adjustable and fixed settings for the run; method-specific. */
  settings: Record<string, unknown>
  /** Human-rejected suggestions recorded as negatives (image coordinates). */
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
  /** Automated detection runs whose results were (at least partly) accepted. */
  detectionRuns: DetectionRun[]
  updatedAt: Timestamp
}

export type ProjectStorageLink =
  | { kind: 'local' }
  | {
      kind: 'drive'
      folderId: string
      folderName: string
      /** Drive file IDs of outputs we own, so saves update instead of creating duplicates. */
      files: {
        projectJson?: string
        summaryCsv?: string
        annotationsFolder?: string
        imagesFolder?: string
        /** imageId -> Drive file ID of annotations/<imageId>.json */
        annotations: Record<ID, string>
      }
      /**
       * Content token (Drive `md5Checksum`) per output file ID as last read/written by this
       * browser; used for conflict checks. `version` is not used because it also changes on
       * metadata-only edits (rename, sharing). Not uploaded in project.json.
       */
      remoteVersions: Record<string, string>
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
  /** Incremented on each successful local save. */
  revision: number
}
