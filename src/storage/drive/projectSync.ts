/**
 * Drive orchestration for ONE local project: push (with checkpoints and edit
 * counters), link, take-remote, open-from-folder, Drive image import and remote
 * image checks. It composes the pure sync engine (sync.ts) with the local
 * working copy (LocalStore) and the status of the open session (StorageCore).
 *
 * All Drive bookkeeping (output file IDs, content tokens) lives in the local
 * SyncState (`sync.drive`), never in the model.
 */
import type { ID, ImageAnnotations, ImageRecord, Project } from '../../model/types'
import { applyStorageOwned, isRemoved } from '../../model/project'
import { newId } from '../../model/ids'
import type { DriveLinkMode, ImportResult, ProjectSnapshot } from '../api'
import { DriveError, LocalStorageError, errorMessage } from '../errors'
import { ACCEPTED_IMAGE_MIME_TYPES, sha256Hex, type ImageDecoder } from '../images'
import { emptyDriveFiles, type LocalStore, type SyncState } from '../localStore'
import { FOLDER_MIME, type DriveClient, type DriveFile } from './client'
import type { DrivePicker, PickedItem } from './picker'
import type { DriveSession } from './session'
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
} from './sync'

/** Status inputs of the open session that Drive work updates. */
export interface OpenStatusPatch {
  linked?: boolean
  dirty?: boolean
  pushing?: boolean
  conflict?: string[] | undefined
  driveError?: string | undefined
  lastDriveSaveAt?: string
}

/** What the Drive orchestration needs from the repository. */
export interface StorageCore {
  local: LocalStore
  decoder: ImageDecoder
  session: DriveSession
  client: DriveClient
  picker: DrivePicker
  now(): string
  /** Serialises read-modify-write of project records (editor saves vs. Drive checkpoints). */
  withLock<T>(fn: () => Promise<T>): Promise<T>
  edits: EditCounters
  /** Report storage-owned changes to the open session's listeners. */
  notifyUpdated(project: Project): void
  /** Update status inputs if `projectId` is the open project (no-op otherwise). */
  patchOpen(projectId: ID, patch: OpenStatusPatch): void
  isOpen(projectId: ID): boolean
  /** Wrap a local write so failures surface as 'local-error'. */
  localWrite<T>(projectId: ID | null, fn: () => Promise<T>): Promise<T>
  /** Called after a push saved; the repository decides whether to schedule another. */
  onPushed(projectId: ID, stillDirty: boolean): void
  onRetryableFailure(): void
}

/**
 * Per-session edit counters, so a push only clears dirt it actually uploaded:
 * snapshot BEFORE reading what to upload, then clear a key only if its counter
 * did not move meanwhile.
 */
export class EditCounters {
  private readonly seq = new Map<string, number>()
  private static key(projectId: ID, imageId?: ID) {
    return imageId ? `${projectId}/${imageId}` : projectId
  }
  bump(projectId: ID, imageId?: ID): void {
    const k = EditCounters.key(projectId, imageId)
    this.seq.set(k, (this.seq.get(k) ?? 0) + 1)
  }
  snapshot(): (projectId: ID, imageId?: ID) => boolean {
    const start = new Map(this.seq)
    return (projectId, imageId) => {
      const k = EditCounters.key(projectId, imageId)
      return (this.seq.get(k) ?? 0) === (start.get(k) ?? 0)
    }
  }
}

export const isSyncDirty = (s: SyncState): boolean => s.projectDirty || s.dirtyImages.length > 0

