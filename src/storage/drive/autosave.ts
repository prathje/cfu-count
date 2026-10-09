/**
 * Save-status derivation and the debounced Drive autosave scheduler.
 * Both are pure / timer-injectable so they are unit-testable without a browser.
 */
import type { SaveStatus } from '../api'

/** Everything the visible SaveStatus depends on, for the currently open project. */
export interface StatusInputs {
  open: boolean
  localError?: string
  lastLocalSaveAt?: string
  linked: boolean
  /** Local changes not yet confirmed on Drive. */
  dirty: boolean
  pushing: boolean
  conflict?: string[]
  driveConnected: boolean
  driveError?: string
  lastDriveSaveAt?: string
}

/**
 * Precedence: local failure (even with no project open) > Drive save in progress > conflict > (dirty: reconnect /
 * failed / pending) > saved-drive. Local success is still reported for unlinked projects.
 */
export function deriveStatus(s: StatusInputs): SaveStatus {
  if (s.localError) return { state: 'local-error', message: s.localError }
  if (!s.open) return { state: 'idle' }
  if (!s.linked) return { state: 'saved-local', at: s.lastLocalSaveAt ?? new Date(0).toISOString() }
  if (s.pushing) return { state: 'saving-drive' }
  if (s.conflict?.length) return { state: 'conflict', files: s.conflict }
  if (s.dirty) {
    if (!s.driveConnected) return { state: 'reconnect-required' }
    if (s.driveError) return { state: 'failed', message: s.driveError }
    return { state: 'pending' }
  }
  return { state: 'saved-drive', at: s.lastDriveSaveAt ?? s.lastLocalSaveAt ?? new Date(0).toISOString() }
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

/**
 * Debounces autosave requests and backs off after failures.
 * `request()` after a local save: run `task` once things have been quiet for `delayMs`.
 * `failed()` after a retryable failure: retry later with exponential backoff.
 */
export class AutosaveScheduler {
  private handle: unknown = null
  private failures = 0
  private readonly task: () => void
  private readonly delayMs: number
  private readonly maxBackoffMs: number
  private readonly timers: Timers

  constructor(task: () => void, opts: { delayMs: number; maxBackoffMs?: number; timers?: Timers }) {
    this.task = task
    this.delayMs = opts.delayMs
    this.maxBackoffMs = opts.maxBackoffMs ?? 5 * 60_000
    this.timers = opts.timers ?? realTimers
  }

  request(delayMs = this.delayMs): void {
    this.cancel()
    this.handle = this.timers.setTimeout(() => {
      this.handle = null
      this.task()
    }, delayMs)
  }

  /** Schedule a retry after a retryable failure; returns the delay used. */
  failed(): number {
    this.failures++
    const delay = Math.min(this.maxBackoffMs, 15_000 * 2 ** (this.failures - 1))
    this.request(delay)
    return delay
  }

  succeeded(): void {
    this.failures = 0
  }

  cancel(): void {
    if (this.handle !== null) this.timers.clearTimeout(this.handle)
    this.handle = null
  }

  get scheduled(): boolean {
    return this.handle !== null
  }
}
