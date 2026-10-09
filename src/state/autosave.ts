/**
 * Debounced, serialised autosave. Callers mark what changed; after `delay` ms
 * of quiet (or on flush) the saver collects the dirty set and calls `save`.
 * Saves never overlap: changes made during a save are picked up by the next one.
 * A failed save keeps its work marked, so `flush()` reports it and the next
 * change or flush retries it.
 */
import type { ID } from '../model/types'

export interface AutosaveOptions {
  delay?: number
  /** Persist. `docIds` = only the annotation docs changed since the last save. */
  save(docIds: ID[]): Promise<void>
  onError?(err: unknown): void
  /** Called whenever the dirty flag (unsaved or in-flight work) flips. */
  onDirtyChange?(dirty: boolean): void
}

export interface Autosaver {
  markProject(): void
  markDoc(imageId: ID): void
  /**
   * Save immediately (cancels the debounce). Resolves `true` when everything
   * marked so far is saved, `false` if work is still unsaved (the save failed,
   * or saving is suspended). Never rejects.
   */
  flush(): Promise<boolean>
  /** Forget pending changes (e.g. the project is being replaced or deleted). */
  reset(): void
  /**
   * Stop saving until resume() (marks are still recorded). Used while an operation
   * replaces the whole project, so no half-old state is written in between.
   */
  suspend(): void
  resume(): void
  readonly dirty: () => boolean
  /** The error of the last failed save, cleared by the next successful one. */
  readonly lastError: () => unknown
}

export function createAutosaver(opts: AutosaveOptions): Autosaver {
  const delay = opts.delay ?? 400
  let timer: ReturnType<typeof setTimeout> | null = null
  let projectDirty = false
  let docs = new Set<ID>()
  let inFlight: Promise<void> | null = null
  let lastDirty = false
  let suspended = false
  let lastError: unknown = undefined
  const hasWork = () => projectDirty || docs.size > 0
  const isDirty = () => hasWork() || inFlight !== null
  const report = () => {
    const d = isDirty()
    if (d !== lastDirty) {
      lastDirty = d
      opts.onDirtyChange?.(d)
    }
  }

  const schedule = () => {
    if (timer) clearTimeout(timer)
    if (suspended) return
    timer = setTimeout(() => {
      timer = null
      void run()
    }, delay)
  }

  async function run(): Promise<void> {
    if (inFlight) {
      await inFlight
      if (!hasWork() || suspended) return
      return run()
    }
    if (!hasWork() || suspended) return
    const ids = [...docs]
    projectDirty = false
    docs = new Set()
    inFlight = (async () => {
      try {
        await opts.save(ids)
        lastError = undefined
      } catch (err) {
        // Keep the work marked so the next change/flush retries it.
        projectDirty = true
        for (const id of ids) docs.add(id)
        lastError = err
        opts.onError?.(err)
      }
    })()
    report()
    try {
      await inFlight
    } finally {
      inFlight = null
      report()
    }
  }

  return {
    markProject() {
      projectDirty = true
      report()
      schedule()
    },
    markDoc(id) {
      docs.add(id)
      projectDirty = true
      report()
      schedule()
    },
    async flush() {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      await run()
      return !isDirty()
    },
    reset() {
      if (timer) clearTimeout(timer)
      timer = null
      projectDirty = false
      docs = new Set()
      lastError = undefined
      report()
    },
    suspend() {
      suspended = true
      if (timer) clearTimeout(timer)
      timer = null
    },
    resume() {
      suspended = false
      if (hasWork()) schedule()
    },
    dirty: isDirty,
    lastError: () => lastError,
  }
}
