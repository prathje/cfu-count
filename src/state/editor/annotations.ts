/**
 * Annotations of the current image: add / erase / batches (future: accepting
 * automated suggestions) and per-image undo/redo. Every change goes through
 * `applyBatch`, which enforces the edit policy (model/policy.ts via checkOps).
 */
import { batch, createMemo, type Accessor } from 'solid-js'
import { unwrap } from 'solid-js/store'
import type { Annotation, AnnotationGroup, DetectionRun, ID } from '../../model/types'
import {
  applyOps,
  checkDetectionRun,
  checkRunImage,
  checkOps,
  confirmedCount,
  confirmedCountsByGroup,
  makeManualAnnotation,
  visibilitySplit,
  type AnnotationOp,
  type OpBlock,
} from '../../model/annotations'
import { editBlock, type EditBlockReason, type GroupBlockReason } from '../../model/policy'
import { emptyDoc } from '../../model/project'
import { newId, now } from '../../model/ids'
import { emptyHistory, planRedo, planUndo, record } from '../history'
import { editBlockMessage, historyBlockMessage } from '../messages'
import type { EditorContext } from './context'
import type { GroupCommands } from './groups'

export interface BatchOptions {
  /** Shown in undo/redo messages, e.g. "Accept 24 suggestions". */
  label: string
  /**
   * Provenance of an automated batch. Appended to the image's detectionRuns in the
   * same undo step (removed again on undo, restored on redo). Its imageFingerprint
   * must match the image and its targetGroupId must exist.
   */
  detectionRun?: DetectionRun
}

export interface AnnotationCommands {
  /**
   * All annotations of the current image as a plain, immutable snapshot: the array
   * identity changes exactly when the list changes (pass it straight to the viewport).
   */
  current: Accessor<readonly Annotation[]>
  /** Confirmed count per annotation group on the current image. */
  counts: Accessor<Map<ID, number>>
  /** Confirmed total on the current image (hidden groups included). */
  total: Accessor<number>
  /** Confirmed annotations on the current image in visible vs hidden groups. */
  split: Accessor<{ visible: number; hidden: number }>
  canUndo: Accessor<boolean>
  canRedo: Accessor<boolean>

  /** Add a manual, accepted annotation to the active group on the current image. */
  add(x: number, y: number): boolean
  erase(annotationId: ID): boolean
  /** Apply ops to one image as ONE undo step. Returns the block if refused (nothing changes). */
  applyBatch(imageId: ID, ops: AnnotationOp[], opts: BatchOptions): OpBlock | null
  /** Undo/redo on the current image; refused (with explanation) if it would touch a locked/hidden group. */
  undo(): boolean
  redo(): boolean
  /** Explain a viewport-reported refusal (toast with a fix-it action). */
  explainBlocked(reason: EditBlockReason | 'nothing-to-erase'): void
}

