/**
 * IndexedDB working copy: projects, per-image annotation documents, original
 * image blobs and per-project Drive sync bookkeeping.
 *
 * Stores (DB "cfu-count", version 1):
 *   projects     key: id                       value: Project
 *   annotations  key: [projectId, imageId]     value: ImageAnnotations
 *   blobs        key: [projectId, imageId]     value: { projectId, imageId, blob }
 *   sync         key: projectId                value: SyncState (dirty flags + Drive bookkeeping)
 *
 * Image blobs are keyed per project because an imported archive may legitimately
 * reuse image IDs from another local project.
 */
import type { ID, ImageAnnotations, Project } from '../model/types'
import { LocalStorageError, toLocalError } from './errors'
import { openDatabase, promisifyRequest, runTransaction } from './idb'

export const DB_NAME = 'cfu-count'
const DB_VERSION = 1

/**
 * Drive file IDs of the outputs this browser writes for a linked project, plus
 * the content token (Drive `md5Checksum`) of each as last read/written here, used
 * for conflict checks. `version` is not used because it also changes on
 * metadata-only edits (rename, sharing). Storage-internal: not part of the model.
 */
export interface DriveFiles {
  projectJson?: string
  summaryCsv?: string
  annotationsFolder?: string
  imagesFolder?: string
  /** imageId -> Drive file ID of annotations/<imageId>.json */
  annotations: Record<ID, string>
  /** Drive file ID -> md5Checksum last read or written by this browser. */
  remoteVersions: Record<string, string>
}

export const emptyDriveFiles = (): DriveFiles => ({ annotations: {}, remoteVersions: {} })

/** Local-only sync bookkeeping; never exported or uploaded. */
export interface SyncState {
  projectId: ID
  /** project.json / summary.csv need uploading. */
  projectDirty: boolean
  /** Image IDs whose annotation documents changed since the last successful Drive save. */
  dirtyImages: ID[]
  lastDriveSaveAt?: string
  /** Present once the project is linked to a Drive folder. */
  drive?: DriveFiles
}

interface BlobRow {
  projectId: ID
  imageId: ID
  blob: Blob
}

export class LocalStore {
  private readonly factory: IDBFactory | undefined
  private readonly dbName: string
  private dbPromise: Promise<IDBDatabase> | null = null

  constructor(factory: IDBFactory | undefined, dbName = DB_NAME) {
    this.factory = factory
    this.dbName = dbName
  }

  private db(): Promise<IDBDatabase> {
    if (!this.factory) {
      return Promise.reject(
        new LocalStorageError('unavailable', 'This browser does not provide IndexedDB storage, so work cannot be kept locally.'),
      )
    }
    if (!this.dbPromise) {
      this.dbPromise = openDatabase(this.factory, {
        name: this.dbName,
        version: DB_VERSION,
        upgrade(db, oldVersion) {
          if (oldVersion < 1) {
            db.createObjectStore('projects', { keyPath: 'id' })
            const ann = db.createObjectStore('annotations', { keyPath: ['projectId', 'imageId'] })
            ann.createIndex('byProject', 'projectId')
            const blobs = db.createObjectStore('blobs', { keyPath: ['projectId', 'imageId'] })
            blobs.createIndex('byProject', 'projectId')
            db.createObjectStore('sync', { keyPath: 'projectId' })
          }
        },
        // Closed by a version change in another tab (or by the browser): reopen on next use.
        onClose: () => {
          this.dbPromise = null
        },
      }).catch((e) => {
        this.dbPromise = null // allow a later retry
        throw toLocalError(e, 'open browser storage')
      })
    }
    return this.dbPromise
  }

  private async run<T>(
    action: string,
    stores: string[],
    mode: IDBTransactionMode,
    body: (tx: IDBTransaction) => Promise<T> | T,
  ): Promise<T> {
    const db = await this.db()
    try {
      return await runTransaction(db, stores, mode, body)
    } catch (e) {
      throw toLocalError(e, action)
    }
  }

