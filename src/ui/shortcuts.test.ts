import { describe, expect, it } from 'vitest'
import { resolveShortcut, type KeyLike } from './shortcuts'

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
    expect(resolveShortcut(k('0'), true)).toBeNull()
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
})
