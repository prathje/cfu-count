/**
 * Error types surfaced by the storage layer. Messages are written for end users;
 * they never contain access tokens or raw request bodies.
 */

/** Browser storage (IndexedDB) failure. */
export class LocalStorageError extends Error {
  readonly code: 'quota' | 'unavailable' | 'transaction' | 'not-found'
  constructor(code: LocalStorageError['code'], message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'LocalStorageError'
    this.code = code
  }
}

/** A file or archive that does not match schema v1. */
export class SchemaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SchemaError'
  }
}

export type DriveErrorKind =
  | 'unconfigured'
  | 'unauthorized' // token missing/expired/revoked -> reconnect
  | 'forbidden' // no permission (read-only folder, file not granted to the app)
  | 'not-found' // deleted, trashed or never granted (drive.file returns 404)
  | 'rate-limited'
  | 'quota' // Drive storage full
  | 'server'
  | 'network'
  | 'cancelled' // user closed the picker / consent popup
  | 'invalid' // malformed remote content

export class DriveError extends Error {
  readonly kind: DriveErrorKind
  readonly status?: number
  readonly reason?: string
  constructor(kind: DriveErrorKind, message: string, opts: { status?: number; reason?: string; cause?: unknown } = {}) {
    super(message, { cause: opts.cause })
    this.name = 'DriveError'
    this.kind = kind
    this.status = opts.status
    this.reason = opts.reason
  }
}

/** True when the user deliberately cancelled a picker or consent dialog (UI should stay quiet). */
export function isCancelled(e: unknown): boolean {
  return e instanceof DriveError && e.kind === 'cancelled'
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}

/** Map an IndexedDB / DOMException failure to a user-facing LocalStorageError. */
export function toLocalError(e: unknown, action: string): LocalStorageError {
  if (e instanceof LocalStorageError) return e
  const name = (e as { name?: string } | null)?.name ?? ''
  if (name === 'QuotaExceededError' || /quota/i.test(errorMessage(e))) {
    return new LocalStorageError(
      'quota',
      `Could not ${action}: browser storage is full. Export the project as a .zip, delete unused projects, or free up disk space.`,
      { cause: e },
    )
  }
  if (name === 'InvalidStateError' || name === 'SecurityError' || name === 'UnknownError' || name === 'NotSupportedError') {
    return new LocalStorageError(
      'unavailable',
      `Could not ${action}: browser storage is unavailable (private browsing, blocked site data or a storage error). Your work cannot be kept in this browser.`,
      { cause: e },
    )
  }
  return new LocalStorageError('transaction', `Could not ${action}: ${errorMessage(e) || 'browser storage error'}.`, {
    cause: e,
  })
}

/** True when an archive import failed because the file is not a (valid) project archive, as opposed to a storage failure. */
export function isNotProjectArchive(e: unknown): boolean {
  return e instanceof SchemaError || /invalid zip|zip data|central directory/i.test(errorMessage(e))
}
