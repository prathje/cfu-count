/**
 * Pure annotation logic shared by the editor (state), the UI and storage
 * (summary.csv). No Solid, no I/O.
 *
 * "Confirmed" has ONE definition, `isConfirmed`, used everywhere a count is shown
 * or exported. Manual marks are always `accepted` (enforced by
 * `normaliseAnnotation`, which storage applies to everything it reads).
 */
import type { Annotation, AnnotationGroup, DetectionRun, ID } from './types'
import { editBlock } from './policy'

// ---------------------------------------------------------------------------
// Construction & normalisation
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

/**
 * Enforce invariants on an annotation read from an untrusted source:
 * a manual mark is always `accepted` (a person placed it). Returns the same
 * object when nothing changes.
 */
export function normaliseAnnotation(a: Annotation): Annotation {
  if (a.origin === 'manual' && a.reviewStatus !== 'accepted') return { ...a, reviewStatus: 'accepted' }
  return a
}

// ---------------------------------------------------------------------------
// Counts — always derived from records, never stored
// ---------------------------------------------------------------------------

/** Confirmed = accepted (manual marks are always accepted). Hidden groups still count. */
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

/** Per-group breakdown used by summary.csv. `confirmed === manual + automatedAccepted`. */
export interface CountBreakdown {
  confirmed: number
  manual: number
  automatedAccepted: number
  automatedUnreviewed: number
}

export const emptyBreakdown = (): CountBreakdown => ({ confirmed: 0, manual: 0, automatedAccepted: 0, automatedUnreviewed: 0 })

export function countBreakdownByGroup(annotations: readonly Annotation[] | undefined): Map<ID, CountBreakdown> {
  const out = new Map<ID, CountBreakdown>()
  for (const raw of annotations ?? []) {
    const a = normaliseAnnotation(raw)
    let c = out.get(a.groupId)
    if (!c) out.set(a.groupId, (c = emptyBreakdown()))
    if (isConfirmed(a)) {
      c.confirmed++
      if (a.origin === 'manual') c.manual++
      else c.automatedAccepted++
    } else if (a.origin === 'automated' && a.reviewStatus === 'unreviewed') c.automatedUnreviewed++
  }
  return out
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

/** Apply ops to an annotation list, returning a NEW list (input untouched). */
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

/** Why a batch of ops may not be applied. */
export type OpBlock =
  | { reason: 'locked' | 'hidden'; group: AnnotationGroup }
  | { reason: 'missing'; groupId: ID }
  /** A programming error in the batch itself (e.g. an update that rewrites `origin`). */
  | { reason: 'invalid'; detail: string }

/**
 * Why a set of ops may not be applied, or null if allowed.
 * Precedence: invalid > locked > hidden > missing (per-group rule: model/policy.ts).
 * `origin` and `id` are immutable: an update op that changes either is invalid.
 */
export function checkOps(ops: readonly AnnotationOp[], groups: readonly AnnotationGroup[]): OpBlock | null {
  for (const op of ops) {
    if (op.kind !== 'update') continue
    if (op.before.id !== op.after.id) return { reason: 'invalid', detail: `An update may not change an annotation's id (${op.before.id}).` }
    if (op.before.origin !== op.after.origin) {
      return { reason: 'invalid', detail: `An update may not change the origin of annotation ${op.before.id}.` }
    }
  }
  const ids = new Set(ops.flatMap(opGroupIds))
  let hidden: OpBlock | null = null
  let missing: OpBlock | null = null
  for (const id of ids) {
    const group = groups.find((g) => g.id === id)
    const reason = editBlock(group)
    if (!group) missing ??= { reason: 'missing', groupId: id }
    else if (reason === 'locked') return { reason, group }
    else if (reason === 'hidden') hidden ??= { reason, group }
  }
  return hidden ?? missing
}

/**
 * Check a detection-run record against the image it is stored with and the
 * project's groups. Returns a problem description or null.
 */
export function checkDetectionRun(
  run: DetectionRun,
  image: { fingerprint: string },
  groups: readonly AnnotationGroup[],
): string | null {
  if (run.imageFingerprint !== image.fingerprint) return `Detection run ${run.runId} was computed on a different image (fingerprint mismatch).`
  if (!groups.some((g) => g.id === run.targetGroupId)) return `Detection run ${run.runId} targets an unknown annotation group.`
  return null
}
