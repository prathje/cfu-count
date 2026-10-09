import { describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import type { Project } from '../../model/types'
import { createProjectRepository } from '../repository'
import { LocalStore, type VersionPart, type VersionRecord } from '../localStore'
import { LocalStorageError } from '../errors'
import { DriveSession } from '../drive/session'
import type { Timers } from '../drive/autosave'
import { annotation, doc, FakeDrive, FakePicker, FakeTokenProvider, fakeDecoder, group, PNG_1x1 } from './fakes'

const pngFile = (name = 'plate.png') => new File([PNG_1x1 as BlobPart], name, { type: 'image/png' })
const noTimers: Timers = { setTimeout: () => 0, clearTimeout: () => {} }

/** LocalStore whose next `failures` putVersion calls fail with a quota error. */
class QuotaStore extends LocalStore {
  failures = 0
  puts = 0
  override async putVersion(record: VersionRecord, parts: VersionPart[]) {
    this.puts++
    if (this.failures > 0) {
      this.failures--
      throw new LocalStorageError('quota', 'Could not save a version: browser storage is full.')
    }
    return super.putVersion(record, parts)
  }
}

function setup(opts: { clock?: { t: number }; local?: LocalStore; drive?: FakeDrive } = {}) {
  const local = opts.local ?? new LocalStore(new IDBFactory())
  const session = new DriveSession(new FakeTokenProvider())
  const drive = opts.drive ?? new FakeDrive()
  const clock = opts.clock
  const repo = createProjectRepository({
    local,
    decoder: fakeDecoder,
    session,
    drive: { client: drive, picker: new FakePicker(drive) },
    timers: noTimers,
    requestPersistence: async () => true,
    ...(clock ? { now: () => new Date(clock.t).toISOString() } : {}),
  })
  return { repo, local }
}

async function projectWithImages(repo: ReturnType<typeof setup>['repo'], n = 2) {
  const s = await repo.create('Plates')
  const { added } = await s.images.import(Array.from({ length: n }, (_, i) => pngFile(`p${i}.png`)))
  const p: Project = { ...s.opened.project, images: added, annotationGroups: [group('g1', 'Colonies'), group('g2', 'Small')] }
  return { s, p, ids: added.map((i) => i.id) }
}

const marks = (prefix: string, n: number, groupId = 'g1') => Array.from({ length: n }, (_, i) => annotation(`${prefix}${i}`, groupId))

describe('version history (IndexedDB)', () => {
  it('creates, lists, loads and restores a version (round trip)', async () => {
    const { repo, local } = setup()
    const { s, p, ids } = await projectWithImages(repo)
    await s.save(p, [doc(p, ids[0], marks('a', 5)), doc(p, ids[1], marks('b', 3, 'g2'))])

    const { version, created } = await s.history.create('before-destructive', 'Before clearing “Colonies” on all images')
    expect(created).toBe(true)
    expect(version).toMatchObject({
      reason: 'before-destructive',
      label: 'Before clearing “Colonies” on all images',
      counts: { annotations: 8, images: 2, groups: [{ name: 'Colonies', count: 5 }, { name: 'Small', count: 3 }] },
    })
    expect(version.storedBytes).toBeGreaterThan(0)

    // Destructive change: clear everything on both images.
    await s.save(p, [doc(p, ids[0], []), doc(p, ids[1], [])])
    expect((await s.history.list()).map((v) => v.id)).toEqual([version.id])

    const loaded = await s.history.load(version.id)
    expect(loaded.annotations.get(ids[0])!.annotations).toHaveLength(5)
    expect(loaded.project.annotationGroups.map((g) => g.name)).toEqual(['Colonies', 'Small'])

    const { snapshot, backup } = await s.history.restore(version.id)
    expect(backup).toMatchObject({ reason: 'before-restore', counts: { annotations: 0 } })
    expect(snapshot.annotations.get(ids[0])!.annotations).toHaveLength(5)
    // Persisted: a reopen sees the restored state, and the restore itself is reversible.
    const reopened = await repo.open(p.id)
    expect(reopened.opened.annotations.get(ids[1])!.annotations).toHaveLength(3)
    expect((await reopened.history.list()).map((v) => v.reason)).toEqual(['before-restore', 'before-destructive'])
    await reopened.history.restore(backup.id)
    const again = await local.getAnnotations(p.id)
    expect(again.every((d) => d.annotations.length === 0)).toBe(true)
  })

  it('stores unchanged documents once (dedupe by content) and skips unchanged automatic versions', async () => {
    const { repo, local } = setup()
    const { s, p, ids } = await projectWithImages(repo)
    await s.save(p, [doc(p, ids[0], marks('a', 200)), doc(p, ids[1], marks('b', 200))])
    const first = await s.history.create('periodic', 'Automatic')
    expect((await local.versionPartKeys(p.id)).size).toBe(3) // project + 2 docs

    // Nothing changed: an automatic version is skipped, a manual one is stored without new parts.
    expect((await s.history.create('periodic', 'Automatic')).created).toBe(false)
    const manual = await s.history.create('manual', 'Saved by you')
    expect(manual.created).toBe(true)
    expect(manual.version.storedBytes).toBe(0)

    // One image changes: only its document is stored again.
    await s.save(p, [doc(p, ids[0], marks('a', 201))])
    const second = await s.history.create('periodic', 'Automatic')
    expect((await local.versionPartKeys(p.id)).size).toBe(4)
    expect(second.version.storedBytes).toBeLessThan(first.version.storedBytes)
    expect(second.version.storedBytes).toBeGreaterThan(0)

    // Deleting a version frees only the parts no other version uses.
    await s.history.delete(second.version.id)
    expect((await local.versionPartKeys(p.id)).size).toBe(3)
    await s.history.delete(first.version.id)
    await s.history.delete(manual.version.id)
    expect((await local.versionPartKeys(p.id)).size).toBe(0)
  })

  it('compresses documents (~5x smaller than JSON)', async () => {
    const { repo, local } = setup()
    const { s, p, ids } = await projectWithImages(repo, 1)
    await s.save(p, [doc(p, ids[0], marks('a', 500).map((a, i) => ({ ...a, x: i * 1.37, y: i * 2.11 })))])
    await s.history.create('manual', 'Saved by you')
    const parts = await local.getVersionParts(p.id, [...(await local.versionPartKeys(p.id))])
    const docPart = [...parts.values()].sort((a, b) => b.rawBytes - a.rawBytes)[0]
    expect(docPart.rawBytes / docPart.data.length).toBeGreaterThan(4)
  })

  it('a version requested before a save captures the state before it (ordered with saves)', async () => {
    const { repo } = setup()
    const { s, p, ids } = await projectWithImages(repo)
    await s.save(p, [doc(p, ids[0], marks('a', 4))])
    const versionP = s.history.create('session-start', 'Start of session')
    const saveP = s.save(p, [doc(p, ids[0], [])])
    const [{ version }] = await Promise.all([versionP, saveP])
    expect(version.counts.annotations).toBe(4)
  })

  it('after a quota error, removes older automatic versions and retries with a warning', async () => {
    const local = new QuotaStore(new IDBFactory())
    const clock = { t: Date.parse('2026-10-09T08:00:00Z') }
    const { repo } = setup({ local, clock })
    const { s, p, ids } = await projectWithImages(repo)
    for (let i = 0; i < 8; i++) {
      clock.t += 60_000
      await s.save(p, [doc(p, ids[0], marks('a', i + 1))])
      await s.history.create('periodic', 'Automatic')
    }
    clock.t += 60_000
    await s.history.create('before-destructive', 'Before clearing')
    await s.save(p, [doc(p, ids[0], marks('a', 20))])
    local.failures = 1
    const result = await s.history.create('manual', 'Saved by you')
    expect(result.created).toBe(true)
    expect(result.warning).toMatch(/storage is nearly full/)
    const reasons = (await s.history.list()).map((v) => v.reason)
    expect(reasons.filter((r) => r === 'periodic').length).toBeLessThan(8)
    expect(reasons).toContain('before-destructive') // never sacrificed for space
    // Still failing after making room: rejects with a quota error, the save status is untouched.
    local.failures = 10
    await expect(s.history.create('manual', 'Saved by you')).rejects.toMatchObject({ code: 'quota' })
    expect(repo.getStatus().state).toBe('saved-local')
  })

  it('applies retention after each new version', async () => {
    const clock = { t: Date.parse('2026-09-01T08:00:00Z') }
    const { repo } = setup({ clock })
    const { s, p, ids } = await projectWithImages(repo, 1)
    // 40 days of one change and one automatic version every 6 hours.
    for (let i = 0; i < 160; i++) {
      clock.t += 6 * 3_600_000
      await s.save(p, [doc(p, ids[0], marks('a', i + 1))])
      await s.history.create('periodic', 'Automatic')
    }
    const list = await s.history.list()
    const oldest = Date.parse(list.at(-1)!.createdAt)
    expect(clock.t - oldest).toBeLessThan(31 * 24 * 3_600_000)
    expect(list.length).toBeLessThan(60)
  })

  it('restoring a Drive-linked project marks everything pending', async () => {
    const drive = new FakeDrive()
    const { repo, local } = setup({ drive })
    const { s, p, ids } = await projectWithImages(repo)
    await s.save(p, [doc(p, ids[0], marks('a', 2))])
    await s.drive.link('create-folder')
    const { version } = await s.history.create('manual', 'Saved by you')
    await s.drive.push()
    expect((await local.getSync(p.id)).projectDirty).toBe(false)
    await s.history.restore(version.id)
    const sync = await local.getSync(p.id)
    expect(sync.projectDirty).toBe(true)
    expect(sync.dirtyImages).toContain(ids[0])
    expect(repo.getStatus().state).toBe('pending')
    expect((await local.requireProject(p.id)).storage.kind).toBe('drive') // storage-owned link kept
  })

  it('soft-deletes images added after the version and deletes history with the project', async () => {
    const { repo, local } = setup()
    const { s, p, ids } = await projectWithImages(repo, 1)
    await s.save(p, [doc(p, ids[0], marks('a', 2))])
    const { version } = await s.history.create('manual', 'Saved by you')
    const { added } = await s.images.import([pngFile('late.png')])
    const p2 = { ...p, images: [...p.images, ...added] }
    await s.save(p2, [doc(p2, added[0].id, marks('late', 3))])
    const { snapshot } = await s.history.restore(version.id)
    const late = snapshot.project.images.find((i) => i.id === added[0].id)!
    expect(late.deletedAt).toBeTruthy()
    expect(snapshot.annotations.get(added[0].id)!.annotations).toHaveLength(3) // nothing erased
    await repo.delete(p.id)
    expect(await local.listVersions(p.id)).toEqual([])
    expect((await local.versionPartKeys(p.id)).size).toBe(0)
  })

  it('upgrades a version-1 database without losing projects', async () => {
    const factory = new IDBFactory()
    await new Promise<void>((resolve, reject) => {
      const req = factory.open('cfu-count', 1)
      req.onupgradeneeded = () => {
        const db = req.result
        db.createObjectStore('projects', { keyPath: 'id' })
        db.createObjectStore('annotations', { keyPath: ['projectId', 'imageId'] }).createIndex('byProject', 'projectId')
        db.createObjectStore('blobs', { keyPath: ['projectId', 'imageId'] }).createIndex('byProject', 'projectId')
        db.createObjectStore('sync', { keyPath: 'projectId' })
        req.transaction!.objectStore('projects').put({ id: 'old', name: 'Old project', updatedAt: '2026-01-01T00:00:00.000Z', images: [], storage: { kind: 'local' } })
      }
      req.onsuccess = () => {
        req.result.close()
        resolve()
      }
      req.onerror = () => reject(req.error)
    })
    const local = new LocalStore(factory)
    expect((await local.listProjects()).map((p) => p.id)).toEqual(['old'])
    expect(await local.listVersions('old')).toEqual([])
  })
})
