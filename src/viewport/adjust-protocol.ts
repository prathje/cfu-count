/** Messages between the viewport and adjust.worker.ts. */
import type { ColourStage } from './image-adjust'

export type WorkerRequest =
  | { id: number; type: 'adjust'; bitmap: ImageBitmap; stage: ColourStage; lut: Uint8ClampedArray }
  | { id: number; type: 'histogram'; bitmap: ImageBitmap; stage: ColourStage }

export type WorkerReply =
  | { id: number; bitmap: ImageBitmap }
  | { id: number; hist: Uint32Array }
  | { id: number; error: string }
