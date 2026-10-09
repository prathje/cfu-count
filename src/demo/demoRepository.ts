/**
 * In-memory ProjectRepository for demos and development. Never part of the main
 * bundle: src/state/repository.ts loads it with a dynamic import only when the
 * page is opened with `?demoStorage` or the real storage cannot start.
 *
 * Nothing persists across reloads. Drive is simulated only with `?fakeDrive=1`
 * (or `?fakeDrive=conflict`) so the Drive UI can be exercised. The UI shows a
 * visible "demo storage" badge whenever this repository is active. Codecs
 * (archive, CSV, image inspection) are the real ones from src/storage.
 */
import type { ID, ImageAnnotations, ImageRecord, Project } from '../model/types'
import { SCHEMA_VERSION } from '../model/types'
import { newId, now } from '../model/ids'
import { makeManualAnnotation } from '../model/annotations'
import { makeGroup } from '../model/groups'
import { activeImages, applyStorageOwned } from '../model/project'
import type { DriveState, ImportResult, ProjectRepository, ProjectSession, ProjectSnapshot, ProjectSummary, SaveStatus, VersionHistory } from '../storage/api'
import { createMemoryHistory } from '../storage/memoryHistory'
import { decodeArchive, encodeArchive } from '../storage/archive'
import { buildSummaryCsv } from '../storage/csv'
import { browserDecoder, inspectImage, sha256Hex, UnsupportedImageError } from '../storage/images'
import { drawSamplePlate } from './sampleImages'

