/**
 * ProjectRepository implementation. Composes:
 *   LocalStore        IndexedDB working copy (always written first)
 *   images            decode / fingerprint
 *   archive, csv      pure codecs
 *   DriveSession      in-memory OAuth token + DriveState
 *   DriveClient       Drive REST (injectable)
 *   DrivePicker       Google Picker (injectable)
 *   sync              push/pull engine
 *   autosave          status derivation + debounced scheduler
 * This file holds orchestration only: which steps run in which order, and
 * which fields storage owns when merging with editor state.
 */
import { createSignal } from 'solid-js'
import { SCHEMA_VERSION } from '../model/types'
import type { ID, ImageAnnotations, ImageRecord, Project } from '../model/types'
import { newId, now as isoNow } from '../model/ids'
import type { DriveState, ImportResult, OpenedProject, ProjectRepository, ProjectSummary, SaveStatus } from './api'
import { decodeArchive, encodeArchive } from './archive'
import { buildSummaryCsv } from './csv'
import { DriveError, LocalStorageError, errorMessage } from './errors'
import { ACCEPTED_IMAGE_MIME_TYPES, inspectImage, sha256Hex, UnsupportedImageError, type ImageDecoder } from './images'
import { LocalStore, requestPersistentStorage, type SyncState } from './localStore'
import { AutosaveScheduler, deriveStatus, type Timers } from './drive/autosave'
import { FOLDER_MIME, type DriveClient, type DriveFile } from './drive/client'
import type { DrivePicker, PickedItem } from './drive/picker'
import type { DriveSession } from './drive/session'
import {
  checkFolder,
  detectReplacement,
  emptyDriveProject,
  importDriveImage,
  isDriveLinked,
  newDriveLink,
  pullFolder,
  pushProject,
  PROJECT_JSON,
  type PullResult,
} from './drive/sync'

/** Google Drive collaborators; absent when the build has no Google configuration. */
export interface DriveServices {
  session: DriveSession
  client: DriveClient
  picker: DrivePicker
}

/** Everything the repository depends on (all injectable for tests). */
export interface RepositoryDeps {
  local: LocalStore
  decoder: ImageDecoder
  session: DriveSession
  /** null when Drive is unconfigured. */
  drive: Omit<DriveServices, 'session'> | null
  /** Quiet period after the last local save before auto-saving to Drive. */
  autosaveDelayMs?: number
  timers?: Timers
  now?: () => string
  requestPersistence?: () => Promise<boolean>
}

/** In-memory status inputs for the open project. */
interface OpenContext {
  projectId: ID
  linked: boolean
  dirty: boolean
  pushing: boolean
  localError?: string
  driveError?: string
  conflict?: string[]
  lastLocalSaveAt?: string
  lastDriveSaveAt?: string
}

const isDirty = (s: SyncState) => s.projectDirty || s.dirtyImages.length > 0

/** Storage-owned fields of `from` copied onto `onto` (everything else stays editor-owned). */
function mergeStorageFields(onto: Project, from: Project): Project {
  const byId = new Map(from.images.map((i) => [i.id, i]))
  return {
    ...onto,
    storage: from.storage,
    images: onto.images.map((img) => {
      const s = byId.get(img.id)
      if (!s) return img
      const merged: ImageRecord = { ...img, source: s.source }
      if (s.sourceMismatch) merged.sourceMismatch = s.sourceMismatch
      else delete merged.sourceMismatch
      return merged
    }),
  }
}

