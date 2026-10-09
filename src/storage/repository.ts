/**
 * ProjectRepository implementation. Composes:
 *   LocalStore        IndexedDB working copy (always written first)
 *   images            decode / fingerprint
 *   archive, csv      pure codecs
 *   DriveSession      in-memory OAuth token + DriveState
 *   projectSync       Drive orchestration (push/link/pull) over DriveClient + DrivePicker
 *   autosave          status derivation + debounced Drive scheduler
 * This file holds the repository / session surface, the open-session status and
 * local operations. At most one session is open (see api.ts).
 */
import { SCHEMA_VERSION } from '../model/types'
import type { ID, ImageRecord, Project } from '../model/types'
import { applyStorageOwned } from '../model/project'
import { newId, now as isoNow } from '../model/ids'
import type { DriveState, ImportResult, ProjectRepository, ProjectSession, ProjectSnapshot, ProjectSummary, SaveStatus } from './api'
import { decodeArchive, encodeArchive } from './archive'
import { buildSummaryCsv } from './csv'
import { DriveError, LocalStorageError, errorMessage } from './errors'
import { inspectImage, UnsupportedImageError, type ImageDecoder } from './images'
import { LocalStore, requestPersistentStorage, type SyncState } from './localStore'
import { AutosaveScheduler, deriveStatus, type Timers } from './drive/autosave'
import type { DriveClient } from './drive/client'
import type { DrivePicker } from './drive/picker'
import type { DriveSession } from './drive/session'
import { createProjectSync, EditCounters, isSyncDirty, type OpenStatusPatch, type ProjectSync } from './drive/projectSync'

/** Everything the repository depends on (all injectable for tests). */
export interface RepositoryDeps {
  local: LocalStore
  decoder: ImageDecoder
  session: DriveSession
  /** null when Drive is unconfigured. */
  drive: { client: DriveClient; picker: DrivePicker } | null
  /** Quiet period after the last local save before auto-saving to Drive. */
  autosaveDelayMs?: number
  timers?: Timers
  now?: () => string
  requestPersistence?: () => Promise<boolean>
}

/** Status inputs and listeners of the open session. */
interface OpenState {
  projectId: ID
  linked: boolean
  dirty: boolean
  pushing: boolean
  localError?: string
  driveError?: string
  conflict?: string[]
  lastLocalSaveAt?: string
  lastDriveSaveAt?: string
  updated: Set<(p: Project) => void>
}

