/**
 * Edit policy: the ONE rule deciding whether annotations of a group may be
 * changed right now. Used by editor commands (state), history replay and the
 * viewport's tap/hover resolution, so every layer refuses for the same reason.
 *
 * Precedence: no group > locked > hidden. A group that is both locked and hidden
 * reports `locked` first: showing it would not make it editable, unlocking is the
 * first step the user has to take.
 */
import type { AnnotationGroup } from './types'

export type EditBlockReason = 'no-group' | 'locked' | 'hidden'
/** Reasons that belong to an existing group (and can be fixed by unlocking / showing it). */
export type GroupBlockReason = Exclude<EditBlockReason, 'no-group'>

export function editBlock(group: AnnotationGroup | undefined | null): EditBlockReason | null {
  if (!group) return 'no-group'
  if (group.locked) return 'locked'
  if (group.hidden) return 'hidden'
  return null
}