export function createProjectRepository(deps: RepositoryDeps): ProjectRepository {
  const { local, decoder, session } = deps
  const drive = deps.drive
  const now = deps.now ?? isoNow
  const requestPersistence = deps.requestPersistence ?? requestPersistentStorage

  const [status, setStatus] = createSignal<SaveStatus>({ state: 'idle' })
  const [driveState, setDriveState] = createSignal<DriveState>(session.state)
  const listeners = new Set<(p: Project) => void>()
  let ctx: OpenContext | null = null
  /** Local storage failure while no project is open (e.g. IndexedDB unavailable at startup). */
  let bareLocalError: string | undefined
  let persistenceRequested = false

  // Per-session edit counters, so a push only clears dirt it actually uploaded.
  const editSeq = new Map<string, number>()
  const bump = (key: string) => editSeq.set(key, (editSeq.get(key) ?? 0) + 1)
  const seqKey = (projectId: ID, imageId?: ID) => (imageId ? `${projectId}/${imageId}` : projectId)

  // Serialises read-modify-write of project records (editor saves vs. Drive checkpoints).
  let lock: Promise<unknown> = Promise.resolve()
  function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = lock.then(fn, fn)
    lock = run.catch(() => undefined)
    return run
  }

  const scheduler = new AutosaveScheduler(() => void autoPush(), { delayMs: deps.autosaveDelayMs ?? 4000, timers: deps.timers })

  function refresh(): void {
    setStatus(
      deriveStatus(
        ctx
          ? { open: true, ...ctx, driveConnected: session.isConnected }
          : { open: false, localError: bareLocalError, linked: false, dirty: false, pushing: false, driveConnected: false },
      ),
    )
  }

  session.onChange((s) => {
    setDriveState(s)
    refresh()
    if (s.state === 'connected' && ctx?.linked && ctx.dirty && !ctx.conflict) scheduler.request(0)
  })

  function notify(p: Project): void {
    for (const fn of listeners) {
      try {
        fn(p)
      } catch (e) {
        console.error('onProjectUpdated listener failed', e)
      }
    }
  }

  async function setOpen(project: Project, extra: Partial<OpenContext> = {}): Promise<void> {
    const sync = await local.getSync(project.id)
    ctx = {
      projectId: project.id,
      linked: project.storage.kind === 'drive',
      dirty: project.storage.kind === 'drive' && isDirty(sync),
      pushing: false,
      lastLocalSaveAt: project.updatedAt,
      lastDriveSaveAt: sync.lastDriveSaveAt,
      ...extra,
    }
    scheduler.cancel()
    refresh()
    if (ctx.linked && ctx.dirty && session.isConnected) scheduler.request()
  }

  /** Wrap local writes so failures become a visible 'local-error' status. */
  async function localWrite<T>(projectId: ID | null, fn: () => Promise<T>): Promise<T> {
    try {
      const r = await fn()
      if (bareLocalError || (ctx && ctx.projectId === projectId && ctx.localError)) {
        bareLocalError = undefined
        if (ctx && ctx.projectId === projectId) ctx.localError = undefined
        refresh()
      }
      return r
    } catch (e) {
      if (e instanceof LocalStorageError && e.code !== 'not-found') {
        if (ctx && (projectId === null || ctx.projectId === projectId)) ctx.localError = e.message
        else if (!ctx) bareLocalError = e.message
        refresh()
      }
      throw e
    }
  }

  async function opened(projectId: ID, warnings?: string[]): Promise<OpenedProject> {
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

  function requireDrive(): NonNullable<typeof drive> {
    if (!drive) throw unconfigured()
    return drive
  }

  async function connect(): Promise<void> {
    await session.connect()
    try {
      session.setAccount((await requireDrive().client.about()).email)
    } catch {
      // Account display is optional.
    }
  }

  /**
   * Ensure a valid token. MUST be the first thing a Drive action does (no await
   * before it) so the consent popup opens inside the user's click.
   */
  function ensureConnected(): Promise<void> {
    if (!drive) return Promise.reject(unconfigured())
    return session.isConnected ? Promise.resolve() : connect()
  }

  function pickerToken(): string {
    return session.accessToken()
  }

  let pushChain: Promise<unknown> = Promise.resolve()

  /** Serialised push of one project. Updates status; returns 'conflict' | 'saved'. */
  function push(projectId: ID, overwrite: boolean, onlyIfDirty = false): Promise<'saved' | 'conflict' | 'clean'> {
    const run = pushChain.then(() => doPush(projectId, overwrite, onlyIfDirty))
    pushChain = run.catch(() => undefined)
    return run
  }

  async function doPush(projectId: ID, overwrite: boolean, onlyIfDirty: boolean): Promise<'saved' | 'conflict' | 'clean'> {
    const { client } = requireDrive()
    const isOpen = () => ctx?.projectId === projectId
    const project = await local.requireProject(projectId)
    if (!isDriveLinked(project)) throw new Error('This project is not linked to Google Drive.')
    session.accessToken() // throws 'unauthorized' early
    const docs = await local.getAnnotations(projectId)
    const sync = await local.getSync(projectId)
    if (onlyIfDirty && !isDirty(sync)) return 'clean'
    const startSeq = new Map(editSeq)
    const unchangedSince = (key: string) => (editSeq.get(key) ?? 0) === (startSeq.get(key) ?? 0)

    if (isOpen()) {
      ctx!.pushing = true
      refresh()
    }
    try {
      const result = await pushProject(client, {
        project,
        annotations: new Map(docs.map((d) => [d.imageId, d])),
        dirtyImages: new Set(sync.dirtyImages),
        overwrite,
        loadImage: (imageId) => local.getBlob(projectId, imageId),
        checkpoint: (p, written) =>
          withLock(async () => {
            const latest = await local.requireProject(projectId)
            const merged = mergeStorageFields(latest, p)
            const s = await local.getSync(projectId)
            s.dirtyImages = s.dirtyImages.filter((id) => !(written.includes(id) && unchangedSince(seqKey(projectId, id))))
            await local.saveProject(merged, [], s)
            notify(merged)
          }),
      })
      if (result.kind === 'conflict') {
        if (isOpen()) ctx!.conflict = result.files
        return 'conflict'
      }
      for (const w of result.warnings) console.warn('[drive]', w)
      const at = now()
      await withLock(async () => {
        const latest = await local.requireProject(projectId)
        const merged = mergeStorageFields(latest, result.project)
        if (merged.storage.kind === 'drive') merged.storage.account = session.accountEmail
        const s = await local.getSync(projectId)
        if (unchangedSince(seqKey(projectId))) s.projectDirty = false
        s.lastDriveSaveAt = at
        await local.saveProject(merged, [], s)
        notify(merged)
        if (isOpen()) {
          ctx!.dirty = isDirty(s)
          ctx!.lastDriveSaveAt = at
        }
      })
      if (isOpen()) {
        ctx!.conflict = undefined
        ctx!.driveError = undefined
        if (ctx!.dirty) scheduler.request()
      }
      scheduler.succeeded()
      return 'saved'
    } catch (e) {
      if (isOpen()) {
        ctx!.driveError = e instanceof DriveError && e.kind === 'unauthorized' ? undefined : errorMessage(e)
      }
      if (e instanceof DriveError && ['network', 'server', 'rate-limited'].includes(e.kind)) scheduler.failed()
      throw e
    } finally {
      if (isOpen()) {
        ctx!.pushing = false
        refresh()
      }
    }
  }

  async function autoPush(): Promise<void> {
    if (!ctx || !ctx.linked || !ctx.dirty || ctx.conflict || !session.isConnected) return
    try {
      await push(ctx.projectId, false, true)
    } catch (e) {
      // Status already reflects the failure; local data is untouched.
      console.warn('[drive] autosave failed:', errorMessage(e))
    }
  }

  /** Picker steps that grant drive.file access to files this app cannot see yet. */
  async function pullWithGrants(folder: PickedItem | DriveFile): Promise<{ result: PullResult; extraPicks: PickedItem[] }> {
    const { client, picker } = requireDrive()
    let result = await pullFolder(client, folder.id, now)
    let extraPicks: PickedItem[] = []
    if (!result.project) {
      extraPicks = await picker.pickFiles(pickerToken(), {
        title: `Select project.json (if any) and the images in "${result.folder.name}"`,
        parentId: folder.id,
        mimeTypes: ['application/json', ...ACCEPTED_IMAGE_MIME_TYPES],
        multiselect: true,
      })
      if (extraPicks.some((p) => p.name === PROJECT_JSON)) result = await pullFolder(client, folder.id, now)
    }
    if (result.project && result.inaccessible.length) {
      const granted = await picker.pickFiles(pickerToken(), {
        title: `Allow access to ${result.inaccessible.length} project file(s): select all, then "Select"`,
        fileIds: result.inaccessible,
        multiselect: true,
        allowFolders: true,
      })
      if (granted.length) result = await pullFolder(client, folder.id, now)
      if (result.inaccessible.length) {
        result.warnings.push(`${result.inaccessible.length} project file(s) could not be read (deleted, or access not granted). They will not be overwritten without asking.`)
      }
    }
    return { result, extraPicks: extraPicks.filter((p) => p.name !== PROJECT_JSON) }
  }

  async function importDriveFiles(project: Project, files: DriveFile[]): Promise<ImportResult> {
    const { client } = requireDrive()
    const res: ImportResult = { added: [], rejected: [] }
    const known = new Set(project.images.flatMap((i) => (i.source.kind === 'drive' ? [i.source.fileId] : [])))
    for (const f of files) {
      if (known.has(f.id)) {
        res.rejected.push({ name: f.name, reason: 'This Drive file is already in the project.' })
        continue
      }
      known.add(f.id)
      try {
        const { record, blob } = await importDriveImage(client, f, decoder, now)
        await localWrite(project.id, () => local.putBlob(project.id, record.id, blob))
        res.added.push(record)
      } catch (e) {
        if (e instanceof LocalStorageError || (e instanceof DriveError && e.kind === 'unauthorized')) throw e
        res.rejected.push({ name: f.name, reason: errorMessage(e) })
      }
    }
    return res
  }

  // ------------------------------------------------------------ public API

  const repo: ProjectRepository = {
    status,
    drive: driveState,

    async listProjects(): Promise<ProjectSummary[]> {
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

    async createProject(name) {
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
        revision: 1,
      }
      await localWrite(null, () => local.saveProject(project))
      maybePersist()
      await setOpen(project, { lastLocalSaveAt: t })
      return { project, annotations: new Map() }
    },

    async openProject(id) {
      const result = await localWrite(id, () => opened(id))
      await setOpen(result.project)
      return result
    },

    async deleteProject(id) {
      await local.deleteProject(id)
      if (ctx?.projectId === id) {
        ctx = null
        scheduler.cancel()
        refresh()
      }
    },

    saveLocal(project, annotations) {
      return localWrite(project.id, () =>
        withLock(async () => {
          const stored = await local.getProject(project.id)
          let merged: Project = stored ? mergeStorageFields(project, stored) : project
          merged = { ...merged, revision: (stored?.revision ?? project.revision ?? 0) + 1 }
          const docs = annotations.map((d) => (d.projectId === project.id ? d : { ...d, projectId: project.id }))
          let sync: SyncState | undefined
          if (merged.storage.kind === 'drive') {
            sync = await local.getSync(project.id)
            sync.projectDirty = true
            sync.dirtyImages = [...new Set([...sync.dirtyImages, ...docs.map((d) => d.imageId)])]
            bump(seqKey(project.id))
            for (const d of docs) bump(seqKey(project.id, d.imageId))
          }
          await local.saveProject(merged, docs, sync)
          if (ctx?.projectId === project.id) {
            ctx.lastLocalSaveAt = now()
            ctx.linked = merged.storage.kind === 'drive'
            if (ctx.linked) ctx.dirty = true
            refresh()
            if (ctx.linked && session.isConnected && !ctx.conflict) scheduler.request()
          }
        }),
      )
    },

    onProjectUpdated(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    async importImageFiles(project, files) {
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
        const record: ImageRecord = {
          id: newId(),
          name: file.name,
          imageGroupId: null,
          ...info,
          source: { kind: 'local' },
          addedAt: now(),
        }
        const blob = file.type === info.mimeType ? file : new Blob([file], { type: info.mimeType })
        try {
          await localWrite(project.id, () => local.putBlob(project.id, record.id, blob))
          result.added.push(record)
        } catch (e) {
          result.rejected.push({ name: file.name, reason: errorMessage(e) })
        }
      }
      return result
    },

    async getImageBlob(project, imageId) {
      const cached = await local.getBlob(project.id, imageId)
      const image = project.images.find((i) => i.id === imageId) ?? (await local.getProject(project.id))?.images.find((i) => i.id === imageId)
      if (cached) {
        if (image?.source.kind === 'drive' && drive && session.isConnected) void checkRemoteImage(project.id, image)
        return cached
      }
      if (!image) throw new LocalStorageError('not-found', 'This image is not part of the project.')
      if (image.source.kind !== 'drive') {
        throw new LocalStorageError('not-found', `The pixels of "${image.name}" are missing from this browser. Re-import the image or restore the project from a .zip export.`)
      }
      const { client } = requireDrive()
      if (!session.isConnected) throw new DriveError('unauthorized', `Connect Google Drive to load "${image.name}".`)
      const file = await client.getFile(image.source.fileId)
      const blob = await client.download(file.id)
      let checked = detectReplacement(image, file, now)
      const fp = await sha256Hex(blob)
      if (fp !== image.fingerprint && !checked.sourceMismatch) {
        let dims: { width?: number; height?: number } = {}
        try {
          const s = await decoder(blob)
          dims = { width: s.width, height: s.height }
        } catch {
          // keep undefined dims
        }
        checked = {
          ...checked,
          sourceMismatch: {
            detectedAt: now(),
            remoteMd5: file.md5Checksum,
            remoteWidth: dims.width,
            remoteHeight: dims.height,
            message: `The Drive file for "${image.name}" differs from the image that was annotated${dims.width && (dims.width !== image.width || dims.height !== image.height) ? ` (now ${dims.width}×${dims.height} px, was ${image.width}×${image.height})` : ''}. Existing marks may not line up.`,
          },
        }
      }
      await localWrite(project.id, () => local.putBlob(project.id, imageId, blob))
      if (checked !== image) await recordImageSource(project.id, checked)
      return blob
    },

    async removeImage(project, imageId) {
      await localWrite(project.id, () => local.deleteImage(project.id, imageId))
      const sync = await local.getSync(project.id)
      if (sync.dirtyImages.includes(imageId)) {
        sync.dirtyImages = sync.dirtyImages.filter((i) => i !== imageId)
        await local.putSync(sync)
      }
    },

    async exportArchive(projectId) {
      const { project, annotations } = await opened(projectId)
      const images = new Map<ID, Blob>()
      for (const img of project.images) {
        let blob = await local.getBlob(projectId, img.id)
        if (!blob && img.source.kind === 'drive' && drive && session.isConnected) {
          blob = await repo.getImageBlob(project, img.id).catch(() => undefined)
        }
        if (blob) images.set(img.id, blob)
      }
      const bytes = await encodeArchive({ project, annotations, images })
      return new Blob([bytes as BlobPart], { type: 'application/zip' })
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
        for (const [imageId, blob] of decoded.images) await local.putBlob(project.id, imageId, blob)
        await local.saveProject(project, docs, { projectId: project.id, projectDirty: false, dirtyImages: [] })
      })
      await setOpen(project)
      return { project, annotations: new Map(docs.map((d) => [d.imageId, d])), ...(warnings.length ? { warnings } : {}) }
    },

    async exportSummaryCsv(projectId) {
      const { project, annotations } = await opened(projectId)
      return new Blob([buildSummaryCsv(project, annotations)], { type: 'text/csv;charset=utf-8' })
    },

    // ---------------------------------------------------------- Drive

    connectDrive() {
      if (!drive) return Promise.reject(unconfigured())
      return connect()
    },

    async disconnectDrive() {
      scheduler.cancel()
      await session.disconnect()
      refresh()
    },

    async linkProjectToDrive(projectId, mode) {
      await ensureConnected()
      const { client, picker } = requireDrive()
      const project = await local.requireProject(projectId)
      let folder: DriveFile
      if (mode === 'create-folder') {
        folder = await client.create({ name: project.name, parents: ['root'], mimeType: FOLDER_MIME })
      } else {
        const picked = await picker.pickFolder(pickerToken(), { title: `Choose a Drive folder for "${project.name}"` })
        if (!picked) throw new DriveError('cancelled', 'No folder was selected.')
        folder = await checkFolder(client, picked.id)
        const children = await client.listChildren(folder.id)
        if (children.some((f) => f.name === PROJECT_JSON)) {
          throw new DriveError('invalid', `"${folder.name}" already contains a project. Use "Open from Drive" to open it, or choose an empty folder.`)
        }
      }
      const docs = await local.getAnnotations(projectId)
      const linkedProject = await withLock(async () => {
        const latest = await local.requireProject(projectId)
        const link = { ...newDriveLink(folder.id, folder.name), account: session.accountEmail }
        const p: Project = { ...latest, storage: link }
        bump(seqKey(projectId))
        await local.saveProject(p, [], { projectId, projectDirty: true, dirtyImages: docs.map((d) => d.imageId) })
        return p
      })
      notify(linkedProject)
      await setOpen(linkedProject)
      const warnings: string[] = []
      try {
        await push(projectId, false)
      } catch (e) {
        warnings.push(`Linked to "${folder.name}", but the first upload failed: ${errorMessage(e)} Your work is safe in this browser; use Save to Drive to retry.`)
      }
      return opened(projectId, warnings)
    },

    async openProjectFromDrive() {
      await ensureConnected()
      const { picker, client } = requireDrive()
      const picked = await picker.pickFolder(pickerToken(), { title: 'Open a project folder from Google Drive' })
      if (!picked) throw new DriveError('cancelled', 'No folder was selected.')
      const { result, extraPicks } = await pullWithGrants(picked)
      const warnings = [...result.warnings]
      let project: Project
      let docs: ImageAnnotations[]
      let dirty = false

      if (!result.project) {
        project = emptyDriveProject(result.folder, now(), { annotationGroups: [] })
        docs = []
        dirty = true
      } else {
        project = result.project
        docs = [...result.annotations.values()]
        const existing = await local.getProject(project.id)
        if (existing) {
          const sameFolder = existing.storage.kind === 'drive' && existing.storage.folderId === result.folder.id
          const localSync = await local.getSync(existing.id)
          if (sameFolder && isDirty(localSync)) {
            warnings.push('This browser has changes to this project that are not on Drive yet, so the local copy was opened. Save to Drive to upload them; you will be asked if the Drive copy changed meanwhile.')
            const r = await opened(existing.id, warnings)
            await setOpen(r.project)
            return r
          }
          if (!sameFolder) {
            const id = newId()
            project = { ...project, id }
            docs = docs.map((d) => ({ ...d, projectId: id }))
            warnings.push('A different copy of this project already exists in this browser, so the Drive folder was opened as a separate project.')
          }
        }
      }
      if (project.storage.kind === 'drive') project.storage.account = session.accountEmail

      // The folder is the project: pull in visible images it does not reference yet.
      const extraFiles: DriveFile[] = []
      for (const p of extraPicks) {
        if (result.unreferencedImages.some((f) => f.id === p.id)) continue
        try {
          extraFiles.push(await client.getFile(p.id))
        } catch (e) {
          warnings.push(`Could not read "${p.name}": ${errorMessage(e)}`)
        }
      }
      const imported = await importDriveFiles(project, [...result.unreferencedImages, ...extraFiles])
      if (imported.added.length) {
        project = { ...project, images: [...project.images, ...imported.added] }
        dirty = true
        if (result.project) warnings.push(`Added ${imported.added.length} image(s) found in the folder that were not in the project yet.`)
      }
      for (const r of imported.rejected) warnings.push(`${r.name}: ${r.reason}`)

      const pid = project.id
      if (dirty) bump(seqKey(pid))
      await localWrite(null, () => local.replaceProject(project, docs, { projectId: pid, projectDirty: dirty, dirtyImages: [], lastDriveSaveAt: dirty ? undefined : now() }))
      await setOpen(project)
      return { project, annotations: new Map(docs.map((d) => [d.imageId, d])), ...(warnings.length ? { warnings } : {}) }
    },

    async importImagesFromDrive(project) {
      await ensureConnected()
      const { picker, client } = requireDrive()
      const stored = (await local.getProject(project.id)) ?? project
      const picks = await picker.pickFiles(pickerToken(), {
        title: 'Select images to add',
        parentId: stored.storage.kind === 'drive' ? stored.storage.folderId : undefined,
        mimeTypes: ACCEPTED_IMAGE_MIME_TYPES,
        multiselect: true,
      })
      if (!picks.length) return { added: [], rejected: [] }
      const files: DriveFile[] = []
      const rejected: ImportResult['rejected'] = []
      for (const p of picks) {
        try {
          files.push(await client.getFile(p.id))
        } catch (e) {
          rejected.push({ name: p.name, reason: errorMessage(e) })
        }
      }
      const res = await importDriveFiles(project, files)
      return { added: res.added, rejected: [...rejected, ...res.rejected] }
    },

    async saveToDrive(projectId, opts = {}) {
      await ensureConnected()
      const outcome = await push(projectId, opts.overwrite ?? false)
      if (outcome === 'conflict') refresh()
    },

    async takeRemote(projectId) {
      await ensureConnected()
      const { client } = requireDrive()
      const current = await local.requireProject(projectId)
      if (!isDriveLinked(current)) throw new Error('This project is not linked to Google Drive.')
      const pulled = await pullFolder(client, current.storage.folderId, now)
      if (!pulled.project) throw new DriveError('not-found', `The Drive folder "${pulled.folder.name}" no longer contains project.json, so there is no Drive version to load.`)

      // 1. Keep the local version as a separate, local-only backup project.
      const backupId = newId()
      const localDocs = await local.getAnnotations(projectId)
      const stamp = now()
      const backup: Project = { ...current, id: backupId, name: `${current.name} (local copy ${stamp.slice(0, 16).replace('T', ' ')})`, storage: { kind: 'local' }, updatedAt: stamp }
      await localWrite(null, async () => {
        for (const img of current.images) {
          const blob = await local.getBlob(projectId, img.id)
          if (blob) await local.putBlob(backupId, img.id, blob)
        }
        await local.saveProject(backup, localDocs.map((d) => ({ ...d, projectId: backupId })), { projectId: backupId, projectDirty: false, dirtyImages: [] })
      })

      // 2. Replace the linked project with the Drive version (same local ID).
      const project: Project = { ...pulled.project, id: projectId, storage: { ...pulled.project.storage, account: session.accountEmail } }
      const docs = [...pulled.annotations.values()].map((d) => ({ ...d, projectId }))
      await localWrite(projectId, () => local.replaceProject(project, docs, { projectId, projectDirty: false, dirtyImages: [], lastDriveSaveAt: now() }))
      const warnings = [`Your previous version was kept as the local project "${backup.name}".`, ...pulled.warnings]
      if (pulled.inaccessible.length) warnings.push(`${pulled.inaccessible.length} file(s) in the Drive folder could not be read.`)
      await setOpen(project)
      return { project, annotations: new Map(docs.map((d) => [d.imageId, d])), warnings }
    },
  }

  /** Background md5 check for cached Drive images (once per image per session). */
  const checkedImages = new Set<string>()
  async function checkRemoteImage(projectId: ID, image: ImageRecord): Promise<void> {
    const key = seqKey(projectId, image.id)
    if (checkedImages.has(key) || image.source.kind !== 'drive') return
    checkedImages.add(key)
    try {
      const file = await requireDrive().client.getFile(image.source.fileId)
      const checked = detectReplacement(image, file, now)
      if (checked !== image) await recordImageSource(projectId, checked)
    } catch {
      // Offline or not granted: nothing to report here; the save path surfaces real problems.
    }
  }

  async function recordImageSource(projectId: ID, image: ImageRecord): Promise<void> {
    await withLock(async () => {
      const latest = await local.getProject(projectId)
      if (!latest) return
      const updated: Project = {
        ...latest,
        images: latest.images.map((i) => (i.id === image.id ? { ...i, source: image.source, sourceMismatch: image.sourceMismatch } : i)),
      }
      await local.saveProject(updated)
      notify(updated)
    })
  }

  refresh()
  return repo
}
