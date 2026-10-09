/** Pure annotation-group helpers (construction, naming, ordering, style limits). */
import type { AnnotationGroup, ID } from './types'
import { nextGroupColor } from './palette'

export const DEFAULT_GROUP_NAME = 'Colonies'
/** Default label font size (CSS px); also used for documents saved before `labelSize` existed. */
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