interface Stored {
  project: Project
  annotations: Map<ID, ImageAnnotations>
  blobs: Map<ID, Blob>
  /** Version history (in memory, kept while the page is open). */
  history?: VersionHistory
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
const clone = <T>(v: T): T => structuredClone(v)

function blankProject(name: string): Project {
  const at = now()
  return {
    schemaVersion: SCHEMA_VERSION,
    id: newId(),
    name,
    createdAt: at,
    updatedAt: at,
    imageGroups: [],
    images: [],
    annotationGroups: [],
    storage: { kind: 'local' },
    revision: 0,
  }
}

async function seedDemo(): Promise<Stored> {
  const project = blankProject('Demo — E. coli dilution series')
  const main = makeGroup([], newId(), 'Colonies')
  const small = makeGroup([main], newId(), 'Small colonies')
  small.render = 'circle'
  project.annotationGroups = [main, small]
  const groupA = { id: newId(), name: 'Treatment A' }
  const groupB = { id: newId(), name: 'Control' }
  project.imageGroups = [groupA, groupB]
  const s: Stored = { project, annotations: new Map(), blobs: new Map() }
  const plates = [
    { seed: 11, name: 'plate_A_10-4.jpg', count: 64, tint: 'cream' as const, group: groupA.id, annotate: 40 },
    { seed: 23, name: 'plate_A_10-5.jpg', count: 18, tint: 'cream' as const, group: groupA.id, annotate: 0 },
    { seed: 37, name: 'control_blood_agar.jpg', count: 120, tint: 'red' as const, group: groupB.id, annotate: 0 },
    { seed: 51, name: 'unsorted_plate.jpg', count: 35, tint: 'amber' as const, group: null, annotate: 0 },
  ]
  for (const p of plates) {
    const plate = await drawSamplePlate(p.seed, p.name, p.count, p.tint)
    const record: ImageRecord = {
      id: newId(),
      name: p.name,
      imageGroupId: p.group,
      width: plate.width,
      height: plate.height,
      mimeType: 'image/jpeg',
      byteSize: plate.blob.size,
      fingerprint: await sha256Hex(plate.blob),
      source: { kind: 'local' },
      addedAt: now(),
    }
    project.images.push(record)
    s.blobs.set(record.id, plate.blob)
    if (p.annotate) {
      const at = now()
      s.annotations.set(record.id, {
        schemaVersion: SCHEMA_VERSION,
        projectId: project.id,
        imageId: record.id,
        imageFingerprint: record.fingerprint,
        width: record.width,
        height: record.height,
        groups: clone(project.annotationGroups),
        annotations: plate.colonies
          .slice(0, p.annotate)
          .map((c, i) => makeManualAnnotation(c.x, c.y, i % 6 === 5 ? small.id : main.id, newId(), at)),
        detectionRuns: [],
        updatedAt: at,
      })
    }
  }
  return s
}

export function createDemoRepository(): ProjectRepository {
  const params = new URLSearchParams(globalThis.location?.search ?? '')
  const driveMode = params.get('fakeDrive') // null | '1' | 'conflict'
  let status: SaveStatus = { state: 'idle' }
  let drive: DriveState = driveMode ? { state: 'disconnected' } : { state: 'unconfigured' }
  const subscribers = new Set<() => void>()
  const emit = () => subscribers.forEach((fn) => fn())
  const setStatus = (s: SaveStatus) => {
    status = s
    emit()
  }
  const setDrive = (d: DriveState) => {
    drive = d
    emit()
  }

  const store = new Map<ID, Stored>()
  let seeded: Promise<void> | null = null
  const seed = () =>
    (seeded ??= seedDemo().then((s) => {
      store.set(s.project.id, s)
    }))

  let current: { id: ID; updated: Set<(p: Project) => void> } | null = null
  let driveTimer: ReturnType<typeof setTimeout> | null = null

  const get = (id: ID): Stored => {
    const s = store.get(id)
    if (!s) throw new Error('Project not found in this browser.')
    return s
  }
  const snapshot = (s: Stored, warnings?: string[]): ProjectSnapshot => ({
    project: clone(s.project),
    annotations: new Map(clone([...s.annotations])),
    ...(warnings?.length ? { warnings } : {}),
  })
  const requireDrive = () => {
    if (!driveMode) throw new Error('Google Drive is not configured in this build.')
    if (drive.state !== 'connected') throw new Error('Connect Google Drive first.')
  }

  function openSession(s: Stored, warnings?: string[]): ProjectSession {
    const id = s.project.id
    const me = { id, updated: new Set<(p: Project) => void>() }
    current = me
    setStatus(s.project.storage.kind === 'drive' ? { state: 'saved-drive', at: now() } : { state: 'saved-local', at: s.project.updatedAt })
    const live = () => {
      if (current !== me) throw new Error('This project was closed (another project was opened).')
    }
    const emitUpdated = () => me.updated.forEach((fn) => fn(clone(s.project)))

    async function push(overwrite = false) {
      requireDrive()
      setStatus({ state: 'saving-drive' })
      await delay(900)
      if (driveMode === 'conflict' && !overwrite) {
        setStatus({ state: 'conflict', files: ['project.json', `annotations/${s.project.images[0]?.id ?? 'x'}.json`] })
        return
      }
      setStatus({ state: 'saved-drive', at: now() })
    }

    const history = (s.history ??= createMemoryHistory({
      read: () => ({ project: s.project, docs: [...s.annotations.values()] }),
      write(project, docs) {
        s.project = clone(project)
        s.annotations = new Map(docs.map((d) => [d.imageId, clone(d)]))
        if (s.project.storage.kind === 'drive') setStatus({ state: 'pending' })
        else setStatus({ state: 'saved-local', at: now() })
      },
      now,
    }))
    const guard = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) => async (...a: A) => {
      live()
      return fn(...a)
    }

    return {
      projectId: id,
      opened: snapshot(s, warnings),
      history: {
        list: guard(history.list),
        create: guard(history.create),
        load: guard(history.load),
        restore: guard(history.restore),
        delete: guard(history.delete),
      },
      get closed() {
        return current !== me
      },
      async save(project, docs) {
        live()
        await delay(60)
        s.project = clone({ ...applyStorageOwned(project, s.project), revision: s.project.revision + 1 })
        for (const doc of docs) s.annotations.set(doc.imageId, clone(doc))
        if (s.project.storage.kind === 'drive') {
          setStatus({ state: 'pending' })
          if (driveTimer) clearTimeout(driveTimer)
          driveTimer = setTimeout(() => {
            if (drive.state === 'connected' && current === me) void push().catch(() => {})
          }, 2500)
        } else setStatus({ state: 'saved-local', at: now() })
      },
      onUpdated(fn) {
        me.updated.add(fn)
        return () => me.updated.delete(fn)
      },
      images: {
        async import(files) {
          live()
          const result: ImportResult = { added: [], rejected: [] }
          for (const file of files) {
            try {
              const info = await inspectImage(file, browserDecoder)
              const record: ImageRecord = { id: newId(), name: file.name, imageGroupId: null, ...info, source: { kind: 'local' }, addedAt: now() }
              s.blobs.set(record.id, file)
              result.added.push(record)
            } catch (e) {
              result.rejected.push({ name: file.name, reason: e instanceof UnsupportedImageError ? e.message : 'The browser could not decode this image.' })
            }
          }
          return result
        },
        async importFromDrive() {
          requireDrive()
          await delay(300)
          return { added: [], rejected: [{ name: 'Drive picker', reason: 'Not available in demo storage.' }] }
        },
        async blob(imageId) {
          const blob = s.blobs.get(imageId)
          if (!blob) throw new Error('Image bytes are not available in this browser.')
          return blob
        },
      },
      async exportZip() {
        const bytes = await encodeArchive({ project: s.project, annotations: s.annotations, images: s.blobs })
        return new Blob([bytes as BlobPart], { type: 'application/zip' })
      },
      async exportCsv() {
        return new Blob([buildSummaryCsv(s.project, s.annotations)], { type: 'text/csv;charset=utf-8' })
      },
      drive: {
        async link(mode) {
          requireDrive()
          await delay(600)
          s.project.storage = { kind: 'drive', folderId: newId(), folderName: mode === 'create-folder' ? s.project.name : 'Lab plates 2026', account: 'demo.user@example.com' }
          setStatus({ state: 'saved-drive', at: now() })
          emitUpdated()
          return { warnings: [] }
        },
        push: (opts) => push(opts?.overwrite),
        async takeRemote() {
          requireDrive()
          await delay(500)
          setStatus({ state: 'saved-drive', at: now() })
          return snapshot(s)
        },
      },
      close() {
        if (current === me) {
          current = null
          setStatus({ state: 'idle' })
        }
      },
    }
  }

