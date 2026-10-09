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
  detector?: DetectorProvenance
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
      /** Drive file `version` per output file ID when last read/written; used for conflict checks. */
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
