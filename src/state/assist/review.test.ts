import { describe, expect, it } from 'vitest'
import type { Annotation, DetectionRun } from '../../model/types'
import { makeManualAnnotation } from '../../model/annotations'
import type { ClusterResult, Suggestion } from '../../detection/types'
import {
  carryRejections,
  dropLayer,
  emptyStore,
  makeLayer,
  noteAccepted,
  pendingView,
  planAccept,
  pruneStore,
  putLayer,
  toggleRejected,
  updateLayer,
  DEFAULT_REVIEW_SETTINGS,
  type LayerResult,
  type SuggestionLayer,
} from './review'

const sug = (x: number, y: number, clusterId: string, status: Suggestion['status'] = 'ok', r = 10): Suggestion => ({ x, y, r, score: 1, clusterId, status })

const run = (over: Partial<DetectionRun> = {}): DetectionRun => ({
  runId: 'det-1',
  method: 'colony-fitter',
  version: '1',
  createdAt: '2026-01-01T00:00:00.000Z',
  imageFingerprint: '',
  analysisScale: 0.3,
  targetGroupId: 'g1',
  seeds: [],
  prior: {},
  settings: {},
  ...over,
})

function result(suggestions: Suggestion[], clusters: ClusterResult[] = []): LayerResult {
  return {
    method: 'fitter',
    suggestions,
    clusters,
    calibration: { seeds: [], nTotal: 3, nUsable: 3, prior: null, appearance: {}, polarity: 1, colorAxis: [1, 0, 0], summary: '3 manual examples; 3 usable for size estimation', tentative: false, warnings: [] },
    roi: { source: 'auto', outline: [], shape: 'square', marginPx: 10, area: 1 },
    run: run(),
    timingsMs: {},
  }
}

const cluster = (clusterId: string, status: ClusterResult['status'], over: Partial<ClusterResult> = {}): ClusterResult => ({
  clusterId,
  bbox: [0, 0, 10, 10],
  area: 100,
  fixedIds: [],
  chosenK: 1,
  runnerUpK: null,
  objectiveGap: null,
  status,
  ...over,
})

function layer(suggestions: Suggestion[], clusters: ClusterResult[] = [], over: Partial<SuggestionLayer> = {}): SuggestionLayer {
  return {
    ...makeLayer({ imageId: 'i1', imageFingerprint: 'fp-i1', groupId: 'g1', result: result(suggestions, clusters), settings: DEFAULT_REVIEW_SETTINGS, reference: null, elapsedMs: 0 }),
    ...over,
  }
}

const manual = (x: number, y: number, id = `m${x}-${y}`, groupId = 'g1'): Annotation => makeManualAnnotation(x, y, groupId, id, '2026-01-01T00:00:00.000Z')
let seq = 0
const ctx = (annotations: Annotation[], runId = 'acc-1') => ({ annotations, image: { id: 'i1', fingerprint: 'fp-i1' }, runId, at: '2026-02-02T00:00:00.000Z', newId: () => `a${++seq}` })

