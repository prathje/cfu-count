/** Messages between the viewport and adjust.worker.ts. */
import type { Matrix3 } from './image-adjust'

export type WorkerRequest =
  | { id: number; type: 'adjust'; bitmap: ImageBitmap; matrix: Matrix3; lut: Uint8ClampedArray }
  | { id: number; type: 'histogram'; bitmap: ImageBitmap; matrix: Matrix3 }

export type WorkerReply =
  | { id: number; bitmap: ImageBitmap }
  | { id: number; hist: Uint32Array }
  | { id: number; error: string }