export function createAnnotations(ctx: EditorContext, groups: GroupCommands): AnnotationCommands {
  const { state, setState, notify } = ctx

  const current = createMemo<readonly Annotation[]>(() => {
    const id = state.currentImageId
    const list = id ? state.docs[id]?.annotations : undefined
    return list ? unwrap(list) : []
  })
  const counts = createMemo(() => confirmedCountsByGroup(current()))
  const total = createMemo(() => confirmedCount(current()))
  const split = createMemo(() => visibilitySplit(current(), groups.list()))
  const currentHistory = createMemo(() => (state.currentImageId ? state.history[state.currentImageId] : undefined))
  const canUndo = createMemo(() => (currentHistory()?.undo.length ?? 0) > 0)
  const canRedo = createMemo(() => (currentHistory()?.redo.length ?? 0) > 0)

  // ------------------------------------------------------------ notices
  const fixFor = (reason: GroupBlockReason, group: AnnotationGroup) =>
    reason === 'locked'
      ? { label: 'Unlock', run: () => groups.setLocked(group.id, false) }
      : { label: 'Show group', run: () => groups.setHidden(group.id, false) }

  function explainBlocked(reason: EditBlockReason | 'nothing-to-erase') {
    const group = groups.active()
    if (reason === 'nothing-to-erase') {
      notify({
        tone: 'info',
        key: 'blocked',
        message: group ? `No “${group.name}” marker here to erase` : 'Nothing to erase here',
        detail: 'Erase removes the nearest marker of the selected group.',
      })
      return
    }
    if (reason === 'no-group' || !group) {
      notify({ tone: 'warning', key: 'blocked', message: editBlockMessage('no-group', group) })
      return
    }
    notify({
      tone: 'warning',
      key: 'blocked',
      message: editBlockMessage(reason, group),
      detail:
        reason === 'hidden'
          ? 'Hidden groups can’t be edited, so no change happens out of sight.'
          : 'Locked groups can’t be added to or erased. Visibility still works.',
      action: fixFor(reason, group),
    })
  }

  function explainOpBlock(block: OpBlock, message: string, detail: string) {
    const action = block.reason === 'locked' || block.reason === 'hidden' ? fixFor(block.reason, block.group) : undefined
    notify({ tone: 'warning', key: 'blocked', message, detail, action })
  }

  // ------------------------------------------------------------ writes
  function ensureDoc(imageId: ID): void {
    if (state.docs[imageId] || !state.project) return
    const image = state.project.images.find((i) => i.id === imageId)
    if (image) setState('docs', imageId, emptyDoc(unwrap(state.project), unwrap(image), now()))
  }

  /** Add (or remove) a detection run record on an image's document. */
  function setRun(imageId: ID, run: DetectionRun, present: boolean) {
    ensureDoc(imageId)
    const runs = (unwrap(state.docs[imageId]).detectionRuns ?? []).filter((r) => r.runId !== run.runId)
    setState('docs', imageId, 'detectionRuns', present ? [...runs, structuredClone(run)] : runs)
  }

  function writeOps(imageId: ID, ops: AnnotationOp[]) {
    ensureDoc(imageId)
    setState('docs', imageId, 'annotations', applyOps(unwrap(state.docs[imageId]).annotations, ops))
    ctx.touchDoc(imageId)
  }

  function applyBatch(imageId: ID, ops: AnnotationOp[], opts: BatchOptions): OpBlock | null {
    const project = state.project
    if (!project || ops.length === 0) return null
    const image = project.images.find((i) => i.id === imageId)
    if (!image) return { reason: 'invalid', detail: `Image ${imageId} is not part of the project.` }
    if (ctx.editsFrozen()) return { reason: 'invalid', detail: 'The project is busy; try again in a moment.' }
    const groupList = unwrap(project.annotationGroups)
    const block = checkOps(ops, groupList)
    if (block) return block
    if (opts.detectionRun) {
      const problem = checkDetectionRun(opts.detectionRun, image, groupList)
      if (problem) return { reason: 'invalid', detail: problem }
    }
    batch(() => {
      writeOps(imageId, ops)
      if (opts.detectionRun) setRun(imageId, opts.detectionRun, true)
      setState(
        'history',
        imageId,
        record(unwrap(state.history[imageId]) ?? emptyHistory(), {
          id: newId(),
          label: opts.label,
          ops,
          at: now(),
          detectionRun: opts.detectionRun ? structuredClone(opts.detectionRun) : undefined,
        }),
      )
    })
    return null
  }

  function add(x: number, y: number): boolean {
    const imageId = state.currentImageId
    if (!imageId || ctx.editsFrozen()) return false
    const group = groups.active()
    const reason = editBlock(group)
    if (reason || !group) {
      explainBlocked(reason ?? 'no-group')
      return false
    }
    const annotation = makeManualAnnotation(x, y, group.id, newId(), now())
    return applyBatch(imageId, [{ kind: 'add', annotation }], { label: 'Add colony' }) === null
  }

  function erase(annotationId: ID): boolean {
    const imageId = state.currentImageId
    if (!imageId || ctx.editsFrozen()) return false
    const annotation = state.docs[imageId]?.annotations.find((a) => a.id === annotationId)
    if (!annotation) return false
    const block = applyBatch(imageId, [{ kind: 'remove', annotation: { ...unwrap(annotation) } }], { label: 'Erase colony' })
    if (block) {
      if (block.reason === 'locked' || block.reason === 'hidden') explainBlocked(block.reason)
      return false
    }
    return true
  }

  function stepHistory(direction: 'undo' | 'redo'): boolean {
    const imageId = state.currentImageId
    if (!imageId || !state.project || ctx.editsFrozen()) return false
    const h = unwrap(state.history[imageId]) ?? emptyHistory()
    const groupList = unwrap(state.project.annotationGroups)
    const plan = direction === 'undo' ? planUndo(h, groupList) : planRedo(h, groupList)
    // Redo re-stores the run record: it must still describe these image bytes.
    const run = plan.ok && direction === 'redo' ? plan.entry.detectionRun : undefined
    const image = run ? state.project.images.find((i) => i.id === imageId) : undefined
    const runProblem = run && image ? checkRunImage(run, image) : null
    if (runProblem) {
      notify({
        tone: 'warning',
        key: 'blocked',
        message: `Can’t redo “${plan.ok ? plan.entry.label : ''}”: the image changed`,
        detail: `${runProblem} Run Find similar again on the current image.`,
      })
      return false
    }
    if (!plan.ok) {
      if (plan.reason === 'blocked') {
        const { message, detail } = historyBlockMessage(plan.block, direction, plan.entry.label)
        explainOpBlock(plan.block, message, detail)
      }
      return false
    }
    batch(() => {
      writeOps(imageId, plan.ops)
      if (plan.entry.detectionRun) setRun(imageId, plan.entry.detectionRun, direction === 'redo')
      setState('history', imageId, plan.next)
    })
    return true
  }

  return {
    current,
    counts,
    total,
    split,
    canUndo,
    canRedo,
    add,
    erase,
    applyBatch,
    undo: () => stepHistory('undo'),
    redo: () => stepHistory('redo'),
    explainBlocked,
  }
}