describe('suggestion store', () => {
  it('keeps one layer per image and returns new maps on change', () => {
    const s0 = emptyStore()
    const l = layer([sug(10, 10, 'c1')])
    const s1 = putLayer(s0, l)
    expect(s0.size).toBe(0)
    expect(s1.get('i1')).toBe(l)
    const s2 = updateLayer(s1, 'i1', (x) => toggleRejected(x, 0))
    expect(s2).not.toBe(s1)
    expect(s2.get('i1')!.rejected.has(0)).toBe(true)
    expect(s1.get('i1')!.rejected.has(0)).toBe(false)
    expect(updateLayer(s2, 'nope', (x) => x)).toBe(s2)
    expect(dropLayer(s2, 'i1').size).toBe(0)
    expect(dropLayer(s2, 'nope')).toBe(s2)
  })

  it('prunes layers whose image vanished, changed bytes or lost its group', () => {
    const store = putLayer(putLayer(emptyStore(), layer([])), { ...layer([]), imageId: 'i2', imageFingerprint: 'fp-i2' })
    const images = [
      { id: 'i1', fingerprint: 'fp-i1' },
      { id: 'i2', fingerprint: 'fp-i2' },
    ]
    expect(pruneStore(store, images, ['g1'])).toBe(store)
    expect([...pruneStore(store, [images[0]], ['g1']).keys()]).toEqual(['i1'])
    expect([...pruneStore(store, [images[0], { ...images[1], sourceMismatch: { message: 'x' } }], ['g1']).keys()]).toEqual(['i1'])
    expect([...pruneStore(store, [images[0], { id: 'i2', fingerprint: 'other' }], ['g1']).keys()]).toEqual(['i1'])
    expect(pruneStore(store, images, ['g2']).size).toBe(0)
  })

  it('toggles rejection and ignores out-of-range indices', () => {
    const l = layer([sug(10, 10, 'c1')])
    expect(toggleRejected(toggleRejected(l, 0), 0).rejected.size).toBe(0)
    expect(toggleRejected(l, 5)).toBe(l)
  })

  it('carries rejections to a re-run by position', () => {
    const prev = toggleRejected(layer([sug(100, 100, 'c1'), sug(300, 300, 'c2')]), 0)
    const next = [sug(500, 500, 'x'), sug(103, 98, 'y'), sug(300, 300, 'z')]
    expect([...carryRejections(prev, next)]).toEqual([1])
    expect(carryRejections(undefined, next).size).toBe(0)
  })
})

describe('pending view', () => {
  it('separates OK suggestions, review clusters and rejections; counts never include rejected', () => {
    const l = toggleRejected(
      layer(
        [sug(10, 10, 'c1'), sug(50, 10, 'c2'), sug(100, 100, 'c3', 'review'), sug(120, 100, 'c3', 'review'), sug(300, 300, 'c4')],
        [cluster('c1', 'ok'), cluster('c2', 'ok'), cluster('c3', 'review', { bbox: [90, 90, 40, 20], chosenK: 2, runnerUpK: 3, alternative: { k: 3, colonies: [{ x: 95, y: 100, r: 8 }, { x: 110, y: 100, r: 8 }, { x: 125, y: 100, r: 8 }] } }), cluster('c4', 'ok')],
      ),
      1,
    )
    const v = pendingView(l, [])
    expect(v.okIndices).toEqual([0, 4])
    expect(v.reviewClusters).toHaveLength(1)
    expect(v.reviewClusters[0]).toMatchObject({ clusterId: 'c3', primary: [2, 3], question: '2 or 3?' })
    expect(v.suggested).toBe(4)
    expect(v.needReview).toBe(2)
    expect(v.rejected).toBe(1)
    expect(v.marks.map((m) => m.state)).toEqual(['ok', 'rejected', 'review', 'review', 'ok'])
  })

  it('treats a cluster holding a review-flagged suggestion as a review cluster', () => {
    const v = pendingView(layer([sug(10, 10, 'c1', 'ok'), sug(30, 10, 'c1', 'review')], [cluster('c1', 'ok')]), [])
    expect(v.okIndices).toEqual([])
    expect(v.reviewClusters[0].primary).toEqual([0, 1])
  })

  it('hides suggestions covered by a current annotation of any group', () => {
    const l = layer([sug(10, 10, 'c1'), sug(100, 100, 'c2')])
    const v = pendingView(l, [manual(14, 12, 'm', 'other-group')])
    expect(v.marks.map((m) => m.index)).toEqual([1])
    expect(v.suggested).toBe(1)
  })

  it('reports too-large regions separately', () => {
    const v = pendingView(layer([], [cluster('big', 'too-large')]), [])
    expect(v.tooLarge.map((c) => c.clusterId)).toEqual(['big'])
    expect(v.suggested).toBe(0)
  })
})

