import { beforeEach, describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import type { Project } from '../../model/types'
import type { ProjectRepository, ProjectSession } from '../api'
import { createProjectRepository } from '../repository'
import { LocalStore } from '../localStore'
import { DriveSession } from '../drive/session'
import type { Timers } from '../drive/autosave'
import { createRepository } from '../index'
import { annotation, doc, FakeDrive, FakePicker, FakeTokenProvider, fakeDecoder, PNG_1x1 } from './fakes'

const pngFile = (name = 'plate.png') => new File([PNG_1x1 as BlobPart], name, { type: 'image/png' })
const flush = () => new Promise((r) => setTimeout(r, 0))

class ManualTimers implements Timers {
  pending: { fn: () => void; ms: number }[] = []
  setTimeout(fn: () => void, ms: number) {
    const h = { fn, ms }
    this.pending.push(h)
    return h
  }
  clearTimeout(h: unknown) {
    const i = this.pending.indexOf(h as never)
    if (i >= 0) this.pending.splice(i, 1)
  }
  async runAll() {
    const due = this.pending.splice(0)
    for (const h of due) h.fn()
    for (let i = 0; i < 20; i++) await flush()
  }
}

interface Device {
  repo: ProjectRepository
  local: LocalStore
  session: DriveSession
  picker: FakePicker
  timers: ManualTimers
}

function device(drive: FakeDrive, opts: { local?: LocalStore } = {}): Device {
  const local = opts.local ?? new LocalStore(new IDBFactory())
  const session = new DriveSession(new FakeTokenProvider())
  const picker = new FakePicker(drive)
  const timers = new ManualTimers()
  const repo = createProjectRepository({
    local,
    decoder: fakeDecoder,
    session,
    drive: { client: drive, picker },
    timers,
    requestPersistence: async () => true,
  })
  return { repo, local, session, picker, timers }
}

const groupG1 = { id: 'g1', name: 'Main', color: '#f00', render: 'dot' as const, opacity: 1, size: 5, labels: false, labelSize: 12, hidden: false, locked: false }
const driveFilesOf = async (dev: Device, projectId: string) => (await dev.local.getSync(projectId)).drive!

describe('repository: local working copy', () => {
  let d: Device
  beforeEach(() => {
    d = device(new FakeDrive())
  })

  it('creates, saves, lists and reopens projects', async () => {
    const s = await d.repo.create('  Plates ')
    const project = s.opened.project
    expect(project.name).toBe('Plates')
    expect(d.repo.getStatus().state).toBe('saved-local')
    const { added } = await s.images.import([pngFile()])
    const p: Project = { ...project, images: added, annotationGroups: [groupG1] }
    await s.save(p, [doc(p, added[0].id, [annotation('a1', 'g1')])])
    const list = await d.repo.list()
    expect(list).toMatchObject([{ id: p.id, name: 'Plates', imageCount: 1, storage: 'local' }])
    const reopened = await d.repo.open(p.id)
    expect(s.closed).toBe(true)
    expect(reopened.opened.project.revision).toBe(2)
    expect(reopened.opened.annotations.get(added[0].id)!.annotations).toHaveLength(1)
    const blob = await reopened.images.blob(added[0].id)
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(PNG_1x1)
  })

  it('rejects calls on a session that another session replaced', async () => {
    const a1 = await d.repo.create('A')
    await d.repo.create('B')
    await expect(a1.save(a1.opened.project, [])).rejects.toThrow(/closed/)
  })

  it('notifies subscribers of status changes (framework-free contract)', async () => {
    const seen: string[] = []
    const off = d.repo.subscribe(() => seen.push(d.repo.getStatus().state))
    await d.repo.create('P')
    off()
    expect(seen).toContain('saved-local')
  })

  it('imports several files and rejects unsupported ones with reasons', async () => {
    const s = await d.repo.create('P')
    const tiff = new File([new Uint8Array([0x49, 0x49, 0x2a, 0, 0, 0])], 'scan.tif')
    const text = new File(['hello'], 'notes.txt')
    const r = await s.images.import([pngFile('a.png'), tiff, pngFile('b.png'), text])
    expect(r.added.map((i) => i.name)).toEqual(['a.png', 'b.png'])
    expect(r.added[0]).toMatchObject({ width: 640, height: 480, mimeType: 'image/png', source: { kind: 'local' } })
    expect(r.rejected.map((x) => x.name)).toEqual(['scan.tif', 'notes.txt'])
    expect(r.rejected[0].reason).toMatch(/TIFF/)
  })

  it('surfaces IndexedDB failures as local-error and recovers', async () => {
    const s = await d.repo.create('P')
    const original = d.local.saveProject.bind(d.local)
    d.local.saveProject = async () => {
      const { toLocalError } = await import('../errors')
      throw toLocalError(new DOMException('full', 'QuotaExceededError'), 'save the project in this browser')
    }
    await expect(s.save(s.opened.project, [])).rejects.toThrow(/storage is full/)
    expect(d.repo.getStatus()).toMatchObject({ state: 'local-error' })
    d.local.saveProject = original
    await s.save(s.opened.project, [])
    expect(d.repo.getStatus().state).toBe('saved-local')
  })

  it('reports unavailable IndexedDB instead of failing silently', async () => {
    const repo = createRepository({ env: {}, indexedDB: undefined as unknown as IDBFactory })
    expect(repo.getDriveState().state).toBe('unconfigured')
    // globalThis.indexedDB is undefined in node, so storage is unavailable
    await expect(repo.list()).rejects.toThrow(/IndexedDB/)
    expect(repo.getStatus().state).toBe('local-error')
  })

  it('exports and re-imports an archive, giving a new ID on collision', async () => {
    const s = await d.repo.create('P')
    const { added } = await s.images.import([pngFile()])
    const p = { ...s.opened.project, images: added }
    await s.save(p, [doc(p, added[0].id, [annotation('a1', 'g1'), annotation('a2', 'g1', { origin: 'automated', reviewStatus: 'unreviewed', lastEditSource: 'automated' })])])
    const zip = await s.exportZip()
    const csv = await (await s.exportCsv()).text()
    expect(csv.split('\r\n')[1]).toContain(',1,1,0,1,') // confirmed, manual, accepted automated, unreviewed
    const imported = await d.repo.importArchive(new File([zip], 'p.zip'))
    expect(imported.opened.project.id).not.toBe(p.id)
    expect(imported.opened.warnings?.join(' ')).toMatch(/separate copy/)
    expect(imported.opened.annotations.get(added[0].id)!.projectId).toBe(imported.projectId)
    expect(imported.opened.annotations.get(added[0].id)!.annotations[1].origin).toBe('automated')
    const blob = await imported.images.blob(added[0].id)
    expect(blob.size).toBe(PNG_1x1.length)

    const other = device(new FakeDrive())
    const fresh = await other.repo.importArchive(new File([zip], 'p.zip'))
    expect(fresh.projectId).toBe(p.id)
  })

  it('deleting a project while a save is in flight does not resurrect it', async () => {
    const s = await d.repo.create('Doomed')
    const p = s.opened.project
    const save = s.save({ ...p, name: 'Renamed' }, []).catch((e: unknown) => e)
    await d.repo.delete(p.id)
    await save
    expect(await d.local.getProject(p.id)).toBeUndefined()
    expect(await d.repo.list()).toEqual([])
  })

  it('keeps storage-owned fields when the editor saves a stale copy', async () => {
    const s = await d.repo.create('P')
    const project = s.opened.project
    await d.local.saveProject({ ...project, storage: { kind: 'drive', folderId: 'F', folderName: 'F' } })
    await s.save({ ...project, name: 'Renamed' }, [])
    const stored = await d.local.getProject(project.id)
    expect(stored!.name).toBe('Renamed')
    expect(stored!.storage.kind).toBe('drive')
  })
})

describe('LocalStore connection lifecycle', () => {
  it('reopens lazily after another tab forces the connection closed (versionchange)', async () => {
    const factory = new IDBFactory()
    const store = new LocalStore(factory, 'lifecycle-test')
    expect(await store.listProjects()).toEqual([])
    // Deleting the database fires versionchange on our open connection; we must close and forget it.
    await new Promise<void>((resolve, reject) => {
      const req = factory.deleteDatabase('lifecycle-test')
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
      req.onblocked = () => reject(new Error('blocked: connection was not closed'))
    })
    expect(await store.listProjects()).toEqual([])
  })
})

describe('repository: Google Drive', () => {
  let drive: FakeDrive
  let a: Device

  async function linkedProject(dev: Device): Promise<{ s: ProjectSession; project: Project; updates: Project[] }> {
    const s = await dev.repo.create('Plates')
    const updates: Project[] = []
    s.onUpdated((p) => updates.push(p))
    const { added } = await s.images.import([pngFile('p1.png')])
    const p = { ...s.opened.project, images: added }
    await s.save(p, [doc(p, added[0].id, [annotation('a1', 'g1')])])
    const { warnings } = await s.drive.link('create-folder')
    expect(warnings).toEqual([])
    return { s, project: await dev.local.requireProject(p.id), updates }
  }

  beforeEach(() => {
    drive = new FakeDrive()
    a = device(drive)
  })

  it('links a project to a new folder, uploads it and reports storage-owned changes (no reload)', async () => {
    const { project, updates } = await linkedProject(a)
    expect(a.repo.getDriveState()).toMatchObject({ state: 'connected', account: 'tester@example.com' })
    expect(project.storage).toEqual({ kind: 'drive', folderId: expect.any(String), folderName: 'Plates', account: 'tester@example.com' })
    expect(project.images[0].source.kind).toBe('drive')
    expect(a.repo.getStatus().state).toBe('saved-drive')
    // The editor learns about the link and uploaded image sources through onUpdated.
    expect(updates.at(-1)!.storage.kind).toBe('drive')
    expect(updates.at(-1)!.images[0].source.kind).toBe('drive')
    const folder = drive.findByName('root', 'Plates')!
    expect(drive.childrenOf(folder.id).map((f) => f.name).sort()).toEqual(['annotations', 'images', 'project.json', 'summary.csv'])
  })

  it('auto-saves after local edits when connected (debounced)', async () => {
    const { s, project } = await linkedProject(a)
    const imageId = project.images[0].id
    const d2 = doc(project, imageId, [annotation('a1', 'g1'), annotation('a2', 'g1')])
    await s.save(project, [d2])
    expect(a.repo.getStatus().state).toBe('pending')
    expect(a.timers.pending).toHaveLength(1)
    await a.timers.runAll()
    expect(a.repo.getStatus().state).toBe('saved-drive')
    const fid = (await driveFilesOf(a, project.id)).annotations[imageId]
    expect(JSON.parse(drive.text(fid)).annotations).toHaveLength(2)
  })

  it('keeps an edit dirty when it lands while a push is reading what to upload (B6)', async () => {
    const { s, project } = await linkedProject(a)
    const imageId = project.images[0].id
    await s.save(project, [doc(project, imageId, [annotation('first', 'g1')])])
    // Hold the push between reading the annotation docs and reading the sync state,
    // save a newer edit in that gap, then let the push continue with the OLD docs.
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const realGetSync = a.local.getSync.bind(a.local)
    const realGetAnnotations = a.local.getAnnotations.bind(a.local)
    let armed = false
    a.local.getAnnotations = async (id) => {
      const r = await realGetAnnotations(id)
      armed = true
      return r
    }
    a.local.getSync = async (id) => {
      if (armed) {
        armed = false
        await gate
      }
      return realGetSync(id)
    }
    const pushing = s.drive.push()
    for (let i = 0; i < 10; i++) await flush()
    a.local.getAnnotations = realGetAnnotations
    await s.save(project, [doc(project, imageId, [annotation('late', 'g1')])])
    release()
    await pushing
    a.local.getSync = realGetSync
    // The upload contained the old doc, so the late edit must still be marked dirty.
    expect((await a.local.getSync(project.id)).dirtyImages).toContain(imageId)
  })

  it('needs reconnect after the token expires, without losing local edits', async () => {
    const { s, project } = await linkedProject(a)
    a.session.expire()
    expect(a.repo.getDriveState().state).toBe('expired')
    const imageId = project.images[0].id
    await s.save(project, [doc(project, imageId, [])])
    expect(a.repo.getStatus().state).toBe('reconnect-required')
    expect((await a.repo.open(project.id)).opened.annotations.get(imageId)!.annotations).toHaveLength(0)
    await a.repo.connectDrive()
    await a.timers.runAll()
    expect(a.repo.getStatus().state).toBe('saved-drive')
  })

  it('stops on remote conflicts; takeRemote keeps a local backup', async () => {
    const { s, project } = await linkedProject(a)
    const files = await driveFilesOf(a, project.id)
    // Another device rewrites project.json with a renamed project.
    const remote = JSON.parse(drive.text(files.projectJson!))
    drive.externalEdit(files.projectJson!, JSON.stringify({ ...remote, name: 'Renamed elsewhere' }))

    const imageId = project.images[0].id
    await s.save(project, [doc(project, imageId, [annotation('mine', 'g1')])])
    await s.drive.push()
    expect(a.repo.getStatus()).toEqual({ state: 'conflict', files: ['project.json'] })
    expect(JSON.parse(drive.text(files.projectJson!)).name).toBe('Renamed elsewhere')

    const taken = await s.drive.takeRemote()
    expect(taken.project.name).toBe('Renamed elsewhere')
    expect(taken.project.id).toBe(project.id)
    expect(a.repo.getStatus().state).toBe('saved-drive')
    const all = await a.repo.list()
    const backup = all.find((p) => p.id !== project.id)!
    expect(backup.name).toMatch(/local copy/)
    expect(backup.storage).toBe('local')
    const backupOpened = await a.repo.open(backup.id)
    expect(backupOpened.opened.annotations.get(imageId)!.annotations[0].id).toBe('mine')
  })

  it('overwrite resolves a conflict in favour of local', async () => {
    const { s, project } = await linkedProject(a)
    const files = await driveFilesOf(a, project.id)
    drive.externalEdit(files.projectJson!, '{}')
    await s.drive.push()
    expect(a.repo.getStatus().state).toBe('conflict')
    await s.drive.push({ overwrite: true })
    expect(a.repo.getStatus().state).toBe('saved-drive')
    expect(JSON.parse(drive.text(files.projectJson!)).id).toBe(project.id)
  })

  it('reopens the project on another device from the Drive folder', async () => {
    const { project } = await linkedProject(a)
    const folder = drive.findByName('root', 'Plates')!
    const b = device(drive)
    b.picker.folders.push({ id: folder.id, name: folder.name, mimeType: folder.mimeType })
    const opened = await b.repo.openFromDrive()
    expect(opened.projectId).toBe(project.id)
    expect(opened.opened.annotations.get(project.images[0].id)!.annotations).toHaveLength(1)
    expect(b.repo.getStatus().state).toBe('saved-drive')
    const blob = await opened.images.blob(project.images[0].id)
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(PNG_1x1)
  })

  it('a removed image (soft delete) keeps its Drive file, bytes and annotations and is not re-imported', async () => {
    const { s, project } = await linkedProject(a)
    const folder = drive.findByName('root', 'Plates')!
    const img = project.images[0]
    const fileId = img.source.kind === 'drive' ? img.source.fileId : ''
    const removedAt = '2026-02-01T00:00:00.000Z'
    await s.save({ ...project, images: project.images.map((i) => (i.id === img.id ? { ...i, deletedAt: removedAt } : i)) }, [])
    await s.drive.push()
    expect(drive.files.has(fileId)).toBe(true)
    expect(await a.local.getBlob(project.id, img.id)).toBeDefined()
    const b = device(drive)
    b.picker.folders.push({ id: folder.id, name: folder.name, mimeType: folder.mimeType })
    const opened = await b.repo.openFromDrive()
    expect(opened.opened.project.images.map((i) => [i.id, i.deletedAt])).toEqual(project.images.map((i) => [i.id, i.id === img.id ? removedAt : undefined]))
    expect(opened.opened.annotations.get(img.id)!.annotations).toHaveLength(1)
    expect(opened.opened.warnings ?? []).toEqual([])
    expect((await b.repo.list())[0].imageCount).toBe(project.images.length - 1)
  })

  it('asks the user to grant access to files it cannot see (drive.file), then reads them', async () => {
    const { project } = await linkedProject(a)
    const folder = drive.findByName('root', 'Plates')!
    // Simulate a second user: nothing in the folder is granted to the app yet.
    for (const id of drive.files.keys()) if (id !== 'root') drive.hidden.add(id)
    const b = device(drive)
    b.picker.folders.push({ id: folder.id, name: folder.name, mimeType: folder.mimeType })
    b.picker.fileAnswers.push((opts) => {
      expect(opts.parentId).toBe(folder.id)
      const pj = drive.findByName(folder.id, 'project.json')!
      return [{ id: pj.id, name: pj.name, mimeType: pj.mimeType }]
    })
    b.picker.fileAnswers.push((opts) => {
      expect(opts.fileIds!.length).toBeGreaterThan(0)
      return opts.fileIds!.map((id) => ({ id, name: id, mimeType: 'x' }))
    })
    const opened = await b.repo.openFromDrive()
    expect(b.picker.requests).toHaveLength(2)
    expect(opened.projectId).toBe(project.id)
    expect(opened.opened.annotations.size).toBe(1)
    expect(opened.opened.warnings).toBeUndefined()
    // Device b edits and saves: same files updated, no duplicate folders or docs.
    const before = drive.files.size
    const imageId = project.images[0].id
    await opened.save(opened.opened.project, [{ ...opened.opened.annotations.get(imageId)!, annotations: [] }])
    await opened.drive.push()
    expect(b.repo.getStatus().state).toBe('saved-drive')
    expect(drive.files.size).toBe(before)
  })

  it('opens a folder of images without project.json as a new project', async () => {
    const folder = drive.addFolder('Experiment 7')
    const img1 = drive.addFile('plate-1.png', folder, PNG_1x1, 'image/png')
    const img2 = drive.addFile('plate-2.png', folder, PNG_1x1, 'image/png')
    drive.hidden.add(img1)
    drive.hidden.add(img2)
    a.picker.folders.push({ id: folder, name: 'Experiment 7', mimeType: 'application/vnd.google-apps.folder' })
    a.picker.fileAnswers.push(() => [
      { id: img1, name: 'plate-1.png', mimeType: 'image/png' },
      { id: img2, name: 'plate-2.png', mimeType: 'image/png' },
    ])
    const opened = await a.repo.openFromDrive()
    expect(opened.opened.project.name).toBe('Experiment 7')
    expect(opened.opened.project.images.map((i) => i.source.kind === 'drive' && i.source.fileId)).toEqual([img1, img2])
    expect(a.repo.getStatus().state).toBe('pending')
    await a.timers.runAll()
    expect(a.repo.getStatus().state).toBe('saved-drive')
    expect(drive.findByName(folder, 'project.json')).toBeTruthy()
    // the original images are referenced in place, not copied
    expect(drive.findByName(folder, 'images')).toBeUndefined()
  })

  it('flags a replaced Drive image when its bytes are fetched', async () => {
    const { project } = await linkedProject(a)
    const folder = drive.findByName('root', 'Plates')!
    const img = project.images[0]
    const fileId = img.source.kind === 'drive' ? img.source.fileId : ''
    drive.externalEdit(fileId, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 1]))
    const b = device(drive)
    b.picker.folders.push({ id: folder.id, name: folder.name, mimeType: folder.mimeType })
    const opened = await b.repo.openFromDrive()
    const flagged = opened.opened.project.images[0]
    expect(flagged.sourceMismatch?.message).toMatch(/replaced/)
  })

  it('reports Drive as unconfigured but keeps working locally', async () => {
    const repo = createProjectRepository({ local: new LocalStore(new IDBFactory()), decoder: fakeDecoder, session: new DriveSession(null), drive: null })
    expect(repo.getDriveState().state).toBe('unconfigured')
    await expect(repo.connectDrive()).rejects.toMatchObject({ kind: 'unconfigured' })
    const s = await repo.create('Offline')
    expect(s.opened.project.storage.kind).toBe('local')
    await expect(s.drive.push()).rejects.toMatchObject({ kind: 'unconfigured' })
  })
})
