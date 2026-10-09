/**
 * Editor state: the open project, per-image annotation documents, selection,
 * tool and per-image undo/redo. One Solid store is shared by small slices
 * (annotations, groups, images, imageGroups, view, projects, drive), each with
 * its own interface; containers take only the slices they use.
 *
 * Persistence: a debounced autosave writes to the open ProjectSession.
 * Storage-owned fields arrive through session.onUpdated and are merged with
 * applyStorageOwned — the editor never reloads the project to pick them up.
 */
import { batch, createRoot, createSignal, type Accessor } from 'solid-js'
import { createStore, reconcile, unwrap } from 'solid-js/store'
import type { ID, ImageAnnotations, Project } from '../../model/types'
import { makeGroup } from '../../model/groups'
import { newId, now } from '../../model/ids'
import { applyStorageOwned, displayOrder, docForSave } from '../../model/project'
import type { DriveState, ProjectRepository, ProjectSession, SaveStatus } from '../../storage/api'
import { isCancelled } from '../../storage/errors'
import { createAutosaver } from '../autosave'
import { noFeedback, type Feedback } from '../feedback'
import type { Confirm, Notify } from '../messages'
import { prefs } from '../prefs'
import { createAnnotations, type AnnotationCommands } from './annotations'
import { errorText, type EditorContext, type EditorState } from './context'
import { createDrive, type DriveCommands } from './drive'
import { createGroups, type GroupCommands } from './groups'
import { createImageGroups, type ImageGroupCommands } from './imageGroups'
import { createImages, type ImageCommands } from './images'
import { createProjects, type ProjectCommands } from './projects'
import { createView, type ViewCommands } from './view'
import { createVersions, type VersionCommands, type VersionOptions } from './versions'

export type { EditorState } from './context'
export type { AnnotationCommands, BatchOptions, ClearScope, ClearSummary } from './annotations'
export type { GroupCommands } from './groups'
export type { ImageCommands } from './images'
export type { ImageGroupCommands } from './imageGroups'
export type { ProjectCommands } from './projects'
export type { DriveCommands } from './drive'
export type { ViewCommands } from './view'
export type { VersionCommands, SnapshotOutcome } from './versions'

export interface EditorDeps {
  notify: Notify
  /** Ask the user a yes/no question (e.g. discard changes that could not be saved). */
  confirm: Confirm
  /** Edit feedback port (sound cues); default: none. */
  feedback?: Feedback
  /** Autosave debounce in ms (tests). */
  autosaveDelay?: number
  /** Automatic version timing (tests). */
  versions?: VersionOptions
}

export interface Editor {
  /** Read-only reactive state. Change it ONLY through the slices below. */
  readonly state: EditorState
  /** Save status of the open project (from storage). */
  readonly saveStatus: Accessor<SaveStatus>
  /** True while edits wait for (or are in) the debounced local save. */
  readonly isDirty: Accessor<boolean>
  /** When the editor last became dirty (ms epoch), or null when everything is saved locally. */
  readonly dirtySince: Accessor<number | null>
  /** The last local save failed and nothing has been saved since. */
  readonly saveFailed: Accessor<boolean>

  readonly annotations: AnnotationCommands
  readonly groups: GroupCommands
  readonly images: ImageCommands
  readonly imageGroups: ImageGroupCommands
  readonly view: ViewCommands
  readonly projects: ProjectCommands
  readonly drive: DriveCommands
  /** Version history (local snapshots) and the `beforeDestructive` hook. */
  readonly versions: VersionCommands

  /** Stop reactive computations and storage subscriptions. */
  dispose(): void
}