describe('accept', () => {
  const base = () =>
    layer(
      [sug(10, 10, 'c1'), sug(60, 10, 'c2'), sug(200, 200, 'c3', 'review'), sug(230, 200, 'c3', 'review')],
      [cluster('c1', 'ok'), cluster('c2', 'ok'), cluster('c3', 'review', { chosenK: 2, runnerUpK: 1, alternative: { k: 1, colonies: [{ x: 215, y: 200, r: 18 }] } })],
    )

  it('"Accept all OK" builds automated, accepted annotations with fitted geometry and provenance, excluding review clusters', () => {
    const l = toggleRejected(base(), 1)
    const v = pendingView(l, [])
    const plan = planAccept(l, v, { kind: 'ok' }, ctx([]))!
    expect(plan.annotations).toHaveLength(1)
    const a = plan.annotations[0]
    expect(a).toMatchObject({
      x: 10,
      y: 10,
      groupId: 'g1',
      origin: 'automated',
      reviewStatus: 'accepted',
      lastEditSource: 'automated',
      geometry: { kind: 'circle', r: 10, source: 'fit' },
      detector: { runId: 'acc-1', confidence: null, name: 'colony-fitter' },
    })
    expect(plan.ops).toEqual([{ kind: 'add', annotation: a }])
    expect(plan.run).toMatchObject({ runId: 'acc-1', imageFingerprint: 'fp-i1', targetGroupId: 'g1', negatives: [{ x: 60, y: 10 }] })
    expect(plan.run.diagnostics).toMatchObject({ detectRunId: 'det-1', accepted: 1, acceptScope: 'ok' })
    expect(plan.run.seedImageFingerprints).toBeUndefined()
  })

  it('records the reference plate fingerprint for cross-plate examples', () => {
    const l = { ...base(), reference: { imageId: 'ref', fingerprint: 'fp-ref' } }
    const plan = planAccept(l, pendingView(l, []), { kind: 'ok' }, ctx([]))!
    expect(plan.run.seedImageFingerprints).toEqual({ ref: 'fp-ref' })
  })

  it('never duplicates an existing marker (checked against current annotations at accept time)', () => {
    const l = base()
    const v = pendingView(l, [])
    const plan = planAccept(l, v, { kind: 'ok' }, ctx([manual(12, 11)]))!
    expect(plan.annotations.map((a) => a.x)).toEqual([60])
    expect(plan.duplicates).toBe(1)
    expect(planAccept(l, v, { kind: 'ok' }, ctx([manual(10, 10), manual(60, 10)]))).toBeNull()
  })

  it('resolves a review cluster with the primary set or the alternative count', () => {
    const l = base()
    const v = pendingView(l, [])
    const primary = planAccept(l, v, { kind: 'cluster', clusterId: 'c3', choice: 'primary' }, ctx([]))!
    expect(primary.annotations.map((a) => [a.x, a.y])).toEqual([
      [200, 200],
      [230, 200],
    ])
    const alt = planAccept(l, v, { kind: 'cluster', clusterId: 'c3', choice: 'alternative' }, ctx([]))!
    expect(alt.annotations.map((a) => [a.x, a.geometry?.r])).toEqual([[215, 18]])
    expect(alt.run.negatives).toHaveLength(2)
    expect(alt.run.diagnostics).toMatchObject({ acceptScope: 'cluster:alternative' })
    expect(planAccept(l, v, { kind: 'cluster', clusterId: 'nope', choice: 'primary' }, ctx([]))).toBeNull()
  })

  it('an applied accept resolves its clusters; removing its annotations (undo) brings them back', () => {
    const l = base()
    const plan = planAccept(l, pendingView(l, []), { kind: 'cluster', clusterId: 'c3', choice: 'alternative' }, ctx([], 'acc-7'))!
    const after = noteAccepted(l, 'acc-7')
    const applied = pendingView(after, plan.annotations)
    expect(applied.reviewClusters).toHaveLength(0)
    expect(applied.marks.map((m) => m.index)).toEqual([0, 1])
    const undone = pendingView(after, [])
    expect(undone.reviewClusters.map((c) => c.clusterId)).toEqual(['c3'])
  })
})
