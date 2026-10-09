/**
 * Editing rules for the viewport, as pure functions: given a tap (or hover) in
 * screen space, the current view and the annotation data, decide the intent.
 * No DOM, no rendering, no gesture recognition.
 */
import type { Annotation, AnnotationGroup, ID } from '../model/types'
import type { Tool, ViewState } from './api'
import type { PointerKind } from './gesture'
import type { PointIndex } from './spatial-index'
import { screenToImage } from './transform'

/** Minimum erase hit radius in screen CSS px, by input type. */
export const MIN_HIT_RADIUS: Record<PointerKind, number> = { mouse: 12, pen: 22, touch: 22 }
/** Smallest screen radius (CSS px) used for the near-duplicate cue. */
export const MIN_DUPLICATE_RADIUS = 6

/** Screen-space erase hit radius (CSS px): never smaller than the drawn marker. */
export function eraseHitRadiusPx(markerSize: number, pointer: PointerKind): number {
  return Math.max(markerSize, MIN_HIT_RADIUS[pointer])
}

/** Why the active group cannot be edited. */
export type EditBlock = 'hidden' | 'locked' | 'no-group'

/** Can the active group be edited? Reasons are checked in order: no group, hidden, locked. */
export function editBlockReason(group: AnnotationGroup | undefined | null): EditBlock | null {
  if (!group) return 'no-group'
  if (group.hidden) return 'hidden'
  if (group.locked) return 'locked'
  return null
}

/** Data a tap or hover is resolved against. */
export interface InteractionScene {
  view: ViewState
  imageWidth: number
  imageHeight: number
  groups: readonly AnnotationGroup[]
  activeGroup: AnnotationGroup | undefined
  /** Index over ALL annotations of the image (any group). */
  index: PointIndex
}

/** What a completed tap means. */
export type TapIntent =
  | { kind: 'none' }
  /** Add at image (x, y). `nearby` is an existing visible marker that overlaps (cue only). */
  | { kind: 'add'; x: number; y: number; nearby: Annotation | null }
  | { kind: 'erase'; id: ID; annotation: Annotation }
  | { kind: 'blocked'; reason: EditBlock | 'nothing-to-erase' }

/**
 * Resolve a completed tap at screen (sx, sy).
 *  - Pan tool: nothing.
 *  - Hidden/locked/no active group: blocked (both add and erase).
 *  - Add: inside the image bounds only; never refused for being near another
 *    marker (adds are undoable), but the overlapping marker is reported for a cue.
 *  - Erase: nearest marker of the ACTIVE group within a zoom-aware, input-aware radius.
 */
export function resolveTap(
  scene: InteractionScene,
  tool: Tool,
  sx: number,
  sy: number,
  pointer: PointerKind,
): TapIntent {
  if (tool === 'pan') return { kind: 'none' }
  const g = scene.activeGroup
  const block = editBlockReason(g)
  if (block || !g) return { kind: 'blocked', reason: block ?? 'no-group' }
  const p = screenToImage(scene.view, sx, sy)
  if (tool === 'add') {
    if (p.x < 0 || p.y < 0 || p.x > scene.imageWidth || p.y > scene.imageHeight) return { kind: 'none' }
    return { kind: 'add', x: p.x, y: p.y, nearby: nearbyVisibleMarker(scene, p.x, p.y, g.size) }
  }
  const hit = eraseTarget(scene, g, p.x, p.y, pointer)
  return hit ? { kind: 'erase', id: hit.id, annotation: hit } : { kind: 'blocked', reason: 'nothing-to-erase' }
}

function eraseTarget(
  scene: InteractionScene,
  g: AnnotationGroup,
  x: number,
  y: number,
  pointer: PointerKind,
): Annotation | null {
  const radius = eraseHitRadiusPx(g.size, pointer) / scene.view.scale
  return scene.index.nearest(x, y, radius, (a) => a.groupId === g.id)?.annotation ?? null
}

/**
 * Nearest visible marker (any group) within one marker radius in screen space
 * of image point (x, y): a probable accidental double-tap on the same colony.
 */
export function nearbyVisibleMarker(
  scene: InteractionScene,
  x: number,
  y: number,
  markerSize: number,
): Annotation | null {
  const visible = new Set(scene.groups.filter((g) => !g.hidden).map((g) => g.id))
  const radius = Math.max(MIN_DUPLICATE_RADIUS, markerSize) / scene.view.scale
  return scene.index.nearest(x, y, radius, (a) => visible.has(a.groupId))?.annotation ?? null
}

/** What the hover preview should show, in screen CSS px. */
export type HoverPreview =
  | { kind: 'none' }
  /** Where a tap would add, drawn in the group colour. */
  | { kind: 'add'; x: number; y: number; r: number; color: string }
  /** The marker a tap would erase. */
  | { kind: 'erase-hit'; x: number; y: number; r: number }
  /** Erase hit area at the pointer when nothing is in range. */
  | { kind: 'erase-miss'; x: number; y: number; r: number }

/** Resolve the hover preview for a hovering mouse or pen at screen (sx, sy). */
export function resolveHover(
  scene: InteractionScene,
  tool: Tool,
  sx: number,
  sy: number,
  pointer: PointerKind,
): HoverPreview {
  const g = scene.activeGroup
  if (tool === 'pan' || editBlockReason(g) || !g) return { kind: 'none' }
  if (tool === 'add') return { kind: 'add', x: sx, y: sy, r: Math.max(3, g.size), color: g.color }
  const p = screenToImage(scene.view, sx, sy)
  const hit = eraseTarget(scene, g, p.x, p.y, pointer)
  if (hit) {
    const v = scene.view
    return {
      kind: 'erase-hit',
      x: (hit.x - v.offsetX) * v.scale,
      y: (hit.y - v.offsetY) * v.scale,
      r: Math.max(6, g.size + 4),
    }
  }
  return { kind: 'erase-miss', x: sx, y: sy, r: eraseHitRadiusPx(g.size, pointer) }
}
