import { describe, expect, it, vi } from 'vitest'
import { SCHEMA_VERSION, type ImageRecord, type Project } from '../../model/types'
import type { ProjectRepository } from '../../storage/api'
import type { DetectRequest, DetectResult, DetectorClient } from '../../detection'
import { createEditor } from '../editor'
import { createAssist } from '../assist'
import type { Notice } from '../messages'
import type { FeedbackEvent } from '../feedback'
import { createRegion, comparisonExport, pickSpread, planComparison, summarizeComparison, compareMarks, CLEAR_CONFIRM_ABOVE } from '.'

const img = (id: string): ImageRecord => ({
  id,
  name: `${id}.jpg`,
  imageGroupId: null,
  width: 400,
  height: 300,
  mimeType: 'image/jpeg',
  byteSize: 1,
  fingerprint: `fp-${id}`,
  source: { kind: 'local' },
  addedAt: '2026-01-01T00:00:00.000Z',
})

const project = (): Project => ({
  schemaVersion: SCHEMA_VERSION,
  id: 'p1',
  name: 'Plates',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  imageGroups: [],
  images: [img('i1'), img('i2')],
  annotationGroups: [],
  storage: { kind: 'local' },
  revision: 0,
})

/** Minimal in-memory repository: enough for the editor to open one project. */
function repo(): ProjectRepository {
  const session = {
    projectId: 'p1',
    opened: { project: project(), annotations: new Map() },
    closed: false,
    save: vi.fn(async () => {}),
    onUpdated: () => () => true,
    images: { import: vi.fn(), importFromDrive: vi.fn(), blob: vi.fn(async () => new Blob()) },
    exportZip: vi.fn(),
    exportCsv: vi.fn(),
    drive: { link: vi.fn(), push: vi.fn(), takeRemote: vi.fn() },
    // version history (another slice): every call succeeds and stores nothing
    history: new Proxy({}, { get: () => async () => ({ version: { id: 'v1' } }) }),
    close() {},
  }
  return {
    getStatus: () => ({ state: 'saved-local', at: '' }),
    getDriveState: () => ({ state: 'disconnected' }),
    subscribe: () => () => true,
    list: async () => [{ id: 'p1', name: 'Plates', updatedAt: '1', imageCount: 2, storage: 'local' }],
    open: vi.fn(async () => session),
    create: vi.fn(),
    importArchive: vi.fn(),
    openFromDrive: vi.fn(),
    delete: vi.fn(),
    connectDrive: vi.fn(),
    disconnectDrive: vi.fn(),
  } as unknown as ProjectRepository
}

function fakeDetector(make: (req: DetectRequest) => Partial<DetectResult>) {
  const calls: DetectRequest[] = []
  const client: DetectorClient & { calls: DetectRequest[] } = {
    calls,
    async detect(request, opts = {}) {
      calls.push(request)
      if (opts.signal?.aborted) throw Object.assign(new Error('Detection cancelled'), { name: 'DetectionCancelled' })
      const base = {
        method: 'fitter' as const,
        suggestions: [],
        clusters: [],
        calibration: { seeds: [], nTotal: request.seeds.length, nUsable: request.seeds.length, prior: { mu: Math.log(5), s: 0.25, sMin: 0.25, n: 3, rMedian: 5, rRange: [3, 8] as [number, number] }, appearance: {}, polarity: 1 as const, colorAxis: [1, 0, 0] as [number, number, number], summary: `${request.seeds.length} manual examples`, tentative: false, warnings: [] },
        roi: { source: 'auto' as const, outline: [], shape: 'square' as const, marginPx: 2, area: 1, region: request.roi?.kind === 'polygon' ? request.roi.points : undefined, regionContextPx: 10 },
        run: { runId: request.runId!, method: 'colony-fitter', version: '1', createdAt: '', imageFingerprint: '', analysisScale: 1, targetGroupId: request.targetGroupId, roi: request.roi, seeds: [], prior: {}, settings: {} },
        timingsMs: { total: 5 },
        peakRasterBytes: 0,
      }
      return { ...base, ...make(request) } as DetectResult
    },
    clearCache() {},
    dispose() {},
  }
  return client
}

