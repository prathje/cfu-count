/**
 * Global keyboard shortcuts: ONE binding table (SHORTCUTS) drives both key
 * resolution and the cheat sheet, so the sheet can never drift from behaviour.
 * Pure mapping plus a listener installer.
 */
import { onCleanup } from 'solid-js'
import { TOOL_KEYS, type Tool } from '../model/tool'

export type ShortcutCommand =
  | { type: 'tool'; tool: Tool }
  | { type: 'toggle-visibility' }
  | { type: 'toggle-lock' }
  | { type: 'select-group'; index: number }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'zoom-in' }
  | { type: 'zoom-out' }
  | { type: 'fit' }
  | { type: 'image-adjust' }
  | { type: 'image'; delta: -1 | 1 }
  | { type: 'find-similar' }
  | { type: 'help' }

export type ShortcutSection = 'Tools' | 'Annotation groups' | 'Edit' | 'Assisted counting' | 'View' | 'Images' | 'Help'

/** One row of the shortcut table. */
export interface ShortcutBinding {
  section: ShortcutSection
  label: string
  /**
   * Keys that trigger it (lower-case `KeyboardEvent.key`). Empty for rows that
   * only document behaviour handled elsewhere (Space-to-pan, arrow keys, Escape).
   */
  keys: readonly string[]
  /** Needs the platform modifier (Cmd on Apple, Ctrl elsewhere). */
  mod?: boolean
  /** Needs Shift (only checked for modifier shortcuts; plain keys ignore Shift). */
  shift?: boolean
  /** Key caps shown in the sheet; `mod` is replaced by the platform modifier label. */
  display: readonly string[]
  /** Command for a key; omitted for documentation-only rows. */
  command?: (key: string) => ShortcutCommand
}

const TOOL_LABEL: Record<Tool, string> = { add: 'Add colonies', erase: 'Erase colonies', pan: 'Pan' }
/** Hold to show the unadjusted image (KeyboardEvent.key). */
export const COMPARE_KEY = '\\'
/** Opens/closes assisted counting (shown in the toolbar tooltip too). */
export const FIND_SIMILAR_KEY = 'f'
const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9']

export const SHORTCUTS: readonly ShortcutBinding[] = [
  ...(Object.keys(TOOL_KEYS) as Tool[]).map(
    (tool): ShortcutBinding => ({
      section: 'Tools',
      label: TOOL_LABEL[tool],
      keys: TOOL_KEYS[tool],
      display: [TOOL_KEYS[tool][0].toUpperCase()],
      command: () => ({ type: 'tool', tool }),
    }),
  ),
  { section: 'Tools', label: 'Pan while held', keys: [], display: ['Space'] },
  { section: 'Annotation groups', label: 'Select group 1–9', keys: DIGITS, display: ['1', '…', '9'], command: (k) => ({ type: 'select-group', index: Number(k) - 1 }) },
  { section: 'Annotation groups', label: 'Show / hide selected group', keys: ['v'], display: ['V'], command: () => ({ type: 'toggle-visibility' }) },
  { section: 'Annotation groups', label: 'Lock / unlock selected group', keys: ['l'], display: ['L'], command: () => ({ type: 'toggle-lock' }) },
  { section: 'Edit', label: 'Undo', keys: ['z'], mod: true, display: ['mod', 'Z'], command: () => ({ type: 'undo' }) },
  { section: 'Edit', label: 'Redo', keys: ['z'], mod: true, shift: true, display: ['mod', '⇧', 'Z'], command: () => ({ type: 'redo' }) },
  { section: 'Edit', label: 'Redo', keys: ['y'], mod: true, display: [], command: () => ({ type: 'redo' }) },
  { section: 'Assisted counting', label: 'Find similar colonies (beta): open / close', keys: [FIND_SIMILAR_KEY], display: [FIND_SIMILAR_KEY.toUpperCase()], command: () => ({ type: 'find-similar' }) },
  { section: 'View', label: 'Zoom in', keys: ['+', '='], display: ['+'], command: () => ({ type: 'zoom-in' }) },
  { section: 'View', label: 'Zoom out', keys: ['-', '_'], display: ['−'], command: () => ({ type: 'zoom-out' }) },
  { section: 'View', label: 'Fit image', keys: ['0'], display: ['0'], command: () => ({ type: 'fit' }) },
  { section: 'View', label: 'Pan (image focused)', keys: [], display: ['←', '↑', '→', '↓'] },
  { section: 'View', label: 'Image adjustments (display only)', keys: ['i'], display: ['I'], command: () => ({ type: 'image-adjust' }) },
  // Hold-to-compare is handled by the workspace (needs key up as well as key down).
  { section: 'View', label: 'Show original image while held', keys: [], display: [COMPARE_KEY] },
  { section: 'Images', label: 'Previous image', keys: ['['], display: ['['], command: () => ({ type: 'image', delta: -1 }) },
  { section: 'Images', label: 'Next image', keys: [']'], display: [']'], command: () => ({ type: 'image', delta: 1 }) },
  { section: 'Help', label: 'Keyboard shortcuts', keys: ['?'], display: ['?'], command: () => ({ type: 'help' }) },
  { section: 'Help', label: 'Close menu or dialog', keys: [], display: ['Esc'] },
]

