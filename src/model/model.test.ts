import { describe, expect, it } from 'vitest'
import type { Annotation, AnnotationGroup, Project } from '../model/types'
import {
  applyOps,
  checkOps,
  checkRunImage,
  clearGroupOps,
  confirmedCount,
  confirmedCountsByGroup,
  countBreakdownByGroup,
  groupTally,
  invertOps,
  labelNumber,
  makeManualAnnotation,
  normaliseAnnotation,
  visibilitySplit,
  type AnnotationOp,
} from './annotations'
import { clampStyle, makeGroup, moveItem, uniqueName } from './groups'
import { applyStorageOwned, displayOrder, removedImages } from './project'
import { editBlock as groupEditBlock } from './policy'
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

  it('leaves out removed images; removedImages lists them newest first', () => {
    const img = (id: string, deletedAt?: string) => ({ id, imageGroupId: null, ...(deletedAt ? { deletedAt } : {}) }) as unknown as Project['images'][number]
    const project = { imageGroups: [], images: [img('1', '2026-01-01'), img('2'), img('3', '2026-02-01')] } as unknown as Project
    expect(displayOrder(project).map((i) => i.id)).toEqual(['2'])
    expect(removedImages(project).map((i) => i.id)).toEqual(['3', '1'])
  })
})

describe('confirmed definition (shared by UI and summary.csv)', () => {
  it('normalises manual marks to accepted', () => {
    const odd = ann('m', 'g1', { reviewStatus: 'unreviewed' })
    expect(normaliseAnnotation(odd).reviewStatus).toBe('accepted')
    const fine = ann('f')
    expect(normaliseAnnotation(fine)).toBe(fine)
  })
  it('breakdown agrees with confirmedCountsByGroup', () => {
    const list = [
      ann('a'),
      ann('m', 'g1', { reviewStatus: 'unreviewed' }), // manual: always confirmed
      ann('s', 'g1', { origin: 'automated', reviewStatus: 'unreviewed' }),
      ann('t', 'g1', { origin: 'automated', reviewStatus: 'accepted' }),
      ann('r', 'g1', { origin: 'automated', reviewStatus: 'rejected' }),
    ]
    const b = countBreakdownByGroup(list).get('g1')!
    expect(b).toEqual({ confirmed: 3, manual: 2, automatedAccepted: 1, automatedUnreviewed: 1 })
    expect(confirmedCountsByGroup(list.map(normaliseAnnotation)).get('g1')).toBe(b.confirmed)
  })
})

describe('checkOps immutability', () => {
  const groups = [group('g1')]
  it('rejects updates that change origin or id', () => {
    const before = ann('a', 'g1')
    expect(checkOps([{ kind: 'update', before, after: { ...before, origin: 'automated' } }], groups)).toMatchObject({ reason: 'invalid' })
    expect(checkOps([{ kind: 'update', before, after: { ...before, id: 'b' } }], groups)).toMatchObject({ reason: 'invalid' })
    expect(checkOps([{ kind: 'update', before, after: { ...before, x: 5 } }], groups)).toBeNull()
  })
})

describe('applyStorageOwned', () => {
  it('takes storage, revision, exclusions and image sources from storage; keeps editor fields', () => {
    const img = { id: 'i1', name: 'edited', imageGroupId: null, source: { kind: 'local' } } as unknown as Project['images'][number]
    const editor = { name: 'Mine', revision: 1, storage: { kind: 'local' }, images: [img] } as unknown as Project
    const stored = {
      name: 'Old',
      revision: 7,
      storage: { kind: 'drive', folderId: 'F', folderName: 'F' },
      images: [{ ...img, name: 'old', source: { kind: 'drive', fileId: 'd1' }, sourceMismatch: { detectedAt: '', message: 'm' } }],
    } as unknown as Project
    const merged = applyStorageOwned(editor, stored)
    expect(merged).toMatchObject({ name: 'Mine', revision: 7, storage: { kind: 'drive' } })
    expect(merged.images[0]).toMatchObject({ name: 'edited', source: { kind: 'drive', fileId: 'd1' }, sourceMismatch: { message: 'm' } })
  })
})

describe('labelNumber', () => {
  it('numbers markers per group in list order, like the viewport labels', () => {
    const list = [ann('a', 'g1'), ann('b', 'g2'), ann('c', 'g1'), ann('d', 'g2'), ann('e', 'g1')]
    expect(labelNumber(list, 'e')).toBe(3)
    expect(labelNumber(list, 'd')).toBe(2)
    expect(labelNumber(list, 'zzz')).toBeNull()
  })
})

describe('clearing a group', () => {
  it('tallies a group by origin (every review state) and removes exactly its annotations', () => {
    const list = [ann('a'), ann('b', 'g2'), ann('c', 'g1', { origin: 'automated', reviewStatus: 'unreviewed' }), ann('d', 'g1', { origin: 'automated' })]
    expect(groupTally(list, 'g1')).toEqual({ total: 3, manual: 1, automated: 2 })
    expect(groupTally(undefined, 'g1')).toEqual({ total: 0, manual: 0, automated: 0 })
    const ops = clearGroupOps(list, 'g1')
    expect(ops.map((o) => o.kind)).toEqual(['remove', 'remove', 'remove'])
    expect(applyOps(list, ops).map((a) => a.id)).toEqual(['b'])
    expect(clearGroupOps(list, 'none')).toEqual([])
  })
})

describe('checkRunImage', () => {
  const run = { runId: 'r', imageFingerprint: 'fp' } as Parameters<typeof checkRunImage>[0]
  it('accepts the analysed bytes only', () => {
    expect(checkRunImage(run, { fingerprint: 'fp' })).toBeNull()
    expect(checkRunImage(run, { fingerprint: 'other' })).toMatch(/fingerprint/)
    expect(checkRunImage(run, { fingerprint: 'fp', sourceMismatch: { detectedAt: '', message: '' } })).toMatch(/changed/)
  })
})