// region: the square 0..100 × 0..100
const square = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 100 },
  { x: 0, y: 100 },
]

async function setup(make: (req: DetectRequest) => Partial<DetectResult> = () => ({})) {
  const notices: Notice[] = []
  const events: FeedbackEvent[] = []
  const editor = createEditor(repo(), { notify: (n) => notices.push(n), feedback: (e) => events.push(e), confirm: async () => false })
  await editor.projects.init()
  const detector = fakeDetector(make)
  let ids = 0
  const assist = createAssist({ editor, notify: (n) => notices.push(n), feedback: (e) => events.push(e), createClient: () => detector, debounceMs: 0, newId: () => `id${++ids}` })
  const versions: string[] = []
  const region = createRegion({
    editor,
    assist,
    notify: (n) => notices.push(n),
    feedback: (e) => events.push(e),
    newId: () => `r${++ids}`,
    beforeDestructive: async (label) => {
      versions.push(label)
      return { ok: true }
    },
  })
  const settle = () => new Promise((r) => setTimeout(r, 0))
  return { editor, assist, region, detector, notices, events, settle, versions }
}

describe('region controller', () => {
  it('keeps one region per image in memory and counts by centre', async () => {
    const { editor, region } = await setup()
    for (const [x, y] of [[10, 10], [50, 50], [99, 99], [150, 20]]) editor.annotations.add(x, y)
    region.set(square)
    expect(region.tally()).toEqual({ group: { total: 3, manual: 3, automated: 0 }, groupConfirmed: 3, allConfirmed: 3 })
    editor.images.select('i2')
    expect(region.current()).toBeNull()
    editor.images.select('i1')
    expect(region.current()).toEqual(square)
    region.clear()
    expect(region.current()).toBeNull()
    expect(region.tally()).toBeNull()
    // a region never changes annotations
    expect(editor.annotations.total()).toBe(4)
  })

  it('clears the active group in the region as ONE undo step; undo and redo restore exactly that', async () => {
    const { editor, region, events, notices, versions } = await setup()
    for (const [x, y] of [[10, 10], [50, 50], [150, 20]]) editor.annotations.add(x, y)
    const other = editor.groups.create('Other')!
    editor.view.setActiveGroup(other)
    editor.annotations.add(20, 20)
    editor.view.setActiveGroup(editor.groups.list()[0].id)
    region.set(square)
    const plan = region.clearPlan()!
    expect(plan).toMatchObject({ groupName: 'Colonies', manual: 2, automated: 0 })
    expect(await region.clearInRegion(plan)).toBe(true)
    expect(events.at(-1)).toEqual({ type: 'erased' })
    expect(notices.at(-1)?.message).toMatch(/Removed 2 marks/)
    // a version is saved first (version-history hook), and the toast says so
    expect(versions).toEqual(['Before clearing “Colonies” in a region of “i1.jpg”'])
    expect(notices.at(-1)?.detail).toMatch(/version was saved/)
    const left = editor.annotations.current()
    expect(left.map((a) => [a.x, a.y])).toEqual([[150, 20], [20, 20]]) // other group and outside kept
    const h = editor.state.history['i1']
    expect(h.undo.at(-1)?.label).toBe('Clear 2 in region')
    expect(editor.annotations.undo()).toBe(true)
    expect(editor.annotations.current()).toHaveLength(4)
    expect(editor.annotations.redo()).toBe(true)
    expect(editor.annotations.current()).toHaveLength(2)
  })

  it('refuses on a locked or hidden group with the standard explanation and feedback', async () => {
    const { editor, region, events, notices, versions } = await setup()
    editor.annotations.add(10, 10)
    region.set(square)
    const g = editor.groups.active()!
    editor.groups.setLocked(g.id, true)
    expect(await region.clearInRegion()).toBe(false)
    expect(events.at(-1)).toEqual({ type: 'refused', reason: 'locked' })
    expect(notices.at(-1)?.action?.label).toBe('Unlock')
    editor.groups.setLocked(g.id, false)
    editor.groups.setHidden(g.id, true)
    expect(await region.clearInRegion()).toBe(false)
    expect(events.at(-1)).toEqual({ type: 'refused', reason: 'hidden' })
    expect(notices.at(-1)?.action?.label).toBe('Show group')
    expect(editor.annotations.current()).toHaveLength(1)
    expect(versions).toEqual([]) // refused before any version is taken
    // nothing to clear
    editor.groups.setHidden(g.id, false)
    region.set([{ x: 200, y: 200 }, { x: 300, y: 200 }, { x: 300, y: 290 }])
    expect(await region.clearInRegion()).toBe(false)
    expect(events.at(-1)).toEqual({ type: 'refused', reason: 'nothing-to-erase' })
    expect(CLEAR_CONFIRM_ABOVE).toBe(20)
  })

  it('Find similar in region sends the polygon as ROI and stores it on accepted runs', async () => {
    const { editor, assist, region, detector, settle } = await setup(() => ({
      suggestions: [{ x: 60, y: 60, r: 5, score: 1, clusterId: 'c1', status: 'ok' }],
      clusters: [{ clusterId: 'c1', bbox: [55, 55, 10, 10], area: 70, fixedIds: [], chosenK: 1, runnerUpK: null, objectiveGap: null, status: 'ok' }],
    }))
    for (const [x, y] of [[10, 10], [20, 10], [200, 200]]) editor.annotations.add(x, y)
    region.set(square)
    region.findSimilar()
    expect(assist.open()).toBe(true)
    await settle()
    expect(detector.calls[0].roi).toEqual({ kind: 'polygon', points: square })
    expect(detector.calls[0].seeds).toHaveLength(3) // seeds from inside and outside the region
    expect(assist.roi()).toEqual(square)
    expect(assist.accept({ kind: 'ok' })).toBe(true)
    expect(editor.state.docs['i1'].detectionRuns.at(-1)?.roi).toEqual({ kind: 'polygon', points: square })
    // whole plate again
    assist.start({ roi: null })
    await settle()
    expect(detector.calls.at(-1)?.roi).toBeUndefined()
  })

  it('compares the detector with the manual marks in the region without changing annotations', async () => {
    // manual marks on a 20 px grid inside the region; the detector finds all but one plus one extra
    let skipped: { x: number; y: number } | null = null
    const { editor, region, detector, settle } = await setup((req) => {
      const fixed = new Set(req.existing.map((e) => `${e.x},${e.y}`))
      const truth: { x: number; y: number }[] = []
      for (let y = 10; y <= 90; y += 20) for (let x = 10; x <= 90; x += 20) truth.push({ x, y })
      const open = truth.filter((p) => !fixed.has(`${p.x},${p.y}`))
      skipped = open[0]
      const found = open.slice(1).map((p) => ({ x: p.x + 1, y: p.y, r: 5, score: 1, clusterId: 'c', status: 'ok' as const }))
      return { suggestions: [...found, { x: 95, y: 5, r: 5, score: 1, clusterId: 'c', status: 'ok' }] }
    })
    for (let y = 10; y <= 90; y += 20) for (let x = 10; x <= 90; x += 20) editor.annotations.add(x, y)
    const before = editor.annotations.current()
    region.set(square)
    expect(region.compareCounts()).toEqual({ inside: 25, outside: 0 })
    await region.compare()
    await settle()
    const req = detector.calls[0]
    expect(req.seeds).toHaveLength(8)
    expect(req.existing).toHaveLength(8) // the scored marks are NOT fixed colonies
    expect(req.roi).toEqual({ kind: 'polygon', points: square })
    const c = region.comparison()!
    expect(c.summary).toMatchObject({ manual: 17, matched: 16, detected: 17 })
    expect(c.summary.missed).toHaveLength(1)
    expect(c.summary.extra).toHaveLength(1)
    expect(region.compareMarks().filter((m) => m.kind === 'missed')).toEqual([{ ...skipped!, r: 5, kind: 'missed' }])
    expect(region.comparisonStale()).toBe(false)
    expect(editor.annotations.current()).toBe(before) // never modifies annotations
    expect(editor.state.history['i1'].undo).toHaveLength(25)
    // a new mark inside makes it stale
    editor.annotations.add(70, 80)
    expect(region.comparisonStale()).toBe(true)
    const json = comparisonExport(c, { projectName: 'Plates', image: img('i1'), groupName: 'Colonies' })
    expect(json).toMatchObject({ kind: 'cfu-count/region-comparison', counts: { manual: 17, detected: 17, matched: 16, missed: 1, extra: 1 }, examples: { mode: 'inside', count: 8 } })
    expect(json.missed[0]).toMatchObject(skipped!)
    expect(JSON.parse(JSON.stringify(json))).toEqual(json)
  })
})

