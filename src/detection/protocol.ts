/**
 * Messages between the main thread (createDetectorClient) and the detection
 * Worker. Only structured-cloneable data; pixel buffers and ImageBitmaps are
 * transferred, not copied.
 */
import type { DetectInput, DetectProgress, DetectResult, SeedInput } from './types.ts'

/** Where the worker gets the analysed image from. */
export type ImageSource =
  /** Original encoded bytes (JPEG/PNG/…): decoded and resized in the worker. Preferred. */
  | { kind: 'blob'; blob: Blob }
  /** Already decoded at full (oriented) resolution; resized in the worker. Transferred. */
  | { kind: 'bitmap'; bitmap: ImageBitmap }
  /** Already at analysis scale (tests, node, or a cached decode). Buffer is transferred. */
  | { kind: 'rgba'; width: number; height: number; data: Uint8ClampedArray; scale: number }

/** A seed on another image: the worker crops its patch from `source`. */
export interface RemoteSeed extends Omit<SeedInput, 'patch'> {
  /** Oriented size of the reference image. */
  imageWidth: number
  imageHeight: number
}

export interface DetectRequest extends Omit<DetectInput, 'image' | 'scale' | 'seeds' | 'origin'> {
  source: ImageSource
  /** Seeds on the analysed image. */
  seeds: Omit<SeedInput, 'patch'>[]
  /** Seeds on other images, with the bytes of each reference image (keyed by imageId). */
  remoteSeeds?: RemoteSeed[]
  remoteSources?: Record<string, Blob>
  /** ImageRecord.fingerprint of each reference image (cache keys); recommended. */
  remoteFingerprints?: Record<string, string>
  /**
   * Analysis-scale policy. Defaults: typical colony 8 px, budget 2.5 MP (raised
   * up to 4 MP only when needed for 8 px), decode cropped to the plate.
   */
  analysis?: { scale?: number; targetTypicalRadius?: number; maxPixels?: number }
}

export type ToWorker = { type: 'detect'; id: number; request: DetectRequest } | { type: 'cancel'; id: number } | { type: 'clear-cache' }

export type ErrorCode = 'decode-failed' | 'out-of-memory' | 'internal'

export type FromWorker =
  | { type: 'progress'; id: number; progress: DetectProgress }
  | { type: 'result'; id: number; result: DetectResult }
  | { type: 'cancelled'; id: number }
  | { type: 'error'; id: number; code: ErrorCode; message: string }
