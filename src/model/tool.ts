/**
 * Tools offered by the toolbar, the shortcuts and the viewport. `region` selects
 * an area of the image (lasso or rectangle); it never creates or changes
 * annotations itself (see model/region.ts).
 */
export type Tool = 'add' | 'erase' | 'pan' | 'region'

/**
 * Keyboard keys selecting each tool (lower-case `KeyboardEvent.key`). The first
 * key is the one shown in hints; the rest are aliases.
 */
export const TOOL_KEYS: Readonly<Record<Tool, readonly string[]>> = {
  add: ['a'],
  erase: ['e'],
  pan: ['h', 'p'],
  region: ['r'],
}

/** Key shown in tooltips / hints for a tool, e.g. "A". */
export const toolHintKey = (tool: Tool): string => TOOL_KEYS[tool][0].toUpperCase()
