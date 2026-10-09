/** Image groups (treatments, batches, dilutions): pure project.json edits. */
import { batch } from 'solid-js'
import { unwrap } from 'solid-js/store'
import type { ID } from '../../model/types'
import { moveItem, uniqueName } from '../../model/groups'
import { newId } from '../../model/ids'
import type { EditorContext } from './context'

export interface ImageGroupCommands {
  create(name?: string): ID | null
  rename(id: ID, name: string): void
  /** Images of a deleted image group become ungrouped (never deleted). */
  remove(id: ID): void
  move(id: ID, delta: number): void
}

export function createImageGroups(ctx: EditorContext): ImageGroupCommands {
  const { state, setState } = ctx
  return {
    create(name) {
      if (!state.project || ctx.editsFrozen()) return null
      const id = newId()
      const groupName = name?.trim() || uniqueName(state.project.imageGroups.map((g) => g.name), 'New group')
      setState('project', 'imageGroups', [...unwrap(state.project.imageGroups), { id, name: groupName }])
      ctx.touchProject()
      return id
    },
    rename(id, name) {
      const trimmed = name.trim()
      if (!state.project || !trimmed || ctx.editsFrozen()) return
      setState('project', 'imageGroups', unwrap(state.project.imageGroups).map((g) => (g.id === id ? { ...g, name: trimmed } : g)))
      ctx.touchProject()
    },
    remove(id) {
      const project = state.project
      if (!project || ctx.editsFrozen()) return
      batch(() => {
        setState('project', 'images', unwrap(project.images).map((img) => (img.imageGroupId === id ? { ...img, imageGroupId: null } : img)))
        setState('project', 'imageGroups', unwrap(project.imageGroups).filter((g) => g.id !== id))
      })
      ctx.touchProject()
    },
    move(id, delta) {
      const groups = state.project?.imageGroups
      if (!groups || ctx.editsFrozen()) return
      const from = groups.findIndex((g) => g.id === id)
      setState('project', 'imageGroups', moveItem(unwrap(groups), from, from + delta))
      ctx.touchProject()
    },
  }
}
