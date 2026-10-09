import { describe, expect, it } from 'vitest'
import type { Annotation, AnnotationGroup, Project } from '../model/types'
import {
  applyOps,
  checkOps,
  clampStyle,
  confirmedCount,
  confirmedCountsByGroup,
  displayOrder,
  groupEditBlock,
  invertOps,
  makeGroup,
  makeManualAnnotation,
  moveItem,
  uniqueName,
  visibilitySplit,
  type AnnotationOp,
} from './core'
import { GROUP_PALETTE, nextGroupColor } from './palette'

const at = '2026-01-01T00:00:00.000Z'
const group = (id: string, extra: Partial<AnnotationGroup> = {}): AnnotationGroup => ({
  ...makeGroup([], id, id),
  ...extra,
})
const ann = (id: string, groupId = 'g1', extra: Partial<Annotation> = {}): Annotation => ({
  ...makeManualAnnotation(1, 2, groupId, id, at),
  ...extra,
})

describe('makeManualAnnotation', () => {
  it('creates accepted, manual-origin records', () => {
    const a = makeManualAnnotation(10.5, 20.25, 'g', 'id', at)
    expect(a).toMatchObject({
      x: 10.5,
      y: 20.25,
      origin: 'manual',
      reviewStatus: 'accepted',
      lastEditSource: 'manual',
      manuallyAdjusted: false,
    })
  })
})

describe('applyOps / invertOps', () => {
  it('adds, removes and updates without mutating input', () => {
    const base = [ann('a'), ann('b')]
    const moved = { ...base[1], x: 99 }
    const ops: AnnotationOp[] = [
      { kind: 'add', annotation: ann('c') },
      { kind: 'remove', annotation: base[0] },
      { kind: 'update', before: base[1], after: moved },
    ]
    const out = applyOps(base, ops)
    expect(out.map((a) => a.id)).toEqual(['b', 'c'])
    expect(out[0].x).toBe(99)
    expect(base.map((a) => a.id)).toEqual(['a', 'b'])
  })

  it('inverse restores the original set exactly (origin preserved)', () => {
    const auto = ann('auto', 'g1', { origin: 'automated', reviewStatus: 'unreviewed' })
    const base = [ann('a'), auto]
    const ops: AnnotationOp[] = [
      { kind: 'remove', annotation: auto },
      { kind: 'add', annotation: ann('n') },
    ]
    const restored = applyOps(applyOps(base, ops), invertOps(ops))
    expect(restored.map((a) => a.id).sort()).toEqual(['a', 'auto'])
    expect(restored.find((a) => a.id === 'auto')?.origin).toBe('automated')
  })

  it('does not duplicate an annotation added twice', () => {
    const a = ann('a')
    expect(applyOps([a], [{ kind: 'add', annotation: a }])).toHaveLength(1)
  })
})

describe('checkOps', () => {
  const groups = [group('g1'), group('g2', { locked: true }), group('g3', { hidden: true })]
  it('allows edits to visible unlocked groups', () => {
    expect(checkOps([{ kind: 'add', annotation: ann('a', 'g1') }], groups)).toBeNull()
  })
  it('refuses locked, hidden and missing groups (locked wins)', () => {
    expect(checkOps([{ kind: 'add', annotation: ann('a', 'g2') }], groups)).toMatchObject({ reason: 'locked' })
    expect(checkOps([{ kind: 'add', annotation: ann('a', 'g3') }], groups)).toMatchObject({ reason: 'hidden' })
    expect(checkOps([{ kind: 'add', annotation: ann('a', 'zz') }], groups)).toMatchObject({ reason: 'missing' })
    expect(
      checkOps(
        [
          { kind: 'add', annotation: ann('a', 'g3') },
          { kind: 'add', annotation: ann('b', 'g2') },
        ],
        groups,
      ),
    ).toMatchObject({ reason: 'locked' })
  })
  it('checks both groups of a regrouping update', () => {
    const before = ann('a', 'g1')
    expect(checkOps([{ kind: 'update', before, after: { ...before, groupId: 'g2' } }], groups)).toMatchObject({
      reason: 'locked',
    })
  })
  it('groupEditBlock', () => {
    expect(groupEditBlock(undefined)).toBe('no-group')
    expect(groupEditBlock(groups[1])).toBe('locked')
    expect(groupEditBlock(groups[2])).toBe('hidden')
    expect(groupEditBlock(groups[0])).toBeNull()
  })
})

describe('counts', () => {
  const list = [
    ann('a', 'g1'),
    ann('b', 'g1'),
    ann('c', 'g2'),
    ann('s', 'g1', { origin: 'automated', reviewStatus: 'unreviewed' }),
    ann('r', 'g2', { origin: 'automated', reviewStatus: 'rejected' }),
  ]
  it('counts only confirmed annotations', () => {
    expect(confirmedCount(list)).toBe(3)
    expect(confirmedCount(undefined)).toBe(0)
    expect(Object.fromEntries(confirmedCountsByGroup(list))).toEqual({ g1: 2, g2: 1 })
  })
  it('hidden groups stay in totals but are reported as hidden', () => {
    const groups = [group('g1'), group('g2', { hidden: true })]
    expect(visibilitySplit(list, groups)).toEqual({ visible: 2, hidden: 1 })
    expect(confirmedCount(list)).toBe(3)
  })
})

describe('groups', () => {
  it('first group is "Colonies"; later ones get unique names and new colours', () => {
    const first = makeGroup([], 'a')
    expect(first.name).toBe('Colonies')
    const second = makeGroup([first], 'b')
    expect(second.name).toBe('Group')
    expect(second.color).not.toBe(first.color)
    expect(makeGroup([first, second], 'c').name).toBe('Group 2')
  })
  it('uniqueName is case-insensitive', () => {
    expect(uniqueName(['group', 'Group 2'], 'Group')).toBe('Group 3')
  })
  it('palette cycles after all colours are used', () => {
    expect(nextGroupColor([])).toBe(GROUP_PALETTE[0].value)
    expect(nextGroupColor(GROUP_PALETTE.map((c) => c.value.toUpperCase()))).toBe(GROUP_PALETTE[0].value)
  })
  it('moveItem clamps', () => {
    expect(moveItem([1, 2, 3], 0, 5)).toEqual([2, 3, 1])
    expect(moveItem([1, 2, 3], 2, -3)).toEqual([3, 1, 2])
  })
  it('clampStyle keeps values in range', () => {
    expect(clampStyle({ opacity: 3, size: 0.4 })).toEqual({ opacity: 1, size: 2 })
    expect(clampStyle({ labelSize: 100 })).toEqual({ labelSize: 32 })
    expect(makeGroup([], 'x').labelSize).toBe(12)
  })
})

describe('displayOrder', () => {
  it('orders by image group then ungrouped (including dangling group ids)', () => {
    const img = (id: string, imageGroupId: string | null) =>
      ({ id, imageGroupId }) as unknown as Project['images'][number]
    const project = {
      imageGroups: [
        { id: 'B', name: 'B' },
        { id: 'A', name: 'A' },
      ],
      images: [img('1', 'A'), img('2', null), img('3', 'B'), img('4', 'gone')],
    } as unknown as Project
    expect(displayOrder(project).map((i) => i.id)).toEqual(['3', '1', '2', '4'])
  })
})
