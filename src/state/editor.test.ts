import { describe, expect, it, vi } from 'vitest'
import type { Annotation, ImageRecord, Project } from '../model/types'
import { SCHEMA_VERSION } from '../model/types'
import type { DriveState, ImportResult, ProjectRepository, ProjectSession, ProjectSnapshot, SaveStatus } from '../storage/api'
import { createEditor } from './editor'
import { createAssist } from './assist'
import type { DetectRequest, DetectResult, DetectorClient } from '../detection'
import type { ConfirmRequest, Notice } from './messages'

const img = (id: string, imageGroupId: string | null): ImageRecord => ({
  id,
  name: `${id}.jpg`,
  imageGroupId,
  width: 100,
  height: 80,
  mimeType: 'image/jpeg',
  byteSize: 1,
  fingerprint: `fp-${id}`,
  source: { kind: 'local' },
  addedAt: '2026-01-01T00:00:00.000Z',
})

function project(id = 'p1'): Project {
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    name: `Test ${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    imageGroups: [{ id: 'ig1', name: 'Batch 1' }],
    images: [img('i1', 'ig1'), img('i2', null)],
    annotationGroups: [],
    storage: { kind: 'local' },
    excludedDriveFileIds: [],
    revision: 0,
  }
}

type MockSession = ProjectSession & {
  save: ReturnType<typeof vi.fn>
  emitUpdated(p: Project): void
}

function mockRepo() {
  const subscribers = new Set<() => void>()
  let drive: DriveState = { state: 'disconnected' }
  const status: SaveStatus = { state: 'saved-local', at: '' }
  const control = { failSave: false, importHook: null as null | (() => Promise<void>), takeRemoteHook: null as null | (() => Promise<void>) }
  const sessions: MockSession[] = []

  function makeSession(p: Project): MockSession {
    const updated = new Set<(p: Project) => void>()
    const session: MockSession = {
      projectId: p.id,
      opened: { project: p, annotations: new Map() },
      closed: false,
      save: vi.fn(async () => {
        if (control.failSave) throw new Error('quota exceeded')
      }),
      onUpdated(fn) {
        updated.add(fn)
        return () => updated.delete(fn)
      },
      emitUpdated: (np) => updated.forEach((fn) => fn(np)),
      images: {
        import: vi.fn(async (files: File[]): Promise<ImportResult> => {
          await control.importHook?.()
          return { added: files.map((f, i) => ({ ...img(`new${i}`, null), name: f.name })), rejected: [] }
        }),
        importFromDrive: vi.fn(async () => ({ added: [], rejected: [] })),
        blob: vi.fn(async () => new Blob()),
        remove: vi.fn(async () => {}),
      },
      exportZip: vi.fn(async () => new Blob()),
      exportCsv: vi.fn(async () => new Blob()),
      drive: {
        link: vi.fn(async () => ({ warnings: [] })),
        push: vi.fn(async () => {}),
        takeRemote: vi.fn(async (): Promise<ProjectSnapshot> => {
          await control.takeRemoteHook?.()
          return { project: { ...project(p.id), name: 'Drive version' }, annotations: new Map() }
        }),
      },
      close() {},
    }
    sessions.push(session)
    return session
  }

  const repo: ProjectRepository = {
    getStatus: () => status,
    getDriveState: () => drive,
    subscribe(fn) {
      subscribers.add(fn)
      return () => subscribers.delete(fn)
    },
    list: async () => [
      { id: 'p1', name: 'Test p1', updatedAt: '2', imageCount: 2, storage: 'local' },
      { id: 'p2', name: 'Test p2', updatedAt: '1', imageCount: 2, storage: 'local' },
    ],
    open: vi.fn(async (id: string) => makeSession(project(id))),
    create: vi.fn(async (name: string) => makeSession({ ...project('new'), name })),
    importArchive: vi.fn(async () => makeSession(project('zip'))),
    openFromDrive: vi.fn(async () => makeSession(project('drive'))),
    delete: vi.fn(async () => {}),
    connectDrive: vi.fn(async () => {
      drive = { state: 'connected', expiresAt: Date.now() + 1e6 }
      subscribers.forEach((fn) => fn())
    }),
    disconnectDrive: vi.fn(async () => {}),
  }
  return { repo, sessions, control }
}

async function setup(opts: { confirm?: (r: ConfirmRequest) => Promise<boolean> } = {}) {
  const notices: Notice[] = []
  const confirms: ConfirmRequest[] = []
  const { repo, sessions, control } = mockRepo()
  const editor = createEditor(repo, {
    notify: (n) => notices.push(n),
    confirm: (r) => {
      confirms.push(r)
      return opts.confirm ? opts.confirm(r) : Promise.resolve(false)
    },
  })
  await editor.projects.init()
  const session = () => sessions.at(-1)!
  return { editor, notices, confirms, repo, sessions, session, control }
}

const automated = (id: string, groupId: string, extra: Partial<Annotation> = {}): Annotation => ({
  id,
  x: 1,
  y: 1,
  groupId,
  origin: 'automated',
  createdAt: '',
  updatedAt: '',
  reviewStatus: 'accepted',
  lastEditSource: 'automated',
  manuallyAdjusted: false,
  ...extra,
})

describe('editor', () => {
  it('opens the last project with a default "Colonies" group and selects the first image', async () => {
    const { editor } = await setup()
    expect(editor.state.phase).toBe('ready')
    expect(editor.groups.list().map((g) => g.name)).toEqual(['Colonies'])
    expect(editor.state.currentImageId).toBe('i1')
    expect(editor.groups.active()?.name).toBe('Colonies')
  })

  it('adds manual annotations and derives counts', async () => {
    const { editor } = await setup()
    editor.annotations.add(10, 20)
    editor.annotations.add(30, 40)
    expect(editor.annotations.total()).toBe(2)
    expect(editor.annotations.current()[0]).toMatchObject({ origin: 'manual', reviewStatus: 'accepted', x: 10, y: 20 })
    expect(editor.images.confirmedCount('i1')).toBe(2)
    expect(editor.images.confirmedCount('i2')).toBe(0)
  })

  it('exposes annotations as an immutable snapshot whose identity changes only on edits', async () => {
    const { editor } = await setup()
    editor.annotations.add(1, 1)
    const before = editor.annotations.current()
    editor.projects.rename('Something else')
    editor.view.setTool('pan')
    expect(editor.annotations.current()).toBe(before)
    editor.annotations.add(2, 2)
    expect(editor.annotations.current()).not.toBe(before)
    expect(before).toHaveLength(1) // the old snapshot was not mutated
    const groupsBefore = editor.groups.list()
    editor.groups.setStyle(groupsBefore[0].id, { size: 10 })
    expect(editor.groups.list()).not.toBe(groupsBefore)
    expect(groupsBefore[0].size).not.toBe(10)
  })

  it('scopes undo/redo to the current image', async () => {
    const { editor } = await setup()
    editor.annotations.add(1, 1)
    editor.images.select('i2')
    expect(editor.annotations.canUndo()).toBe(false)
    expect(editor.annotations.undo()).toBe(false)
    expect(editor.images.confirmedCount('i1')).toBe(1)
    editor.images.select('i1')
    expect(editor.annotations.undo()).toBe(true)
    expect(editor.images.confirmedCount('i1')).toBe(0)
    expect(editor.annotations.redo()).toBe(true)
    expect(editor.images.confirmedCount('i1')).toBe(1)
  })

  it('refuses edits and undo on locked/hidden groups with an explanation', async () => {
    const { editor, notices } = await setup()
    const id = editor.groups.active()!.id
    editor.annotations.add(1, 1)
    editor.groups.toggleLocked(id)
    expect(editor.annotations.add(2, 2)).toBe(false)
    expect(notices.at(-1)?.message).toMatch(/locked/)
    expect(editor.annotations.undo()).toBe(false)
    expect(notices.at(-1)?.detail).toMatch(/Unlock/)
    expect(editor.annotations.total()).toBe(1)
    expect(editor.groups.setStyle(id, { opacity: 0.5 })).toBe(false)
    editor.groups.toggleLocked(id)
    editor.groups.toggleHidden(id)
    expect(editor.annotations.undo()).toBe(false)
    expect(notices.at(-1)?.detail).toMatch(/hidden/)
    expect(editor.annotations.total()).toBe(1) // hidden still counted
    notices.at(-1)?.action?.run() // "Show group"
    expect(editor.groups.active()?.hidden).toBe(false)
    expect(editor.annotations.undo()).toBe(true)
    expect(editor.annotations.total()).toBe(0)
  })

  it('reports a locked+hidden group as locked first (one policy)', async () => {
    const { editor, notices } = await setup()
    const id = editor.groups.active()!.id
    editor.groups.setHidden(id, true)
    editor.groups.setLocked(id, true)
    expect(editor.annotations.add(1, 1)).toBe(false)
    expect(notices.at(-1)?.message).toMatch(/locked/)
  })

  it('applyBatch is a single undo step', async () => {
    const { editor } = await setup()
    const groupId = editor.groups.active()!.id
    const ops = ['a', 'b', 'c'].map((id) => ({ kind: 'add' as const, annotation: automated(id, groupId) }))
    expect(editor.annotations.applyBatch('i1', ops, { label: 'Accept 3 suggestions' })).toBeNull()
    expect(editor.annotations.total()).toBe(3)
    editor.annotations.undo()
    expect(editor.annotations.total()).toBe(0)
  })

  it('applyBatch rejects origin/id rewrites and inconsistent detection runs', async () => {
    const { editor } = await setup()
    const groupId = editor.groups.active()!.id
    const a = automated('a', groupId)
    editor.annotations.applyBatch('i1', [{ kind: 'add', annotation: a }], { label: 'add' })
    expect(editor.annotations.applyBatch('i1', [{ kind: 'update', before: a, after: { ...a, origin: 'manual' } }], { label: 'x' })).toMatchObject({ reason: 'invalid' })
    const run = (over: object) => ({ runId: 'r', method: 'm', version: '0', createdAt: '', imageFingerprint: 'fp-i1', analysisScale: 1, targetGroupId: groupId, seeds: [], prior: {}, settings: {}, ...over })
    const add = [{ kind: 'add' as const, annotation: automated('b', groupId) }]
    expect(editor.annotations.applyBatch('i1', add, { label: 'x', detectionRun: run({ imageFingerprint: 'other' }) })).toMatchObject({ reason: 'invalid' })
    expect(editor.annotations.applyBatch('i1', add, { label: 'x', detectionRun: run({ targetGroupId: 'nope' }) })).toMatchObject({ reason: 'invalid' })
    expect(editor.annotations.total()).toBe(1)
  })

  it('applyBatch records a detection run in the same undo step and keeps geometry', async () => {
    const { editor } = await setup()
    const groupId = editor.groups.active()!.id
    const run = { runId: 'run1', method: 'test', version: '0', createdAt: '', imageFingerprint: 'fp-i1', analysisScale: 1, targetGroupId: groupId, seeds: [], prior: {}, settings: {} }
    const annotation = automated('auto1', groupId, { geometry: { kind: 'circle', r: 4, source: 'fit' } })
    editor.annotations.applyBatch('i1', [{ kind: 'add', annotation }], { label: 'Accept 1 suggestion', detectionRun: run })
    expect(editor.state.docs['i1'].detectionRuns.map((r) => r.runId)).toEqual(['run1'])
    editor.annotations.undo()
    expect(editor.state.docs['i1'].detectionRuns).toEqual([])
    editor.annotations.redo()
    expect(editor.state.docs['i1'].detectionRuns).toHaveLength(1)
    expect(editor.annotations.current()[0]).toMatchObject({ origin: 'automated', geometry: { r: 4 } })
  })

  it('redo refuses to restore a detection run whose image bytes changed meanwhile', async () => {
    const { editor, session, notices } = await setup()
    const groupId = editor.groups.active()!.id
    const run = { runId: 'run1', method: 'test', version: '0', createdAt: '', imageFingerprint: 'fp-i1', analysisScale: 1, targetGroupId: groupId, seeds: [], prior: {}, settings: {} }
    editor.annotations.applyBatch('i1', [{ kind: 'add', annotation: automated('auto1', groupId) }], { label: 'Accept 1 suggestion', detectionRun: run })
    editor.annotations.undo()
    const updated = project()
    updated.images[0].sourceMismatch = { detectedAt: '', message: 'Replaced' }
    session().emitUpdated(updated)
    expect(editor.annotations.redo()).toBe(false)
    expect(notices.at(-1)?.message).toMatch(/image changed/)
    expect(editor.state.docs['i1'].detectionRuns).toEqual([])
    expect(editor.annotations.total()).toBe(0)
  })

  it('deleting a group keeps detection runs that target it (audit trail)', async () => {
    const { editor } = await setup()
    const groupId = editor.groups.active()!.id
    editor.groups.create('Other')
    const run = { runId: 'run1', method: 'test', version: '0', createdAt: '', imageFingerprint: 'fp-i1', analysisScale: 1, targetGroupId: groupId, seeds: [], prior: {}, settings: {} }
    editor.annotations.applyBatch('i1', [{ kind: 'add', annotation: automated('auto1', groupId) }], { label: 'Accept', detectionRun: run })
    expect(editor.groups.remove(groupId)).toBe(true)
    expect(editor.state.docs['i1'].detectionRuns.map((r) => r.targetGroupId)).toEqual([groupId])
    expect(await editor.projects.flush()).toBe(true)
  })

  it('reassigning images keeps annotations; deleting an image group ungroups images', async () => {
    const { editor } = await setup()
    editor.annotations.add(5, 5)
    const ig = editor.imageGroups.create('Treatment B')!
    editor.images.assign('i1', ig)
    expect(editor.state.project!.images.find((i) => i.id === 'i1')!.imageGroupId).toBe(ig)
    expect(editor.images.confirmedCount('i1')).toBe(1)
    editor.imageGroups.remove(ig)
    expect(editor.state.project!.images.find((i) => i.id === 'i1')!.imageGroupId).toBeNull()
    expect(editor.images.confirmedCount('i1')).toBe(1)
  })

  it('imports into an image group that was deleted mid-import as ungrouped (B4)', async () => {
    const { editor, control } = await setup()
    const ig = editor.imageGroups.create('Doomed')!
    control.importHook = async () => editor.imageGroups.remove(ig)
    await editor.images.import([new File(['x'], 'late.jpg')], ig)
    const added = editor.state.project!.images.find((i) => i.name === 'late.jpg')!
    expect(added.imageGroupId).toBeNull()
  })

  it('deleting a group removes its annotations and history; last group cannot be deleted', async () => {
    const { editor } = await setup()
    const first = editor.groups.active()!.id
    expect(editor.groups.remove(first)).toBe(false)
    const second = editor.groups.create('Small')!
    expect(editor.state.activeGroupId).toBe(second)
    editor.annotations.add(1, 1)
    editor.view.setActiveGroup(first)
    editor.annotations.add(2, 2)
    expect(editor.groups.usage(second)).toEqual({ annotations: 1, images: 1 })
    expect(editor.groups.remove(second)).toBe(true)
    expect(editor.annotations.total()).toBe(1)
    editor.annotations.undo() // undoes the "first" add
    expect(editor.annotations.total()).toBe(0)
    expect(editor.annotations.canUndo()).toBe(false)
  })

  it('autosaves changed docs with refreshed group snapshots', async () => {
    const { editor, session } = await setup()
    editor.annotations.add(1, 1)
    expect(await editor.projects.flush()).toBe(true)
    const last = session().save.mock.calls.at(-1)! as [Project, { imageId: string; groups: unknown[] }[]]
    expect(last[1].map((d) => d.imageId)).toEqual(['i1'])
    expect(last[1][0].groups).toHaveLength(1)
  })

  it('group visibility/lock/style changes save project.json only, not every annotation doc (B10)', async () => {
    const { editor, session } = await setup()
    editor.annotations.add(1, 1)
    editor.images.select('i2')
    editor.annotations.add(2, 2)
    await editor.projects.flush()
    const id = editor.groups.active()!.id
    editor.groups.toggleHidden(id)
    editor.groups.toggleLocked(id)
    editor.groups.toggleLocked(id)
    editor.groups.setStyle(id, { color: '#000000' })
    await editor.projects.flush()
    const last = session().save.mock.calls.at(-1)! as [Project, unknown[]]
    expect(last[0].annotationGroups[0]).toMatchObject({ hidden: true, color: '#000000' })
    expect(last[1]).toEqual([])
  })

  it('display adjustments save project.json only, work on locked groups and keep storage merges intact', async () => {
    const { editor, session } = await setup()
    editor.annotations.add(1, 1)
    await editor.projects.flush()
    editor.groups.toggleLocked(editor.groups.active()!.id)
    const display = { brightness: 0.2, contrast: 0, gamma: 1, saturation: 1, invert: true, channel: 'green' as const, autoContrast: false }
    editor.images.setDisplay(['i1', 'i2'], display)
    await editor.projects.flush()
    const last = session().save.mock.calls.at(-1)! as [Project, unknown[]]
    expect(last[0].images.map((i) => i.display)).toEqual([display, display])
    expect(last[1]).toEqual([])
    session().emitUpdated(project()) // storage-owned merge must not drop editor-owned display
    expect(editor.state.project!.images[0].display).toEqual(display)
    editor.images.setDisplay(['i1'], { ...display, brightness: 0, invert: false, channel: 'rgb' })
    expect('display' in editor.state.project!.images[0]).toBe(false)
    expect(editor.state.project!.images[1].display).toEqual(display)
  })

  it('merges storage-owned fields from session.onUpdated without touching edits', async () => {
    const { editor, session } = await setup()
    editor.projects.rename('Renamed')
    editor.annotations.add(1, 1)
    const updated = project()
    updated.storage = { kind: 'drive', folderId: 'f', folderName: 'Folder' }
    updated.images[0].sourceMismatch = { detectedAt: '', message: 'Replaced' }
    updated.excludedDriveFileIds = ['gone']
    session().emitUpdated(updated)
    expect(editor.state.project!.storage.kind).toBe('drive')
    expect(editor.state.project!.excludedDriveFileIds).toEqual(['gone'])
    expect(editor.state.project!.name).toBe('Renamed')
    expect(editor.state.project!.images[0].sourceMismatch?.message).toBe('Replaced')
    expect(editor.annotations.total()).toBe(1)
  })

  it('does not discard edits that failed to save when switching projects; asks first (B1)', async () => {
    const { editor, control, confirms, repo } = await setup()
    editor.annotations.add(1, 1)
    control.failSave = true
    expect(await editor.projects.open('p2')).toBe(false)
    expect(confirms).toHaveLength(1)
    expect(confirms[0].confirmLabel).toMatch(/Discard/)
    expect(editor.state.project!.id).toBe('p1')
    expect(editor.annotations.total()).toBe(1)
    expect(repo.open).toHaveBeenCalledTimes(1) // only the initial open
  })

  it('switches after the user agrees to discard unsaved edits', async () => {
    const { editor, control } = await setup({ confirm: async () => true })
    editor.annotations.add(1, 1)
    control.failSave = true
    expect(await editor.projects.open('p2')).toBe(true)
    expect(editor.state.project!.id).toBe('p2')
  })

  it('explains a file that is not a project archive in plain language', async () => {
    const { editor, notices, repo } = await setup()
    ;(repo.importArchive as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('invalid zip data'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await editor.projects.importArchive(new File(['z'], 'photo.zip'))).toBe(false)
    expect(notices.at(-1)?.message).toBe('This file isn’t a CFU Count project')
    expect(notices.at(-1)?.detail).toMatch(/Download project/)
    expect(notices.at(-1)?.detail).not.toMatch(/invalid zip/)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('also guards import of a .zip and take-remote', async () => {
    const { editor, control, confirms, session } = await setup()
    editor.annotations.add(1, 1)
    control.failSave = true
    expect(await editor.projects.importArchive(new File(['z'], 'p.zip'))).toBe(false)
    await editor.drive.takeRemote()
    expect(session().drive.takeRemote).not.toHaveBeenCalled()
    expect(confirms).toHaveLength(2)
  })

  it('linking to Drive merges storage fields instead of reloading: edits during the link survive (B2)', async () => {
    const { editor, session, repo } = await setup()
    const s = session()
    ;(s.drive.link as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      editor.annotations.add(7, 7) // user keeps working while the first upload runs
      s.emitUpdated({ ...project(), storage: { kind: 'drive', folderId: 'F', folderName: 'Lab' } })
      return { warnings: [] }
    })
    await editor.drive.link('create-folder')
    expect(repo.open).toHaveBeenCalledTimes(1)
    expect(editor.annotations.total()).toBe(1)
    expect(editor.state.project!.storage).toMatchObject({ kind: 'drive', folderName: 'Lab' })
  })

  it('freezes edits and autosave while the Drive version is loaded (B2)', async () => {
    const { editor, session, control, notices } = await setup()
    editor.annotations.add(1, 1)
    await editor.projects.flush()
    const savesBefore = session().save.mock.calls.length
    let refused: boolean | undefined
    control.takeRemoteHook = async () => {
      refused = !editor.annotations.add(9, 9)
    }
    await editor.drive.takeRemote()
    expect(refused).toBe(true)
    expect(notices.some((n) => n.key === 'busy')).toBe(true)
    expect(session().save.mock.calls.length).toBe(savesBefore)
    expect(editor.state.project!.name).toBe('Drive version')
    expect(editor.annotations.total()).toBe(0)
  })

  it('starts Google sign-in synchronously inside the click for Drive commands (B8)', async () => {
    const { editor, repo } = await setup()
    void editor.drive.save()
    expect(repo.connectDrive).toHaveBeenCalledTimes(1) // before any await
    const { editor: e2, repo: r2 } = await setup()
    void e2.drive.takeRemote()
    expect(r2.connectDrive).toHaveBeenCalledTimes(1)
    const { editor: e3, repo: r3 } = await setup()
    void e3.drive.openFolder()
    expect(r3.connectDrive).toHaveBeenCalledTimes(1)
  })

  it('dispose stops storage subscriptions', async () => {
    const { editor, repo } = await setup()
    editor.dispose()
    await repo.connectDrive() // emits; must not throw or update disposed signals
    expect(true).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Assisted counting (state/assist) on top of the real editor
// ---------------------------------------------------------------------------

function fakeDetector(make: (req: DetectRequest) => Partial<DetectResult>) {
  const calls: DetectRequest[] = []
  let gate: Promise<void> | null = null
  const client: DetectorClient & { calls: DetectRequest[]; hold(): () => void; cleared: number } = {
    calls,
    cleared: 0,
    hold() {
      let release!: () => void
      gate = new Promise((r) => (release = r))
      return release
    },
    async detect(request, opts = {}) {
      calls.push(request)
      opts.onProgress?.({ stage: 'fit', fraction: 0.5 })
      if (gate) await gate
      if (opts.signal?.aborted) throw Object.assign(new Error('Detection cancelled'), { name: 'DetectionCancelled' })
      const base = {
        method: 'fitter' as const,
        suggestions: [],
        clusters: [],
        calibration: { seeds: [], nTotal: request.seeds.length, nUsable: request.seeds.length, prior: null, appearance: {}, polarity: 1 as const, colorAxis: [1, 0, 0] as [number, number, number], summary: `${request.seeds.length} manual examples`, tentative: false, warnings: [] },
        roi: { source: 'auto' as const, outline: [], shape: 'square' as const, marginPx: 2, area: 1 },
        run: { runId: request.runId!, method: 'colony-fitter', version: '1', createdAt: '', imageFingerprint: '', analysisScale: 1, targetGroupId: request.targetGroupId, seeds: [], prior: {}, settings: {} },
        timingsMs: {},
        peakRasterBytes: 0,
      }
      return { ...base, ...make(request) } as DetectResult
    },
    clearCache() {
      client.cleared++
    },
    dispose() {},
  }
  return client
}

const s = (x: number, y: number, clusterId: string, status: 'ok' | 'review' = 'ok') => ({ x, y, r: 3, score: 1, clusterId, status })

async function setupAssist(make: (req: DetectRequest) => Partial<DetectResult> = () => ({
  suggestions: [s(50, 50, 'c1'), s(70, 50, 'c2'), s(60, 70, 'c3', 'review'), s(66, 70, 'c3', 'review')],
  clusters: [
    { clusterId: 'c1', bbox: [47, 47, 6, 6], area: 28, fixedIds: [], chosenK: 1, runnerUpK: null, objectiveGap: null, status: 'ok' },
    { clusterId: 'c2', bbox: [67, 47, 6, 6], area: 28, fixedIds: [], chosenK: 1, runnerUpK: null, objectiveGap: null, status: 'ok' },
    { clusterId: 'c3', bbox: [57, 67, 12, 6], area: 50, fixedIds: [], chosenK: 2, runnerUpK: 1, objectiveGap: 0.1, status: 'review', alternative: { k: 1, colonies: [{ x: 63, y: 70, r: 5 }] } },
  ],
})) {
  const env = await setup()
  const detector = fakeDetector(make)
  let ids = 0
  const assist = createAssist({ editor: env.editor, notify: (n) => env.notices.push(n), createClient: () => detector, debounceMs: 0, newId: () => `id${++ids}` })
  for (const [x, y] of [[10, 10], [20, 10], [30, 10]]) env.editor.annotations.add(x, y)
  const settle = () => new Promise((r) => setTimeout(r, 0))
  return { ...env, assist, detector, settle }
}

describe('assisted counting', () => {
  it('runs on open with this image’s manual examples and never counts suggestions', async () => {
    const { editor, assist, detector, settle } = await setupAssist()
    expect(assist.block()).toBeNull()
    assist.start()
    expect(assist.phase()).toBe('running')
    await settle()
    expect(assist.phase()).toBe('ready')
    expect(detector.calls[0].seeds).toHaveLength(3)
    expect(detector.calls[0].existing).toHaveLength(3)
    expect(assist.view()).toMatchObject({ suggested: 4, needReview: 2, rejected: 0 })
    expect(editor.annotations.total()).toBe(3) // confirmed only
    expect(editor.state.docs['i1'].annotations).toHaveLength(3) // suggestions never enter the document
  })

  it('accepting all OK is one undo step that stores the run; undo removes both and suggestions are pending again', async () => {
    const { editor, assist, settle, notices } = await setupAssist()
    assist.start()
    await settle()
    assist.toggleReject(1)
    expect(assist.view()!.rejected).toBe(1)
    expect(assist.accept({ kind: 'ok' })).toBe(true)
    expect(notices.at(-1)).toMatchObject({ tone: 'success', message: 'Added 1 colony to “Colonies”' })
    expect(editor.annotations.total()).toBe(4)
    const added = editor.annotations.current().at(-1)!
    expect(added).toMatchObject({ origin: 'automated', reviewStatus: 'accepted', geometry: { kind: 'circle', r: 3, source: 'fit' }, detector: { confidence: null } })
    const runs = editor.state.docs['i1'].detectionRuns
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ runId: added.detector!.runId, imageFingerprint: 'fp-i1', negatives: [{ x: 70, y: 50 }] })
    expect(assist.view()!.okIndices).toEqual([])
    notices.at(-1)!.action!.run() // toast Undo
    expect(editor.annotations.total()).toBe(3)
    expect(editor.state.docs['i1'].detectionRuns).toEqual([])
    expect(assist.view()!.okIndices).toEqual([0])
    editor.annotations.redo()
    expect(editor.annotations.total()).toBe(4)
    expect(editor.state.docs['i1'].detectionRuns).toHaveLength(1)
  })

  it('resolves a review cluster with the alternative count as its own undo step', async () => {
    const { editor, assist, settle } = await setupAssist()
    assist.start()
    await settle()
    expect(assist.accept({ kind: 'cluster', clusterId: 'c3', choice: 'alternative' })).toBe(true)
    expect(editor.annotations.total()).toBe(4)
    expect(assist.view()!.reviewClusters).toHaveLength(0)
    editor.annotations.undo()
    expect(assist.view()!.reviewClusters).toHaveLength(1)
  })

  it('refuses to accept into a locked or hidden group and offers the fix', async () => {
    const { editor, assist, settle, notices } = await setupAssist()
    assist.start()
    await settle()
    const id = editor.groups.active()!.id
    editor.groups.setLocked(id, true)
    expect(assist.accept({ kind: 'ok' })).toBe(false)
    expect(notices.at(-1)).toMatchObject({ message: expect.stringMatching(/locked/), action: { label: 'Unlock' } })
    expect(editor.annotations.total()).toBe(3)
    expect(assist.block()?.reason).toBe('locked')
    notices.at(-1)!.action!.run()
    editor.groups.setHidden(id, true)
    expect(assist.accept({ kind: 'ok' })).toBe(false)
    expect(notices.at(-1)?.action?.label).toBe('Show group')
  })

  it('does not duplicate a colony marked by hand after the run', async () => {
    const { editor, assist, settle } = await setupAssist()
    assist.start()
    await settle()
    editor.annotations.add(50.5, 50.5)
    expect(assist.view()!.okIndices).toEqual([1])
    assist.accept({ kind: 'ok' })
    expect(editor.annotations.current().filter((a) => Math.hypot(a.x - 50, a.y - 50) < 3)).toHaveLength(1)
  })

  it('cancels on image switch and keeps per-image layers; a project switch discards them', async () => {
    const { editor, assist, detector, settle } = await setupAssist()
    assist.start()
    await settle()
    expect(assist.layer()).not.toBeNull()
    editor.images.select('i2')
    expect(assist.layer()).toBeNull()
    expect(assist.phase()).toBe('idle')
    expect(detector.cleared).toBeGreaterThan(0)
    editor.images.select('i1')
    expect(assist.phase()).toBe('ready')
    const release = detector.hold()
    assist.run()
    await settle()
    expect(assist.phase()).toBe('running')
    editor.images.select('i2')
    release()
    await settle()
    expect(assist.phase()).toBe('idle')
    await editor.projects.open('p2')
    await settle()
    editor.images.select('i1')
    expect(assist.layer()).toBeNull()
    expect(assist.open()).toBe(false)
  })

  it('borrows examples from a reference image and records its fingerprint on accept', async () => {
    const { editor, assist, detector, settle } = await setupAssist()
    editor.images.select('i2')
    expect(assist.localSeeds()).toBe(0)
    expect(assist.candidates()).toEqual([{ imageId: 'i1', name: 'i1.jpg', count: 3 }])
    expect(assist.seedSource()).toEqual({ kind: 'reference', imageId: 'i1' })
    assist.start()
    expect(assist.phase()).toBe('idle') // a reference plate is confirmed by the user first
    assist.run()
    await settle()
    const req = detector.calls.at(-1)!
    expect(req.seeds).toHaveLength(0)
    expect(req.remoteSeeds).toHaveLength(3)
    expect(Object.keys(req.remoteSources ?? {})).toEqual(['i1'])
    assist.accept({ kind: 'ok' })
    expect(editor.state.docs['i2'].detectionRuns[0].seedImageFingerprints).toEqual({ i1: 'fp-i1' })
  })

  it('drops a layer when storage reports the image bytes changed (reconciled in place)', async () => {
    const { editor, assist, session, settle } = await setupAssist()
    assist.start()
    await settle()
    expect(assist.layer()).not.toBeNull()
    const updated = project()
    updated.images[0].sourceMismatch = { detectedAt: '', message: 'Replaced' }
    session().emitUpdated(updated)
    expect(editor.state.project!.images[0].sourceMismatch).toBeDefined()
    expect(assist.layer()).toBeNull()
    expect(assist.phase()).toBe('idle')
  })

  it('drops a layer when its target group is deleted', async () => {
    const { editor, assist, settle } = await setupAssist()
    assist.start()
    await settle()
    const target = editor.groups.active()!.id
    editor.groups.create('Other')
    expect(editor.groups.remove(target)).toBe(true)
    expect(assist.layer()).toBeNull()
    expect(assist.phase()).toBe('idle')
  })

  it('carries rejections over a settings re-run and blocks with no examples anywhere', async () => {
    const { editor, assist, detector, settle } = await setupAssist()
    assist.start()
    await settle()
    assist.toggleReject(0)
    assist.setSettings({ sensitivity: 0.8 })
    await new Promise((r) => setTimeout(r, 5))
    await settle()
    expect(detector.calls).toHaveLength(2)
    expect(detector.calls[1].settings).toMatchObject({ sensitivity: 0.8 })
    expect(assist.layer()!.rejected.has(0)).toBe(true)
    editor.annotations.undo()
    editor.annotations.undo()
    editor.annotations.undo()
    expect(assist.block()?.reason).toBe('no-seeds')
  })
})
