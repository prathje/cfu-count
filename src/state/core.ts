/**
 * Pure annotation / group logic. No Solid, no I/O — everything here is unit-tested.
 */
import type { Annotation, AnnotationGroup, ID, ImageAnnotations, ImageRecord, Project } from '../model/types'
import { SCHEMA_VERSION } from '../model/types'
import { nextGroupColor } from './palette'

// ---------------------------------------------------------------------------
// Annotation operations (the unit of history)
// ---------------------------------------------------------------------------

export type AnnotationOp =
  | { kind: 'add'; annotation: Annotation }
  | { kind: 'remove'; annotation: Annotation }
  | { kind: 'update'; before: Annotation; after: Annotation }

export function invertOp(op: AnnotationOp): AnnotationOp {
  switch (op.kind) {
    case 'add':
      return { kind: 'remove', annotation: op.annotation }
    case 'remove':
      return { kind: 'add', annotation: op.annotation }
    case 'update':
      return { kind: 'update', before: op.after, after: op.before }
  }
}

/** Inverse of a batch: inverted ops in reverse order. */
export function invertOps(ops: readonly AnnotationOp[]): AnnotationOp[] {
  return ops.map(invertOp).reverse()
}

/** Apply ops to an annotation list, returning a new list (input untouched). */
export function applyOps(annotations: readonly Annotation[], ops: readonly AnnotationOp[]): Annotation[] {
  let list = annotations.slice()
  for (const op of ops) {
    switch (op.kind) {
      case 'add':
        if (!list.some((a) => a.id === op.annotation.id)) list.push(op.annotation)
        break
      case 'remove':
        list = list.filter((a) => a.id !== op.annotation.id)
        break
      case 'update': {
        const i = list.findIndex((a) => a.id === op.before.id)
        if (i >= 0) list[i] = op.after
        break
      }
    }
  }
  return list
}

/** Group IDs an op touches (both sides of an update, so regrouping checks both groups). */
export function opGroupIds(op: AnnotationOp): ID[] {
  if (op.kind === 'update') {
    return op.before.groupId === op.after.groupId ? [op.after.groupId] : [op.before.groupId, op.after.groupId]
  }
  return [op.annotation.groupId]
}

export type EditBlock =
  | { reason: 'locked'; group: AnnotationGroup }
  | { reason: 'hidden'; group: AnnotationGroup }
  | { reason: 'missing'; groupId: ID }

/** Why a set of ops may not be applied (locked > hidden > missing), or null if allowed. */
export function checkOps(ops: readonly AnnotationOp[], groups: readonly AnnotationGroup[]): EditBlock | null {
  const ids = new Set(ops.flatMap(opGroupIds))
  let hidden: EditBlock | null = null
  let missing: EditBlock | null = null
  for (const id of ids) {
    const group = groups.find((g) => g.id === id)
    if (!group) {
      missing ??= { reason: 'missing', groupId: id }
      continue
    }
    if (group.locked) return { reason: 'locked', group }
    if (group.hidden) hidden ??= { reason: 'hidden', group }
  }
  return hidden ?? missing
}

/** Can the user edit annotations of this group right now? */
export function groupEditBlock(group: AnnotationGroup | undefined): 'locked' | 'hidden' | 'no-group' | null {
  if (!group) return 'no-group'
  if (group.locked) return 'locked'
  if (group.hidden) return 'hidden'
  return null
}

// ---------------------------------------------------------------------------
// Annotation construction
// ---------------------------------------------------------------------------

export function makeManualAnnotation(x: number, y: number, groupId: ID, id: ID, at: string): Annotation {
  return {
    id,
    x,
    y,
    groupId,
    origin: 'manual',
    createdAt: at,
    updatedAt: at,
    reviewStatus: 'accepted',
    reviewedAt: at,
    lastEditSource: 'manual',
    manuallyAdjusted: false,
  }
}

// ---------------------------------------------------------------------------
// Counts — always derived from records, never stored
// ---------------------------------------------------------------------------

/** Confirmed = accepted. Hidden groups still count (visibility is not exclusion). */
export const isConfirmed = (a: Annotation): boolean => a.reviewStatus === 'accepted'

