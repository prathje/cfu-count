import { describe, expect, it } from 'vitest'
import { resolveShortcut, shortcutSheet, SHORTCUTS, type KeyLike } from './shortcuts'

const k = (key: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
})

describe('resolveShortcut', () => {
  it('maps tools and group toggles', () => {
    expect(resolveShortcut(k('a'), true)).toEqual({ type: 'tool', tool: 'add' })
    expect(resolveShortcut(k('E'), true)).toEqual({ type: 'tool', tool: 'erase' })
    expect(resolveShortcut(k('h'), true)).toEqual({ type: 'tool', tool: 'pan' })
    expect(resolveShortcut(k('p'), true)).toEqual({ type: 'tool', tool: 'pan' })
    expect(resolveShortcut(k('v'), true)).toEqual({ type: 'toggle-visibility' })
    expect(resolveShortcut(k('l'), true)).toEqual({ type: 'toggle-lock' })
    expect(resolveShortcut(k('3'), true)).toEqual({ type: 'select-group', index: 2 })
  })
  it('maps F to assisted counting and lists it in the sheet', () => {
    expect(resolveShortcut(k('f'), true)).toEqual({ type: 'find-similar' })
    expect(resolveShortcut(k('f', { metaKey: true }), true)).toBeNull() // Cmd+F stays the browser's find
    const row = shortcutSheet('⌘').find((s) => s.section === 'Assisted counting')!.rows[0]
    expect(row.keys).toEqual(['F'])
  })
  it('uses Cmd on Apple and Ctrl elsewhere for undo/redo', () => {
    expect(resolveShortcut(k('z', { metaKey: true }), true)).toEqual({ type: 'undo' })
    expect(resolveShortcut(k('Z', { metaKey: true, shiftKey: true }), true)).toEqual({ type: 'redo' })
    expect(resolveShortcut(k('z', { ctrlKey: true }), true)).toBeNull()
    expect(resolveShortcut(k('z', { ctrlKey: true }), false)).toEqual({ type: 'undo' })
    expect(resolveShortcut(k('y', { ctrlKey: true }), false)).toEqual({ type: 'redo' })
  })
  it('ignores tool keys with modifiers (browser shortcuts stay intact)', () => {
    expect(resolveShortcut(k('a', { metaKey: true }), true)).toBeNull()
    expect(resolveShortcut(k('l', { ctrlKey: true }), false)).toBeNull()
  })
  it('maps zoom, fit, image navigation and help', () => {
    expect(resolveShortcut(k('+', { shiftKey: true }), true)).toEqual({ type: 'zoom-in' })
    expect(resolveShortcut(k('='), true)).toEqual({ type: 'zoom-in' })
    expect(resolveShortcut(k('-'), true)).toEqual({ type: 'zoom-out' })
    expect(resolveShortcut(k('0'), true)).toEqual({ type: 'fit' })
    expect(resolveShortcut(k('['), true)).toEqual({ type: 'image', delta: -1 })
    expect(resolveShortcut(k(']'), true)).toEqual({ type: 'image', delta: 1 })
    expect(resolveShortcut(k('?', { shiftKey: true }), true)).toEqual({ type: 'help' })
    expect(resolveShortcut(k('0', { metaKey: true }), true)).toBeNull() // browser zoom reset stays intact
    expect(resolveShortcut(k('i'), true)).toEqual({ type: 'image-adjust' })
    expect(resolveShortcut(k('\\'), true)).toBeNull() // hold-to-compare is handled by the workspace
  })
})

describe('shortcutSheet', () => {
  it('is generated from the binding table, with the platform modifier', () => {
    const sheet = shortcutSheet('⌘')
    const rows = sheet.flatMap((s) => s.rows)
    expect(rows.find((r) => r.label === 'Undo')?.keys).toEqual(['⌘', 'Z'])
    expect(shortcutSheet('Ctrl+').flatMap((s) => s.rows).find((r) => r.label === 'Undo')?.keys).toEqual(['Ctrl', 'Z'])
    // Every executable binding with a display row appears exactly once in the sheet.
    const documented = SHORTCUTS.filter((s) => s.display.length > 0).length
    expect(rows.length).toBe(documented)
    expect(sheet.map((s) => s.section)).toEqual(['Tools', 'Annotation groups', 'Edit', 'Assisted counting', 'View', 'Images', 'Help'])
  })
})
