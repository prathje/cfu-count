/**
 * Version history commands (local snapshots in this browser, `session.history`).
 *
 * Automatic versions: one before the first change of a session (the state as
 * opened), then one every 10 minutes while there are changes. Failures of
 * automatic versions never block editing; they surface once as a warning.
 *
 * `beforeDestructive(label)` is THE hook for any destructive or bulk change
 * (clear a group, delete a group, clear in a region, take the Drive version):
 * call and await it right before applying the change. Contract (docs/architecture.md):
 *   - flushes pending edits, then stores a `before-destructive` version of the
 *     saved state, labelled `label` (e.g. "Before clearing “Colonies” on all images");
 *   - freezes edits (busy, blocking) while it runs, typically < 100 ms;
 *   - never throws: resolves { ok: true, version } or { ok: false, reason };
 *   - the caller decides what a failure means: bulk changes that undo cannot fully
 *     reverse must not proceed without an extra confirmation.
 */
import { createSignal, type Accessor } from 'solid-js'
import { unwrap } from 'solid-js/store'
import type { Annotation, ID } from '../../model/types'
import type { AnnotationOp } from '../../model/annotations'
import type { ProjectSnapshot, VersionInfo, VersionReason } from '../../storage/api'
import { errorText, type EditorContext } from './context'
import type { AnnotationCommands } from './annotations'

export type SnapshotOutcome = { ok: true; version: VersionInfo } | { ok: false; reason: string }

export interface VersionCommands {
  /** Versions of the open project, newest first ([] when none is open or on failure). */
  list(): Promise<VersionInfo[]>
  /** Increments whenever a version is added, removed or restored (open dialogs refresh). */
  changes: Accessor<number>
  /** "Save version now": a manual version of the current state (after saving pending edits). */
  saveNow(): Promise<VersionInfo | null>
  /** Snapshot before a destructive or bulk change. See the module comment for the contract. */
  beforeDestructive(label: string): Promise<SnapshotOutcome>
  /** Contents of a version (for previews), or null with a toast on failure. */
  load(id: ID): Promise<ProjectSnapshot | null>
  /**
   * Replace the project with a version. Storage first saves the current state as a
   * version (so the restore can be undone from the toast or the list); undo history
   * starts over, like opening the project.
   */
  restore(id: ID): Promise<boolean>
  /**
   * Restore one image's annotations from a version as ONE undoable step on that image.
   * Refused (with an explanation) when marks belong to groups that were deleted since,
   * or to a locked or hidden group.
   */
  restoreImage(id: ID, imageId: ID): Promise<boolean>
  remove(id: ID): Promise<boolean>
}

export interface VersionOptions {
  /** Interval between automatic versions while there are changes (default 10 min). */
  periodicMs?: number
  /** How often to check whether an automatic version is due (default 1 min). */
  checkMs?: number
  now?: () => number
}

export interface Versions {
  commands: VersionCommands
  /** The editor became dirty (an edit happened). */
  noteChange(): void
  /** A project snapshot was loaded (open, import, Drive version, restore). */
  sessionLoaded(): void
  dispose(): void
}

const LABELS: Record<Exclude<VersionReason, 'before-destructive' | 'before-restore'>, string> = {
  'session-start': 'When you opened the project',
  periodic: 'Automatic version',
  manual: 'Saved by you',
}

