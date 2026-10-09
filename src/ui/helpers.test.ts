import { describe, expect, it } from 'vitest'
import type { AnnotationGroup } from '../model/types'
import { makeGroup } from '../model/groups'
import { saveStatusLabel } from './format'
import { removeImageBody } from './projectActions'
import { toolbarModeFor } from './toolbar/layout'
import { groupTallies, interactionHint, nearDuplicateMessage, sizeMismatchMessage } from './workspace/hints'
import type { SaveStatus } from '../storage/api'

const group = (id: string, extra: Partial<AnnotationGroup> = {}): AnnotationGroup => ({ ...makeGroup([], id, id), ...extra })

describe('interactionHint', () => {
  const base = { tool: 'add' as const, activeGroup: group('Colonies'), coarse: false, touchAnnotates: false }
  it('explains a blocked active group with the shared wording (locked before hidden)', () => {
    expect(interactionHint({ ...base, activeGroup: group('G', { hidden: true }) })).toBe('“G” is hidden — show it to edit')
    expect(interactionHint({ ...base, activeGroup: group('G', { hidden: true, locked: true }) })).toBe('“G” is locked — unlock to edit')
  })
  it('does not complain about a blocked group while panning', () => {
    expect(interactionHint({ ...base, tool: 'pan', activeGroup: group('G', { locked: true }) })).toBe('Drag to pan · scroll to zoom')
  })
  it('describes mouse and touch interaction per tool', () => {
    expect(interactionHint(base)).toMatch(/^Click to add/)
    expect(interactionHint({ ...base, tool: 'erase' })).toMatch(/^Click a marker to erase/)
    expect(interactionHint({ ...base, coarse: true })).toBe('Pencil taps add · fingers pan & zoom')
    expect(interactionHint({ ...base, coarse: true, touchAnnotates: true })).toBe('Tap to add · two fingers pan & zoom')
    expect(interactionHint({ ...base, coarse: true, tool: 'pan' })).toBe('Drag to pan · pinch to zoom')
  })
})

describe('groupTallies', () => {
  it('lists every group in order with zero counts', () => {
    const tallies = groupTallies([group('a'), group('b', { hidden: true })], new Map([['b', 3]]))
    expect(tallies.map((t) => [t.id, t.count, t.hidden])).toEqual([
      ['a', 0, false],
      ['b', 3, true],
    ])
  })
})

describe('toolbarModeFor', () => {
  it('collapses as width shrinks', () => {
    expect([1000, 860, 700, 620, 500, 470, 300].map(toolbarModeFor)).toEqual(['full', 'full', 'compact', 'compact', 'minimal', 'minimal', 'tiny'])
  })
})

describe('saveStatusLabel', () => {
  it('gives every state a distinct label', () => {
    const states: SaveStatus[] = [
      { state: 'idle' },
      { state: 'saved-local', at: '2026-01-01T10:00:00Z' },
      { state: 'local-error', message: 'full' },
      { state: 'pending' },
      { state: 'saving-drive' },
      { state: 'saved-drive', at: '2026-01-01T10:00:00Z' },
      { state: 'reconnect-required' },
      { state: 'failed', message: 'x' },
      { state: 'conflict', files: ['project.json'] },
    ]
    const labels = states.map((s) => saveStatusLabel(s).label)
    expect(new Set(labels).size).toBe(states.length)
    expect(saveStatusLabel({ state: 'local-error', message: 'full' }).tone).toBe('error')
  })
})

describe('dialog wording', () => {
  it('tells the user a Drive file is kept when removing an image', () => {
    expect(removeImageBody(0, false)).toBe('The image is removed from this project.')
    expect(removeImageBody(2, true)).toMatch(/2 annotations.*stays in Google Drive/)
  })
  it('explains a decode size mismatch', () => {
    expect(sizeMismatchMessage({ width: 100, height: 80 }, { width: 80, height: 100 })).toMatch(/80×100.*100×80/)
    expect(removeImageBody(1, false)).toBe('Its 1 annotation is deleted too. This can’t be undone.')
  })
})

describe('nearDuplicateMessage', () => {
  it('names the marker number, and the group when it differs', () => {
    expect(nearDuplicateMessage({ groupName: 'Colonies', number: 14, sameGroup: true })).toBe('Added close to #14')
    expect(nearDuplicateMessage({ groupName: 'Small', number: 3, sameGroup: false })).toBe('Added close to “Small” #3')
    expect(nearDuplicateMessage({ groupName: 'Small', number: null, sameGroup: true })).toBe('Added close to an existing marker')
  })
})
