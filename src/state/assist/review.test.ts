import { describe, expect, it } from 'vitest'
import type { Annotation, DetectionRun } from '../../model/types'
import { makeManualAnnotation } from '../../model/annotations'
import type { ClusterResult, Suggestion } from '../../detection/types'
import {
  carryRejections,
  diffOptions,
  displayMarks,
  nearDuplicates,
  dropLayer,
  emptyStore,
  makeLayer,
  noteAccepted,
  pendingView,
  planAccept,
  planRejectRun,
  pruneStore,
  rejectAllPending,
  restoreAllRejected,
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
    ...makeLayer({ imageId: 'i1', imageFingerprint: 'fp-i1', groupId: 'g1', result: result(suggestions, clusters), settings: DEFAULT_REVIEW_SETTINGS, reference: null, elapsedMs: 0, rejectRunId: 'rej-1' }),
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

describe('review questions', () => {
  it('asks "One more?" when the detector proposes nothing new but the runner-up adds a colony', () => {
    const l = layer([], [cluster('c1', 'review', { chosenK: 0, runnerUpK: 1, alternative: { k: 1, colonies: [{ x: 5, y: 5, r: 4 }] } })])
    expect(pendingView(l, []).reviewClusters[0]).toMatchObject({ primary: [], question: 'One more?' })
  })
})

describe('negatives', () => {
  it('records rejected suggestions of an accepted review cluster', () => {
    const l = toggleRejected(
      layer([sug(200, 200, 'c3', 'review'), sug(230, 200, 'c3', 'review')], [cluster('c3', 'review', { chosenK: 2, runnerUpK: 1 })]),
      1,
    )
    const plan = planAccept(l, pendingView(l, []), { kind: 'cluster', clusterId: 'c3', choice: 'primary' }, ctx([]))!
    expect(plan.annotations).toHaveLength(1)
    expect(plan.run.negatives).toEqual([{ x: 230, y: 200 }])
  })
})

describe('reject-only run', () => {
  const twoOk = () => layer([sug(10, 10, 'c1'), sug(50, 10, 'c2'), sug(90, 10, 'c3')])

  it('records rejections no stored accept run covers, with zero accepted', () => {
    const l = rejectAllPending(twoOk(), pendingView(twoOk(), []))
    expect(l.rejected.size).toBe(3)
    const r = planRejectRun(l, pendingView(l, []), new Set(), '2026-03-03T00:00:00.000Z')!
    expect(r).toMatchObject({ runId: 'rej-1', imageFingerprint: 'fp-i1', targetGroupId: 'g1', createdAt: '2026-03-03T00:00:00.000Z', diagnostics: { accepted: 0, acceptScope: 'reject', detectRunId: 'det-1' } })
    expect(r.negatives).toEqual([{ x: 10, y: 10 }, { x: 50, y: 10 }, { x: 90, y: 10 }])
    expect(planRejectRun(restoreAllRejected(l), pendingView(restoreAllRejected(l), []), new Set(), '')).toBeNull()
  })

  it('leaves out negatives an accept run records while that run is stored (undo puts them back)', () => {
    let l = toggleRejected(twoOk(), 1)
    const plan = planAccept(l, pendingView(l, []), { kind: 'ok' }, ctx([], 'acc-1'))!
    expect(plan.negativeIndices).toEqual([1])
    l = noteAccepted(l, 'acc-1', plan.negativeIndices)
    const v = pendingView(l, plan.annotations)
    expect(planRejectRun(l, v, new Set(['acc-1']), '')).toBeNull()
    expect(planRejectRun(l, pendingView(l, []), new Set(), '')!.negatives).toEqual([{ x: 50, y: 10 }])
  })
})

describe('near-duplicate suggestions', () => {
  const scored = (x: number, y: number, score: number | null, clusterId = 'c1', r = 10): Suggestion => ({ x, y, r, score, clusterId, status: 'ok' })

  it('keeps the higher-support circle of a pair within 0.5 r', () => {
    expect([...nearDuplicates([scored(100, 100, 0.2), scored(103, 101, 0.9), scored(200, 100, 0.1)])]).toEqual([0])
    expect(nearDuplicates([scored(100, 100, 0.2), scored(106, 100, 0.9)]).size).toBe(0) // touching neighbours are distinct
    expect([...nearDuplicates([scored(0, 0, null), scored(1, 1, 0.1)])]).toEqual([0]) // no score loses
  })

  it('hides duplicates from the pending view and its counts, and never accepts both', () => {
    const l = layer([scored(100, 100, 0.2), scored(102, 100, 0.9), scored(300, 300, 0.5, 'c2')], [cluster('c1', 'ok'), cluster('c2', 'ok')])
    const v = pendingView(l, [])
    expect(v.marks.map((m) => m.index)).toEqual([1, 2])
    expect(v.suggested).toBe(2)
    expect(v.duplicates).toBe(1)
    const plan = planAccept(l, v, { kind: 'ok' }, ctx([]))!
    expect(plan.annotations.map((a) => a.x)).toEqual([102, 300])
  })
})

describe('review options', () => {
  it('matches the two explanations circle by circle', () => {
    const d = diffOptions(
      [
        { index: 4, x: 0, y: 0, r: 10 },
        { index: 5, x: 30, y: 0, r: 10 },
      ],
      [
        { x: 2, y: 1, r: 10 },
        { x: 26, y: 0, r: 8 },
        { x: 38, y: 0, r: 8 },
      ],
    )
    expect(d.shared).toEqual([
      { primary: 4, alternative: 0 },
      { primary: 5, alternative: 1 },
    ])
    expect(d.primaryOnly).toEqual([])
    expect(d.alternativeOnly).toEqual([2])
  })

  it('gives each review region a diff and drops the runner-up\'s own duplicates', () => {
    const l = layer(
      [sug(100, 100, 'c3', 'review'), sug(130, 100, 'c3', 'review')],
      [cluster('c3', 'review', { chosenK: 2, runnerUpK: 3, alternative: { k: 3, colonies: [{ x: 101, y: 100, r: 10 }, { x: 102, y: 101, r: 10 }, { x: 129, y: 100, r: 10 }, { x: 150, y: 100, r: 8 }] } })],
    )
    const rc = pendingView(l, []).reviewClusters[0]
    expect(rc.alternative!.colonies).toHaveLength(3)
    expect(rc.question).toBe('2 or 3?')
    expect(rc.diff).toEqual({ shared: [{ primary: 0, alternative: 0 }, { primary: 1, alternative: 1 }], primaryOnly: [], alternativeOnly: [2] })
  })
})

describe('display marks', () => {
  const l = layer(
    [sug(10, 10, 'c1'), sug(100, 100, 'c3', 'review'), sug(130, 100, 'c3', 'review')],
    [cluster('c1', 'ok'), cluster('c3', 'review', { chosenK: 2, runnerUpK: 3, alternative: { k: 3, colonies: [{ x: 101, y: 100, r: 10 }, { x: 129, y: 101, r: 10 }, { x: 150, y: 100, r: 8 }] } })],
  )
  const v = pendingView(l, [])

  it('draws one ring per colony: the detector choice outside the selected region', () => {
    expect(displayMarks(v, null).map((m) => [m.index, m.state])).toEqual([
      [0, 'ok'],
      [1, 'review'],
      [2, 'review'],
    ])
  })

  it('shows only the selected option in the region and marks what it changes', () => {
    const primary = displayMarks(v, { clusterId: 'c3', choice: 'primary' })
    expect(primary).toHaveLength(3)
    expect(primary.filter((m) => m.state === 'changed')).toEqual([])
    const alt = displayMarks(v, { clusterId: 'c3', choice: 'alternative' })
    expect(alt.map((m) => [m.x, m.state, m.tappable])).toEqual([
      [10, 'ok', true],
      [101, 'review', false],
      [129, 'review', false],
      [150, 'changed', false],
    ])
  })

  it('marks the circles only the detector choice has when it is the larger option', () => {
    const l2 = layer([sug(100, 100, 'c3', 'review'), sug(130, 100, 'c3', 'review')], [cluster('c3', 'review', { chosenK: 2, runnerUpK: 1, alternative: { k: 1, colonies: [{ x: 101, y: 100, r: 12 }] } })])
    const m = displayMarks(pendingView(l2, []), { clusterId: 'c3', choice: 'primary' })
    expect(m.map((x) => [x.index, x.state])).toEqual([
      [0, 'review'],
      [1, 'changed'],
    ])
  })
})
