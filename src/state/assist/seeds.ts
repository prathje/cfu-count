/**
 * Assisted counting: when "Find similar" may run, which examples (seeds) it
 * uses, and the detector request built from them (pure).
 *
 * Seeds are the active group's MANUAL annotations on the current image. When
 * there are fewer than MIN_SEEDS, the user may borrow examples from another
 * image of the project (a reference plate): its manual annotations in the same
 * group are sent as remote seeds and the worker crops patches around them.
 */
import type { Annotation, AnnotationGroup, ID, ImageAnnotations, ImageRecord } from '../../model/types'
import { editBlock } from '../../model/policy'
import type { DetectRequest, ExistingAnnotation, RemoteSeed } from '../../detection'
import type { ReviewSettings } from './review'
import type { RegionPolygon } from '../../model/region'

/** Below this many examples the result is tentative and a reference plate is offered. */
export const MIN_SEEDS = 3
/** At most this many examples are sent (the most recently placed ones). */
export const MAX_SEEDS = 40

/** Manual annotations of a group usable as examples (most recent MAX_SEEDS). */
export function seedAnnotations(annotations: readonly Annotation[] | undefined, groupId: ID): Annotation[] {
  const list = (annotations ?? []).filter((a) => a.groupId === groupId && a.origin === 'manual' && a.reviewStatus === 'accepted')
  return list.length > MAX_SEEDS ? list.slice(-MAX_SEEDS) : list
}

/** Another image of the project that can lend examples. */
export interface ReferenceCandidate {
  imageId: ID
  name: string
  count: number
}

/**
 * Images (other than the current one) with at least MIN_SEEDS manual examples
 * of the group, most examples first. Images whose bytes changed are skipped.
 */
export function referenceCandidates(
  images: readonly ImageRecord[],
  docs: Readonly<Record<ID, Pick<ImageAnnotations, 'annotations'> | undefined>>,
  groupId: ID,
  currentImageId: ID | null,
): ReferenceCandidate[] {
  const out: ReferenceCandidate[] = []
  for (const img of images) {
    if (img.id === currentImageId || img.sourceMismatch || img.deletedAt) continue
    const count = seedAnnotations(docs[img.id]?.annotations, groupId).length
    if (count >= MIN_SEEDS) out.push({ imageId: img.id, name: img.name, count })
  }
  return out.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

/** Where the examples come from. */
export type SeedSource = { kind: 'this-image' } | { kind: 'reference'; imageId: ID }

/** Why Find similar can't run right now, with a plain-language explanation. */
export type FindBlockReason = 'no-image' | 'no-group' | 'locked' | 'hidden' | 'source-mismatch' | 'size-mismatch' | 'no-seeds'

export interface FindBlock {
  reason: FindBlockReason
  message: string
  detail: string
}

export interface FindBlockInput {
  image: ImageRecord | null
  group: AnnotationGroup | undefined
  /** The decoded picture's size differs from the recorded size. */
  sizeMismatch: boolean
  localSeeds: number
  referenceCount: number
}

/** First reason Find similar is unavailable, or null. Same precedence as the edit policy. */
export function findBlock(i: FindBlockInput): FindBlock | null {
  if (!i.image) return { reason: 'no-image', message: 'No image open', detail: 'Open an image to look for colonies on it.' }
  const g = i.group
  const block = editBlock(g)
  if (block === 'no-group' || !g) return { reason: 'no-group', message: 'Choose an annotation group first', detail: 'Suggestions are added to the selected group.' }
  if (block === 'locked') return { reason: 'locked', message: `“${g.name}” is locked`, detail: 'Unlock the group to add suggestions to it.' }
  if (block === 'hidden') return { reason: 'hidden', message: `“${g.name}” is hidden`, detail: 'Show the group so you can see what is added.' }
  if (i.image.sourceMismatch)
    return { reason: 'source-mismatch', message: 'This image changed since it was counted', detail: 'Assisted counting is off until the image and its markers agree again.' }
  if (i.sizeMismatch)
    return { reason: 'size-mismatch', message: 'Image size doesn’t match the markers', detail: 'This browser decodes the image at a different size, so suggestions could be misplaced.' }
  if (i.localSeeds === 0 && i.referenceCount === 0)
    return {
      reason: 'no-seeds',
      message: `Mark a few colonies in “${g.name}” first`,
      detail: `Add ${MIN_SEEDS} or more typical, isolated colonies by hand. They are the examples the search looks for.`,
    }
  return null
}

/** The seed source to start with: this image when it has enough examples, otherwise the best reference. */
export function defaultSeedSource(localSeeds: number, candidates: readonly ReferenceCandidate[]): SeedSource {
  if (localSeeds >= MIN_SEEDS || candidates.length === 0) return { kind: 'this-image' }
  return { kind: 'reference', imageId: candidates[0].imageId }
}

/** Everything about the request except the image bytes. */
export type RequestWithoutBytes = Omit<DetectRequest, 'source' | 'remoteSources'>

export interface RequestInput {
  image: ImageRecord
  groupId: ID
  /** All annotations on the analysed image (every group, hidden too). */
  annotations: readonly Annotation[]
  /** Reference image and its annotations, when borrowing examples. */
  reference?: { image: ImageRecord; annotations: readonly Annotation[] }
  settings: ReviewSettings
  runId: ID
  /** Restrict the search to a drawn region (image px); seeds may lie anywhere. */
  roi?: RegionPolygon | null
}

/**
 * Build the detector request: local seeds = manual examples of the group on
 * this image; existing = every annotation of the image (fixed colonies, so
 * none is suggested twice); remote seeds from the reference image, if any.
 */
export function buildRequest(i: RequestInput): RequestWithoutBytes {
  const local = seedAnnotations(i.annotations, i.groupId)
  const existing: ExistingAnnotation[] = i.annotations.map((a) => ({
    id: a.id,
    x: a.x,
    y: a.y,
    groupId: a.groupId,
    origin: a.origin,
    ...(a.geometry?.kind === 'circle' ? { r: a.geometry.r } : {}),
  }))
  const remoteSeeds: RemoteSeed[] = i.reference
    ? seedAnnotations(i.reference.annotations, i.groupId).map((a) => ({
        annotationId: a.id,
        imageId: i.reference!.image.id,
        x: a.x,
        y: a.y,
        imageWidth: i.reference!.image.width,
        imageHeight: i.reference!.image.height,
      }))
    : []
  return {
    originalWidth: i.image.width,
    originalHeight: i.image.height,
    imageId: i.image.id,
    // fingerprints key the worker's decode/plan/fit caches: replaced bytes under the same id never reuse stale fits
    ...(i.image.fingerprint ? { imageFingerprint: i.image.fingerprint } : {}),
    targetGroupId: i.groupId,
    seeds: local.map((a) => ({ annotationId: a.id, imageId: i.image.id, x: a.x, y: a.y })),
    existing,
    ...(remoteSeeds.length ? { remoteSeeds } : {}),
    ...(remoteSeeds.length && i.reference!.image.fingerprint ? { remoteFingerprints: { [i.reference!.image.id]: i.reference!.image.fingerprint } } : {}),
    settings: { method: i.settings.method, sensitivity: i.settings.sensitivity, priorWidth: i.settings.priorWidth },
    runId: i.runId,
    ...(i.roi && i.roi.length >= 3 ? { roi: { kind: 'polygon' as const, points: i.roi.map((p) => ({ x: p.x, y: p.y })) } } : {}),
  }
}
