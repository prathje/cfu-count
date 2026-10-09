/**
 * When to ask the browser to warn before the tab is closed or reloaded (pure).
 *
 * The IndexedDB copy is the working copy, so most of the time nothing can be
 * lost: an edit reaches it after the 400 ms autosave debounce. A warning during
 * that normal debounce would only be noise. Warn when local work is at risk:
 *  - the last local save failed (autosave error or a `local-error` status), or
 *  - edits have been waiting for longer than UNSAVED_GRACE_MS (a save is stuck).
 * Changes waiting only for Google Drive are not a reason: the local copy is safe.
 */
import type { SaveStatus } from '../storage/api'

export const UNSAVED_GRACE_MS = 3000

export interface UnloadInput {
  status: SaveStatus
  /** The last local save failed and nothing has been saved since. */
  saveFailed: boolean
  /** When the editor last went from "all saved" to "unsaved" (ms epoch), or null when all is saved. */
  dirtySince: number | null
  now: number
}

export function shouldWarnBeforeUnload(i: UnloadInput): boolean {
  if (i.status.state === 'local-error' || i.saveFailed) return true
  return i.dirtySince !== null && i.now - i.dirtySince > UNSAVED_GRACE_MS
}
