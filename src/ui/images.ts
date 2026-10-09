/**
 * Image loading for the UI: decoded images for the viewport and small cached
 * thumbnails for the sidebar. Decoding uses the SAME path as import
 * (storage/images.ts decodeImage), and the decoded size is compared with the
 * stored record so a mismatch is reported instead of silently misplacing
 * markers. Object URLs are revoked when images are removed or the cache is
 * cleared (project switch).
 */
import { createEffect, createMemo, createSignal, onCleanup, untrack, type Accessor } from 'solid-js'
import type { ID } from '../model/types'
import { decodeImage, type DecodedImage } from '../storage/images'

/** Supplies original image bytes (bound to the repository + open project by the caller). */
export type BlobSource = (imageId: ID) => Promise<Blob>

const THUMB_SIZE = 96

/** Small JPEG thumbnail cache keyed by image id. Generation is serialised to bound memory on iPad. */
export interface ThumbnailCache {
  /** Reactive URL for an image (undefined while generating / on failure). */
  url(imageId: ID): string | undefined
  /** Whether generating the thumbnail failed (a later request or retryFailed tries again). */
  failed(imageId: ID): boolean
  request(imageId: ID): void
  /** Try every failed thumbnail again (e.g. after connecting Google Drive). */
  retryFailed(): void
  forget(imageId: ID): void
  clear(): void
}

export function createThumbnailCache(source: Accessor<BlobSource | null>): ThumbnailCache {
  const [urls, setUrls] = createSignal<Record<ID, string>>({})
  const [failures, setFailures] = createSignal<Record<ID, true>>({})
  const requested = new Set<ID>()
  let queue = Promise.resolve()
  let generation = 0

  function setUrl(imageId: ID, url: string) {
    // A re-request (forget + request while a job was queued) must not leak the earlier URL.
    const old = untrack(urls)[imageId]
    if (old && old !== url) URL.revokeObjectURL(old)
    setUrls((u) => ({ ...u, [imageId]: url }))
  }

  async function render(decoded: DecodedImage): Promise<Blob | null> {
    const scale = THUMB_SIZE / Math.min(decoded.width, decoded.height)
    const w = Math.max(1, Math.round(decoded.width * scale))
    const h = Math.max(1, Math.round(decoded.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    try {
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('Canvas 2D unavailable')
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(decoded.source, 0, 0, w, h)
    } finally {
      decoded.close() // release the full-size bitmap even when drawing fails
    }
    return new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.8))
  }

  async function make(imageId: ID, gen: number) {
    const src = source()
    if (gen !== generation || !requested.has(imageId)) return
    if (!src) {
      requested.delete(imageId) // no project open: let a later request try again
      return
    }
    try {
      const blob = await render(await decodeImage(await src(imageId)))
      if (!blob || gen !== generation || !requested.has(imageId)) return
      setUrl(imageId, URL.createObjectURL(blob))
    } catch (err) {
      console.warn('Thumbnail failed', imageId, err)
      if (gen !== generation) return
      // Forget the request so a later request (or retryFailed) tries again.
      requested.delete(imageId)
      setFailures((f) => ({ ...f, [imageId]: true }))
    }
  }

  function request(id: ID) {
    if (requested.has(id)) return
    requested.add(id)
    if (untrack(failures)[id]) setFailures(({ [id]: _, ...rest }) => rest)
    const gen = generation
    queue = queue.then(() => make(id, gen))
  }

  return {
    url: (id) => urls()[id],
    failed: (id) => !!failures()[id],
    request,
    retryFailed() {
      for (const id of Object.keys(untrack(failures))) request(id)
    },
    forget(id) {
      requested.delete(id)
      const url = untrack(urls)[id]
      if (url) URL.revokeObjectURL(url)
      setUrls(({ [id]: _, ...rest }) => rest)
    },
    clear() {
      generation++
      requested.clear()
      for (const url of Object.values(untrack(urls))) URL.revokeObjectURL(url)
      setUrls({})
      setFailures({})
    },
  }
}

/** State of the decoded current image. */
export type BitmapState =
  | { status: 'idle' }
  | { status: 'loading' }
  | {
      status: 'ready'
      image: DecodedImage
      /** Decoded size differs from the stored record: markers may not line up. */
      sizeMismatch: { width: number; height: number } | null
    }
  | { status: 'error'; message: string }

/** The drawable image of a ready state, else null (narrows the union without casts). */
export function readyImage(s: BitmapState): DecodedImage | null {
  return s.status === 'ready' ? s.image : null
}

/** Decoded size when it differs from the stored record, else null. */
export function bitmapSizeMismatch(s: BitmapState): { width: number; height: number } | null {
  return s.status === 'ready' ? s.sizeMismatch : null
}

/** The error message of a failed state, else null. */
export function bitmapError(s: BitmapState): string | null {
  return s.status === 'error' ? s.message : null
}

export interface ExpectedImage {
  id: ID
  /** Oriented size stored in the ImageRecord at import. */
  width: number
  height: number
}

/**
 * Decodes the current image whenever it changes, closing the previous one to
 * release memory. Stale decodes (user switched quickly) are discarded.
 */
export function createCurrentBitmap(image: Accessor<ExpectedImage | null>, source: Accessor<BlobSource | null>): Accessor<BitmapState> {
  const [state, setState] = createSignal<BitmapState>({ status: 'idle' })
  let token = 0
  let current: DecodedImage | null = null
  const release = () => {
    current?.close()
    current = null
  }

  // Re-decode only when the image identity or its recorded size changes (not on rename).
  const expected = createMemo(image, null, {
    equals: (a, b) => a === b || (!!a && !!b && a.id === b.id && a.width === b.width && a.height === b.height),
  })
  createEffect(() => {
    const img = expected()
    const src = source()
    const mine = ++token
    if (!img || !src) {
      release()
      setState({ status: 'idle' })
      return
    }
    const { id, width, height } = img
    setState({ status: 'loading' })
    src(id)
      .then(decodeImage)
      .then((decoded) => {
        if (mine !== token) return decoded.close()
        release()
        current = decoded
        const sizeMismatch = decoded.width !== width || decoded.height !== height ? { width: decoded.width, height: decoded.height } : null
        setState({ status: 'ready', image: decoded, sizeMismatch })
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
