/** Pure toolbar layout rules (unit-tested). */

/**
 * Layout density, chosen from the available width so the toolbar never wraps:
 * full = labelled tools; compact = icons; minimal = style/undo/redo in "More";
 * tiny = tools also collapse into a single tool switcher.
 */
export type ToolbarMode = 'full' | 'compact' | 'minimal' | 'tiny'

export function toolbarModeFor(width: number): ToolbarMode {
  // 900: the labelled row with Find similar and Region is ~856 px with touch targets.
  if (width >= 900) return 'full'
  // 670: the compact row with 44 px touch targets plus the trailing Find similar and Region buttons is ~644 px.
  if (width >= 670) return 'compact'
  if (width >= 470) return 'minimal'
  return 'tiny'
}