export function createProjectSync(core: StorageCore) {
  const { local, session, client, picker, now } = core

  let pushChain: Promise<unknown> = Promise.resolve()

  /** Serialised push of one project. */
  function push(projectId: ID, overwrite: boolean, onlyIfDirty = false): Promise<'saved' | 'conflict' | 'clean'> {
    const run = pushChain.then(() => doPush(projectId, overwrite, onlyIfDirty))
    pushChain = run.catch(() => undefined)
    return run
  }

  async function doPush(projectId: ID, overwrite: boolean, onlyIfDirty: boolean): Promise<'saved' | 'conflict' | 'clean'> {
    // Snapshot the edit counters BEFORE reading anything: an edit saved after this point
    // keeps its dirt even if its bytes happen to be included in this upload.
    const unchangedSince = core.edits.snapshot()
    const project = await local.requireProject(projectId)
    if (!isDriveLinked(project)) throw new Error('This project is not linked to Google Drive.')
    session.accessToken() // throws 'unauthorized' early
    const docs = await local.getAnnotations(projectId)
    const sync = await local.getSync(projectId)
    if (onlyIfDirty && !isSyncDirty(sync)) return 'clean'

    core.patchOpen(projectId, { pushing: true })
    try {
      const result = await pushProject(client, {
        project,
        files: sync.drive ?? emptyDriveFiles(),
        annotations: new Map(docs.map((d) => [d.imageId, d])),
        dirtyImages: new Set(sync.dirtyImages),
        overwrite,
        loadImage: (imageId) => local.getBlob(projectId, imageId),
        checkpoint: (p, files, written) =>
          core.withLock(async () => {
            const latest = await local.requireProject(projectId)
            const merged = applyStorageOwned(latest, { ...p, revision: latest.revision })
            const s = await local.getSync(projectId)
            s.drive = files
            s.dirtyImages = s.dirtyImages.filter((id) => !(written.includes(id) && unchangedSince(projectId, id)))
            await local.saveProject(merged, [], s)
            core.notifyUpdated(merged)
          }),
      })
      if (result.kind === 'conflict') {
        core.patchOpen(projectId, { conflict: result.files })
        return 'conflict'
      }
      for (const w of result.warnings) console.warn('[drive]', w)
      const at = now()
      let stillDirty = false
      await core.withLock(async () => {
        const latest = await local.requireProject(projectId)
        const merged = applyStorageOwned(latest, {
          ...result.project,
          storage: { ...(result.project.storage as Extract<Project['storage'], { kind: 'drive' }>), account: session.accountEmail },
          revision: latest.revision,
        })
        const s = await local.getSync(projectId)
        s.drive = result.files
        if (unchangedSince(projectId)) s.projectDirty = false
        s.lastDriveSaveAt = at
        await local.saveProject(merged, [], s)
        core.notifyUpdated(merged)
        stillDirty = isSyncDirty(s)
      })
      core.patchOpen(projectId, { dirty: stillDirty, lastDriveSaveAt: at, conflict: undefined, driveError: undefined })
      core.onPushed(projectId, stillDirty)
      return 'saved'
    } catch (e) {
      core.patchOpen(projectId, { driveError: e instanceof DriveError && e.kind === 'unauthorized' ? undefined : errorMessage(e) })
      if (e instanceof DriveError && ['network', 'server', 'rate-limited'].includes(e.kind)) core.onRetryableFailure()
      throw e
    } finally {
      core.patchOpen(projectId, { pushing: false })
    }
  }

  /** Picker steps that grant drive.file access to files this app cannot see yet. */
  async function pullWithGrants(folder: PickedItem | DriveFile): Promise<{ result: PullResult; extraPicks: PickedItem[] }> {
    let result = await pullFolder(client, folder.id, now)
    let extraPicks: PickedItem[] = []
    if (!result.project) {
      extraPicks = await picker.pickFiles(session.accessToken(), {
        title: `Select project.json (if any) and the images in "${result.folder.name}"`,
        parentId: folder.id,
        mimeTypes: ['application/json', ...ACCEPTED_IMAGE_MIME_TYPES],
        multiselect: true,
      })
      if (extraPicks.some((p) => p.name === PROJECT_JSON)) result = await pullFolder(client, folder.id, now)
    }
    if (result.project && result.inaccessible.length) {
      const granted = await picker.pickFiles(session.accessToken(), {
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

  /** Download + register Drive images (skips files already in the project). Bytes go to the local cache. */
  async function importDriveFiles(project: Project, files: DriveFile[]): Promise<ImportResult> {
    const res: ImportResult = { added: [], rejected: [] }
    const known = new Map(project.images.flatMap((i) => (i.source.kind === 'drive' ? [[i.source.fileId, i] as const] : [])))
    const seen = new Set<string>()
    for (const f of files) {
      const existing = known.get(f.id)
      if (existing || seen.has(f.id)) {
        res.rejected.push({
          name: f.name,
          reason: existing && isRemoved(existing) ? `This Drive file was removed from the project as “${existing.name}”. Restore it from Recently removed.` : 'This Drive file is already in the project.',
        })
        continue
      }
      seen.add(f.id)
      try {
        const { record, blob } = await importDriveImage(client, f, core.decoder, now)
        await core.localWrite(project.id, () => local.putBlob(project.id, record.id, blob))
        res.added.push(record)
      } catch (e) {
        if (e instanceof LocalStorageError || (e instanceof DriveError && e.kind === 'unauthorized')) throw e
        res.rejected.push({ name: f.name, reason: errorMessage(e) })
      }
    }
    return res
  }

  /** Picker → Drive images added to the project's local cache (the editor adds the records). */
  async function importFromPicker(projectId: ID): Promise<ImportResult> {
    const stored = await local.requireProject(projectId)
    const picks = await picker.pickFiles(session.accessToken(), {
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
    const res = await importDriveFiles(stored, files)
    return { added: res.added, rejected: [...rejected, ...res.rejected] }
  }

  /**
   * Link a local project to a folder and upload it. Storage-owned changes are
   * reported through notifyUpdated; returns warnings (e.g. failed first upload).
   */
  async function link(projectId: ID, mode: DriveLinkMode): Promise<{ warnings: string[] }> {
    const project = await local.requireProject(projectId)
    let folder: DriveFile
    if (mode === 'create-folder') {
      folder = await client.create({ name: project.name, parents: ['root'], mimeType: FOLDER_MIME, appProperties: { cfuKey: 'dir:project', cfuProjectId: projectId } })
    } else {
      const picked = await picker.pickFolder(session.accessToken(), { title: `Choose a Drive folder for "${project.name}"` })
      if (!picked) throw new DriveError('cancelled', 'No folder was selected.')
      folder = await checkFolder(client, picked.id)
      const children = await client.listChildren(folder.id)
      if (children.some((f) => f.name === PROJECT_JSON)) {
        throw new DriveError('invalid', `"${folder.name}" already contains a project. Use "Open from Drive" to open it, or choose an empty folder.`)
      }
    }
    const docs = await local.getAnnotations(projectId)
    const linked = await core.withLock(async () => {
      const latest = await local.requireProject(projectId)
      const p: Project = { ...latest, storage: { ...newDriveLink(folder.id, folder.name), account: session.accountEmail } }
      core.edits.bump(projectId)
      const s = await local.getSync(projectId)
      await local.saveProject(p, [], { ...s, projectDirty: true, dirtyImages: docs.map((d) => d.imageId), drive: emptyDriveFiles() })
      return p
    })
    core.notifyUpdated(linked)
    core.patchOpen(projectId, { linked: true, dirty: true })
    const warnings: string[] = []
    try {
      await push(projectId, false)
    } catch (e) {
      warnings.push(`Linked to "${folder.name}", but the first upload failed: ${errorMessage(e)} Your work is safe in this browser; use Save to Drive to retry.`)
    }
    return { warnings }
  }

  /**
   * Pick a folder and bring it into the local store. Returns the local project ID
   * to open plus warnings; the caller opens the session.
   */
  async function openFolder(): Promise<{ projectId: ID; warnings: string[]; snapshot?: ProjectSnapshot }> {
    const picked = await picker.pickFolder(session.accessToken(), { title: 'Open a project folder from Google Drive' })
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
        if (sameFolder && isSyncDirty(localSync)) {
          warnings.push('This browser has changes to this project that are not on Drive yet, so the local copy was opened. Save to Drive to upload them; you will be asked if the Drive copy changed meanwhile.')
          return { projectId: existing.id, warnings }
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

    // The folder is the project: pull in visible images it does not reference yet (removed images are still referenced).
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
    if (dirty) core.edits.bump(pid)
    await core.localWrite(null, () =>
      local.replaceProject(project, docs, { projectId: pid, projectDirty: dirty, dirtyImages: [], lastDriveSaveAt: dirty ? undefined : now(), drive: result.files }),
    )
    return { projectId: pid, warnings, snapshot: { project, annotations: new Map(docs.map((d) => [d.imageId, d])) } }
  }

  /** Replace the local project with the Drive version, keeping the local one as a backup project. */
  async function takeRemote(projectId: ID): Promise<ProjectSnapshot> {
    const current = await local.requireProject(projectId)
    if (!isDriveLinked(current)) throw new Error('This project is not linked to Google Drive.')
    const pulled = await pullFolder(client, current.storage.folderId, now)
    if (!pulled.project) throw new DriveError('not-found', `The Drive folder "${pulled.folder.name}" no longer contains project.json, so there is no Drive version to load.`)

    // 1. Keep the local version as a separate, local-only backup project.
    const backupId = newId()
    const localDocs = await local.getAnnotations(projectId)
    const stamp = now()
    const backup: Project = { ...current, id: backupId, name: `${current.name} (local copy ${stamp.slice(0, 16).replace('T', ' ')})`, storage: { kind: 'local' }, updatedAt: stamp }
    await core.localWrite(null, async () => {
      for (const img of current.images) {
        const blob = await local.getBlob(projectId, img.id)
        if (blob) await local.putBlob(backupId, img.id, blob)
      }
      await local.saveProject(backup, localDocs.map((d) => ({ ...d, projectId: backupId })), { projectId: backupId, projectDirty: false, dirtyImages: [] })
    })

    // 2. Replace the linked project with the Drive version (same local ID).
    const project: Project = { ...pulled.project, id: projectId, storage: { ...pulled.project.storage, account: session.accountEmail } }
    const docs = [...pulled.annotations.values()].map((d) => ({ ...d, projectId }))
    await core.withLock(() =>
      core.localWrite(projectId, () => local.replaceProject(project, docs, { projectId, projectDirty: false, dirtyImages: [], lastDriveSaveAt: now(), drive: pulled.files })),
    )
    core.patchOpen(projectId, { dirty: false, conflict: undefined, driveError: undefined })
    const warnings = [`Your previous version was kept as the local project "${backup.name}".`, ...pulled.warnings]
    if (pulled.inaccessible.length) warnings.push(`${pulled.inaccessible.length} file(s) in the Drive folder could not be read.`)
    return { project, annotations: new Map(docs.map((d) => [d.imageId, d])), warnings }
  }

  /** Download an image that is not cached locally, flagging replaced files. */
  async function fetchImage(projectId: ID, image: ImageRecord & { source: { kind: 'drive' } }): Promise<Blob> {
    if (!session.isConnected) throw new DriveError('unauthorized', `Connect Google Drive to load "${image.name}".`)
    const file = await client.getFile(image.source.fileId)
    const blob = await client.download(file.id)
    let checked = detectReplacement(image, file, now)
    const fp = await sha256Hex(blob)
    if (fp !== image.fingerprint && !checked.sourceMismatch) {
      let dims: { width?: number; height?: number } = {}
      try {
        const s = await core.decoder(blob)
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
    await core.localWrite(projectId, () => local.putBlob(projectId, image.id, blob))
    if (checked !== image) await recordImageSource(projectId, checked)
    return blob
  }

  /** Background md5 check for cached Drive images (once per image per session). */
  const checkedImages = new Set<string>()
  async function checkRemoteImage(projectId: ID, image: ImageRecord): Promise<void> {
    const key = `${projectId}/${image.id}`
    if (checkedImages.has(key) || image.source.kind !== 'drive' || !session.isConnected) return
    checkedImages.add(key)
    try {
      const file = await client.getFile(image.source.fileId)
      const checked = detectReplacement(image, file, now)
      if (checked !== image) await recordImageSource(projectId, checked)
    } catch {
      // Offline or not granted: nothing to report here; the save path surfaces real problems.
    }
  }

  async function recordImageSource(projectId: ID, image: ImageRecord): Promise<void> {
    await core.withLock(async () => {
      const latest = await local.getProject(projectId)
      if (!latest) return
      const updated: Project = {
        ...latest,
        images: latest.images.map((i) => (i.id === image.id ? { ...i, source: image.source, sourceMismatch: image.sourceMismatch } : i)),
      }
      await local.saveProject(updated)
      core.notifyUpdated(updated)
    })
  }

  return { push, link, openFolder, takeRemote, importFromPicker, fetchImage, checkRemoteImage }
}

export type ProjectSync = ReturnType<typeof createProjectSync>
