import { describe, expect, it } from 'vitest'
import type { AnnotationGroup } from '../model/types'
import { editBlock as editBlockReason } from '../model/policy'
import {
  eraseHitRadiusPx,
  resolveHover,
  resolveTap,
  suggestionAt,
  type InteractionScene,
} from './interaction'
import { createPointIndex } from './spatial-index'
import { ann, group } from './test-fixtures'
import type { Annotation } from '../model/types'

function scene(annotations: Annotation[], groups: AnnotationGroup[], activeId: string | null, scale = 1): InteractionScene {
  return {
    view: { scale, offsetX: 0, offsetY: 0 },
    imageWidth: 1000,
    imageHeight: 1000,
    groups,
    activeGroup: groups.find((g) => g.id === activeId),
    index: createPointIndex(annotations),
  }
}

const g1 = group('g1', { size: 6 })
const g2 = group('g2', { size: 6 })

describe('edit blocking', () => {
  it('orders reasons: no group, locked, hidden (model/policy)', () => {
    expect(editBlockReason(undefined)).toBe('no-group')
    expect(editBlockReason(group('x', { hidden: true, locked: true }))).toBe('locked')
    expect(editBlockReason(group('x', { hidden: true }))).toBe('hidden')
    expect(editBlockReason(group('x', { locked: true }))).toBe('locked')
    expect(editBlockReason(g1)).toBeNull()
  })

  it('blocks add and erase on hidden/locked/missing group', () => {
    const hidden = group('g1', { hidden: true })
    const locked = group('g1', { locked: true })
    for (const tool of ['add', 'erase'] as const) {
      expect(resolveTap(scene([], [hidden], 'g1'), tool, 5, 5, 'mouse')).toEqual({ kind: 'blocked', reason: 'hidden' })
      expect(resolveTap(scene([], [locked], 'g1'), tool, 5, 5, 'mouse')).toEqual({ kind: 'blocked', reason: 'locked' })
      expect(resolveTap(scene([], [g1], null), tool, 5, 5, 'mouse')).toEqual({ kind: 'blocked', reason: 'no-group' })
    }
  })

  it('pan tool taps do nothing', () => {
    expect(resolveTap(scene([], [g1], 'g1'), 'pan', 5, 5, 'mouse')).toEqual({ kind: 'none' })
  })

  it('region tool taps never add, erase or refuse (even on a locked group or a marker)', () => {
    const a = ann('a', 5, 5)
    expect(resolveTap(scene([a], [g1], 'g1'), 'region', 5, 5, 'mouse')).toEqual({ kind: 'none' })
    expect(resolveTap(scene([], [group('g1', { locked: true })], 'g1'), 'region', 5, 5, 'touch')).toEqual({ kind: 'none' })
    expect(resolveHover(scene([a], [g1], 'g1'), 'region', 5, 5, 'pen')).toEqual({ kind: 'none' })
  })
})

describe('add', () => {
  it('converts screen to image coordinates', () => {
    const sc = { ...scene([], [g1], 'g1'), view: { scale: 2, offsetX: 100, offsetY: 50 } }
    expect(resolveTap(sc, 'add', 20, 40, 'pen')).toEqual({ kind: 'add', x: 110, y: 70, nearby: null })
  })

  it('ignores taps outside the image', () => {
    expect(resolveTap(scene([], [g1], 'g1'), 'add', -1, 5, 'mouse')).toEqual({ kind: 'none' })
    expect(resolveTap(scene([], [g1], 'g1'), 'add', 5, 1001, 'mouse')).toEqual({ kind: 'none' })
  })

  it('never refuses a near-duplicate, but reports it for the cue (screen-space radius)', () => {
    const a = ann('a', 100, 100)
    const r = resolveTap(scene([a], [g1], 'g1'), 'add', 104, 100, 'mouse')
    expect(r).toMatchObject({ kind: 'add', x: 104, nearby: { id: 'a' } })
    // At scale 0.5 the same 4 image px is 2 screen px: still near; 20 image px = 10 screen px: not near.
    expect(resolveTap(scene([a], [g1], 'g1', 0.5), 'add', 52, 50, 'mouse')).toMatchObject({ nearby: { id: 'a' } })
    expect(resolveTap(scene([a], [g1], 'g1', 0.5), 'add', 60, 50, 'mouse')).toMatchObject({ nearby: null })
  })

  it('near-duplicate cue ignores hidden groups but considers other visible groups', () => {
    const a = ann('a', 100, 100, 'g2')
    expect(resolveTap(scene([a], [g1, g2], 'g1'), 'add', 101, 100, 'mouse')).toMatchObject({ nearby: { id: 'a' } })
    const g2h = group('g2', { hidden: true })
    expect(resolveTap(scene([a], [g1, g2h], 'g1'), 'add', 101, 100, 'mouse')).toMatchObject({ nearby: null })
  })
})

