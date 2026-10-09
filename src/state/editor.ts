/**
 * Editor state: the open project, per-image annotation documents, selection,
 * tool, and per-image undo/redo history. All mutations go through the commands
 * returned by createEditor(); persistence is a debounced autosave to the
 * ProjectRepository.
 */
import { batch, createMemo, createRoot, createSignal, type Accessor } from 'solid-js'
import { createStore, produce, unwrap } from 'solid-js/store'
import type { Annotation, AnnotationGroup, DetectionRun, ID, ImageAnnotations, ImageRecord, Project } from '../model/types'
import { newId, now } from '../model/ids'
import type { DriveState, OpenedProject, ProjectRepository, ProjectSummary, SaveStatus } from '../storage/api'
import type { Tool } from '../viewport/api'
import { createAutosaver } from './autosave'
import {
  applyOps,
  checkOps,
  clampStyle,
  confirmedCount,
  confirmedCountsByGroup,
  DEFAULT_LABEL_SIZE,
  displayOrder,
  docForSave,
  emptyDoc,
  groupEditBlock,
  makeGroup,
  makeManualAnnotation,
  moveItem,
  uniqueName,
  visibilitySplit,
  type AnnotationOp,
  type EditBlock,
  type GroupStylePatch,
} from './core'
import { dropEntriesForGroup, emptyHistory, planRedo, planUndo, record, type ImageHistory } from './history'
import { hiddenMessage, historyBlockMessage, lockedMessage, type Notify } from './messages'
import { prefs } from './prefs'
import { isCancelled } from '../storage/errors'

export interface EditorState {
  /** loading = initial project list; empty = no project open; ready = project open. */
  phase: 'loading' | 'empty' | 'ready'
  projects: ProjectSummary[]
  project: Project | null
  /** Annotation documents keyed by imageId (missing = none yet). */
  docs: Record<ID, ImageAnnotations>
  currentImageId: ID | null
  activeGroupId: ID | null
  tool: Tool
  touchAnnotates: boolean
  /** Number of files currently being imported (for progress UI). */
  importing: number
  /** Long-running repository operation label (e.g. "Opening project…"), or null. */
  busy: string | null
}

export interface BatchOptions {
  /** Shown in undo/redo messages, e.g. "Accept 24 suggestions". */
  label: string
  /**
   * Provenance of an automated batch. Appended to the image's detectionRuns in the
   * same undo step (removed again on undo, restored on redo).
   */
  detectionRun?: DetectionRun
}

/**
 * The editor's command API. UI containers read state through `state` and the
 * derived accessors, and change it ONLY through these methods (no direct store
 * writes). Commands that can be refused (locked/hidden groups) explain why via
 * the Notify callback and return false / the block.
 */
export interface Editor {
  /** Read-only reactive state. */
  readonly state: EditorState
  /** Per-image undo/redo stacks (read-only; use undo/redo). */
  readonly history: Readonly<Record<ID, ImageHistory>>

  // ---- derived (reactive) ----
  /** Save status of the open project, from the repository. */
  saveStatus: Accessor<SaveStatus>
  /** Google Drive connection state, from the repository. */
  driveState: Accessor<DriveState>
  /** True while edits wait for (or are in) the debounced local save. */
  isDirty: Accessor<boolean>
  currentImage: Accessor<ImageRecord | null>
  currentAnnotations: Accessor<Annotation[]>
  groups: Accessor<AnnotationGroup[]>
  activeGroup: Accessor<AnnotationGroup | undefined>
  /** Confirmed count per annotation group on the current image. */
  groupCounts: Accessor<Map<ID, number>>
  /** Confirmed total on the current image (hidden groups included). */
  total: Accessor<number>
  /** Confirmed annotations on the current image in visible vs hidden groups. */
  split: Accessor<{ visible: number; hidden: number }>
  canUndo: Accessor<boolean>
  canRedo: Accessor<boolean>
  /** Confirmed count of any image. */
  imageCount(imageId: ID): number
  groupById(id: ID): AnnotationGroup | undefined
  /** Annotations of a group across all images (for delete confirmations). */
  groupUsage(id: ID): { annotations: number; images: number }
  /** Explain a viewport-reported refusal (toast with a fix-it action). */
  explainBlocked(reason: 'hidden' | 'locked' | 'no-group' | 'nothing-to-erase'): void

