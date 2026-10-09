import { describe, expect, it } from 'vitest'
import type { AnnotationGroup } from '../model/types'
import { applyOps, makeManualAnnotation, type AnnotationOp } from '../model/annotations'
import { makeGroup } from '../model/groups'
import { dropEntriesForGroup, emptyHistory, planRedo, planUndo, record, type HistoryEntry } from './history'

const at = '2026-01-01T00:00:00.000Z'
const g = (id: string, extra: Partial<AnnotationGroup> = {}) => ({ ...makeGroup([], id, id), ...extra })
const add = (id: string, groupId = 'g1'): AnnotationOp => ({
  kind: 'add',
  annotation: makeManualAnnotation(1, 1, groupId, id, at),
})
const entry = (label: string, ops: AnnotationOp[]): HistoryEntry => ({ id: label, label, ops, at })

describe('history', () => {
  it('records, undoes and redoes a batch as one step', () => {
    const batch = entry('Accept 3', [add('a'), add('b'), add('c')])
    let h = record(emptyHistory(), batch)
    let annotations = applyOps([], batch.ops)
    const undo = planUndo(h, [g('g1')])
    expect(undo.ok).toBe(true)
    if (!undo.ok) return
    annotations = applyOps(annotations, undo.ops)
    expect(annotations).toHaveLength(0)
    h = undo.next
    expect(h.undo).toHaveLength(0)
    expect(h.redo).toHaveLength(1)
    const redo = planRedo(h, [g('g1')])
    expect(redo.ok).toBe(true)
    if (!redo.ok) return
    expect(applyOps(annotations, redo.ops)).toHaveLength(3)
  })

  it('a new edit clears redo', () => {
    let h = record(emptyHistory(), entry('one', [add('a')]))
    const u = planUndo(h, [g('g1')])
    if (!u.ok) throw new Error()
    h = record(u.next, entry('two', [add('b')]))
    expect(h.redo).toHaveLength(0)
  })

  it('refuses undo/redo touching a locked or hidden group without changing history', () => {
    const h = record(emptyHistory(), entry('Add colony', [add('a')]))
    const locked = planUndo(h, [g('g1', { locked: true })])
    expect(locked).toMatchObject({ ok: false, reason: 'blocked', block: { reason: 'locked' } })
    const hidden = planUndo(h, [g('g1', { hidden: true })])
    expect(hidden).toMatchObject({ ok: false, reason: 'blocked', block: { reason: 'hidden' } })
    expect(h.undo).toHaveLength(1)

    const undone = planUndo(h, [g('g1')])
    if (!undone.ok) throw new Error()
    expect(planRedo(undone.next, [g('g1', { locked: true })])).toMatchObject({ ok: false, reason: 'blocked' })
  })

  it('reports empty stacks', () => {
    expect(planUndo(emptyHistory(), [])).toEqual({ ok: false, reason: 'empty' })
    expect(planRedo(emptyHistory(), [])).toEqual({ ok: false, reason: 'empty' })
  })

  it('trims to the limit', () => {
    let h = emptyHistory()
    for (let i = 0; i < 5; i++) h = record(h, entry(String(i), [add(String(i))]), 3)
    expect(h.undo.map((e) => e.label)).toEqual(['2', '3', '4'])
  })

  it('drops entries that reference a deleted group', () => {
    let h = record(emptyHistory(), entry('a', [add('a', 'g1')]))
    h = record(h, entry('b', [add('b', 'g2')]))
    expect(dropEntriesForGroup(h, 'g2').undo.map((e) => e.label)).toEqual(['a'])
  })
})
