/**
 * Contract between the app (src/state, src/ui) and persistence (src/storage).
 *
 * Model: the browser's IndexedDB copy is ALWAYS the working copy and is written
 * on every change. A project may additionally be linked to a Google Drive folder
 * (the folder IS the project). Drive saves never discard the local copy.
 *
 * Folder / archive layout (identical for Drive folders and exported .zip files):
 *   project.json
 *   summary.csv
 *   annotations/<imageId>.json
 *   images/<original file name>     (Drive: any images in the folder; zip: images/<imageId>.<ext>)
 */
import type { Accessor } from 'solid-js'
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

export interface ProjectSummary {
  id: ID
  name: string
  updatedAt: string
  imageCount: number
  storage: 'local' | 'drive'
  driveFolderName?: string
}

export interface OpenedProject {
  project: Project
  /** Keyed by imageId. Missing entries mean "no annotations yet". */
  annotations: Map<ID, ImageAnnotations>
}

export interface ImportResult {
  added: ImageRecord[]
  rejected: { name: string; reason: string }[]
}

export interface ProjectRepository {
  /** Save status of the currently open project. */
  readonly status: Accessor<SaveStatus>
  readonly drive: Accessor<DriveState>

  listProjects(): Promise<ProjectSummary[]>
  createProject(name: string): Promise<OpenedProject>
  openProject(id: ID): Promise<OpenedProject>
  deleteProject(id: ID): Promise<void>

  /**
   * Persist to IndexedDB now (callers debounce). `annotations` = only the docs that changed.
   * If the project is Drive-linked this marks it 'pending' and schedules a debounced Drive save.
   */
  saveLocal(project: Project, annotations: ImageAnnotations[]): Promise<void>

  /** Decode, measure (EXIF-oriented), fingerprint and store images. Rejects unsupported formats clearly. */
  importImageFiles(project: Project, files: File[]): Promise<ImportResult>
  /** Original bytes from local cache, fetching from Drive if needed. */
  getImageBlob(project: Project, imageId: ID): Promise<Blob>
  removeImage(project: Project, imageId: ID): Promise<void>

  /** Download project as a .zip (same layout as the Drive folder). */
  exportArchive(projectId: ID): Promise<Blob>
  /** Import a .zip produced by exportArchive (new local project; IDs preserved, conflicts get a new project ID). */
  importArchive(file: File): Promise<OpenedProject>
  /** Summary CSV for the project (derived from annotation docs). */
  exportSummaryCsv(projectId: ID): Promise<Blob>

  // ---- Google Drive ----
  connectDrive(): Promise<void>
  disconnectDrive(): Promise<void>
  /** Link a local project to a Drive folder (pick existing or create new) and upload it. */
  linkProjectToDrive(projectId: ID, mode: 'create-folder' | 'pick-folder'): Promise<OpenedProject>
  /** Pick a Drive folder and open it as a project (reads project.json + annotations + images). */
  openProjectFromDrive(): Promise<OpenedProject>
  /** Add images that already exist in Drive (Picker) to the project. */
  importImagesFromDrive(project: Project): Promise<ImportResult>
  /** Push local state to Drive now. `overwrite` resolves a conflict in favour of local. */
  saveToDrive(projectId: ID, opts?: { overwrite?: boolean }): Promise<void>
  /** Resolve a conflict in favour of the remote copy (local copy is kept as a backup project). */
  takeRemote(projectId: ID): Promise<OpenedProject>
}