export function createProjectRepository(deps: RepositoryDeps): ProjectRepository {
  const { local, decoder, session } = deps
  const now = deps.now ?? isoNow
  const requestPersistence = deps.requestPersistence ?? requestPersistentStorage

  const listeners = new Set<() => void>()
  let status: SaveStatus = { state: 'idle' }
  let open: OpenState | null = null
  /** Local storage failure while no project is open (e.g. IndexedDB unavailable at startup). */
  let bareLocalError: string | undefined
  let persistenceRequested = false
  const edits = new EditCounters()

  let lock: Promise<unknown> = Promise.resolve()
  function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = lock.then(fn, fn)
    lock = run.catch(() => undefined)
    return run
  }

  const scheduler = new AutosaveScheduler(() => void autoPush(), { delayMs: deps.autosaveDelayMs ?? 4000, timers: deps.timers })

  function emit(): void {
    for (const fn of listeners) {
      try {
        fn()
      } catch (e) {
        console.error('storage subscriber failed', e)
      }
    }
  }

  function refresh(): void {
    status = deriveStatus(
      open
        ? { open: true, ...open, driveConnected: session.isConnected }
        : { open: false, localError: bareLocalError, linked: false, dirty: false, pushing: false, driveConnected: false },
    )
    emit()
  }

  session.onChange((s) => {
    refresh()
    if (s.state === 'connected' && open?.linked && open.dirty && !open.conflict) scheduler.request(0)
  })

  const isOpen = (projectId: ID) => open?.projectId === projectId

  function patchOpen(projectId: ID, patch: OpenStatusPatch): void {
    if (!open || open.projectId !== projectId) return
    Object.assign(open, patch)
    refresh()
  }

  function notifyUpdated(p: Project): void {
    if (!open || open.projectId !== p.id) return
    for (const fn of open.updated) {
      try {
        fn(structuredClone(p))
      } catch (e) {
        console.error('onUpdated listener failed', e)
      }
    }
  }

  /** Wrap local writes so failures become a visible 'local-error' status. */
  async function localWrite<T>(projectId: ID | null, fn: () => Promise<T>): Promise<T> {
    try {
      const r = await fn()
      if (bareLocalError || (open && open.projectId === projectId && open.localError)) {
        bareLocalError = undefined
        if (open && open.projectId === projectId) open.localError = undefined
        refresh()
      }
      return r
    } catch (e) {
      if (e instanceof LocalStorageError && e.code !== 'not-found') {
        if (open && (projectId === null || open.projectId === projectId)) open.localError = e.message
        else if (!open) bareLocalError = e.message
        refresh()
      }
      throw e
    }
  }

  async function readSnapshot(projectId: ID, warnings?: string[]): Promise<ProjectSnapshot> {
    const project = await local.requireProject(projectId)
    const docs = await local.getAnnotations(projectId)
    return { project, annotations: new Map(docs.map((d) => [d.imageId, d])), ...(warnings?.length ? { warnings } : {}) }
  }

  function maybePersist(): void {
    if (persistenceRequested) return
    persistenceRequested = true
    void requestPersistence()
  }

  // ------------------------------------------------------------ Drive plumbing

  const unconfigured = () => new DriveError('unconfigured', 'Google Drive is not configured in this build. Work is saved in this browser only.')

  let sync: ProjectSync | null = null
  if (deps.drive) {
    const drive = deps.drive
    sync = createProjectSync({
      local,
      decoder,
      session,
      client: drive.client,
      picker: drive.picker,
      now,
      withLock,
      edits,
      notifyUpdated,
      patchOpen,
      isOpen,
      localWrite,
      onPushed(projectId, stillDirty) {
        scheduler.succeeded()
        if (stillDirty && isOpen(projectId)) scheduler.request()
      },
      onRetryableFailure: () => void scheduler.failed(),
    })
  }

  function requireSync(): ProjectSync {
    if (!sync) throw unconfigured()
    return sync
  }

  async function connect(): Promise<void> {
    await session.connect()
    try {
      session.setAccount((await deps.drive!.client.about()).email)
    } catch {
      // Account display is optional.
    }
  }

  /**
   * Ensure a valid token. MUST be called before any await in a Drive action so the
   * consent popup opens inside the user's click.
   */
  function ensureConnected(): Promise<void> {
    if (!deps.drive) return Promise.reject(unconfigured())
    return session.isConnected ? Promise.resolve() : connect()
  }

  async function autoPush(): Promise<void> {
    if (!open || !open.linked || !open.dirty || open.conflict || !session.isConnected) return
    try {
      await requireSync().push(open.projectId, false, true)
    } catch (e) {
      // Status already reflects the failure; local data is untouched.
      console.warn('[drive] autosave failed:', errorMessage(e))
    }
  }

  // ------------------------------------------------------------ sessions

  function closeOpen(): void {
    if (!open) return
    const prev = open
    open = null
    prev.updated.clear()
    scheduler.cancel()
    refresh()
  }

  /** Open `snapshot` as THE session (closing any previous one). */
  async function startSession(snapshot: ProjectSnapshot, extra: { lastLocalSaveAt?: string } = {}): Promise<ProjectSession> {
    const projectId = snapshot.project.id
    const syncState = await local.getSync(projectId)
    closeOpen()
    const linked = snapshot.project.storage.kind === 'drive'
    const state: OpenState = {
      projectId,
      linked,
      dirty: linked && isSyncDirty(syncState),
      pushing: false,
      lastLocalSaveAt: extra.lastLocalSaveAt ?? snapshot.project.updatedAt,
      lastDriveSaveAt: syncState.lastDriveSaveAt,
      updated: new Set(),
    }
    const handle = createSession(state, snapshot)
    open = state
    refresh()
    if (state.linked && state.dirty && session.isConnected) scheduler.request()
    return handle
  }

  function createSession(state: OpenState, opened: ProjectSnapshot): ProjectSession {
    const projectId = state.projectId
    const live = () => {
      if (open !== state) throw new Error('This project was closed (another project was opened).')
    }
    function guarded<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
      return async (...args: A) => {
        live()
        return fn(...args)
      }
    }
    /** Drive actions: start sign-in synchronously (popup inside the click), then run. */
    function withDrive<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
      return (...args: A) => {
        if (open !== state) return Promise.reject(new Error('This project was closed (another project was opened).'))
        const auth = ensureConnected()
        return auth.then(() => {
          live()
          return fn(...args)
        })
      }
    }

    async function save(project: Project, changedDocs: Parameters<ProjectSession['save']>[1]): Promise<void> {
      await localWrite(projectId, () =>
        withLock(async () => {
          const stored = await local.getProject(projectId)
          const merged: Project = stored ? applyStorageOwned({ ...project, id: projectId }, stored) : { ...project, id: projectId }
          merged.revision = (stored?.revision ?? project.revision ?? 0) + 1
          const docs = changedDocs.map((d) => (d.projectId === projectId ? d : { ...d, projectId }))
          let syncState: SyncState | undefined
          if (merged.storage.kind === 'drive') {
            syncState = await local.getSync(projectId)
            syncState.projectDirty = true
            syncState.dirtyImages = [...new Set([...syncState.dirtyImages, ...docs.map((d) => d.imageId)])]
            edits.bump(projectId)
            for (const d of docs) edits.bump(projectId, d.imageId)
          }
          await local.saveProject(merged, docs, syncState)
          if (open === state) {
            state.lastLocalSaveAt = now()
            state.linked = merged.storage.kind === 'drive'
            if (state.linked) state.dirty = true
            refresh()
            if (state.linked && session.isConnected && !state.conflict) scheduler.request()
          }
        }),
      )
    }

    async function importFiles(files: File[]): Promise<ImportResult> {
      maybePersist()
      const result: ImportResult = { added: [], rejected: [] }
      for (const file of files) {
        let info
        try {
          info = await inspectImage(file, decoder)
        } catch (e) {
          result.rejected.push({ name: file.name, reason: e instanceof UnsupportedImageError ? e.message : `Could not read the file: ${errorMessage(e)}` })
          continue
        }
        const record: ImageRecord = { id: newId(), name: file.name, imageGroupId: null, ...info, source: { kind: 'local' }, addedAt: now() }
        const blob = file.type === info.mimeType ? file : new Blob([file], { type: info.mimeType })
        try {
          await localWrite(projectId, () => local.putBlob(projectId, record.id, blob))
          result.added.push(record)
        } catch (e) {
          result.rejected.push({ name: file.name, reason: errorMessage(e) })
        }
      }
      return result
    }

    async function blob(imageId: ID): Promise<Blob> {
      const cached = await local.getBlob(projectId, imageId)
      const image = (await local.getProject(projectId))?.images.find((i) => i.id === imageId)
      if (cached) {
        if (image?.source.kind === 'drive' && sync) void sync.checkRemoteImage(projectId, image)
        return cached
      }
      if (!image) throw new LocalStorageError('not-found', 'This image is not part of the project.')
      if (image.source.kind !== 'drive') {
        throw new LocalStorageError('not-found', `The pixels of "${image.name}" are missing from this browser. Re-import the image or restore the project from a .zip export.`)
      }
      return requireSync().fetchImage(projectId, image as ImageRecord & { source: { kind: 'drive' } })
    }

    async function remove(imageId: ID): Promise<void> {
      await localWrite(projectId, () =>
        withLock(async () => {
          const stored = await local.getProject(projectId)
          await local.deleteImage(projectId, imageId)
          if (!stored) return
          const image = stored.images.find((i) => i.id === imageId)
          const syncState = await local.getSync(projectId)
          syncState.dirtyImages = syncState.dirtyImages.filter((i) => i !== imageId)
          // Never delete a Drive file: remember it so the folder scan does not re-add it.
          if (image?.source.kind === 'drive' && !stored.excludedDriveFileIds.includes(image.source.fileId)) {
            const updated: Project = { ...stored, excludedDriveFileIds: [...stored.excludedDriveFileIds, image.source.fileId] }
            if (stored.storage.kind === 'drive') {
              syncState.projectDirty = true
              edits.bump(projectId)
            }
            await local.saveProject(updated, [], syncState)
            notifyUpdated(updated)
          } else {
            await local.putSync(syncState)
          }
        }),
      )
    }

    async function exportZip(): Promise<Blob> {
      const { project, annotations } = await readSnapshot(projectId)
      const images = new Map<ID, Blob>()
      for (const img of project.images) {
        let bytes = await local.getBlob(projectId, img.id)
        if (!bytes && img.source.kind === 'drive' && sync && session.isConnected) bytes = await blob(img.id).catch(() => undefined)
        if (bytes) images.set(img.id, bytes)
      }
      const zipped = await encodeArchive({ project, annotations, images })
      return new Blob([zipped as BlobPart], { type: 'application/zip' })
    }

    async function exportCsv(): Promise<Blob> {
      const { project, annotations } = await readSnapshot(projectId)
      return new Blob([buildSummaryCsv(project, annotations)], { type: 'text/csv;charset=utf-8' })
    }

    return {
      projectId,
      opened,
      get closed() {
        return open !== state
      },
      save: guarded(save),
      onUpdated(listener) {
        state.updated.add(listener)
        return () => state.updated.delete(listener)
      },
      images: {
        import: guarded(importFiles),
        importFromDrive: withDrive(() => requireSync().importFromPicker(projectId)),
        blob: guarded(blob),
        remove: guarded(remove),
      },
      exportZip: guarded(exportZip),
      exportCsv: guarded(exportCsv),
      drive: {
        link: withDrive((mode) => requireSync().link(projectId, mode)),
        push: withDrive(async (opts: { overwrite?: boolean } = {}) => {
          const outcome = await requireSync().push(projectId, opts.overwrite ?? false)
          if (outcome === 'conflict') refresh()
        }),
        takeRemote: withDrive(async () => {
          scheduler.cancel()
          return requireSync().takeRemote(projectId)
        }),
      },
      close() {
        if (open === state) closeOpen()
      },
    }
  }

  // ------------------------------------------------------------ repository

  return {
    getStatus: () => status,
    getDriveState: (): DriveState => session.state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    async list(): Promise<ProjectSummary[]> {
      const projects = await localWrite(null, () => local.listProjects())
      return projects
        .map((p) => ({
          id: p.id,
          name: p.name,
          updatedAt: p.updatedAt,
          imageCount: p.images.length,
          storage: p.storage.kind,
          ...(p.storage.kind === 'drive' ? { driveFolderName: p.storage.folderName } : {}),
        }))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    },

    async create(name) {
      const t = now()
      const project: Project = {
        schemaVersion: SCHEMA_VERSION,
        id: newId(),
        name: name.trim() || 'Untitled project',
        createdAt: t,
        updatedAt: t,
        imageGroups: [],
        images: [],
        annotationGroups: [],
        storage: { kind: 'local' },
        excludedDriveFileIds: [],
        revision: 1,
      }
      await localWrite(null, () => local.saveProject(project))
      maybePersist()
      return startSession({ project, annotations: new Map() }, { lastLocalSaveAt: t })
    },

    async open(id) {
      return startSession(await localWrite(id, () => readSnapshot(id)))
    },

    async delete(id) {
      await local.deleteProject(id)
      if (isOpen(id)) closeOpen()
    },

    async importArchive(file) {
      const decoded = await decodeArchive(new Uint8Array(await file.arrayBuffer()))
      const warnings = [...decoded.warnings]
      let project: Project = { ...decoded.project, storage: { kind: 'local' }, updatedAt: now() }
      if (await local.getProject(project.id)) {
        project = { ...project, id: newId(), name: `${project.name} (imported)` }
        warnings.push('A project with the same ID already exists in this browser, so the import was saved as a separate copy.')
      }
      const docs = [...decoded.annotations.values()].map((d) => ({ ...d, projectId: project.id }))
      maybePersist()
      await localWrite(null, async () => {
        for (const [imageId, bytes] of decoded.images) await local.putBlob(project.id, imageId, bytes)
        await local.saveProject(project, docs, { projectId: project.id, projectDirty: false, dirtyImages: [] })
      })
      return startSession({ project, annotations: new Map(docs.map((d) => [d.imageId, d])), ...(warnings.length ? { warnings } : {}) })
    },

    openFromDrive() {
      const auth = ensureConnected()
      return auth.then(async () => {
        const { projectId, warnings, snapshot } = await requireSync().openFolder()
        return startSession(snapshot ? { ...snapshot, ...(warnings.length ? { warnings } : {}) } : await readSnapshot(projectId, warnings))
      })
    },

    connectDrive() {
      if (!deps.drive) return Promise.reject(unconfigured())
      return connect()
    },

    async disconnectDrive() {
      scheduler.cancel()
      await session.disconnect()
      refresh()
    },
  }
}
