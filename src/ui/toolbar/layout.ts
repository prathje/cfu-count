/** Pure toolbar layout rules (unit-tested). */

/**
 * Layout density, chosen from the available width so the toolbar never wraps:
 * full = labelled tools; compact = icons; minimal = style/undo/redo in "More";
 * tiny = tools also collapse into a single tool switcher.
 */
export type ToolbarMode = 'full' | 'compact' | 'minimal' | 'tiny'

export function toolbarModeFor(width: number): ToolbarMode {
  if (width >= 860) return 'full'
  if (width >= 620) return 'compact'
  if (width >= 470) return 'minimal'
  return 'tiny'
}
