/**
 * The shared editor context: ONE Solid store plus the collaborators every slice
 * needs. Slices (annotations, groups, images, imageGroups, view, projects,
 * drive) each receive this context and expose a small interface; they never
 * import each other except through explicit constructor arguments.
 *
 * Store rule: arrays in the store are REPLACED on every change, never mutated in
 * place (`setState('docs', id, 'annotations', newArray)`), so plain snapshots
 * (`unwrap`) change identity exactly when their content changes. The viewport
 * relies on this (see viewport/api.ts).
 */
import type { SetStoreFunction } from 'solid-js/store'
import type { AnnotationGroup, ID, ImageAnnotations, Project } from '../../model/types'
import type { Tool } from '../../model/tool'
import type { ProjectRepository, ProjectSession, ProjectSnapshot, ProjectSummary } from '../../storage/api'
import type { Autosaver } from '../autosave'
import type { ImageHistory } from '../history'
import type { Confirm, Notify } from '../messages'

export interface EditorState {
  /** loading = initial project list; empty = no project open; ready = project open. */
  phase: 'loading' | 'empty' | 'ready'
  projects: ProjectSummary[]
  project: Project | null
  /** Annotation documents keyed by imageId (missing = none yet). */
  docs: Record<ID, ImageAnnotations>
  /** Per-image undo/redo stacks. */
  history: Record<ID, ImageHistory>
  currentImageId: ID | null
  activeGroupId: ID | null
  tool: Tool
  touchAnnotates: boolean
  /** Number of files currently being imported (for progress UI). */
  importing: number
  /**
   * Long-running repository operation, or null. `blocking` operations replace the
   * project (open, take Drive version, ...): edits are refused while they run.
   */
  busy: { label: string; blocking: boolean } | null
  /**
   * Incremented whenever a project snapshot is loaded (open, import, take the Drive
   * version). Lets in-memory caches drop state even when the project id is unchanged.
   */
  loadCount: number
}

export interface RunOptions {
  /** Refuse edits while running (the operation replaces editor state). */
  blocking?: boolean
}

export interface EditorContext {
  readonly state: EditorState
  readonly setState: SetStoreFunction<EditorState>
  readonly repo: ProjectRepository
  readonly saver: Autosaver
  readonly notify: Notify
  readonly confirm: Confirm
  /** The open storage session (null when no project is open). */
  session(): ProjectSession | null
  /**
   * Make `session` the open project and load `snapshot` (default: what it opened with)
   * into the store: resets history and pending saves, subscribes to storage updates.
   */
  load(session: ProjectSession, snapshot?: ProjectSnapshot): void
  /** Forget the open project (after it was deleted). */
  unload(): void

  /** Mark project.json dirty (debounced save). */
  touchProject(): void
  /** Mark one annotation document dirty and bump its updatedAt. */
  touchDoc(imageId: ID): void
  groupById(id: ID): AnnotationGroup | undefined

  /** True (and explains why) when edits must be refused right now (blocking operation running). */
  editsFrozen(): boolean
  /** Run a repository operation with a busy label; errors become toasts, cancellation is silent. */
  run<T>(label: string, fn: () => Promise<T>, failMessage: string, opts?: RunOptions): Promise<T | undefined>
  /**
   * Save pending edits before an operation that would replace them. If the save
   * fails, ask the user whether to discard; false = abort the operation.
   */
  guardUnsaved(action: string): Promise<boolean>
  /**
   * Start Google sign-in if needed. MUST be called synchronously inside the user's
   * click (before any await) so Safari allows the popup.
   */
  ensureDriveAuth(): Promise<void>
}

export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  return typeof err === 'string' ? err : 'Unknown error.'
}