  // ---- annotations (current image unless stated) ----
  /** Add a manual, accepted annotation to the active group. */
  addAnnotation(x: number, y: number): boolean
  eraseAnnotation(annotationId: ID): boolean
  /** Apply ops to one image as ONE undo step (future: accepting suggestions). Returns the block if refused. */
  applyBatch(imageId: ID, ops: AnnotationOp[], opts: BatchOptions): EditBlock | null
  /** Undo/redo on the current image; refused (with explanation) if it would touch a locked/hidden group. */
  undo(): boolean
  redo(): boolean

  // ---- annotation groups ----
  createGroup(name?: string): ID | null
  renameGroup(id: ID, name: string): void
  /** Deletes the group and its annotations on every image (refused if locked or last group). */
  deleteGroup(id: ID): boolean
  moveGroup(id: ID, delta: number): void
  /** Refused while the group is locked. */
  setGroupStyle(id: ID, patch: GroupStylePatch): boolean
  setGroupFlag(id: ID, flag: 'hidden' | 'locked', value: boolean): void
  toggleHidden(id: ID): void
  toggleLocked(id: ID): void
  setActiveGroup(id: ID): void
  selectGroupByIndex(index: number): void

  // ---- tool ----
  setTool(tool: Tool): void
  setTouchAnnotates(on: boolean): void

  // ---- images & image groups ----
  createImageGroup(name?: string): ID | null
  renameImageGroup(id: ID, name: string): void
  /** Images of a deleted image group become ungrouped (never deleted). */
  deleteImageGroup(id: ID): void
  moveImageGroup(id: ID, delta: number): void
  /** Reassign an image; its annotations are unaffected. */
  assignImage(imageId: ID, imageGroupId: ID | null): void
  renameImage(imageId: ID, name: string): void
  selectImage(imageId: ID | null): void
  selectAdjacentImage(delta: number): void
  importImages(files: File[], imageGroupId?: ID | null): Promise<void>
  removeImage(imageId: ID): Promise<void>
  /** Original bytes of an image in the open project. */
  getImageBlob(imageId: ID): Promise<Blob>

  // ---- projects ----
  /** Load the project list and open the last-used project. */
  init(): Promise<void>
  refreshProjects(): Promise<void>
  openProject(id: ID): Promise<OpenedProject | undefined>
  createProject(name: string): Promise<OpenedProject | undefined>
  renameProject(name: string): void
  deleteProject(id: ID): Promise<void>
  importArchive(file: File): Promise<OpenedProject | undefined>
  exportArchive(): Promise<Blob | undefined>
  exportCsv(): Promise<Blob | undefined>

  // ---- Google Drive ----
  connectDrive(): Promise<void>
  disconnectDrive(): Promise<void>
  linkToDrive(mode: 'create-folder' | 'pick-folder'): Promise<void>
  openFromDrive(): Promise<OpenedProject | undefined>
  importFromDrive(imageGroupId?: ID | null): Promise<void>
  /** `overwrite` resolves a conflict in favour of the local copy. */
  saveToDrive(overwrite?: boolean): Promise<void>
  /** Resolve a conflict in favour of Drive (local copy kept as a backup project by storage). */
  takeRemote(): Promise<void>

  /** Persist pending changes now (visibilitychange / pagehide / before switching). */
  flush(): Promise<void>
}