describe('comparison helpers', () => {
  const grid = (n: number) => Array.from({ length: n * n }, (_, i) => ({ id: `a${i}`, x: (i % n) * 10, y: Math.floor(i / n) * 10 }))

  it('pickSpread picks spread-out, distinct points deterministically', () => {
    const pts = grid(5)
    const four = pickSpread(pts, 4)
    expect(new Set(four.map((p) => p.id)).size).toBe(4)
    expect(four[0]).toMatchObject({ x: 20, y: 20 }) // nearest the centroid first
    // the next ones are corners, not neighbours
    expect(four.slice(1).every((p) => (p.x === 0 || p.x === 40) && (p.y === 0 || p.y === 40))).toBe(true)
    expect(pickSpread(pts, 4)).toEqual(four)
    expect(pickSpread(pts.slice(0, 2), 8)).toHaveLength(2)
  })

  it('planComparison: inside mode scores the rest, outside mode scores everything inside', () => {
    const at = '2026-01-01T00:00:00.000Z'
    const mk = (id: string, x: number, y: number, origin: 'manual' | 'automated' = 'manual') => ({
      id, x, y, groupId: 'g', origin, createdAt: at, updatedAt: at, reviewStatus: 'accepted' as const, lastEditSource: origin, manuallyAdjusted: false,
    })
    const inside = Array.from({ length: 20 }, (_, i) => mk(`in${i}`, 5 + (i % 5) * 20, 5 + Math.floor(i / 5) * 20))
    const outside = [mk('o1', 150, 10), mk('o2', 160, 10), mk('o3', 170, 10)]
    const auto = mk('auto', 50, 50, 'automated')
    const list = [...inside, ...outside, auto]
    const a = planComparison(list, square, 'g', 'inside')
    expect(a.ok && a.plan.seeds.length).toBe(8)
    expect(a.ok && a.plan.scored.length).toBe(12)
    expect(a.ok && a.plan.automatedInside).toBe(1)
    expect(a.ok && a.plan.existing.some((e) => e.id === 'auto')).toBe(true)
    const b = planComparison(list, square, 'g', 'outside')
    expect(b.ok && b.plan.seeds.map((s) => s.id)).toEqual(['o1', 'o2', 'o3'])
    expect(b.ok && b.plan.scored.length).toBe(20)
    expect(planComparison(inside.slice(0, 3), square, 'g', 'inside').ok).toBe(false)
    expect(planComparison(inside, square, 'g', 'outside').ok).toBe(false)
  })

  it('summarizeComparison matches within the typical radius and lists missed / extra', () => {
    const manual = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 40, y: 0 }]
    const found = [{ x: 1, y: 1, r: 4, score: null, clusterId: 'c', status: 'ok' as const }, { x: 26, y: 0, r: 4, score: null, clusterId: 'c', status: 'ok' as const }, { x: 80, y: 0, r: 4, score: null, clusterId: 'c', status: 'ok' as const }]
    const s = summarizeComparison(manual, found, 5)
    expect(s).toMatchObject({ manual: 3, detected: 3, matched: 1, missed: [1, 2], extra: [1, 2] })
    expect(s.precision).toBeCloseTo(1 / 3)
    expect(compareMarks(s, manual, found).map((m) => m.kind)).toEqual(['matched', 'extra', 'extra', 'missed', 'missed'])
    expect(summarizeComparison(manual, found, 7).matched).toBe(2)
  })
})
