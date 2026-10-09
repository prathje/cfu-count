/** Annotation tools offered by the toolbar, the shortcuts and the viewport. */
export type Tool = 'add' | 'erase' | 'pan'

/**
 * Keyboard keys selecting each tool (lower-case `KeyboardEvent.key`). The first
 * key is the one shown in hints; the rest are aliases.
 */
export const TOOL_KEYS: Readonly<Record<Tool, readonly string[]>> = {
  add: ['a'],
  erase: ['e'],
  pan: ['h', 'p'],
}

/** Key shown in tooltips / hints for a tool, e.g. "A". */
export const toolHintKey = (tool: Tool): string => TOOL_KEYS[tool][0].toUpperCase()
