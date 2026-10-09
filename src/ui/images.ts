/**
 * Image loading for the UI: decoded bitmaps for the viewport and small cached
 * thumbnails for the sidebar. Object URLs are revoked when images are removed
 * or the cache is cleared (project switch).
 */
import { createEffect, createSignal, onCleanup, type Accessor } from 'solid-js'
import type { ID } from '../model/types'

/** Supplies original image bytes (bound to the repository + open project by the caller). */
export type BlobSource = (imageId: ID) => Promise<Blob>

const THUMB_SIZE = 96

export function decodeImage(blob: Blob): Promise<ImageBitmap> {
  return createImageBitmap(blob, { imageOrientation: 'from-image' })
}

/** Small JPEG thumbnail cache keyed by image id. Generation is serialised to bound memory on iPad. */
export interface ThumbnailCache {
  /** Reactive URL for an image (undefined while generating / on failure). */
  url(imageId: ID): string | undefined
  /** Whether generating the thumbnail failed. */
  failed(imageId: ID): boolean
  request(imageId: ID): void
  forget(imageId: ID): void
  clear(): void
}

export function createThumbnailCache(source: Accessor<BlobSource | null>): ThumbnailCache {
  const [urls, setUrls] = createSignal<Record<ID, string>>({})
  const [failures, setFailures] = createSignal<Record<ID, true>>({})
  const requested = new Set<ID>()
  let queue = Promise.resolve()
  let generation = 0

  async function make(imageId: ID, gen: number) {
    const src = source()
    if (!src) return
    try {
      const bitmap = await decodeImage(await src(imageId))
      const scale = THUMB_SIZE / Math.min(bitmap.width, bitmap.height)
      const w = Math.max(1, Math.round(bitmap.width * scale))
      const h = Math.max(1, Math.round(bitmap.height * scale))
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')!
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(bitmap, 0, 0, w, h)
      bitmap.close()
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.8))
      if (!blob || gen !== generation || !requested.has(imageId)) return
      const url = URL.createObjectURL(blob)
      setUrls((u) => ({ ...u, [imageId]: url }))
    } catch (err) {
      console.warn('Thumbnail failed', imageId, err)
      if (gen === generation) setFailures((f) => ({ ...f, [imageId]: true }))
    }
  }

  return {
    url: (id) => urls()[id],
    failed: (id) => !!failures()[id],
    request(id) {
      if (requested.has(id)) return
      requested.add(id)
      const gen = generation
      queue = queue.then(() => make(id, gen))
    },
    forget(id) {
      requested.delete(id)
      const url = urls()[id]
      if (url) URL.revokeObjectURL(url)
      setUrls(({ [id]: _, ...rest }) => rest)
    },
    clear() {
      generation++
      requested.clear()
      for (const url of Object.values(urls())) URL.revokeObjectURL(url)
      setUrls({})
      setFailures({})
    },
  }
}

/** State of the decoded current image. */
export type BitmapState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; bitmap: ImageBitmap }
  | { status: 'error'; message: string }

/**
 * Decodes the current image whenever `imageId` changes, closing the previous
 * bitmap to release memory. Stale decodes (user switched quickly) are discarded.
 */
export function createCurrentBitmap(imageId: Accessor<ID | null>, source: Accessor<BlobSource | null>): Accessor<BitmapState> {
  const [state, setState] = createSignal<BitmapState>({ status: 'idle' })
  let token = 0
  let current: ImageBitmap | null = null
  const release = () => {
    current?.close()
    current = null
  }

  createEffect(() => {
    const id = imageId()
    const src = source()
    const mine = ++token
    if (!id || !src) {
      release()
      setState({ status: 'idle' })
      return
    }
    setState({ status: 'loading' })
    src(id)
      .then(decodeImage)
      .then((bitmap) => {
        if (mine !== token) return bitmap.close()
        release()
        current = bitmap
        setState({ status: 'ready', bitmap })
      })
      .catch((err: unknown) => {
        if (mine !== token) return
        release()
        setState({ status: 'error', message: err instanceof Error ? err.message : 'The image could not be decoded.' })
      })
  })
  onCleanup(release)
  return state
}
