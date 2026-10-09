/**
 * Contract between the app (src/state, src/ui) and persistence (src/storage).
 * Framework-free: no Solid or other UI library types cross this boundary;
 * src/state adapts `subscribe` to signals.
 *
 * Model: the browser's IndexedDB copy is ALWAYS the working copy and is written
 * on every change. A project may additionally be linked to a Google Drive folder
 * (the folder IS the project). Drive saves never discard the local copy.
 *
 * Sessions: project-scoped operations live on a `ProjectSession`, obtained from
 * `create` / `open` / `importArchive` / `openFromDrive`. At most ONE session is
 * open at a time: obtaining a new one closes the previous one, after which its
 * methods reject. Repository-level status (`getStatus`) describes the open
 * session (or `idle` / a startup storage failure when none is open).
 *
 * Folder / archive layout (identical for Drive folders and exported .zip files):
 *   project.json
 *   summary.csv
 *   annotations/<imageId>.json
 *   images/<original file name>     (Drive: any images in the folder; zip: images/<imageId>.<ext>)
 */
import type { ID, ImageAnnotations, ImageRecord, Project } from '../model/types'

export type SaveStatus =
  | { state: 'idle' } // no project open
  | { state: 'saved-local'; at: string }
  | { state: 'local-error'; message: string } // IndexedDB write failed — must be visible
  | { state: 'pending' } // linked to Drive, local changes not yet on Drive
  | { state: 'saving-drive' }
  | { state: 'saved-drive'; at: string }
  | { state: 'reconnect-required' }
  | { state: 'failed'; message: string }
  | { state: 'conflict'; files: string[] }

export type DriveState =
  | { state: 'unconfigured' } // no client ID configured in this build
  | { state: 'disconnected' }
  | { state: 'connecting' }
  | { state: 'connected'; account?: string; expiresAt: number }
  | { state: 'expired'; account?: string }

/** How a local project gets its Drive folder. */
export type DriveLinkMode = 'create-folder' | 'pick-folder'

export interface ProjectSummary {
  id: ID
  name: string
  updatedAt: string
  imageCount: number
  storage: 'local' | 'drive'
  driveFolderName?: string
}

/** Full contents of a project as stored (what the editor loads). */
export interface ProjectSnapshot {
  project: Project
  /** Keyed by imageId. Missing entries mean "no annotations yet". */
  annotations: Map<ID, ImageAnnotations>
  /** Non-fatal problems found while opening/importing (missing files, replaced images, ...). */
  warnings?: string[]
}

export interface ImportResult {
  added: ImageRecord[]
  rejected: { name: string; reason: string }[]
}

export interface ProjectRepository {
  /** Save status of the open session (idle when none; local-error if storage is unusable). */
  getStatus(): SaveStatus
  getDriveState(): DriveState
  /** Called after any change of getStatus() or getDriveState(). Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void

  list(): Promise<ProjectSummary[]>
  /** Create a new local project and open it. */
  create(name: string): Promise<ProjectSession>
  open(id: ID): Promise<ProjectSession>
  /** Import a .zip produced by exportZip as a new local project (IDs kept unless they collide) and open it. */
  importArchive(file: File): Promise<ProjectSession>
  /** Pick a Drive folder and open it as a project (reads project.json + annotations + images). */
  openFromDrive(): Promise<ProjectSession>
  /** Delete the browser copy (never touches Drive). Closes the session if it is the open project. */
  delete(id: ID): Promise<void>

  /**
   * Sign in to Google. Opens a popup when no valid token exists, so call it
   * synchronously from the user's click (Safari blocks popups after an await).
   */
  connectDrive(): Promise<void>
  disconnectDrive(): Promise<void>
}

/**
 * The open project. Storage owns `project.storage`, `project.revision`
 * and each image's `source` / `sourceMismatch`
 * (see model/project.ts `applyStorageOwned`): `save` keeps storage's values for
 * these, and `onUpdated` reports every change storage makes to them.
 */
export interface ProjectSession {
  readonly projectId: ID
  /** Contents when the session was opened. */
  readonly opened: ProjectSnapshot
  /** True once another session replaced this one or the project was deleted. */
  readonly closed: boolean

  /**
   * Persist to IndexedDB now (callers debounce). `changedDocs` = only the docs that changed.
   * If the project is Drive-linked this marks it pending and schedules a debounced Drive save.
   */
  save(project: Project, changedDocs: ImageAnnotations[]): Promise<void>
  /** Storage changed storage-owned fields; merge them with `applyStorageOwned`. */
  onUpdated(listener: (project: Project) => void): () => void

  images: {
    /** Decode, measure (EXIF-oriented), fingerprint and store images. Rejects unsupported formats clearly. */
    import(files: File[]): Promise<ImportResult>
    /** Add images that already exist in Drive (Picker). Requires a Drive connection. */
    importFromDrive(): Promise<ImportResult>
    /** Original bytes from the local cache, fetching from Drive if needed. */
    blob(imageId: ID): Promise<Blob>
    // There is no remove: removing an image is a soft delete the editor records in
    // project.json (ImageRecord.deletedAt). Storage never erases image bytes or documents.
  }

  /** Download as a .zip (same layout as the Drive folder). */
  exportZip(): Promise<Blob>
  /** Summary CSV derived from the annotation documents. */
  exportCsv(): Promise<Blob>

  drive: {
    /**
     * Link this local project to a Drive folder (create one, or pick an empty one) and
     * upload it. Storage-owned changes arrive through `onUpdated`; nothing is reloaded.
     * Resolves with non-fatal warnings (e.g. the first upload failed).
     */
    link(mode: DriveLinkMode): Promise<{ warnings: string[] }>
    /** Push local state to Drive now. `overwrite` resolves a conflict in favour of local. */
    push(opts?: { overwrite?: boolean }): Promise<void>
    /**
     * Resolve a conflict in favour of Drive: the local copy is kept as a separate
     * backup project and the session's project is replaced by the Drive version.
     */
    takeRemote(): Promise<ProjectSnapshot>
  }

  /** Stop background work for this project. Idempotent. */
  close(): void
}
