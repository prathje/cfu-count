/**
 * Google Drive REST v3 over fetch. `DriveClient` is the seam the sync engine
 * depends on; tests substitute an in-memory fake.
 *
 * Retries: 429, 5xx, 403 rate-limit reasons and network failures, with
 * exponential backoff + jitter (honouring Retry-After). 401 marks the session
 * expired. Error messages never include the access token.
 */
import { DriveError } from '../errors'

export const FOLDER_MIME = 'application/vnd.google-apps.folder'

/** Subset of the Drive `File` resource we request. */
export interface DriveFile {
  id: string
  name: string
  mimeType: string
  md5Checksum?: string
  /** Monotonic per file; changes on content AND metadata edits. */
  version?: string
  size?: string
  modifiedTime?: string
  trashed?: boolean
  parents?: string[]
  appProperties?: Record<string, string>
  capabilities?: { canEdit?: boolean; canAddChildren?: boolean }
}

export interface NewFileMetadata {
  name: string
  parents: string[]
  mimeType: string
  appProperties?: Record<string, string>
}

/** The Drive operations the app needs. Every method throws DriveError on failure. */
export interface DriveClient {
  /** Email/display name of the signed-in user. */
  about(): Promise<{ email?: string; name?: string }>
  getFile(fileId: string): Promise<DriveFile>
  /** All non-trashed direct children of a folder that this app can see. */
  listChildren(folderId: string): Promise<DriveFile[]>
  download(fileId: string): Promise<Blob>
  /** Create a folder (no body) or a file with content. */
  create(meta: NewFileMetadata, body?: Blob): Promise<DriveFile>
  /** Replace the content (and optionally merge appProperties) of an existing file, keeping its ID. */
  updateContent(fileId: string, body: Blob, appProperties?: Record<string, string>): Promise<DriveFile>
}

export const FILE_FIELDS = 'id,name,mimeType,md5Checksum,version,size,modifiedTime,trashed,parents,appProperties,capabilities(canEdit,canAddChildren)'
const API = 'https://www.googleapis.com/drive/v3'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3'
/** Drive docs recommend multipart only for files up to 5 MB; larger uses a resumable session. */
const MULTIPART_LIMIT = 5 * 1024 * 1024

export interface HttpClientOptions {
  /** Returns a valid access token or throws DriveError('unauthorized'). */
  getToken: () => string
  /** Called when Drive answers 401 (token expired/revoked). */
  onUnauthorized?: () => void
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  maxRetries?: number
  random?: () => number
}

const RETRYABLE_403 = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'sharingRateLimitExceeded'])

