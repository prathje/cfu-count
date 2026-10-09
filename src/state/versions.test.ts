import { describe, expect, it, vi } from 'vitest'
import type { ImageAnnotations, ImageRecord, Project } from '../model/types'
import { SCHEMA_VERSION } from '../model/types'
import type { ProjectRepository, ProjectSession } from '../storage/api'
import { LocalStorageError } from '../storage/errors'
import { createMemoryHistory } from '../storage/memoryHistory'
import { createEditor } from './editor'
import { createProjectActions } from '../ui/projectActions'
import type { ChooseOptions, ConfirmOptions, Dialogs } from '../ui/primitives/Dialog'
import type { Notice } from './messages'

const img = (id: string): ImageRecord => ({
  id,
  name: `${id}.jpg`,
  imageGroupId: null,
  width: 100,
  height: 80,
  mimeType: 'image/jpeg',
  byteSize: 1,
  fingerprint: `fp-${id}`,
  source: { kind: 'local' },
  addedAt: '2026-01-01T00:00:00.000Z',
})

const baseProject = (): Project => ({
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

/** Repository whose session keeps a saved state and a real in-memory version history. */
function mockRepo() {
  const control = { failVersions: false }
  const stored = { project: baseProject(), docs: new Map<string, ImageAnnotations>() }
  const order: string[] = []
  const history = createMemoryHistory({
    read: () => ({ project: stored.project, docs: [...stored.docs.values()] }),
    write(p, docs) {
      stored.project = structuredClone(p)
      stored.docs = new Map(docs.map((d) => [d.imageId, structuredClone(d)]))
    },
    now: () => new Date().toISOString(),
    failCreate: () => (control.failVersions ? new LocalStorageError('quota', 'Could not save a version: browser storage is full.') : undefined),
  })
  const session = {
    projectId: 'p1',
    get opened() {
      return { project: structuredClone(stored.project), annotations: structuredClone(stored.docs) }
    },
    closed: false,
    save: vi.fn(async (p: Project, docs: ImageAnnotations[]) => {
      order.push('save')
      stored.project = structuredClone(p)
      for (const d of docs) stored.docs.set(d.imageId, structuredClone(d))
    }),
    onUpdated: () => () => {},
    history: {
      ...history,
      create: vi.fn(async (...args: Parameters<typeof history.create>) => {
        order.push(`version:${args[0]}`)
        return history.create(...args)
      }),
    },
    images: { import: vi.fn(), importFromDrive: vi.fn(), blob: vi.fn(async () => new Blob()) },
    exportZip: vi.fn(),
    exportCsv: vi.fn(),
    drive: {
      link: vi.fn(),
      push: vi.fn(async () => {}),
      takeRemote: vi.fn(async () => {
        order.push('takeRemote')
        return { project: { ...structuredClone(stored.project), name: 'Drive version' }, annotations: new Map() }
      }),
    },
    close() {},
  } as unknown as ProjectSession
  const repo: ProjectRepository = {
    getStatus: () => ({ state: 'saved-local', at: '' }),
    getDriveState: () => ({ state: 'connected', expiresAt: Date.now() + 1e6 }),
    subscribe: () => () => {},
    list: async () => [{ id: 'p1', name: 'Plates', updatedAt: '1', imageCount: 2, storage: 'local' }],
    open: vi.fn(async () => session),
    create: vi.fn(),
    importArchive: vi.fn(),
    openFromDrive: vi.fn(),
    delete: vi.fn(),
    connectDrive: vi.fn(async () => {}),
    disconnectDrive: vi.fn(),
  }
  return { repo, session, stored, history, control, order }
}

/** Scripted dialogs: each call takes the next answer (default: confirm / first choice). */
function scriptedDialogs(answers: unknown[] = []) {
  const asked: { kind: string; opts: ConfirmOptions | ChooseOptions }[] = []
  const dialogs: Dialogs = {
    async confirm(opts) {
      asked.push({ kind: 'confirm', opts })
      return (answers.length ? answers.shift() : true) as boolean
    },
    async prompt() {
      return null
    },
    async choose<T extends string>(opts: ChooseOptions<T>) {
      asked.push({ kind: 'choose', opts: opts as ChooseOptions })
      return (answers.length ? answers.shift() : opts.value) as T | null
    },
  }
  return { dialogs, asked }
}

async function setup(opts: { answers?: unknown[]; versions?: { periodicMs?: number; checkMs?: number } } = {}) {
  const notices: Notice[] = []
  const m = mockRepo()
  const editor = createEditor(m.repo, { notify: (n) => notices.push(n), confirm: async () => true, autosaveDelay: 5, versions: opts.versions })
  await editor.projects.init()
  const { dialogs, asked } = scriptedDialogs(opts.answers)
  const actions = createProjectActions(editor, dialogs, (n) => notices.push(n))
  const group = () => editor.groups.list()[0]
  const mark = (imageId: string, n: number) => {
    editor.images.select(imageId)
    for (let i = 0; i < n; i++) editor.annotations.add(i, i)
  }
  return { ...m, editor, notices, actions, asked, group, mark }
}

const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms))