describe('erase', () => {
  it('hit radius is input-aware and never smaller than the marker', () => {
    expect(eraseHitRadiusPx(6, 'mouse')).toBe(12)
    expect(eraseHitRadiusPx(6, 'touch')).toBe(22)
    expect(eraseHitRadiusPx(6, 'pen')).toBe(22)
    expect(eraseHitRadiusPx(30, 'mouse')).toBe(30)
  })

  it('erases the nearest marker of the active group only', () => {
    const pts = [ann('a', 100, 100, 'g2'), ann('b', 108, 100, 'g1'), ann('c', 115, 100, 'g1')]
    expect(resolveTap(scene(pts, [g1, g2], 'g1'), 'erase', 100, 100, 'mouse')).toMatchObject({ kind: 'erase', id: 'b' })
  })

  it('radius is zoom-aware (screen space)', () => {
    const pts = [ann('a', 100, 100)]
    // 15 screen px away: mouse (12) misses, pen (22) hits.
    expect(resolveTap(scene(pts, [g1], 'g1', 1), 'erase', 115, 100, 'mouse')).toEqual({
      kind: 'blocked',
      reason: 'nothing-to-erase',
    })
    expect(resolveTap(scene(pts, [g1], 'g1', 1), 'erase', 115, 100, 'pen')).toMatchObject({ kind: 'erase', id: 'a' })
    // At scale 4 the marker is 60 screen px away from screen (460, 400): miss even for pen.
    expect(resolveTap(scene(pts, [g1], 'g1', 4), 'erase', 460, 400, 'pen')).toMatchObject({ kind: 'blocked' })
  })

  it('reports nothing-to-erase', () => {
    expect(resolveTap(scene([], [g1], 'g1'), 'erase', 1, 1, 'mouse')).toEqual({ kind: 'blocked', reason: 'nothing-to-erase' })
  })
})

describe('hover preview', () => {
  it('add shows the group ring at the pointer', () => {
    expect(resolveHover(scene([], [g1], 'g1'), 'add', 5, 6, 'mouse')).toEqual({ kind: 'add', x: 5, y: 6, r: 6, color: g1.color })
  })
  it('erase highlights the target marker, or shows the hit area', () => {
    const sc = scene([ann('a', 100, 100)], [g1], 'g1', 2)
    expect(resolveHover(sc, 'erase', 205, 200, 'mouse')).toEqual({ kind: 'erase-hit', x: 200, y: 200, r: 10 })
    expect(resolveHover(sc, 'erase', 300, 300, 'pen')).toEqual({ kind: 'erase-miss', x: 300, y: 300, r: 22 })
  })
  it('nothing on pan or blocked group', () => {
    expect(resolveHover(scene([], [g1], 'g1'), 'pan', 5, 6, 'mouse')).toEqual({ kind: 'none' })
    expect(resolveHover(scene([], [group('g1', { locked: true })], 'g1'), 'add', 5, 6, 'mouse')).toEqual({ kind: 'none' })
  })
})

describe('suggestion hit testing', () => {
  const pts = [
    { x: 100, y: 100, r: 20, index: 0 },
    { x: 150, y: 100, r: 20, index: 1 },
    { x: 500, y: 500, r: 2, index: 2 },
  ]
  const idx = createPointIndex(pts)
  const view = (scale: number) => ({ scale, offsetX: 0, offsetY: 0 })

  it('hits the nearest suggestion whose ring contains the point', () => {
    expect(suggestionAt(idx, 20, view(1), 110, 100, 'mouse')?.index).toBe(0)
    expect(suggestionAt(idx, 20, view(1), 140, 100, 'mouse')?.index).toBe(1)
    expect(suggestionAt(idx, 20, view(1), 100, 140, 'mouse')).toBeNull()
  })

  it('gives tiny rings a minimum, input-aware hit radius on screen', () => {
    expect(suggestionAt(idx, 20, view(1), 506, 500, 'mouse')?.index).toBe(2)
    expect(suggestionAt(idx, 20, view(1), 512, 500, 'mouse')).toBeNull()
    expect(suggestionAt(idx, 20, view(1), 512, 500, 'touch')?.index).toBe(2)
  })
})
