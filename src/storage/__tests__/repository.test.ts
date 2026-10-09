import { beforeEach, describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import type { Project } from '../../model/types'
import type { ProjectRepository } from '../api'
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

describe('repository: local working copy', () => {
  let d: Device
  beforeEach(() => {
    d = device(new FakeDrive())
  })

  it('creates, saves, lists and reopens projects', async () => {
    const { project } = await d.repo.createProject('  Plates ')
    expect(project.name).toBe('Plates')
    expect(d.repo.status().state).toBe('saved-local')
    const { added } = await d.repo.importImageFiles(project, [pngFile()])
    const p: Project = { ...project, images: added, annotationGroups: [{ id: 'g1', name: 'Main', color: '#f00', render: 'dot', opacity: 1, size: 5, labels: false, labelSize: 12, hidden: false, locked: false }] }
    await d.repo.saveLocal(p, [doc(p, added[0].id, [annotation('a1', 'g1')])])
    const list = await d.repo.listProjects()
    expect(list).toMatchObject([{ id: p.id, name: 'Plates', imageCount: 1, storage: 'local' }])
    const reopened = await d.repo.openProject(p.id)
    expect(reopened.project.revision).toBe(2)
    expect(reopened.annotations.get(added[0].id)!.annotations).toHaveLength(1)
    const blob = await d.repo.getImageBlob(reopened.project, added[0].id)
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(PNG_1x1)
  })

  it('imports several files and rejects unsupported ones with reasons', async () => {
    const { project } = await d.repo.createProject('P')
    const tiff = new File([new Uint8Array([0x49, 0x49, 0x2a, 0, 0, 0])], 'scan.tif')
    const text = new File(['hello'], 'notes.txt')
    const r = await d.repo.importImageFiles(project, [pngFile('a.png'), tiff, pngFile('b.png'), text])
    expect(r.added.map((i) => i.name)).toEqual(['a.png', 'b.png'])
    expect(r.added[0]).toMatchObject({ width: 640, height: 480, mimeType: 'image/png', source: { kind: 'local' } })
    expect(r.rejected.map((x) => x.name)).toEqual(['scan.tif', 'notes.txt'])
    expect(r.rejected[0].reason).toMatch(/TIFF/)
  })

  it('surfaces IndexedDB failures as local-error and recovers', async () => {
    const { project } = await d.repo.createProject('P')
    const original = d.local.saveProject.bind(d.local)
    d.local.saveProject = async () => {
      const { toLocalError } = await import('../errors')
      throw toLocalError(new DOMException('full', 'QuotaExceededError'), 'save the project in this browser')
    }
    await expect(d.repo.saveLocal(project, [])).rejects.toThrow(/storage is full/)
    expect(d.repo.status()).toMatchObject({ state: 'local-error' })
    d.local.saveProject = original
    await d.repo.saveLocal(project, [])
    expect(d.repo.status().state).toBe('saved-local')
  })

  it('reports unavailable IndexedDB instead of failing silently', async () => {
    const repo = createRepository({ env: {}, indexedDB: undefined as unknown as IDBFactory })
    expect(repo.drive().state).toBe('unconfigured')
    // globalThis.indexedDB is undefined in node, so storage is unavailable
    await expect(repo.listProjects()).rejects.toThrow(/IndexedDB/)
    expect(repo.status().state).toBe('local-error')
  })

  it('exports and re-imports an archive, giving a new ID on collision', async () => {
    const { project } = await d.repo.createProject('P')
    const { added } = await d.repo.importImageFiles(project, [pngFile()])
    const p = { ...project, images: added }
    await d.repo.saveLocal(p, [doc(p, added[0].id, [annotation('a1', 'g1'), annotation('a2', 'g1', { origin: 'automated', reviewStatus: 'unreviewed', lastEditSource: 'automated' })])])
    const zip = await d.repo.exportArchive(p.id)
    const imported = await d.repo.importArchive(new File([zip], 'p.zip'))
    expect(imported.project.id).not.toBe(p.id)
    expect(imported.warnings?.join(' ')).toMatch(/separate copy/)
    expect(imported.annotations.get(added[0].id)!.projectId).toBe(imported.project.id)
    expect(imported.annotations.get(added[0].id)!.annotations[1].origin).toBe('automated')
    const blob = await d.repo.getImageBlob(imported.project, added[0].id)
    expect(blob.size).toBe(PNG_1x1.length)

    const other = device(new FakeDrive())
    const fresh = await other.repo.importArchive(new File([zip], 'p.zip'))
    expect(fresh.project.id).toBe(p.id)

    const csv = await (await d.repo.exportSummaryCsv(p.id)).text()
    expect(csv.split('\r\n')[1]).toContain(',1,1,0,1,') // confirmed, manual, accepted automated, unreviewed
  })

  it('keeps storage-owned fields when the editor saves a stale copy', async () => {
    const { project } = await d.repo.createProject('P')
    await d.local.saveProject({ ...project, storage: { kind: 'drive', folderId: 'F', folderName: 'F', files: { annotations: {} }, remoteVersions: {} } })
    await d.repo.saveLocal({ ...project, name: 'Renamed' }, [])
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

  async function linkedProject(dev: Device) {
    const { project } = await dev.repo.createProject('Plates')
    const { added } = await dev.repo.importImageFiles(project, [pngFile('p1.png')])
    const p = { ...project, images: added }
    await dev.repo.saveLocal(p, [doc(p, added[0].id, [annotation('a1', 'g1')])])
    const linked = await dev.repo.linkProjectToDrive(p.id, 'create-folder')
    return linked
  }

  beforeEach(() => {
    drive = new FakeDrive()
    a = device(drive)
  })

  it('links a project to a new folder, uploads it and reports saved-drive', async () => {
    const updates: Project[] = []
    a.repo.onProjectUpdated((p) => updates.push(p))
    const linked = await linkedProject(a)
    expect(a.repo.drive()).toMatchObject({ state: 'connected', account: 'tester@example.com' })
    expect(linked.warnings).toBeUndefined()
    expect(linked.project.storage.kind).toBe('drive')
    expect(linked.project.images[0].source.kind).toBe('drive')
    expect(a.repo.status().state).toBe('saved-drive')
    expect(updates.length).toBeGreaterThan(0)
    const folder = drive.findByName('root', 'Plates')!
    expect(drive.childrenOf(folder.id).map((f) => f.name).sort()).toEqual(['annotations', 'images', 'project.json', 'summary.csv'])
  })

  it('auto-saves after local edits when connected (debounced)', async () => {
    const { project, annotations } = await linkedProject(a)
    const imageId = project.images[0].id
    const d2 = { ...annotations.get(imageId)!, annotations: [annotation('a1', 'g1'), annotation('a2', 'g1')] }
    await a.repo.saveLocal(project, [d2])
    expect(a.repo.status().state).toBe('pending')
    expect(a.timers.pending).toHaveLength(1)
    await a.timers.runAll()
    expect(a.repo.status().state).toBe('saved-drive')
    const annId = (await a.local.getProject(project.id))!.storage
    const fid = annId.kind === 'drive' ? annId.files.annotations[imageId] : ''
    expect(JSON.parse(drive.text(fid)).annotations).toHaveLength(2)
  })

  it('needs reconnect after the token expires, without losing local edits', async () => {
    const { project, annotations } = await linkedProject(a)
    a.session.expire()
    expect(a.repo.drive().state).toBe('expired')
    const imageId = project.images[0].id
    await a.repo.saveLocal(project, [{ ...annotations.get(imageId)!, annotations: [] }])
    expect(a.repo.status().state).toBe('reconnect-required')
    expect((await a.repo.openProject(project.id)).annotations.get(imageId)!.annotations).toHaveLength(0)
    await a.repo.connectDrive()
    await a.timers.runAll()
    expect(a.repo.status().state).toBe('saved-drive')
  })

  it('stops on remote conflicts; takeRemote keeps a local backup', async () => {
    const { project, annotations } = await linkedProject(a)
    const link = (await a.local.getProject(project.id))!.storage
    if (link.kind !== 'drive') throw new Error('not linked')
    // Another device rewrites project.json with a renamed project.
    const remote = JSON.parse(drive.text(link.files.projectJson!))
    drive.externalEdit(link.files.projectJson!, JSON.stringify({ ...remote, name: 'Renamed elsewhere' }))

    const imageId = project.images[0].id
    await a.repo.saveLocal(project, [{ ...annotations.get(imageId)!, annotations: [annotation('mine', 'g1')] }])
    await a.repo.saveToDrive(project.id)
    expect(a.repo.status()).toEqual({ state: 'conflict', files: ['project.json'] })
    expect(JSON.parse(drive.text(link.files.projectJson!)).name).toBe('Renamed elsewhere')

    const taken = await a.repo.takeRemote(project.id)
    expect(taken.project.name).toBe('Renamed elsewhere')
    expect(taken.project.id).toBe(project.id)
    const all = await a.repo.listProjects()
    const backup = all.find((p) => p.id !== project.id)!
    expect(backup.name).toMatch(/local copy/)
    expect(backup.storage).toBe('local')
    const backupOpened = await a.repo.openProject(backup.id)
    expect(backupOpened.annotations.get(imageId)!.annotations[0].id).toBe('mine')
  })

  it('overwrite resolves a conflict in favour of local', async () => {
    const { project } = await linkedProject(a)
    const link = (await a.local.getProject(project.id))!.storage
    if (link.kind !== 'drive') throw new Error('not linked')
    drive.externalEdit(link.files.projectJson!, '{}')
    await a.repo.saveToDrive(project.id)
    expect(a.repo.status().state).toBe('conflict')
    await a.repo.saveToDrive(project.id, { overwrite: true })
    expect(a.repo.status().state).toBe('saved-drive')
    expect(JSON.parse(drive.text(link.files.projectJson!)).id).toBe(project.id)
  })

  it('reopens the project on another device from the Drive folder', async () => {
    const { project } = await linkedProject(a)
    const folder = drive.findByName('root', 'Plates')!
    const b = device(drive)
    b.picker.folders.push({ id: folder.id, name: folder.name, mimeType: folder.mimeType })
    const opened = await b.repo.openProjectFromDrive()
    expect(opened.project.id).toBe(project.id)
    expect(opened.annotations.get(project.images[0].id)!.annotations).toHaveLength(1)
    expect(b.repo.status().state).toBe('saved-drive')
    const blob = await b.repo.getImageBlob(opened.project, project.images[0].id)
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(PNG_1x1)
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
    const opened = await b.repo.openProjectFromDrive()
    expect(b.picker.requests).toHaveLength(2)
    expect(opened.project.id).toBe(project.id)
    expect(opened.annotations.size).toBe(1)
    expect(opened.warnings).toBeUndefined()
    // Device b edits and saves: same files updated, no duplicate folders or docs.
    const before = drive.files.size
    const imageId = project.images[0].id
    await b.repo.saveLocal(opened.project, [{ ...opened.annotations.get(imageId)!, annotations: [] }])
    await b.repo.saveToDrive(opened.project.id)
    expect(b.repo.status().state).toBe('saved-drive')
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
    const opened = await a.repo.openProjectFromDrive()
    expect(opened.project.name).toBe('Experiment 7')
    expect(opened.project.images.map((i) => i.source.kind === 'drive' && i.source.fileId)).toEqual([img1, img2])
    expect(a.repo.status().state).toBe('pending')
    await a.timers.runAll()
    expect(a.repo.status().state).toBe('saved-drive')
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
    const opened = await b.repo.openProjectFromDrive()
    const flagged = opened.project.images[0]
    expect(flagged.sourceMismatch?.message).toMatch(/replaced/)
  })

  it('reports Drive as unconfigured but keeps working locally', async () => {
    const repo = createProjectRepository({ local: new LocalStore(new IDBFactory()), decoder: fakeDecoder, session: new DriveSession(null), drive: null })
    expect(repo.drive().state).toBe('unconfigured')
    await expect(repo.connectDrive()).rejects.toMatchObject({ kind: 'unconfigured' })
    const { project } = await repo.createProject('Offline')
    expect(project.storage.kind).toBe('local')
  })
})