export function createVersions(ctx: EditorContext, annotations: AnnotationCommands, opts: VersionOptions = {}): Versions {
  const { state, setState, notify, saver } = ctx
  const periodicMs = opts.periodicMs ?? 10 * 60_000
  const clock = opts.now ?? Date.now
  const [changes, setChanges] = createSignal(0)
  const bump = () => setChanges((n) => n + 1)

  let sessionStarted = false
  let changedSinceVersion = false
  let lastVersionAt = 0
  let warnedThisSession = false
  let autoInFlight = false

  function warn(message: string, detail: string) {
    notify({ tone: 'warning', key: 'version-warning', message, detail })
  }

  /** Automatic version: never blocks, never throws, warns once per session on failure. */
  function auto(reason: 'session-start' | 'periodic') {
    const session = ctx.session()
    if (!session || autoInFlight) return
    autoInFlight = true
    // Called synchronously from the edit: storage queues it before the edit's save.
    session.history
      .create(reason, LABELS[reason])
      .then((r) => {
        lastVersionAt = clock()
        if (r.created) bump()
        if (r.warning) warn('Older versions were removed to free space', r.warning)
      })
      .catch((err) => {
        changedSinceVersion = true
        console.warn('[history] automatic version failed', err)
        if (warnedThisSession) return
        warnedThisSession = true
        warn('Couldn’t save an automatic version', `${errorText(err)} Editing and saving continue normally.`)
      })
      .finally(() => (autoInFlight = false))
  }

  const timer = setInterval(() => {
    if (!ctx.session() || !changedSinceVersion || state.busy || clock() - lastVersionAt < periodicMs) return
    changedSinceVersion = false
    auto('periodic')
  }, opts.checkMs ?? 60_000)

  async function withBusy<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const prev = state.busy
    setState('busy', { label, blocking: true })
    try {
      return await fn()
    } finally {
      setState('busy', prev)
    }
  }

  async function beforeDestructive(label: string): Promise<SnapshotOutcome> {
    const session = ctx.session()
    if (!session) return { ok: false, reason: 'No project is open.' }
    try {
      return await withBusy('Saving a version…', async (): Promise<SnapshotOutcome> => {
        if (!(await saver.flush())) {
          return { ok: false, reason: `Your latest changes couldn’t be saved in this browser, so no version of them could be kept. (${errorText(saver.lastError())})` }
        }
        const r = await session.history.create('before-destructive', label)
        lastVersionAt = clock()
        bump()
        if (r.warning) warn('Older versions were removed to free space', r.warning)
        return { ok: true, version: r.version }
      })
    } catch (err) {
      console.warn('[history] version before a destructive change failed', err)
      return { ok: false, reason: errorText(err) }
    }
  }

  async function saveNow(): Promise<VersionInfo | null> {
    const session = ctx.session()
    if (!session) return null
    if (!(await saver.flush())) {
      notify({ tone: 'error', message: 'Couldn’t save a version', detail: `Your latest changes aren’t saved in this browser yet. (${errorText(saver.lastError())})` })
      return null
    }
    const r = await ctx.run('Saving a version…', () => session.history.create('manual', LABELS.manual), 'Couldn’t save a version')
    if (!r) return null
    lastVersionAt = clock()
    changedSinceVersion = false
    bump()
    if (r.warning) warn('Older versions were removed to free space', r.warning)
    notify({ tone: 'success', key: 'version', message: 'Version saved', detail: 'Find it in Version history (project menu).' })
    return r.version
  }

  async function restore(id: ID): Promise<boolean> {
    const session = ctx.session()
    if (!session) return false
    if (!(await ctx.guardUnsaved('Restoring a version'))) return false
    saver.suspend()
    try {
      const result = await ctx.run('Restoring version…', () => session.history.restore(id), 'Couldn’t restore this version', { blocking: true })
      if (!result) return false
      ctx.load(session, result.snapshot)
      // The restored state is already saved (and pending for Drive): no session-start version needed.
      sessionStarted = true
      changedSinceVersion = false
      lastVersionAt = clock()
      bump()
      const backupId = result.backup.id
      notify({
        tone: 'success',
        key: 'version',
        message: 'Version restored',
        detail: 'The state before restoring was saved as a version.',
        action: { label: 'Undo restore', run: () => void restore(backupId) },
      })
      return true
    } finally {
      saver.resume()
    }
  }

  async function restoreImage(id: ID, imageId: ID): Promise<boolean> {
    const session = ctx.session()
    const image = state.project?.images.find((i) => i.id === imageId)
    if (!session || !image || ctx.editsFrozen()) return false
    let snapshot: ProjectSnapshot
    try {
      snapshot = await session.history.load(id)
    } catch (err) {
      notify({ tone: 'error', message: 'Couldn’t read this version', detail: errorText(err) })
      return false
    }
    const target = snapshot.annotations.get(imageId)?.annotations ?? []
    const known = new Set(state.project!.annotationGroups.map((g) => g.id))
    const gone = [...new Set(target.filter((a) => !known.has(a.groupId)).map((a) => a.groupId))]
    if (gone.length) {
      const names = gone.map((g) => `“${snapshot.project.annotationGroups.find((x) => x.id === g)?.name ?? 'deleted group'}”`).join(', ')
      notify({
        tone: 'warning',
        key: 'version',
        message: 'Can’t restore only this image',
        detail: `This version has marks in ${names}, which ${gone.length === 1 ? 'was' : 'were'} deleted since. Restore the whole version to bring ${gone.length === 1 ? 'it' : 'them'} back.`,
      })
      return false
    }
    const ops = diffOps(unwrap(state.docs[imageId]?.annotations) ?? [], target)
    if (!ops.length) {
      notify({ tone: 'info', key: 'version', message: `“${image.name}” already matches this version` })
      return false
    }
    const block = annotations.applyBatch(imageId, ops, { label: 'Restore image from version' })
    if (block) {
      if (block.reason === 'locked' || block.reason === 'hidden') annotations.explainGroupBlock(block.group.id)
      else notify({ tone: 'warning', key: 'version', message: 'Can’t restore this image right now', detail: block.reason === 'invalid' ? block.detail : 'A group of these marks no longer exists.' })
      return false
    }
    // Detection-run records the restored marks refer to (audit trail; skipped if the image bytes changed).
    const runs = snapshot.annotations.get(imageId)?.detectionRuns ?? []
    const present = new Set((state.docs[imageId]?.detectionRuns ?? []).map((r) => r.runId))
    const used = new Set(target.map((a) => a.detector?.runId).filter(Boolean))
    for (const run of runs) if (used.has(run.runId) && !present.has(run.runId)) annotations.setRunRecord(imageId, run.runId, run)
    const entryId = state.history[imageId]?.undo.at(-1)?.id
    notify({
      tone: 'success',
      key: 'version',
      message: `Restored “${image.name}” from the version`,
      detail: 'Other images were not changed. Undo works on this image.',
      action: {
        label: 'Undo',
        run: () => {
          if (state.history[imageId]?.undo.at(-1)?.id !== entryId) {
            notify({ tone: 'info', key: 'version', message: 'Use Undo in the toolbar', detail: 'Other changes were made after restoring.' })
            return
          }
          if (state.currentImageId !== imageId) setState('currentImageId', imageId)
          annotations.undo()
        },
      },
    })
    return true
  }

  const commands: VersionCommands = {
    changes,
    async list() {
      const session = ctx.session()
      if (!session) return []
      try {
        return await session.history.list()
      } catch (err) {
        console.warn('[history] listing versions failed', err)
        return []
      }
    },
    saveNow,
    beforeDestructive,
    async load(id) {
      const session = ctx.session()
      if (!session) return null
      try {
        return await session.history.load(id)
      } catch (err) {
        notify({ tone: 'error', message: 'Couldn’t read this version', detail: errorText(err) })
        return null
      }
    },
    restore,
    restoreImage,
    async remove(id) {
      const session = ctx.session()
      if (!session) return false
      const ok = await ctx.run('Deleting version…', () => session.history.delete(id).then(() => true), 'Couldn’t delete this version')
      if (ok) bump()
      return !!ok
    },
  }

  return {
    commands,
    noteChange() {
      changedSinceVersion = true
      // A project without images has nothing worth restoring yet: wait for a later change.
      if (sessionStarted || !state.project?.images.length) return
      sessionStarted = true
      auto('session-start')
    },
    sessionLoaded() {
      sessionStarted = false
      changedSinceVersion = false
      warnedThisSession = false
      lastVersionAt = clock()
      bump()
    },
    dispose() {
      clearInterval(timer)
    },
  }
}

/** Ops turning `from` into `to` (by annotation id); one batch = one undo step. */
export function diffOps(from: readonly Annotation[], to: readonly Annotation[]): AnnotationOp[] {
  const target = new Map(to.map((a) => [a.id, a]))
  const ops: AnnotationOp[] = []
  for (const a of from) {
    const t = target.get(a.id)
    if (!t) ops.push({ kind: 'remove', annotation: a })
    else if (t.origin !== a.origin) ops.push({ kind: 'remove', annotation: a }, { kind: 'add', annotation: structuredClone(t) })
    else if (JSON.stringify(t) !== JSON.stringify(a)) ops.push({ kind: 'update', before: a, after: structuredClone(t) })
  }
  const current = new Set(from.map((a) => a.id))
  for (const t of to) if (!current.has(t.id)) ops.push({ kind: 'add', annotation: structuredClone(t) })
  return ops
}
