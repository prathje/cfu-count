/**
 * Image intake: format sniffing (magic bytes, not file extensions), decoding with
 * EXIF orientation applied, and SHA-256 fingerprinting.
 */

export interface SniffedFormat {
  mimeType: string
  /** File extension used inside archives (images/<imageId>.<ext>). */
  ext: string
  label: string
}

const FORMATS = {
  jpeg: { mimeType: 'image/jpeg', ext: 'jpg', label: 'JPEG' },
  png: { mimeType: 'image/png', ext: 'png', label: 'PNG' },
  webp: { mimeType: 'image/webp', ext: 'webp', label: 'WebP' },
  gif: { mimeType: 'image/gif', ext: 'gif', label: 'GIF' },
  bmp: { mimeType: 'image/bmp', ext: 'bmp', label: 'BMP' },
  avif: { mimeType: 'image/avif', ext: 'avif', label: 'AVIF' },
  heic: { mimeType: 'image/heic', ext: 'heic', label: 'HEIC/HEIF' },
  tiff: { mimeType: 'image/tiff', ext: 'tif', label: 'TIFF' },
} satisfies Record<string, SniffedFormat>

/** MIME types offered in file pickers / the Drive picker. */
export const ACCEPTED_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp', 'image/avif', 'image/heic', 'image/heif']

export function extensionForMime(mime: string): string {
  for (const f of Object.values(FORMATS)) if (f.mimeType === mime) return f.ext
  if (mime === 'image/heif') return 'heif'
  return 'bin'
}

export function sniffFormat(head: Uint8Array): SniffedFormat | null {
  const b = head
  const ascii = (start: number, len: number) => String.fromCharCode(...b.subarray(start, start + len))
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return FORMATS.jpeg
  if (b.length >= 8 && b[0] === 0x89 && ascii(1, 3) === 'PNG') return FORMATS.png
  if (b.length >= 6 && ascii(0, 4) === 'GIF8') return FORMATS.gif
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return FORMATS.webp
  if (b.length >= 2 && ascii(0, 2) === 'BM') return FORMATS.bmp
  if (b.length >= 4 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 0x2a)))
    return FORMATS.tiff
  if (b.length >= 12 && ascii(4, 4) === 'ftyp') {
    const brands = [ascii(8, 4)]
    // compatible brands follow major brand + minor version
    for (let i = 16; i + 4 <= Math.min(b.length, 64); i += 4) brands.push(ascii(i, 4))
    if (brands.some((x) => x === 'avif' || x === 'avis')) return FORMATS.avif
    if (brands.some((x) => ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(x))) return FORMATS.heic
  }
  return null
}

export interface DecodedSize {
  width: number
  height: number
}

/** Returns oriented (EXIF-applied) pixel dimensions or throws if the browser cannot decode. */
export type ImageDecoder = (blob: Blob) => Promise<DecodedSize>

/**
 * Default browser decoder. createImageBitmap with imageOrientation 'from-image'
 * applies EXIF orientation; the <img> fallback relies on CSS `image-orientation:
 * from-image`, the default in all current browsers, which also orients naturalWidth/Height.
 */
export const browserDecoder: ImageDecoder = async (blob) => {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' })
      const size = { width: bmp.width, height: bmp.height }
      bmp.close()
      if (size.width > 0 && size.height > 0) return size
    } catch {
      // fall through to <img> (e.g. Safari builds without Blob/option support)
    }
  }
  if (typeof document === 'undefined') throw new Error('no image decoder available')
  const url = URL.createObjectURL(blob)
  try {
    const img = new Image()
    img.decoding = 'async'
    img.src = url
    await img.decode()
    return { width: img.naturalWidth, height: img.naturalHeight }
  } finally {
    URL.revokeObjectURL(url)
  }
}

export async function sha256Hex(data: Blob | ArrayBuffer | Uint8Array): Promise<string> {
  const buf: BufferSource = data instanceof Blob ? await data.arrayBuffer() : (data as BufferSource)
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, '0')).join('')
}

export interface InspectedImage {
  mimeType: string
  width: number
  height: number
  byteSize: number
  fingerprint: string
}

/** Browsers cannot reliably allocate canvases beyond this many pixels (iOS Safari limits are lower). */
export const MAX_PIXELS = 250_000_000

export class UnsupportedImageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedImageError'
  }
}

/** Validate, decode and fingerprint one image. Throws UnsupportedImageError with a user-facing reason. */
export async function inspectImage(blob: Blob, decode: ImageDecoder): Promise<InspectedImage> {
  if (blob.size === 0) throw new UnsupportedImageError('The file is empty.')
  const head = new Uint8Array(await blob.slice(0, 64).arrayBuffer())
  const format = sniffFormat(head)
  if (!format) {
    throw new UnsupportedImageError('Not a recognised image format. Use JPEG, PNG, WebP, AVIF, GIF or BMP.')
  }
  if (format === FORMATS.tiff) {
    throw new UnsupportedImageError('TIFF images cannot be displayed by web browsers. Convert to PNG (lossless) or JPEG first.')
  }
  let size: DecodedSize
  try {
    size = await decode(blob.type === format.mimeType ? blob : blob.slice(0, blob.size, format.mimeType))
  } catch {
    if (format === FORMATS.heic) {
      throw new UnsupportedImageError(
        'HEIC/HEIF photos can only be decoded by Safari. Open the app in Safari, or export the photo as JPEG (on iPhone: Settings > Camera > Formats > Most Compatible).',
      )
    }
    throw new UnsupportedImageError(`This ${format.label} file could not be decoded by the browser (it may be corrupt or use an unsupported variant).`)
  }
  if (!(size.width > 0 && size.height > 0)) throw new UnsupportedImageError('The image has no pixels.')
  if (size.width * size.height > MAX_PIXELS) {
    throw new UnsupportedImageError(
      `The image is too large (${size.width}×${size.height} px). Images up to ${MAX_PIXELS / 1e6} megapixels are supported.`,
    )
  }
  return {
    mimeType: format.mimeType,
    width: size.width,
    height: size.height,
    byteSize: blob.size,
    fingerprint: await sha256Hex(blob),
  }
}
