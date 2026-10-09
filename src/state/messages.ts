/** User-facing wording for blocked edits, shared by editor commands and the UI. */
import type { AnnotationGroup } from '../model/types'
import type { EditBlock } from './core'

export interface NoticeAction {
  label: string
  run(): void
}

export interface Notice {
  tone: 'info' | 'success' | 'warning' | 'error'
  message: string
  /** Optional secondary line. */
  detail?: string
  action?: NoticeAction
  /** Notices with the same key replace each other instead of stacking. */
  key?: string
}

export type Notify = (notice: Notice) => void

export function hiddenMessage(group: AnnotationGroup): string {
  return `“${group.name}” is hidden — show it to edit`
}

export function lockedMessage(group: AnnotationGroup): string {
  return `“${group.name}” is locked — unlock to edit`
}

export function historyBlockMessage(block: EditBlock, direction: 'undo' | 'redo', label: string): { message: string; detail: string } {
  const verb = direction === 'undo' ? 'Undo' : 'Redo'
  switch (block.reason) {
    case 'locked':
      return {
        message: `Can’t ${direction} “${label}”`,
        detail: `It changes “${block.group.name}”, which is locked. Unlock the group to ${direction}.`,
      }
    case 'hidden':
      return {
        message: `Can’t ${direction} “${label}”`,
        detail: `It changes “${block.group.name}”, which is hidden. Show the group first so the change is visible.`,
      }
    case 'missing':
      return {
        message: `${verb} unavailable`,
        detail: 'The annotation group this change belongs to no longer exists.',
      }
  }
}