/** Minimal keyboard event shape (keeps the mapping unit-testable). */
export interface KeyLike {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
}

export function resolveShortcut(e: KeyLike, apple: boolean): ShortcutCommand | null {
  const mod = apple ? e.metaKey : e.ctrlKey
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
  if (e.altKey) return null
  if (mod) {
    const b = SHORTCUTS.find((s) => s.mod && !!s.shift === e.shiftKey && s.keys.includes(key))
    return b?.command?.(key) ?? null
  }
  if (e.metaKey || e.ctrlKey) return null // the other platform's modifier: leave browser shortcuts alone
  const b = SHORTCUTS.find((s) => !s.mod && s.keys.includes(key))
  return b?.command?.(key) ?? null
}

/** A cheat-sheet row: label plus key caps (platform modifier already substituted). */
export interface ShortcutRow {
  label: string
  keys: string[]
}

/** The cheat sheet, grouped by section in table order (documentation-only rows included). */
export function shortcutSheet(modLabel: string): { section: ShortcutSection; rows: ShortcutRow[] }[] {
  const out: { section: ShortcutSection; rows: ShortcutRow[] }[] = []
  const mod = modLabel.replace(/\+$/, '')
  for (const s of SHORTCUTS) {
    if (s.display.length === 0) continue // alias with no row of its own
    let sec = out.find((x) => x.section === s.section)
    if (!sec) out.push((sec = { section: s.section, rows: [] }))
    sec.rows.push({ label: s.label, keys: s.display.map((k) => (k === 'mod' ? mod : k)) })
  }
  return out
}

/** True when the event comes from somewhere the user is typing. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  if (target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return true
  if (target.tagName === 'INPUT') {
    const type = (target as HTMLInputElement).type
    return !['button', 'checkbox', 'radio', 'range', 'color', 'submit', 'reset', 'file'].includes(type)
  }
  return false
}

/** Install the global shortcut listener for the lifetime of the calling owner. */
export function useShortcuts(apple: boolean, run: (cmd: ShortcutCommand) => void, enabled: () => boolean) {
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || !enabled() || isTypingTarget(e.target)) return
    if (document.querySelector('dialog[open]')) return
    const cmd = resolveShortcut(e, apple)
    if (!cmd) return
    // Holding a zoom/pan/image key may repeat; toggles and history must not.
    if (e.repeat && !['zoom-in', 'zoom-out', 'image'].includes(cmd.type)) return
    e.preventDefault()
    run(cmd)
  }
  window.addEventListener('keydown', onKey)
  onCleanup(() => window.removeEventListener('keydown', onKey))
}
