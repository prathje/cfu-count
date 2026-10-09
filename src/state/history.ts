/**
 * Per-image undo/redo history (pure). Each image has its own stacks, so
 * switching images can never apply history to the wrong image. One entry =
 * one batch of ops = one undo step.
 */
import type { AnnotationGroup, DetectionRun, ID } from '../model/types'
import { checkOps, invertOps, type AnnotationOp, type EditBlock } from './core'

export interface HistoryEntry {
  id: string
  /** Human label, e.g. "Add colony", "Accept 24 suggestions". */
  label: string
  /** Forward ops; undo applies invertOps(ops). */
  ops: AnnotationOp[]
  at: string
  /** Detection run recorded with this batch (accepting suggestions); removed on undo, restored on redo. */
  detectionRun?: DetectionRun
}

export interface ImageHistory {
  undo: HistoryEntry[]
  redo: HistoryEntry[]
}

export const HISTORY_LIMIT = 300

export const emptyHistory = (): ImageHistory => ({ undo: [], redo: [] })

/** Record a new entry: pushes onto undo, clears redo, trims to the limit. */
export function record(h: ImageHistory, entry: HistoryEntry, limit = HISTORY_LIMIT): ImageHistory {
  const undo = [...h.undo, entry]
  if (undo.length > limit) undo.splice(0, undo.length - limit)
  return { undo, redo: [] }
}

export type HistoryPlan =
  | { ok: true; ops: AnnotationOp[]; entry: HistoryEntry; next: ImageHistory }
  | { ok: false; reason: 'empty' }
  | { ok: false; reason: 'blocked'; block: EditBlock; entry: HistoryEntry }

/** Plan an undo; refuses (without changing history) if it would touch a locked/hidden/missing group. */
export function planUndo(h: ImageHistory, groups: readonly AnnotationGroup[]): HistoryPlan {
  const entry = h.undo[h.undo.length - 1]
  if (!entry) return { ok: false, reason: 'empty' }
  const ops = invertOps(entry.ops)
  const block = checkOps(ops, groups)
  if (block) return { ok: false, reason: 'blocked', block, entry }
  return { ok: true, ops, entry, next: { undo: h.undo.slice(0, -1), redo: [...h.redo, entry] } }
}

export function planRedo(h: ImageHistory, groups: readonly AnnotationGroup[]): HistoryPlan {
  const entry = h.redo[h.redo.length - 1]
  if (!entry) return { ok: false, reason: 'empty' }
  const ops = entry.ops
  const block = checkOps(ops, groups)
  if (block) return { ok: false, reason: 'blocked', block, entry }
  return { ok: true, ops, entry, next: { undo: [...h.undo, entry], redo: h.redo.slice(0, -1) } }
}

/** Drop entries that reference a group (used when a group is deleted — they could never be replayed). */
export function dropEntriesForGroup(h: ImageHistory, groupId: ID): ImageHistory {
  const keep = (e: HistoryEntry) =>
    !e.ops.some((op) =>
      op.kind === 'update' ? op.before.groupId === groupId || op.after.groupId === groupId : op.annotation.groupId === groupId,
    )
  return { undo: h.undo.filter(keep), redo: h.redo.filter(keep) }
}
