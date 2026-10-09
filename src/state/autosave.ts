/**
 * Debounced, serialised autosave. Callers mark what changed; after `delay` ms
 * of quiet (or on flush) the saver collects the dirty set and calls `save`.
 * Saves never overlap: changes made during a save are picked up by the next one.
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
  /** Save immediately (cancels the debounce). Resolves when everything marked so far is saved. */
  flush(): Promise<void>
  /** Forget pending changes (e.g. project closed after an explicit flush). */
  reset(): void
  readonly dirty: () => boolean
}

export function createAutosaver(opts: AutosaveOptions): Autosaver {
  const delay = opts.delay ?? 400
  let timer: ReturnType<typeof setTimeout> | null = null
  let projectDirty = false
  let docs = new Set<ID>()
  let inFlight: Promise<void> | null = null
  let lastDirty = false
  const isDirty = () => projectDirty || docs.size > 0 || inFlight !== null
  const report = () => {
    const d = isDirty()
    if (d !== lastDirty) {
      lastDirty = d
      opts.onDirtyChange?.(d)
    }
  }

  const schedule = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void run()
    }, delay)
  }

  async function run(): Promise<void> {
    if (inFlight) {
      await inFlight
      if (!projectDirty && docs.size === 0) return
      return run()
    }
    if (!projectDirty && docs.size === 0) return
    const ids = [...docs]
    projectDirty = false
    docs = new Set()
    inFlight = (async () => {
      try {
        await opts.save(ids)
      } catch (err) {
        // Keep the work marked so the next change/flush retries it.
        projectDirty = true
        for (const id of ids) docs.add(id)
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
    },
    reset() {
      if (timer) clearTimeout(timer)
      timer = null
      projectDirty = false
      docs = new Set()
      report()
    },
    dirty: isDirty,
  }
}
