/** Pure text/data helpers for the workspace (unit-tested). */
import type { AnnotationGroup, ID } from '../../model/types'
import type { Tool } from '../../model/tool'
import { editBlock } from '../../model/policy'
import { editBlockMessage } from '../../state/messages'
import type { GroupTally } from './ImageHeader'

export interface HintInput {
  tool: Tool
  activeGroup: AnnotationGroup | undefined
  /** Coarse pointer (touch screen). */
  coarse: boolean
  touchAnnotates: boolean
}

/** One-line interaction hint under the viewport; explains a blocked active group first. */
export function interactionHint(h: HintInput): string {
  if (h.tool !== 'pan') {
    const reason = editBlock(h.activeGroup)
    if (reason === 'locked' || reason === 'hidden') return editBlockMessage(reason, h.activeGroup)
  }
  if (h.coarse) {
    if (h.tool === 'pan') return 'Drag to pan · pinch to zoom'
    const verb = h.tool === 'add' ? 'add' : 'erase'
    return h.touchAnnotates
      ? `Tap to ${verb} · two fingers to pan & zoom`
      : `Pencil taps ${verb} · drag to pan · pinch to zoom · turn on touch annotates to use fingers`
  }
  if (h.tool === 'add') return 'Click to add · drag to pan · scroll to zoom'
  if (h.tool === 'erase') return 'Click a marker to erase · drag to pan'
  return 'Drag to pan · scroll to zoom'
}

/** Per-group header breakdown in display order (zero counts included). */
export function groupTallies(groups: readonly AnnotationGroup[], counts: ReadonlyMap<ID, number>): GroupTally[] {
  return groups.map((g) => ({
    id: g.id,
    name: g.name,
    color: g.color,
    render: g.render,
    count: counts.get(g.id) ?? 0,
    hidden: g.hidden,
    locked: g.locked,
  }))
}

/** Warning shown when the decoded picture's size differs from the size the marks were made on. */
export function sizeMismatchMessage(recorded: { width: number; height: number }, decoded: { width: number; height: number }): string {
  return `This browser decodes the image as ${decoded.width}×${decoded.height} px, but it was annotated at ${recorded.width}×${recorded.height} px. Markers may not line up; try another browser or re-import the original file.`
}

/** Toast text after an add that landed on top of an existing marker. */
export function nearDuplicateMessage(near: { groupName: string; number: number | null; sameGroup: boolean }): string {
  const ref = near.number == null ? 'an existing marker' : `#${near.number}`
  return near.sameGroup ? `Added close to ${ref}` : `Added close to “${near.groupName}” ${ref}`
}

/** Toast shown (once per session) when a finger tap only navigated. */
export const TOUCH_NAVIGATES_MESSAGE = 'Fingers pan and zoom'
export const TOUCH_NAVIGATES_DETAIL = 'Turn on Touch annotates to add with a finger. Apple Pencil always works.'