  listProjects(): Promise<Project[]> {
    return this.run('list projects', ['projects'], 'readonly', (tx) =>
      promisifyRequest(tx.objectStore('projects').getAll() as IDBRequest<Project[]>),
    )
  }

  getProject(id: ID): Promise<Project | undefined> {
    return this.run('read the project', ['projects'], 'readonly', (tx) =>
      promisifyRequest(tx.objectStore('projects').get(id) as IDBRequest<Project | undefined>),
    )
  }

  async requireProject(id: ID): Promise<Project> {
    const p = await this.getProject(id)
    if (!p) throw new LocalStorageError('not-found', 'This project no longer exists in this browser.')
    return p
  }

  /** Write a project and (optionally) annotation docs atomically. */
  saveProject(project: Project, annotations: ImageAnnotations[] = [], sync?: SyncState): Promise<void> {
    return this.run('save the project in this browser', ['projects', 'annotations', 'sync'], 'readwrite', (tx) => {
      tx.objectStore('projects').put(project)
      const store = tx.objectStore('annotations')
      for (const doc of annotations) store.put(doc)
      if (sync) tx.objectStore('sync').put(sync)
    })
  }

  /** Atomically replace a project's record, ALL its annotation docs and its sync state (blobs kept). */
  replaceProject(project: Project, annotations: ImageAnnotations[], sync: SyncState): Promise<void> {
    return this.run('save the project in this browser', ['projects', 'annotations', 'sync'], 'readwrite', async (tx) => {
      const store = tx.objectStore('annotations')
      const keys = await promisifyRequest(store.index('byProject').getAllKeys(project.id))
      for (const k of keys) store.delete(k)
      for (const doc of annotations) store.put(doc)
      tx.objectStore('projects').put(project)
      tx.objectStore('sync').put(sync)
    })
  }

  getAnnotations(projectId: ID): Promise<ImageAnnotations[]> {
    return this.run('read annotations', ['annotations'], 'readonly', (tx) =>
      promisifyRequest(
        tx.objectStore('annotations').index('byProject').getAll(projectId) as IDBRequest<ImageAnnotations[]>,
      ),
    )
  }

  putBlob(projectId: ID, imageId: ID, blob: Blob): Promise<void> {
    return this.run('store the image in this browser', ['blobs'], 'readwrite', (tx) => {
      const row: BlobRow = { projectId, imageId, blob }
      tx.objectStore('blobs').put(row)
    })
  }

  async getBlob(projectId: ID, imageId: ID): Promise<Blob | undefined> {
    const row = await this.run('read the image', ['blobs'], 'readonly', (tx) =>
      promisifyRequest(tx.objectStore('blobs').get([projectId, imageId]) as IDBRequest<BlobRow | undefined>),
    )
    return row?.blob
  }

  deleteProject(projectId: ID): Promise<void> {
    return this.run('delete the project', ['projects', 'annotations', 'blobs', 'sync'], 'readwrite', async (tx) => {
      tx.objectStore('projects').delete(projectId)
      tx.objectStore('sync').delete(projectId)
      for (const name of ['annotations', 'blobs']) {
        const keys = await promisifyRequest(tx.objectStore(name).index('byProject').getAllKeys(projectId))
        for (const k of keys) tx.objectStore(name).delete(k)
      }
    })
  }

  async getSync(projectId: ID): Promise<SyncState> {
    const s = await this.run('read sync state', ['sync'], 'readonly', (tx) =>
      promisifyRequest(tx.objectStore('sync').get(projectId) as IDBRequest<SyncState | undefined>),
    )
    return s ?? { projectId, projectDirty: false, dirtyImages: [] }
  }

  putSync(state: SyncState): Promise<void> {
    return this.run('save sync state', ['sync'], 'readwrite', (tx) => {
      tx.objectStore('sync').put(state)
    })
  }
}

/** Ask the browser not to evict our data under storage pressure (best effort, never throws). */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false
    if (await navigator.storage.persisted()) return true
    return await navigator.storage.persist()
  } catch {
    return false
  }
}
