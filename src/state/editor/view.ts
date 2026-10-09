/** View preferences of the editor: tool, active group, touch policy. Never dirty the project. */
import type { ID } from '../../model/types'
import type { Tool } from '../../model/tool'
import { prefs } from '../prefs'
import type { EditorContext } from './context'

export interface ViewCommands {
  setTool(tool: Tool): void
  setActiveGroup(id: ID): void
  /** Select the n-th group (0-based) in display order, e.g. from the 1–9 shortcuts. */
  selectGroupByIndex(index: number): void
  /** Allow single-finger touch to annotate (remembered per browser). */
  setTouchAnnotates(on: boolean): void
}

export function createView(ctx: EditorContext): ViewCommands {
  const { state, setState } = ctx
  return {
    setTool: (tool) => setState('tool', tool),
    setActiveGroup(id) {
      if (ctx.groupById(id)) setState('activeGroupId', id)
    },
    selectGroupByIndex(index) {
      const g = state.project?.annotationGroups[index]
      if (g) setState('activeGroupId', g.id)
    },
    setTouchAnnotates(on) {
      setState('touchAnnotates', on)
      prefs.set('touchAnnotates', on)
    },
  }
}