  return {
    getStatus: () => status,
    getDriveState: () => drive,
    subscribe(fn) {
      subscribers.add(fn)
      return () => subscribers.delete(fn)
    },
    async list(): Promise<ProjectSummary[]> {
      await seed()
      return [...store.values()].map(({ project }) => ({
        id: project.id,
        name: project.name,
        updatedAt: project.updatedAt,
        imageCount: activeImages(project).length,
        storage: project.storage.kind,
        driveFolderName: project.storage.kind === 'drive' ? project.storage.folderName : undefined,
      }))
    },
    async create(name) {
      await delay(120)
      const s: Stored = { project: blankProject(name.trim() || 'Untitled project'), annotations: new Map(), blobs: new Map() }
      store.set(s.project.id, s)
      return openSession(s)
    },
    async open(id) {
      await seed()
      await delay(80)
      return openSession(get(id))
    },
    async delete(id) {
      store.delete(id)
      if (current?.id === id) {
        current = null
        setStatus({ state: 'idle' })
      }
    },
    async importArchive(file) {
      const decoded = await decodeArchive(new Uint8Array(await file.arrayBuffer()))
      const project = { ...decoded.project, storage: { kind: 'local' as const } }
      if (store.has(project.id)) project.id = newId()
      const s: Stored = {
        project,
        annotations: new Map([...decoded.annotations].map(([k, d]) => [k, { ...d, projectId: project.id }])),
        blobs: decoded.images,
      }
      store.set(project.id, s)
      return openSession(s, decoded.warnings)
    },
    async openFromDrive() {
      requireDrive()
      await delay(500)
      throw new Error('The demo storage cannot open real Drive folders.')
    },
    async connectDrive() {
      if (!driveMode) throw new Error('Google Drive is not configured in this build.')
      setDrive({ state: 'connecting' })
      await delay(700)
      setDrive({ state: 'connected', account: 'demo.user@example.com', expiresAt: Date.now() + 3600_000 })
    },
    async disconnectDrive() {
      setDrive(driveMode ? { state: 'disconnected' } : { state: 'unconfigured' })
    },
  }
}