export function createDriveClient(opts: HttpClientOptions): DriveClient {
  const doFetch = opts.fetch ?? ((input, init) => fetch(input, init))
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const maxRetries = opts.maxRetries ?? 4
  const random = opts.random ?? Math.random

  async function request(method: string, url: string, init: { body?: BodyInit; headers?: Record<string, string> } = {}, what = 'Drive request'): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const token = opts.getToken()
      let res: Response
      try {
        res = await doFetch(url, { method, body: init.body, headers: { ...init.headers, Authorization: `Bearer ${token}` } })
      } catch (e) {
        if (attempt < maxRetries) {
          await sleep(backoff(attempt))
          continue
        }
        throw new DriveError('network', `${what} failed: no connection to Google Drive. Your work is kept in this browser.`, { cause: e })
      }
      if (res.ok) return res
      const { message, reason } = await readError(res)
      const retryable = res.status === 429 || res.status >= 500 || (res.status === 403 && reason !== undefined && RETRYABLE_403.has(reason))
      if (retryable && attempt < maxRetries) {
        const retryAfter = Number(res.headers.get('Retry-After'))
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt))
        continue
      }
      throw toDriveError(res.status, reason, message, what, opts.onUnauthorized)
    }
  }

  function backoff(attempt: number): number {
    return Math.min(32_000, 1000 * 2 ** attempt) + Math.floor(random() * 1000)
  }

  async function json<T>(res: Response): Promise<T> {
    try {
      return (await res.json()) as T
    } catch (e) {
      throw new DriveError('invalid', 'Google Drive returned an unreadable response.', { cause: e })
    }
  }

  const common = 'supportsAllDrives=true'

  return {
    async about() {
      const res = await request('GET', `${API}/about?fields=user(emailAddress,displayName)`, {}, 'Reading account')
      const body = await json<{ user?: { emailAddress?: string; displayName?: string } }>(res)
      return { email: body.user?.emailAddress, name: body.user?.displayName }
    },

    async getFile(fileId) {
      const res = await request('GET', `${API}/files/${encodeURIComponent(fileId)}?fields=${FILE_FIELDS}&${common}`, {}, 'Reading file info')
      return json<DriveFile>(res)
    },

    async listChildren(folderId) {
      const q = `'${folderId.replace(/['\\]/g, '\\$&')}' in parents and trashed = false`
      const out: DriveFile[] = []
      let pageToken: string | undefined
      do {
        const params = new URLSearchParams({
          q,
          fields: `nextPageToken,files(${FILE_FIELDS})`,
          pageSize: '1000',
          supportsAllDrives: 'true',
          includeItemsFromAllDrives: 'true',
          corpora: 'allDrives',
        })
        if (pageToken) params.set('pageToken', pageToken)
        const res = await request('GET', `${API}/files?${params}`, {}, 'Listing folder')
        const body = await json<{ files?: DriveFile[]; nextPageToken?: string }>(res)
        out.push(...(body.files ?? []))
        pageToken = body.nextPageToken
      } while (pageToken)
      return out
    },

    async download(fileId) {
      const res = await request('GET', `${API}/files/${encodeURIComponent(fileId)}?alt=media&${common}`, {}, 'Downloading file')
      return res.blob()
    },

    async create(meta, body) {
      const fields = `fields=${FILE_FIELDS}&${common}`
      if (!body) {
        const res = await request('POST', `${API}/files?${fields}`, { body: JSON.stringify(meta), headers: { 'Content-Type': 'application/json; charset=UTF-8' } }, 'Creating folder')
        return json<DriveFile>(res)
      }
      if (body.size <= MULTIPART_LIMIT) {
        const { blob, contentType } = multipartBody(meta, body, meta.mimeType)
        const res = await request('POST', `${UPLOAD}/files?uploadType=multipart&${fields}`, { body: blob, headers: { 'Content-Type': contentType } }, `Uploading ${meta.name}`)
        return json<DriveFile>(res)
      }
      const init = await request('POST', `${UPLOAD}/files?uploadType=resumable&${fields}`, {
        body: JSON.stringify(meta),
        headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': meta.mimeType },
      }, `Uploading ${meta.name}`)
      const session = init.headers.get('Location')
      if (!session) throw new DriveError('invalid', 'Google Drive did not start the upload session.')
      const res = await request('PUT', session, { body, headers: { 'Content-Type': meta.mimeType } }, `Uploading ${meta.name}`)
      return json<DriveFile>(res)
    },

    async updateContent(fileId, body, appProperties) {
      const url = `${UPLOAD}/files/${encodeURIComponent(fileId)}?fields=${FILE_FIELDS}&${common}`
      const mime = body.type || 'application/octet-stream'
      if (appProperties) {
        const { blob, contentType } = multipartBody({ appProperties }, body, mime)
        const res = await request('PATCH', `${url}&uploadType=multipart`, { body: blob, headers: { 'Content-Type': contentType } }, 'Updating file')
        return json<DriveFile>(res)
      }
      const res = await request('PATCH', `${url}&uploadType=media`, { body, headers: { 'Content-Type': mime } }, 'Updating file')
      return json<DriveFile>(res)
    },
  }
}

function multipartBody(meta: object, body: Blob, mimeType: string): { blob: Blob; contentType: string } {
  const boundary = `cfu${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
  const blob = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`,
    `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
    body,
    `\r\n--${boundary}--\r\n`,
  ])
  return { blob, contentType: `multipart/related; boundary=${boundary}` }
}

async function readError(res: Response): Promise<{ message?: string; reason?: string }> {
  try {
    const body = (await res.json()) as { error?: { message?: string; errors?: { reason?: string }[]; status?: string } }
    return { message: body.error?.message, reason: body.error?.errors?.[0]?.reason ?? body.error?.status }
  } catch {
    return {}
  }
}

function toDriveError(status: number, reason: string | undefined, message: string | undefined, what: string, onUnauthorized?: () => void): DriveError {
  const o = { status, reason }
  if (status === 401) {
    onUnauthorized?.()
    return new DriveError('unauthorized', 'Google Drive session expired. Reconnect to continue saving to Drive.', o)
  }
  if (status === 404) {
    return new DriveError('not-found', `${what} failed: the file or folder was deleted, moved to trash, or this app was not given access to it.`, o)
  }
  if (status === 403) {
    if (reason === 'storageQuotaExceeded' || reason === 'quotaExceeded') {
      return new DriveError('quota', 'Google Drive storage is full. Free up space in Drive; your work is kept in this browser.', o)
    }
    if (reason && RETRYABLE_403.has(reason)) {
      return new DriveError('rate-limited', 'Google Drive is rate-limiting requests. Try again in a minute.', o)
    }
    return new DriveError('forbidden', `${what} failed: you do not have permission (the folder may be read-only for you, or the file was not opened with this app).`, o)
  }
  if (status === 429) return new DriveError('rate-limited', 'Google Drive is rate-limiting requests. Try again in a minute.', o)
  if (status >= 500) return new DriveError('server', 'Google Drive is temporarily unavailable. Try again later.', o)
  return new DriveError('server', `${what} failed (HTTP ${status}${message ? `: ${message}` : ''}).`, o)
}