export function createEditor(repo: ProjectRepository, notify: Notify): Editor {
  const [state, setState] = createStore<EditorState>({
    phase: 'loading',
    projects: [],
    project: null,
    docs: {},
    currentImageId: null,
    activeGroupId: null,
    tool: 'add',
    touchAnnotates: prefs.get('touchAnnotates', false),
    importing: 0,
    busy: null,
  })
  const [history, setHistory] = createStore<Record<ID, ImageHistory>>({})
  const [dirty, setDirty] = createSignal(false)

  // ---------------------------------------------------------------- autosave
  const saver = createAutosaver({
    delay: 400,
    async save(docIds) {
      const project = state.project
      if (!project) return
      const snapshot = structuredClone(unwrap(project)) as Project
      const docs: ImageAnnotations[] = []
      for (const id of docIds) {
        const image = snapshot.images.find((i) => i.id === id)
        const doc = state.docs[id]
        if (image && doc) docs.push(structuredClone(docForSave(snapshot, image, unwrap(doc))))
      }
      await repo.saveLocal(snapshot, docs)
    },
    onDirtyChange: setDirty,
    onError(err) {
      console.error('Local save failed', err)
      notify({
        tone: 'error',
        key: 'save-error',
        message: 'Couldn’t save changes in this browser',
        detail: errorText(err) + ' Your edits are still open — keep this tab open and try again.',
      })
    },
  })

  const touchProject = () => {
    if (!state.project) return
    setState('project', 'updatedAt', now())
    saver.markProject()
  }
  const touchDoc = (imageId: ID) => {
    if (state.docs[imageId]) setState('docs', imageId, 'updatedAt', now())
    saver.markDoc(imageId)
  }
  /** Group definitions are snapshotted into every annotation doc, so refresh all of them. */
  const touchAllDocs = () => {
    touchProject()
    for (const id of Object.keys(state.docs)) saver.markDoc(id)
  }

  // ---------------------------------------------------------------- derived
  const derived = createRoot(() => {
    const currentImage = createMemo<ImageRecord | null>(
      () => state.project?.images.find((i) => i.id === state.currentImageId) ?? null,
    )
    const currentAnnotations = createMemo<Annotation[]>(() => {
      const id = state.currentImageId
      return (id && state.docs[id]?.annotations) || []
    })
    const groups = createMemo<AnnotationGroup[]>(() => state.project?.annotationGroups ?? [])
    const activeGroup = createMemo(() => groups().find((g) => g.id === state.activeGroupId))
    const groupCounts = createMemo(() => confirmedCountsByGroup(currentAnnotations()))
    const total = createMemo(() => confirmedCount(currentAnnotations()))
    const split = createMemo(() => visibilitySplit(currentAnnotations(), groups()))
    const currentHistory = createMemo(() => (state.currentImageId ? history[state.currentImageId] : undefined))
    const canUndo = createMemo(() => (currentHistory()?.undo.length ?? 0) > 0)
    const canRedo = createMemo(() => (currentHistory()?.redo.length ?? 0) > 0)
    return { currentImage, currentAnnotations, groups, activeGroup, groupCounts, total, split, canUndo, canRedo }
  })

  const imageCount = (imageId: ID) => confirmedCount(state.docs[imageId]?.annotations)
  const groupById = (id: ID) => state.project?.annotationGroups.find((g) => g.id === id)

  // ---------------------------------------------------------------- notices
  function explainBlocked(reason: 'hidden' | 'locked' | 'no-group' | 'nothing-to-erase') {
    const group = derived.activeGroup()
    if (reason === 'nothing-to-erase') {
      notify({
        tone: 'info',
        key: 'blocked',
        message: group ? `No “${group.name}” marker here to erase` : 'Nothing to erase here',
        detail: 'Erase removes the nearest marker of the selected group.',
      })
      return
    }
    if (reason === 'no-group' || !group) {
      notify({ tone: 'warning', key: 'blocked', message: 'Choose an annotation group first' })
      return
    }
    if (reason === 'hidden') {
      notify({
        tone: 'warning',
        key: 'blocked',
        message: hiddenMessage(group),
        detail: 'Hidden groups can’t be edited, so no change happens out of sight.',
        action: { label: 'Show group', run: () => setGroupFlag(group.id, 'hidden', false) },
      })
    } else {
      notify({
        tone: 'warning',
        key: 'blocked',
        message: lockedMessage(group),
        action: { label: 'Unlock', run: () => setGroupFlag(group.id, 'locked', false) },
      })
    }
  }

  function explainEditBlock(block: EditBlock, message: string, detail: string) {
    const action =
      block.reason === 'locked'
        ? { label: 'Unlock', run: () => setGroupFlag(block.group.id, 'locked', false) }
        : block.reason === 'hidden'
          ? { label: 'Show group', run: () => setGroupFlag(block.group.id, 'hidden', false) }
          : undefined
    notify({ tone: 'warning', key: 'blocked', message, detail, action })
  }

  // ---------------------------------------------------------------- annotations & history
  function ensureDoc(imageId: ID): void {
    if (state.docs[imageId] || !state.project) return
    const image = state.project.images.find((i) => i.id === imageId)
    if (!image) return
    setState('docs', imageId, emptyDoc(unwrap(state.project), unwrap(image), now()))
  }

  /** Add (or remove) a detection run record on an image's document. */
  function setRun(imageId: ID, run: DetectionRun, present: boolean) {
    ensureDoc(imageId)
    const runs = (unwrap(state.docs[imageId]).detectionRuns ?? []).filter((r) => r.runId !== run.runId)
    setState('docs', imageId, 'detectionRuns', present ? [...runs, structuredClone(run)] : runs)
  }

  function writeOps(imageId: ID, ops: AnnotationOp[]) {
    ensureDoc(imageId)
    const current = unwrap(state.docs[imageId]).annotations
    setState('docs', imageId, 'annotations', applyOps(current, ops))
    touchDoc(imageId)
  }

  /**
   * Apply a batch of annotation ops to one image as ONE undo step. This is the
   * entry point for future automated suggestions (accept N = one batch).
   * Refuses (returns the block) if any op touches a locked, hidden or unknown group.
   */
  function applyBatch(imageId: ID, ops: AnnotationOp[], opts: BatchOptions): EditBlock | null {
    if (!state.project || ops.length === 0) return null
    if (!state.project.images.some((i) => i.id === imageId)) return null
    const block = checkOps(ops, unwrap(state.project.annotationGroups))
    if (block) return block
    batch(() => {
      writeOps(imageId, ops)
      if (opts.detectionRun) setRun(imageId, opts.detectionRun, true)
      setHistory(
        imageId,
        record(history[imageId] ?? emptyHistory(), {
          id: newId(),
          label: opts.label,
          ops,
          at: now(),
          detectionRun: opts.detectionRun ? structuredClone(opts.detectionRun) : undefined,
        }),
      )
    })
    return null
  }

  function addAnnotation(x: number, y: number): boolean {
    const imageId = state.currentImageId
    const group = derived.activeGroup()
    if (!imageId) return false
    const blocked = groupEditBlock(group)
    if (blocked || !group) {
      explainBlocked(blocked ?? 'no-group')
      return false
    }
    const annotation = makeManualAnnotation(x, y, group.id, newId(), now())
    return applyBatch(imageId, [{ kind: 'add', annotation }], { label: 'Add colony' }) === null
  }

  function eraseAnnotation(annotationId: ID): boolean {
    const imageId = state.currentImageId
    if (!imageId) return false
    const annotation = state.docs[imageId]?.annotations.find((a) => a.id === annotationId)
    if (!annotation) return false
    const block = applyBatch(imageId, [{ kind: 'remove', annotation: { ...unwrap(annotation) } }], { label: 'Erase colony' })
    if (block) {
      if (block.reason === 'locked') explainBlocked('locked')
      else if (block.reason === 'hidden') explainBlocked('hidden')
      return false
    }
    return true
  }

  function stepHistory(direction: 'undo' | 'redo'): boolean {
    const imageId = state.currentImageId
    if (!imageId || !state.project) return false
    const h = history[imageId] ?? emptyHistory()
    const groups = unwrap(state.project.annotationGroups)
    const plan = direction === 'undo' ? planUndo(unwrap(h), groups) : planRedo(unwrap(h), groups)
    if (!plan.ok) {
      if (plan.reason === 'blocked') {
        const { message, detail } = historyBlockMessage(plan.block, direction, plan.entry.label)
        explainEditBlock(plan.block, message, detail)
      }
      return false
    }
    batch(() => {
      writeOps(imageId, plan.ops)
      if (plan.entry.detectionRun) setRun(imageId, plan.entry.detectionRun, direction === 'redo')
      setHistory(imageId, plan.next)
    })
    return true
  }

  // ---------------------------------------------------------------- annotation groups
  function createGroup(name?: string): ID | null {
    if (!state.project) return null
    const group = makeGroup(unwrap(state.project.annotationGroups), newId(), name)
    batch(() => {
      setState('project', 'annotationGroups', (gs) => [...gs, group])
      setState('activeGroupId', group.id)
    })
    touchAllDocs()
    return group.id
  }

  function renameGroup(id: ID, name: string) {
    const trimmed = name.trim()
    const group = groupById(id)
    if (!group || !trimmed || trimmed === group.name) return
    setState('project', 'annotationGroups', (g) => g.id === id, 'name', trimmed)
    touchAllDocs()
  }

  /** Annotations of a group across all images (for delete confirmation). */
  function groupUsage(id: ID): { annotations: number; images: number } {
    let annotations = 0
    let images = 0
    for (const doc of Object.values(state.docs)) {
      const n = doc.annotations.filter((a) => a.groupId === id).length
      annotations += n
      if (n) images++
    }
    return { annotations, images }
  }

  function deleteGroup(id: ID): boolean {
    const project = state.project
    const group = groupById(id)
    if (!project || !group) return false
    if (group.locked) {
      notify({ tone: 'warning', key: 'blocked', message: lockedMessage(group), detail: 'Locked groups can’t be deleted.' })
      return false
    }
    if (project.annotationGroups.length <= 1) {
      notify({ tone: 'info', message: 'A project needs at least one annotation group' })
      return false
    }
    const index = project.annotationGroups.findIndex((g) => g.id === id)
    batch(() => {
      for (const [imageId, doc] of Object.entries(state.docs)) {
        if (doc.annotations.some((a) => a.groupId === id)) {
          setState('docs', imageId, 'annotations', (list) => list.filter((a) => a.groupId !== id))
          setState('docs', imageId, 'updatedAt', now())
        }
      }
      for (const imageId of Object.keys(history)) setHistory(imageId, dropEntriesForGroup(unwrap(history[imageId]), id))
      setState('project', 'annotationGroups', (gs) => gs.filter((g) => g.id !== id))
      if (state.activeGroupId === id) {
        const groups = state.project!.annotationGroups
        setState('activeGroupId', groups[Math.min(index, groups.length - 1)]?.id ?? null)
      }
    })
    touchAllDocs()
    return true
  }

  function moveGroup(id: ID, delta: number) {
    const groups = state.project?.annotationGroups
    if (!groups) return
    const from = groups.findIndex((g) => g.id === id)
    if (from < 0) return
    setState('project', 'annotationGroups', moveItem(unwrap(groups), from, from + delta))
    touchAllDocs()
  }

  /** Style changes are refused for locked groups (UI shows an "unlock to edit" state). */
  function setGroupStyle(id: ID, patch: GroupStylePatch): boolean {
    const group = groupById(id)
    if (!group) return false
    if (group.locked) {
      notify({
        tone: 'warning',
        key: 'blocked',
        message: lockedMessage(group),
        action: { label: 'Unlock', run: () => setGroupFlag(id, 'locked', false) },
      })
      return false
    }
    setState('project', 'annotationGroups', (g) => g.id === id, clampStyle(patch))
    touchAllDocs()
    return true
  }

  /** Visibility and lock stay available regardless of lock state. */
  function setGroupFlag(id: ID, flag: 'hidden' | 'locked', value: boolean) {
    if (!groupById(id)) return
    setState('project', 'annotationGroups', (g) => g.id === id, flag, value)
    touchAllDocs()
  }
  const toggleHidden = (id: ID) => {
    const g = groupById(id)
    if (g) setGroupFlag(id, 'hidden', !g.hidden)
  }
  const toggleLocked = (id: ID) => {
    const g = groupById(id)
    if (g) setGroupFlag(id, 'locked', !g.locked)
  }

  function setActiveGroup(id: ID) {
    if (groupById(id)) setState('activeGroupId', id)
  }
  function selectGroupByIndex(index: number) {
    const g = state.project?.annotationGroups[index]
    if (g) setState('activeGroupId', g.id)
  }

  // ---------------------------------------------------------------- tool & prefs
  const setTool = (tool: Tool) => setState('tool', tool)
  function setTouchAnnotates(on: boolean) {
    setState('touchAnnotates', on)
    prefs.set('touchAnnotates', on)
  }

  // ---------------------------------------------------------------- image groups & images
  function createImageGroup(name?: string): ID | null {
    if (!state.project) return null
    const id = newId()
    const groupName = name?.trim() || uniqueName(state.project.imageGroups.map((g) => g.name), 'New group')
    setState('project', 'imageGroups', (gs) => [...gs, { id, name: groupName }])
    touchProject()
    return id
  }

  function renameImageGroup(id: ID, name: string) {
    const trimmed = name.trim()
    if (!trimmed) return
    setState('project', 'imageGroups', (g) => g.id === id, 'name', trimmed)
    touchProject()
  }

  /** Deleting an image group never deletes images: they become ungrouped. */
  function deleteImageGroup(id: ID) {
    if (!state.project) return
    batch(() => {
      setState('project', 'images', (img) => img.imageGroupId === id, 'imageGroupId', null)
      setState('project', 'imageGroups', (gs) => gs.filter((g) => g.id !== id))
    })
    touchProject()
  }

  function moveImageGroup(id: ID, delta: number) {
    const groups = state.project?.imageGroups
    if (!groups) return
    const from = groups.findIndex((g) => g.id === id)
    setState('project', 'imageGroups', moveItem(unwrap(groups), from, from + delta))
    touchProject()
  }

  /** Reassign an image; annotations are keyed by image ID and are unaffected. */
  function assignImage(imageId: ID, imageGroupId: ID | null) {
    if (!state.project) return
    if (imageGroupId && !state.project.imageGroups.some((g) => g.id === imageGroupId)) return
    setState('project', 'images', (img) => img.id === imageId, 'imageGroupId', imageGroupId)
    touchProject()
  }

  function renameImage(imageId: ID, name: string) {
    const trimmed = name.trim()
    if (!trimmed) return
    setState('project', 'images', (img) => img.id === imageId, 'name', trimmed)
    touchProject()
  }

  function selectImage(imageId: ID | null) {
    if (imageId && !state.project?.images.some((i) => i.id === imageId)) return
    setState('currentImageId', imageId)
    if (state.project && imageId) prefs.set(`lastImage:${state.project.id}`, imageId)
  }

  function selectAdjacentImage(delta: number) {
    if (!state.project) return
    const order = displayOrder(state.project)
    if (!order.length) return
    const i = order.findIndex((img) => img.id === state.currentImageId)
    const next = order[Math.max(0, Math.min(order.length - 1, (i < 0 ? 0 : i) + delta))]
    selectImage(next.id)
  }

  async function importImages(files: File[], imageGroupId: ID | null = null) {
    const project = state.project
    if (!project || files.length === 0) return
    setState('importing', (n) => n + files.length)
    try {
      await saver.flush()
      const result = await repo.importImageFiles(structuredClone(unwrap(project)) as Project, files)
      addImportedImages(result.added, imageGroupId)
      reportRejected(result.rejected)
    } catch (err) {
      notify({ tone: 'error', message: 'Import failed', detail: errorText(err) })
    } finally {
      setState('importing', (n) => Math.max(0, n - files.length))
    }
  }

  function addImportedImages(added: ImageRecord[], imageGroupId: ID | null) {
    if (!state.project || added.length === 0) return
    const known = new Set(state.project.images.map((i) => i.id))
    const fresh = added
      .filter((img) => !known.has(img.id))
      .map((img) => ({ ...img, imageGroupId: imageGroupId ?? img.imageGroupId ?? null }))
    batch(() => {
      if (fresh.length) setState('project', 'images', (imgs) => [...imgs, ...fresh])
      // Records the repository already put into the project may still need the target group.
      if (imageGroupId) {
        const ids = new Set(added.map((i) => i.id))
        setState('project', 'images', (img) => ids.has(img.id), 'imageGroupId', imageGroupId)
      }
      if (!state.currentImageId || !state.project!.images.some((i) => i.id === state.currentImageId)) {
        selectImage(added[0].id)
      }
    })
    touchProject()
    notify({
      tone: 'success',
      key: 'import',
      message: added.length === 1 ? `Imported “${added[0].name}”` : `Imported ${added.length} images`,
    })
  }

  function reportRejected(rejected: { name: string; reason: string }[]) {
    if (!rejected.length) return
    notify({
      tone: 'warning',
      message: rejected.length === 1 ? `Couldn’t import “${rejected[0].name}”` : `${rejected.length} files couldn’t be imported`,
      detail: rejected
        .slice(0, 4)
        .map((r) => (rejected.length === 1 ? r.reason : `${r.name}: ${r.reason}`))
        .join(' · '),
    })
  }

  async function removeImage(imageId: ID) {
    const project = state.project
    if (!project) return
    try {
      await saver.flush()
      await repo.removeImage(structuredClone(unwrap(project)) as Project, imageId)
    } catch (err) {
      notify({ tone: 'error', message: 'Couldn’t remove image', detail: errorText(err) })
      return
    }
    batch(() => {
      if (state.currentImageId === imageId) {
        const order = displayOrder(state.project!)
        const i = order.findIndex((img) => img.id === imageId)
        const next = order[i + 1] ?? order[i - 1]
        setState('currentImageId', next && next.id !== imageId ? next.id : null)
      }
      setState('project', 'images', (imgs) => imgs.filter((i) => i.id !== imageId))
      setState(
        'docs',
        produce((docs) => {
          delete docs[imageId]
        }),
      )
      setHistory(
        produce((h) => {
          delete h[imageId]
        }),
      )
    })
    touchProject()
  }

  // ---------------------------------------------------------------- projects
  /**
   * Storage owns project.storage, project.revision and each image's source /
   * sourceMismatch. Merge those fields when the repository reports a change,
   * leaving everything the editor owns untouched.
   */
  function mergeStorageFields(updated: Project) {
    if (!state.project || updated.id !== state.project.id) return
    batch(() => {
      setState('project', 'storage', structuredClone(updated.storage))
      setState('project', 'revision', updated.revision)
      for (const img of updated.images) {
        const index = state.project!.images.findIndex((i) => i.id === img.id)
        if (index < 0) continue
        setState('project', 'images', index, 'source', structuredClone(img.source))
        setState('project', 'images', index, 'sourceMismatch', img.sourceMismatch ? structuredClone(img.sourceMismatch) : undefined)
      }
    })
  }
  repo.onProjectUpdated(mergeStorageFields)

  function loadOpened(opened: OpenedProject) {
    const project = structuredClone(opened.project) as Project
    let needsSave = false
    // Older documents may predate labelSize.
    for (const g of project.annotationGroups) if (typeof g.labelSize !== 'number') g.labelSize = DEFAULT_LABEL_SIZE
    if (project.annotationGroups.length === 0) {
      project.annotationGroups = [makeGroup([], newId())]
      needsSave = true
    }
    const docs: Record<ID, ImageAnnotations> = {}
    for (const [id, doc] of opened.annotations) docs[id] = { ...structuredClone(doc), detectionRuns: doc.detectionRuns ?? [] }
    const order = displayOrder(project)
    const lastImage = prefs.get<string | null>(`lastImage:${project.id}`, null)
    const current = order.find((i) => i.id === lastImage) ?? order[0] ?? null
    saver.reset()
    batch(() => {
      setHistory(produce((h) => Object.keys(h).forEach((k) => delete h[k])))
      setState({
        phase: 'ready',
        project,
        docs,
        currentImageId: current?.id ?? null,
        activeGroupId: project.annotationGroups[0]?.id ?? null,
      })
    })
    prefs.set('lastProject', project.id)
    if (needsSave) touchProject()
    if (opened.warnings?.length) {
      notify({
        tone: 'warning',
        message: opened.warnings.length === 1 ? 'Opened with a warning' : `Opened with ${opened.warnings.length} warnings`,
        detail: opened.warnings.slice(0, 3).join(' · '),
      })
    }
  }

  async function run<T>(label: string, fn: () => Promise<T>, failMessage: string): Promise<T | undefined> {
    setState('busy', label)
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
  }

  async function refreshProjects() {
    try {
      setState('projects', await repo.listProjects())
    } catch (err) {
      notify({ tone: 'error', message: 'Couldn’t read projects stored in this browser', detail: errorText(err) })
    }
  }

  async function init() {
    await refreshProjects()
    const last = prefs.get<string | null>('lastProject', null)
    const candidates = [...state.projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    const target = candidates.find((p) => p.id === last) ?? candidates[0]
    if (target) {
      const opened = await run('Opening project…', () => repo.openProject(target.id), 'Couldn’t open project')
      if (opened) {
        loadOpened(opened)
        return
      }
    }
    setState('phase', 'empty')
  }

  async function switchTo(fn: () => Promise<OpenedProject>, label: string, failMessage: string) {
    await saver.flush()
    return finishSwitch(run(label, fn, failMessage))
  }

  /**
   * Drive variant: the repository opens a Google popup before its first await, and
   * Safari only allows popups within the click's user activation, so `fn` must start
   * synchronously. The pending local save is flushed concurrently (it completes
   * long before the user finishes in the picker).
   */
  async function switchToDrive(fn: () => Promise<OpenedProject>, label: string, failMessage: string) {
    const pending = run(label, fn, failMessage)
    await saver.flush()
    return finishSwitch(pending)
  }

  async function finishSwitch(pending: Promise<OpenedProject | undefined>) {
    const opened = await pending
    if (opened) {
      loadOpened(opened)
      await refreshProjects()
    }
    return opened
  }

  const openProject = (id: ID) => switchTo(() => repo.openProject(id), 'Opening project…', 'Couldn’t open project')

  const createProject = (name: string) =>
    switchTo(() => repo.createProject(name.trim() || 'Untitled project'), 'Creating project…', 'Couldn’t create project')

  function renameProject(name: string) {
    const trimmed = name.trim()
    if (!state.project || !trimmed || trimmed === state.project.name) return
    setState('project', 'name', trimmed)
    setState('projects', (p) => p.id === state.project!.id, 'name', trimmed)
    touchProject()
  }

  async function deleteProject(id: ID) {
    const isOpen = state.project?.id === id
    if (isOpen) saver.reset()
    const ok = await run('Deleting project…', () => repo.deleteProject(id).then(() => true), 'Couldn’t delete project')
    if (!ok) return
    await refreshProjects()
    if (isOpen) {
      batch(() => {
        setHistory(produce((h) => Object.keys(h).forEach((k) => delete h[k])))
        setState({ project: null, docs: {}, currentImageId: null, activeGroupId: null, phase: 'empty' })
      })
      prefs.set('lastProject', null)
      const next = [...state.projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
      if (next) await openProject(next.id)
    }
  }

  const importArchive = (file: File) =>
    switchTo(() => repo.importArchive(file), 'Importing project…', 'Couldn’t import that project file')

  async function exportArchive(): Promise<Blob | undefined> {
    if (!state.project) return
    const id = state.project.id
    await saver.flush()
    return run('Preparing download…', () => repo.exportArchive(id), 'Couldn’t create the project download')
  }

  async function exportCsv(): Promise<Blob | undefined> {
    if (!state.project) return
    const id = state.project.id
    await saver.flush()
    return run('Preparing CSV…', () => repo.exportSummaryCsv(id), 'Couldn’t create the CSV summary')
  }

  // ---------------------------------------------------------------- Google Drive
  async function connectDrive() {
    try {
      await repo.connectDrive()
    } catch (err) {
      if (isCancelled(err)) return
      notify({ tone: 'error', message: 'Couldn’t connect to Google Drive', detail: errorText(err) })
    }
  }
  async function disconnectDrive() {
    try {
      await repo.disconnectDrive()
    } catch (err) {
      notify({ tone: 'error', message: 'Couldn’t disconnect Google Drive', detail: errorText(err) })
    }
  }
  async function linkToDrive(mode: 'create-folder' | 'pick-folder') {
    if (!state.project) return
    const id = state.project.id
    const opened = await switchToDrive(
      () => repo.linkProjectToDrive(id, mode),
      'Linking to Google Drive…',
      'Couldn’t link the project to Google Drive',
    )
    if (opened && opened.project.storage.kind === 'drive') {
      notify({ tone: 'success', message: `Linked to Drive folder “${opened.project.storage.folderName}”` })
    }
  }
  const openFromDrive = () =>
    switchToDrive(() => repo.openProjectFromDrive(), 'Opening from Google Drive…', 'Couldn’t open the project from Google Drive')

  async function importFromDrive(imageGroupId: ID | null = null) {
    const project = state.project
    if (!project) return
    const result = await run(
      'Importing from Google Drive…',
      () => repo.importImagesFromDrive(structuredClone(unwrap(project)) as Project),
      'Couldn’t import images from Google Drive',
    )
    if (result) {
      addImportedImages(result.added, imageGroupId)
      reportRejected(result.rejected)
    }
  }

  async function saveToDrive(overwrite = false) {
    if (!state.project) return
    const id = state.project.id
    await saver.flush()
    await run('Saving to Google Drive…', () => repo.saveToDrive(id, { overwrite }), 'Couldn’t save to Google Drive')
  }

  async function takeRemote() {
    if (!state.project) return
    const id = state.project.id
    const opened = await switchTo(() => repo.takeRemote(id), 'Loading the Drive version…', 'Couldn’t load the Drive version')
    if (opened) notify({ tone: 'success', message: 'Loaded the Drive version', detail: 'Your local copy was kept as a backup project.' })
  }

  // ---------------------------------------------------------------- lifecycle
  const flush = () => saver.flush()

  /** Original bytes of an image of the open project (local cache or Drive). */
  function getImageBlob(imageId: ID): Promise<Blob> {
    const project = state.project
    if (!project) return Promise.reject(new Error('No project open.'))
    return repo.getImageBlob(structuredClone(unwrap(project)) as Project, imageId)
  }

  return {
    state,
    history,
    saveStatus: repo.status,
    driveState: repo.drive,
    ...derived,
    imageCount,
    groupById,
    groupUsage,
    explainBlocked,
    // annotations
    addAnnotation,
    eraseAnnotation,
    applyBatch,
    undo: () => stepHistory('undo'),
    redo: () => stepHistory('redo'),
    // annotation groups
    createGroup,
    renameGroup,
    deleteGroup,
    moveGroup,
    setGroupStyle,
    setGroupFlag,
    toggleHidden,
    toggleLocked,
    setActiveGroup,
    selectGroupByIndex,
    // tool
    setTool,
    setTouchAnnotates,
    // images
    createImageGroup,
    renameImageGroup,
    deleteImageGroup,
    moveImageGroup,
    assignImage,
    renameImage,
    selectImage,
    selectAdjacentImage,
    importImages,
    removeImage,
    // projects
    init,
    refreshProjects,
    openProject,
    createProject,
    renameProject,
    deleteProject,
    importArchive,
    exportArchive,
    exportCsv,
    // drive
    connectDrive,
    disconnectDrive,
    linkToDrive,
    openFromDrive,
    importFromDrive,
    saveToDrive,
    takeRemote,
    flush,
    getImageBlob,
    isDirty: dirty,
  }
}

export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  return typeof err === 'string' ? err : 'Unknown error.'
}
