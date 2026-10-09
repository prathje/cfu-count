/** Annotation groups: project-wide marker groups (create, rename, delete, order, style, visibility, lock). */
import { batch, createMemo, type Accessor } from 'solid-js'
import { unwrap } from 'solid-js/store'
import type { AnnotationGroup, ID } from '../../model/types'
import { clampStyle, makeGroup, moveItem, type GroupStylePatch } from '../../model/groups'
import { newId } from '../../model/ids'
import { dropEntriesForGroup } from '../history'
import { lockedMessage } from '../messages'
import type { EditorContext } from './context'

export interface GroupCommands {
  /** All groups in display order (immutable snapshot; identity changes on every change). */
  list: Accessor<readonly AnnotationGroup[]>
  active: Accessor<AnnotationGroup | undefined>
  byId(id: ID): AnnotationGroup | undefined
  /** Annotations of a group across all images (for delete confirmations). */
  usage(id: ID): { annotations: number; images: number }

  create(name?: string): ID | null
  rename(id: ID, name: string): void
  /** Deletes the group and its annotations on every image (refused if locked or last group). */
  remove(id: ID): boolean
  move(id: ID, delta: number): void
  /** Refused while the group is locked. */
  setStyle(id: ID, patch: GroupStylePatch): boolean
  /** Visibility and lock stay available regardless of lock state. */
  setHidden(id: ID, hidden: boolean): void
  setLocked(id: ID, locked: boolean): void
  toggleHidden(id: ID): void
  toggleLocked(id: ID): void
}

export function createGroups(ctx: EditorContext): GroupCommands {
  const { state, setState, notify } = ctx

  const list = createMemo<readonly AnnotationGroup[]>(() => {
    const groups = state.project?.annotationGroups
    return groups ? unwrap(groups) : []
  })
  const active = createMemo(() => list().find((g) => g.id === state.activeGroupId))

  /**
   * Replace the group list. Group changes only dirty project.json: it is the source of
   * truth for groups, and a document's group snapshot is refreshed when that document
   * is saved for its own reasons (docs/schema.md). Toggling visibility therefore never
   * re-uploads every annotation document.
   */
  function write(next: AnnotationGroup[]) {
    setState('project', 'annotationGroups', next)
    ctx.touchProject()
  }
  const patch = (id: ID, fields: Partial<AnnotationGroup>) =>
    write(unwrap(state.project!.annotationGroups).map((g) => (g.id === id ? { ...g, ...fields } : g)))

  function create(name?: string): ID | null {
    if (!state.project || ctx.editsFrozen()) return null
    const group = makeGroup(unwrap(state.project.annotationGroups), newId(), name)
    batch(() => {
      write([...unwrap(state.project!.annotationGroups), group])
      setState('activeGroupId', group.id)
    })
    return group.id
  }

  function rename(id: ID, name: string) {
    const trimmed = name.trim()
    const group = ctx.groupById(id)
    if (!group || !trimmed || trimmed === group.name || ctx.editsFrozen()) return
    patch(id, { name: trimmed })
  }

  function usage(id: ID) {
    let annotations = 0
    let images = 0
    for (const doc of Object.values(state.docs)) {
      const n = doc.annotations.filter((a) => a.groupId === id).length
      annotations += n
      if (n) images++
    }
    return { annotations, images }
  }

  function remove(id: ID): boolean {
    const project = state.project
    const group = ctx.groupById(id)
    if (!project || !group || ctx.editsFrozen()) return false
    if (group.locked) {
      notify({ tone: 'warning', key: 'blocked', message: lockedMessage(group), detail: 'Locked groups can’t be deleted.' })
      return false
    }
    if (project.annotationGroups.length <= 1) {
      notify({ tone: 'info', message: 'A project needs at least one annotation group' })
      return false
    }
    const index = project.annotationGroups.findIndex((g) => g.id === id)
    batch(() => {
      for (const [imageId, doc] of Object.entries(state.docs)) {
        if (doc.annotations.some((a) => a.groupId === id)) {
          setState('docs', imageId, 'annotations', unwrap(doc.annotations).filter((a) => a.groupId !== id))
          ctx.touchDoc(imageId)
        }
      }
      for (const imageId of Object.keys(state.history)) {
        setState('history', imageId, dropEntriesForGroup(unwrap(state.history[imageId]), id))
      }
      write(unwrap(project.annotationGroups).filter((g) => g.id !== id))
      if (state.activeGroupId === id) {
        const groups = state.project!.annotationGroups
        setState('activeGroupId', groups[Math.min(index, groups.length - 1)]?.id ?? null)
      }
    })
    return true
  }

  function move(id: ID, delta: number) {
    const groups = state.project?.annotationGroups
    if (!groups || ctx.editsFrozen()) return
    const from = groups.findIndex((g) => g.id === id)
    if (from < 0) return
    write(moveItem(unwrap(groups), from, from + delta))
  }

  function setStyle(id: ID, style: GroupStylePatch): boolean {
    const group = ctx.groupById(id)
    if (!group || ctx.editsFrozen()) return false
    if (group.locked) {
      notify({
        tone: 'warning',
        key: 'blocked',
        message: lockedMessage(group),
        action: { label: 'Unlock', run: () => setLocked(id, false) },
      })
      return false
    }
    patch(id, clampStyle(style))
    return true
  }

  function setHidden(id: ID, hidden: boolean) {
    const g = ctx.groupById(id)
    if (g && g.hidden !== hidden && !ctx.editsFrozen()) patch(id, { hidden })
  }
  function setLocked(id: ID, locked: boolean) {
    const g = ctx.groupById(id)
    if (g && g.locked !== locked && !ctx.editsFrozen()) patch(id, { locked })
  }

  return {
    list,
    active,
    byId: ctx.groupById,
    usage,
    create,
    rename,
    remove,
    move,
    setStyle,
    setHidden,
    setLocked,
    toggleHidden: (id) => {
      const g = ctx.groupById(id)
      if (g) setHidden(id, !g.hidden)
    },
    toggleLocked: (id) => {
      const g = ctx.groupById(id)
      if (g) setLocked(id, !g.locked)
    },
  }
}
