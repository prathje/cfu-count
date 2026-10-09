/** Global keyboard shortcuts: a pure key → command map plus a listener installer. */
import { onCleanup } from 'solid-js'
import { TOOL_KEYS, type Tool } from '../model/tool'

export type ShortcutCommand =
  | { type: 'tool'; tool: Tool }
  | { type: 'toggle-visibility' }
  | { type: 'toggle-lock' }
  | { type: 'select-group'; index: number }
  | { type: 'undo' }
  | { type: 'redo' }

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
  if (mod && !e.altKey) {
    if (key === 'z') return e.shiftKey ? { type: 'redo' } : { type: 'undo' }
    if (key === 'y' && !e.shiftKey) return { type: 'redo' }
    return null
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return null
  for (const tool of Object.keys(TOOL_KEYS) as Tool[]) {
    if (TOOL_KEYS[tool].includes(key)) return { type: 'tool', tool }
  }
  switch (key) {
    case 'v':
      return { type: 'toggle-visibility' }
    case 'l':
      return { type: 'toggle-lock' }
  }
  if (/^[1-9]$/.test(key) && !e.shiftKey) return { type: 'select-group', index: Number(key) - 1 }
  return null
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
    if (e.defaultPrevented || e.repeat || !enabled() || isTypingTarget(e.target)) return
    if (document.querySelector('dialog[open]')) return
    const cmd = resolveShortcut(e, apple)
    if (!cmd) return
    e.preventDefault()
    run(cmd)
  }
  window.addEventListener('keydown', onKey)
  onCleanup(() => window.removeEventListener('keydown', onKey))
}