export function confirmedCount(annotations: readonly Annotation[] | undefined): number {
  if (!annotations) return 0
  let n = 0
  for (const a of annotations) if (isConfirmed(a)) n++
  return n
}

export function confirmedCountsByGroup(annotations: readonly Annotation[] | undefined): Map<ID, number> {
  const counts = new Map<ID, number>()
  if (!annotations) return counts
  for (const a of annotations) {
    if (!isConfirmed(a)) continue
    counts.set(a.groupId, (counts.get(a.groupId) ?? 0) + 1)
  }
  return counts
}

/** Confirmed annotations split by the visibility of their group. */
export function visibilitySplit(
  annotations: readonly Annotation[] | undefined,
  groups: readonly AnnotationGroup[],
): { visible: number; hidden: number } {
  const hiddenIds = new Set(groups.filter((g) => g.hidden).map((g) => g.id))
  let visible = 0
  let hidden = 0
  for (const a of annotations ?? []) {
    if (!isConfirmed(a)) continue
    if (hiddenIds.has(a.groupId)) hidden++
    else visible++
  }
  return { visible, hidden }
}

// ---------------------------------------------------------------------------
// Annotation groups
// ---------------------------------------------------------------------------

export const DEFAULT_GROUP_NAME = 'Colonies'
export const DEFAULT_LABEL_SIZE = 12
export const LABEL_SIZE_RANGE = { min: 8, max: 32 } as const

export function makeGroup(existing: readonly AnnotationGroup[], id: ID, name?: string): AnnotationGroup {
  return {
    id,
    name: name?.trim() || uniqueName(existing.map((g) => g.name), existing.length ? 'Group' : DEFAULT_GROUP_NAME),
    color: nextGroupColor(existing.map((g) => g.color)),
    render: 'dot',
    opacity: 0.9,
    size: 6,
    labels: false,
    labelSize: DEFAULT_LABEL_SIZE,
    hidden: false,
    locked: false,
  }
}

/** "Group" -> "Group 2", "Group 3"... avoiding existing names (case-insensitive). */
export function uniqueName(existing: readonly string[], base: string): string {
  const taken = new Set(existing.map((n) => n.trim().toLowerCase()))
  if (!taken.has(base.toLowerCase())) return base
  for (let i = 2; ; i++) {
    const candidate = `${base} ${i}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
}

/** Move an item to a new index (clamped). Returns a new array. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const out = list.slice()
  if (from < 0 || from >= out.length) return out
  const clamped = Math.max(0, Math.min(out.length - 1, to))
  const [item] = out.splice(from, 1)
  out.splice(clamped, 0, item)
  return out
}

/** Style fields that a locked group refuses to change. */
export type GroupStylePatch = Partial<Pick<AnnotationGroup, 'color' | 'render' | 'opacity' | 'size' | 'labels' | 'labelSize'>>

export function clampStyle(patch: GroupStylePatch): GroupStylePatch {
  const out: GroupStylePatch = { ...patch }
  if (out.opacity !== undefined) out.opacity = Math.min(1, Math.max(0.1, out.opacity))
  if (out.size !== undefined) out.size = Math.min(24, Math.max(2, Math.round(out.size)))
  if (out.labelSize !== undefined)
    out.labelSize = Math.min(LABEL_SIZE_RANGE.max, Math.max(LABEL_SIZE_RANGE.min, Math.round(out.labelSize)))
  return out
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

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

/** Snapshot of a document for saving: groups refreshed from the project, image facts from the record. */
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

/** Images ordered for display: by image group order, then ungrouped, preserving import order within a group. */
export function imagesInGroup(project: Project, imageGroupId: ID | null): ImageRecord[] {
  const known = new Set(project.imageGroups.map((g) => g.id))
  return project.images.filter((img) =>
    imageGroupId === null ? img.imageGroupId === null || !known.has(img.imageGroupId) : img.imageGroupId === imageGroupId,
  )
}

/** Flat display order of all images (used for next/previous and default selection). */
export function displayOrder(project: Project): ImageRecord[] {
  return [...project.imageGroups.flatMap((g) => imagesInGroup(project, g.id)), ...imagesInGroup(project, null)]
}
