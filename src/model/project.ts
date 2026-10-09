/**
 * Pure project-level helpers: image ordering, annotation documents and the
 * storage-owned field merge shared by the editor and the repository.
 */
import type { ID, ImageAnnotations, ImageRecord, Project } from './types'
import { SCHEMA_VERSION } from './types'

/** The user removed this image from the project (soft delete; see ImageRecord.deletedAt). */
export const isRemoved = (image: Pick<ImageRecord, 'deletedAt'>): boolean => !!image.deletedAt

/** Images that are part of the project (not removed), in import order. */
export function activeImages(project: Pick<Project, 'images'>): ImageRecord[] {
  return project.images.filter((img) => !isRemoved(img))
}

/** Removed images, most recently removed first ("Recently removed"). */
export function removedImages(project: Pick<Project, 'images'>): ImageRecord[] {
  return project.images.filter(isRemoved).sort((a, b) => b.deletedAt!.localeCompare(a.deletedAt!))
}

/**
 * Images of one image group (null = ungrouped, including dangling group ids), in
 * import order. Removed images are left out.
 */
export function imagesInGroup(project: Project, imageGroupId: ID | null): ImageRecord[] {
  const known = new Set(project.imageGroups.map((g) => g.id))
  return activeImages(project).filter((img) =>
    imageGroupId === null ? img.imageGroupId === null || !known.has(img.imageGroupId) : img.imageGroupId === imageGroupId,
  )
}

/** Flat display order of all images that are not removed: by image group order, then ungrouped (next/previous, default selection). */
export function displayOrder(project: Project): ImageRecord[] {
  return [...project.imageGroups.flatMap((g) => imagesInGroup(project, g.id)), ...imagesInGroup(project, null)]
}

export function emptyDoc(project: Project, image: ImageRecord, at: string): ImageAnnotations {
  return {
    schemaVersion: SCHEMA_VERSION,
    projectId: project.id,
    imageId: image.id,
    imageFingerprint: image.fingerprint,
    width: image.width,
    height: image.height,
    groups: [],
    annotations: [],
    detectionRuns: [],
    updatedAt: at,
  }
}

/**
 * Snapshot of a document for saving: image facts from the record and the group
 * snapshot refreshed from the project. Group snapshots are refreshed ONLY when a
 * document is saved for its own reasons (or exported), never because a group
 * changed — project.json is the source of truth for groups (docs/schema.md).
 */
export function docForSave(project: Project, image: ImageRecord, doc: ImageAnnotations): ImageAnnotations {
  return {
    ...doc,
    schemaVersion: SCHEMA_VERSION,
    projectId: project.id,
    imageId: image.id,
    imageFingerprint: image.fingerprint,
    width: image.width,
    height: image.height,
    groups: project.annotationGroups.map((g) => ({ ...g })),
    annotations: doc.annotations.map((a) => ({ ...a })),
    detectionRuns: doc.detectionRuns ?? [],
  }
}

/**
 * Fields of a project that STORAGE owns (the editor never changes them):
 *   storage, revision, and each image's source / sourceMismatch.
 * (`deletedAt` is editor-owned: removing and restoring images are edits.)
 * Returns `editor` with those fields taken from `stored`; everything else is the
 * editor's. Images that exist only on one side are left as the editor has them.
 * Used by the repository when the editor saves (stale storage fields are ignored)
 * and by the editor when storage reports a change (link created, image uploaded...).
 */
export function applyStorageOwned(editor: Project, stored: Project): Project {
  const byId = new Map(stored.images.map((i) => [i.id, i]))
  return {
    ...editor,
    storage: stored.storage,
    revision: stored.revision,
    images: editor.images.map((img) => {
      const s = byId.get(img.id)
      if (!s) return img
      const merged: ImageRecord = { ...img, source: s.source }
      if (s.sourceMismatch) merged.sourceMismatch = s.sourceMismatch
      else delete merged.sourceMismatch
      return merged
    }),
  }
}