describe('version history in the editor', () => {
  it('saves a version of the state as opened before the first change, then periodically while editing', async () => {
    const { editor, history, mark } = await setup({ versions: { periodicMs: 40, checkMs: 10 } })
    mark('i1', 2)
    await editor.projects.flush()
    await wait(5)
    const starts = history.entries.filter((e) => e.info.reason === 'session-start')
    expect(starts).toHaveLength(1)
    expect(starts[0].info.counts.annotations).toBe(0) // the state before the first change
    mark('i1', 1)
    await editor.projects.flush()
    await wait(120)
    const periodic = history.entries.filter((e) => e.info.reason === 'periodic')
    expect(periodic.length).toBeGreaterThanOrEqual(1)
    expect(periodic.at(-1)!.info.counts.annotations).toBe(3)
    // No changes since: no further automatic versions.
    const n = history.entries.length
    await wait(120)
    expect(history.entries.length).toBe(n)
    editor.dispose()
  })

  it('beforeDestructive saves pending edits first and returns the version', async () => {
    const { editor, mark, order } = await setup()
    mark('i1', 3)
    const outcome = await editor.versions.beforeDestructive('Before something')
    expect(outcome).toMatchObject({ ok: true, version: { reason: 'before-destructive', label: 'Before something', counts: { annotations: 3 } } })
    expect(order.lastIndexOf('save')).toBeLessThan(order.lastIndexOf('version:before-destructive'))
    expect(editor.state.busy).toBeNull()
  })

  it('clearing a group on all images asks twice, saves a version first and says so', async () => {
    const { editor, actions, asked, notices, group, mark, order, history } = await setup({ answers: ['project', true] })
    mark('i1', 3)
    mark('i2', 2)
    await actions.clearGroupAnnotations(group().id)
    expect(asked.map((a) => a.kind)).toEqual(['choose', 'confirm'])
    expect(asked[1].opts.title).toBe('Clear 5 annotations on 2 images?')
    expect((asked[1].opts as ConfirmOptions).body).toMatch(/3 manual|5 manual/)
    // Version first (with all 5 marks), then the clear.
    const version = history.entries.find((e) => e.info.reason === 'before-destructive')!
    expect(version.info).toMatchObject({ label: `Before clearing “Colonies” on all images`, counts: { annotations: 5 } })
    expect(order.indexOf('version:before-destructive')).toBeGreaterThan(-1)
    expect(editor.images.confirmedCount('i1') + editor.images.confirmedCount('i2')).toBe(0)
    const toast = notices.find((n) => n.key === 'clear-group')!
    expect(toast.detail).toBe('A version was saved — restore it from Version history.')
    expect(toast.action?.label).toBe('Version history')
    toast.action!.run()
    expect(actions.versionHistoryOpen()).toBe(true)
  })

  it('refuses to clear all images when the version cannot be saved, unless the user insists', async () => {
    const { editor, actions, asked, group, mark, control } = await setup({ answers: ['project', true, false] })
    mark('i1', 3)
    control.failVersions = true
    await actions.clearGroupAnnotations(group().id)
    expect(asked.map((a) => a.kind)).toEqual(['choose', 'confirm', 'confirm'])
    expect(asked[2].opts).toMatchObject({ title: 'Couldn’t save a version first', confirmLabel: 'Clear anyway', danger: true })
    expect((asked[2].opts as ConfirmOptions).body).toMatch(/storage is full.*Nothing was changed/)
    expect(editor.images.confirmedCount('i1')).toBe(3) // refused

    const second = scriptedDialogs(['project', true, true])
    const insist = createProjectActions(editor, second.dialogs, () => {})
    await insist.clearGroupAnnotations(group().id)
    expect(editor.images.confirmedCount('i1')).toBe(0) // "Clear anyway"
  })

  it('cancelling the second step clears nothing and saves no version', async () => {
    const { editor, actions, group, mark, history } = await setup({ answers: ['project', false] })
    mark('i1', 2)
    await actions.clearGroupAnnotations(group().id)
    expect(editor.images.confirmedCount('i1')).toBe(2)
    expect(history.entries.some((e) => e.info.reason === 'before-destructive')).toBe(false)
  })

  it('restores a version after clearing all images, persists it and can undo the restore', async () => {
    const { editor, actions, group, mark, notices, stored } = await setup({ answers: ['project', true] })
    mark('i1', 3)
    mark('i2', 2)
    await actions.clearGroupAnnotations(group().id)
    await editor.projects.flush()
    const versions = await editor.versions.list()
    const pre = versions.find((v) => v.reason === 'before-destructive')!
    expect(await editor.versions.restore(pre.id)).toBe(true)
    expect(editor.images.confirmedCount('i1')).toBe(3)
    expect(editor.images.confirmedCount('i2')).toBe(2)
    expect(stored.docs.get('i1')!.annotations).toHaveLength(3) // saved by storage
    const listed = await editor.versions.list()
    expect(listed[0]).toMatchObject({ reason: 'before-restore', counts: { annotations: 0 } })
    const toast = notices.find((n) => n.message === 'Version restored')!
    expect(toast.action?.label).toBe('Undo restore')
    toast.action!.run()
    await wait()
    expect(editor.images.confirmedCount('i1')).toBe(0)
  })

  it('restores only one image as an undoable step', async () => {
    const { editor, mark } = await setup()
    mark('i1', 3)
    mark('i2', 2)
    const { version } = (await editor.versions.beforeDestructive('Before')) as { version: { id: string } }
    mark('i1', 1)
    editor.images.select('i2')
    editor.annotations.undo()
    editor.annotations.undo()
    expect(editor.images.confirmedCount('i1')).toBe(4)
    expect(await editor.versions.restoreImage(version.id, 'i2')).toBe(true)
    expect(editor.images.confirmedCount('i2')).toBe(2)
    expect(editor.images.confirmedCount('i1')).toBe(4) // other images untouched
    editor.images.select('i2')
    expect(editor.annotations.undo()).toBe(true)
    expect(editor.images.confirmedCount('i2')).toBe(0)
  })

  it('refuses a per-image restore whose marks belong to a deleted group', async () => {
    const { editor, mark, notices } = await setup()
    const extra = editor.groups.create('Small')!
    mark('i1', 2) // in "Small" (now active)
    const { version } = (await editor.versions.beforeDestructive('Before')) as { version: { id: string } }
    editor.groups.remove(extra)
    expect(await editor.versions.restoreImage(version.id, 'i1')).toBe(false)
    expect(notices.at(-1)!.detail).toMatch(/“Small”, which was deleted since/)
  })

  it('takes a version before loading the Drive version and before deleting a group', async () => {
    const { editor, actions, mark, order, history } = await setup({ answers: [true] })
    mark('i1', 2)
    await editor.drive.takeRemote()
    expect(order.indexOf('version:before-destructive')).toBeLessThan(order.indexOf('takeRemote'))
    expect(history.entries.at(-1)!.info.label).toBe('Before loading the Drive version')
    const g = editor.groups.create('Extra')!
    mark('i2', 1)
    await actions.deleteAnnotationGroup(g)
    expect(history.entries.at(-1)!.info.label).toBe('Before deleting the group “Extra”')
    expect(editor.groups.byId(g)).toBeUndefined()
  })

  it('a failing automatic version warns once and never blocks editing', async () => {
    const { editor, mark, control, notices } = await setup({ versions: { periodicMs: 20, checkMs: 5 } })
    control.failVersions = true
    mark('i1', 1)
    await wait(60)
    mark('i1', 1)
    await wait(60)
    await editor.projects.flush()
    expect(editor.images.confirmedCount('i1')).toBe(2)
    expect(notices.filter((n) => n.key === 'version-warning')).toHaveLength(1)
  })
})
