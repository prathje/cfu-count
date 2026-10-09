/**
 * IndexedDB version history of one project (`ProjectSession.history`).
 *
 * A version = metadata + content keys. project.json (without revision/updatedAt)
 * and each annotation document are stored as deflated JSON parts keyed by content
 * hash, so a version only adds the documents that changed since earlier versions.
 * Image bytes are never part of a version: images are only ever soft-deleted.
 *
 * Every read of the working copy and every restore run inside the repository's
 * lock, so they are ordered with saves: a version requested before a save captures
 * the state before it. Retention runs after each new version (best effort).
 */
import type { ID, ImageAnnotations, Project } from '../model/types'
import { newId } from '../model/ids'
import type { ProjectSnapshot, VersionCreateResult, VersionHistory, VersionInfo, VersionReason } from './api'
import { LocalStorageError } from './errors'
import type { LocalStore, SyncState, VersionPart, VersionRecord } from './localStore'
import { buildRestoredState, computeCounts, contentKey, decodePayload, encodeJson, planQuotaRelief, planRetention, versionedProject, type RetentionPolicy } from './versions'

export interface VersionHistoryDeps {
  local: LocalStore
  projectId: ID
  /** The repository lock (serialises with saves and Drive checkpoints). */
  withLock<T>(fn: () => Promise<T>): Promise<T>
  /** Wraps working-copy writes so failures show as a local-error status. */
  localWrite<T>(fn: () => Promise<T>): Promise<T>
  now(): string
  /** Called inside the lock after a restore was written, with the sync state written (Drive-linked projects). */
  onRestored(project: Project, sync: SyncState | undefined): void
  retention?: RetentionPolicy
}

const AUTOMATIC: readonly VersionReason[] = ['session-start', 'periodic']
const QUOTA_RETRIES = 3

const info = (r: VersionRecord): VersionInfo => {
  const { project: _p, docs: _d, ...meta } = r
  return meta
}