export function createEditor(repo: ProjectRepository, deps: EditorDeps): Editor {
  return createRoot((disposeRoot) => {
    const { notify, confirm } = deps
    const [state, setState] = createStore<EditorState>({
      phase: 'loading',
      projects: [],
      project: null,
      docs: {},
      history: {},
      currentImageId: null,
      activeGroupId: null,
      tool: 'add',
      touchAnnotates: prefs.get('touchAnnotates', false),
      importing: 0,
      busy: null,
      loadCount: 0,
    })

    // ---------------------------------------------------------------- storage status → signals
    const [saveStatus, setSaveStatus] = createSignal<SaveStatus>(repo.getStatus())
    const [driveState, setDriveState] = createSignal<DriveState>(repo.getDriveState())
    const unsubscribeRepo = repo.subscribe(() => {
      setSaveStatus(repo.getStatus())
      setDriveState(repo.getDriveState())
    })

    // ---------------------------------------------------------------- session + autosave
    let session: ProjectSession | null = null
    let unsubscribeSession: (() => void) | null = null
    const [dirty, setDirty] = createSignal(false)
    const [dirtySince, setDirtySince] = createSignal<number | null>(null)
    const [saveFailed, setSaveFailed] = createSignal(false)

    const saver = createAutosaver({
      delay: deps.autosaveDelay ?? 400,
      async save(docIds) {
        const project = state.project
        if (!project || !session) return
        const snapshot = structuredClone(unwrap(project)) as Project
        const docs: ImageAnnotations[] = []
        for (const id of docIds) {
          const image = snapshot.images.find((i) => i.id === id)
          const doc = state.docs[id]
          if (image && doc) docs.push(structuredClone(docForSave(snapshot, image, unwrap(doc))))
        }
        await session.save(snapshot, docs)
      },
      onDirtyChange(d) {
        if (d) onChange()
        batch(() => {
          setDirty(d)
          setDirtySince(d ? Date.now() : null)
          if (!d) setSaveFailed(false)
        })
      },
      onError(err) {
        setSaveFailed(true)
        console.error('Local save failed', err)
        notify({
          tone: 'error',
          key: 'save-error',
          message: 'Couldn’t save changes in this browser',
          detail: errorText(err) + ' Your edits are still open — keep this tab open and try again.',
        })
      },
    })

    /** Merge storage-owned fields reported by storage (never touches editor-owned data). */
    function applyStorageUpdate(stored: Project) {
      const current = state.project
      if (!current || stored.id !== current.id) return
      const merged = applyStorageOwned(unwrap(current), stored)
      batch(() => {
        setState('project', 'storage', merged.storage)
        setState('project', 'revision', merged.revision)
        setState('project', 'images', reconcile(merged.images, { key: 'id' }))
      })
    }

    // Late-bound hooks of the versions slice (created after the context).
    let onChange = () => {}
    let onLoaded = () => {}

    // ---------------------------------------------------------------- context
    const ctx: EditorContext = {
      state,
      setState,
      repo,
      saver,
      notify,
      confirm,
      feedback: deps.feedback ?? noFeedback,
      session: () => session,

      load(next, snapshot = next.opened) {
        unsubscribeSession?.()
        session = next
        unsubscribeSession = next.onUpdated(applyStorageUpdate)
        const project = structuredClone(snapshot.project) as Project
        let needsSave = false
        if (project.annotationGroups.length === 0) {
          project.annotationGroups = [makeGroup([], newId())]
          needsSave = true
        }
        const docs: Record<ID, ImageAnnotations> = {}
        for (const [id, doc] of snapshot.annotations) docs[id] = { ...structuredClone(doc), detectionRuns: doc.detectionRuns ?? [] }
        const order = displayOrder(project)
        const lastImage = prefs.get<string | null>(`lastImage:${project.id}`, null)
        const current = order.find((i) => i.id === lastImage) ?? order[0] ?? null
        saver.reset()
        // Top-level setState REPLACES docs/history (a path set would merge old keys in).
        setState({
          phase: 'ready',
          project,
          docs,
          history: {},
          currentImageId: current?.id ?? null,
          activeGroupId: project.annotationGroups[0]?.id ?? null,
          loadCount: state.loadCount + 1,
        })
        prefs.set('lastProject', project.id)
        onLoaded()
        if (needsSave) ctx.touchProject()
        if (snapshot.warnings?.length) {
          notify({
            tone: 'warning',
            message: snapshot.warnings.length === 1 ? 'Opened with a warning' : `Opened with ${snapshot.warnings.length} warnings`,
            detail: snapshot.warnings.slice(0, 3).join(' · '),
          })
        }
      },

      unload() {
        unsubscribeSession?.()
        unsubscribeSession = null
        session = null
        saver.reset()
        setState({ project: null, docs: {}, history: {}, currentImageId: null, activeGroupId: null, phase: 'empty' })
      },

      touchProject() {
        if (!state.project) return
        setState('project', 'updatedAt', now())
        saver.markProject()
      },
      touchDoc(imageId) {
        if (state.docs[imageId]) setState('docs', imageId, 'updatedAt', now())
        saver.markDoc(imageId)
      },
      groupById: (id) => state.project?.annotationGroups.find((g) => g.id === id),

      editsFrozen() {
        const busy = state.busy
        if (!busy?.blocking) return false
        notify({ tone: 'info', key: 'busy', message: `Please wait — ${busy.label.replace(/…$/, '')}`, detail: 'Changes are paused until it finishes.' })
        ctx.feedback({ type: 'refused', reason: 'busy' })
        return true
      },

      async run(label, fn, failMessage, opts = {}) {
        setState('busy', { label, blocking: !!opts.blocking })
        try {
          return await fn()
        } catch (err) {
          // The user closed a Google popup/picker: not an error worth a toast.
          if (isCancelled(err)) return undefined
          console.error(failMessage, err)
          notify({ tone: 'error', message: failMessage, detail: errorText(err) })
          return undefined
        } finally {
          setState('busy', null)
        }
      },

      async guardUnsaved(action) {
        if (await saver.flush()) return true
        const verb = action.charAt(0).toLowerCase() + action.slice(1)
        return confirm({
          title: 'Discard unsaved changes?',
          body: `Your latest changes couldn’t be saved in this browser, so ${verb} would lose them. Keep editing to try again, or download a .zip of the project first. (${errorText(saver.lastError())})`,
          confirmLabel: 'Discard changes',
          cancelLabel: 'Keep editing',
          danger: true,
        })
      },

      ensureDriveAuth() {
        return repo.getDriveState().state === 'connected' ? Promise.resolve() : repo.connectDrive()
      },
    }

    const groups = createGroups(ctx)
    const annotations = createAnnotations(ctx, groups)
    const images = createImages(ctx)
    const imageGroups = createImageGroups(ctx)
    const view = createView(ctx)
    const projects = createProjects(ctx)
    const versions = createVersions(ctx, annotations, deps.versions)
    onChange = versions.noteChange
    onLoaded = versions.sessionLoaded
    const drive = createDrive(ctx, driveState, projects.refresh, versions.commands)

    return {
      state,
      saveStatus,
      isDirty: dirty,
      dirtySince,
      saveFailed,
      annotations,
      groups,
      images,
      imageGroups,
      view,
      projects,
      drive,
      versions: versions.commands,
      dispose() {
        versions.dispose()
        unsubscribeRepo()
        unsubscribeSession?.()
        disposeRoot()
      },
    }
  })
}