export function createVersionHistory(deps: VersionHistoryDeps): VersionHistory {
  const { local, projectId, withLock, now } = deps

  /** Build a version record (and its parts not stored yet) from the saved working copy. */
  async function capture(reason: VersionReason, label: string): Promise<{ record: VersionRecord; parts: VersionPart[]; unchangedFrom?: VersionRecord }> {
    const project = await local.requireProject(projectId)
    const docs = await local.getAnnotations(projectId)
    const existing = await local.versionPartKeys(projectId)
    const parts: VersionPart[] = []
    const add = (value: unknown): string => {
      const json = JSON.stringify(value)
      const key = contentKey(json)
      if (!existing.has(key) && !parts.some((p) => p.key === key)) parts.push({ projectId, key, ...encodeJson(json) })
      return key
    }
    const projectKey = add(versionedProject(project))
    const docKeys: Record<ID, string> = {}
    for (const d of docs) docKeys[d.imageId] = add(d)
    const record: VersionRecord = {
      id: newId(),
      projectId,
      createdAt: now(),
      reason,
      label,
      counts: computeCounts(project, docs),
      storedBytes: parts.reduce((n, p) => n + p.data.length, 0),
      project: projectKey,
      docs: docKeys,
    }
    let unchangedFrom: VersionRecord | undefined
    if (AUTOMATIC.includes(reason) && parts.length === 0) {
      const latest = newest(await local.listVersions(projectId))
      if (latest && latest.project === projectKey && sameDocs(latest.docs, docKeys)) unchangedFrom = latest
    }
    return { record, parts, unchangedFrom }
  }

  async function prune(): Promise<void> {
    try {
      const doomed = planRetention(await local.listVersions(projectId), Date.parse(now()), deps.retention)
      if (doomed.size) await local.deleteVersions(projectId, [...doomed])
    } catch (e) {
      console.warn('[history] pruning old versions failed', e)
    }
  }

  /**
   * Capture and store a version. On a quota error, remove older automatic versions
   * and try again (capturing afresh: removed versions may have taken shared parts along).
   */
  async function createLocked(reason: VersionReason, label: string): Promise<VersionCreateResult> {
    let relieved = 0
    for (let attempt = 0; ; attempt++) {
      const { record, parts, unchangedFrom } = await capture(reason, label)
      if (unchangedFrom) return { version: info(unchangedFrom), created: false }
      try {
        await local.putVersion(record, parts)
      } catch (e) {
        if (!(e instanceof LocalStorageError && e.code === 'quota') || attempt >= QUOTA_RETRIES) throw e
        const victims = planQuotaRelief(await local.listVersions(projectId), Date.parse(now()), deps.retention)
        if (!victims.length) throw e
        await local.deleteVersions(projectId, victims)
        relieved += victims.length
        continue
      }
      await prune()
      const warning = relieved
        ? `Browser storage is nearly full, so ${relieved === 1 ? 'an older automatic version was' : `${relieved} older automatic versions were`} removed to make room. Download a .zip of important projects or free up space.`
        : undefined
      return { version: info(record), created: true, ...(warning ? { warning } : {}) }
    }
  }

  async function loadRecord(id: ID): Promise<{ record: VersionRecord; project: Omit<Project, 'revision' | 'updatedAt'>; docs: Map<ID, ImageAnnotations> }> {
    const record = await local.getVersion(id)
    if (!record || record.projectId !== projectId) throw new LocalStorageError('not-found', 'This version no longer exists in this browser.')
    const keys = [record.project, ...Object.values(record.docs)]
    const parts = await local.getVersionParts(projectId, keys)
    const missing = keys.filter((k) => !parts.has(k))
    if (missing.length) throw new LocalStorageError('not-found', 'This version is incomplete in this browser storage and cannot be opened.')
    const project = decodePayload<Omit<Project, 'revision' | 'updatedAt'>>(parts.get(record.project)!.data)
    const docs = new Map<ID, ImageAnnotations>()
    for (const [imageId, key] of Object.entries(record.docs)) docs.set(imageId, decodePayload<ImageAnnotations>(parts.get(key)!.data))
    return { record, project, docs }
  }

  return {
    async list() {
      const records = await local.listVersions(projectId)
      return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(info)
    },

    // withLock is entered synchronously: a create() issued before a save reads the pre-save state.
    create: (reason, label) => withLock(() => createLocked(reason, label)),

    async load(id): Promise<ProjectSnapshot> {
      const { record, project, docs } = await loadRecord(id)
      return { project: { ...project, revision: 0, updatedAt: record.createdAt } as Project, annotations: docs }
    },

    restore: (id) =>
      withLock(async () => {
        const version = await loadRecord(id)
        const when = new Date(version.record.createdAt)
        const backup = await createLocked('before-restore', `Before restoring the version from ${formatStamp(when)}`)
        const current = { project: await local.requireProject(projectId), docs: await local.getAnnotations(projectId) }
        const at = now()
        const restored = buildRestoredState(current, version, at)
        restored.project.revision = (current.project.revision ?? 0) + 1
        const sync = await local.getSync(projectId)
        const linked = restored.project.storage.kind === 'drive'
        if (linked) {
          // Pending like any other edit: the next push uploads everything (conflict checks unchanged).
          sync.projectDirty = true
          sync.dirtyImages = [...new Set([...sync.dirtyImages, ...restored.docs.map((d) => d.imageId)])]
        }
        await deps.localWrite(() => local.replaceProject(restored.project, restored.docs, sync))
        deps.onRestored(restored.project, linked ? sync : undefined)
        return {
          snapshot: { project: structuredClone(restored.project), annotations: new Map(restored.docs.map((d) => [d.imageId, structuredClone(d)])) },
          backup: backup.version,
        }
      }),

    async delete(id) {
      await withLock(() => local.deleteVersions(projectId, [id]))
    },
  }
}

function newest(records: VersionRecord[]): VersionRecord | undefined {
  let best: VersionRecord | undefined
  for (const r of records) if (!best || r.createdAt > best.createdAt) best = r
  return best
}

function sameDocs(a: Record<ID, string>, b: Record<ID, string>): boolean {
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  return ka.every((k) => a[k] === b[k])
}

/** "9 Oct, 14:32" in the user's locale (used in labels stored with versions). */
export function formatStamp(d: Date): string {
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
}
