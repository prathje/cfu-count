import { describe, expect, it, vi } from 'vitest'
import { createDriveClient } from '../drive/client'
import { DriveSession, type SessionClock } from '../drive/session'
import { AutosaveScheduler, deriveStatus, type Timers } from '../drive/autosave'
import { readDriveConfig, SCOPE_DRIVE_FILE, SCOPE_DRIVE_READONLY, SCOPE_DRIVE_FULL } from '../drive/config'
import { DriveError } from '../errors'
import { FakeTokenProvider } from './fakes'

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}
const apiError = (status: number, reason: string) => jsonResponse(status, { error: { code: status, message: reason, errors: [{ reason }] } })

describe('Drive HTTP client', () => {
  function client(responses: (Response | Error)[]) {
    const calls: { url: string; init: RequestInit }[] = []
    const sleeps: number[] = []
    const onUnauthorized = vi.fn()
    const c = createDriveClient({
      getToken: () => 'secret-token',
      onUnauthorized,
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        const r = responses.shift()!
        if (r instanceof Error) throw r
        return r
      }) as typeof fetch,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      random: () => 0,
    })
    return { c, calls, sleeps, onUnauthorized }
  }

  it('retries 429/5xx/rate-limit 403 and network errors with backoff', async () => {
    const { c, calls, sleeps } = client([
      apiError(429, 'rateLimitExceeded'),
      apiError(503, 'backendError'),
      apiError(403, 'userRateLimitExceeded'),
      new TypeError('Failed to fetch'),
      jsonResponse(200, { id: 'a', name: 'n', mimeType: 'text/plain' }),
    ])
    const f = await c.getFile('a')
    expect(f.id).toBe('a')
    expect(calls).toHaveLength(5)
    expect(sleeps).toEqual([1000, 2000, 4000, 8000])
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer secret-token')
  })

  it('honours Retry-After', async () => {
    const { c, sleeps } = client([jsonResponse(429, {}, { 'Retry-After': '7' }), jsonResponse(200, { id: 'a' })])
    await c.getFile('a')
    expect(sleeps).toEqual([7000])
  })

  it('maps 401 to unauthorized and notifies the session', async () => {
    const { c, onUnauthorized } = client([apiError(401, 'authError')])
    await expect(c.getFile('a')).rejects.toMatchObject({ kind: 'unauthorized' })
    expect(onUnauthorized).toHaveBeenCalledOnce()
  })

  it('maps 403/404 to clear, token-free errors', async () => {
    const { c } = client([apiError(403, 'insufficientFilePermissions'), apiError(404, 'notFound'), apiError(403, 'storageQuotaExceeded')])
    const e1 = (await c.getFile('a').catch((e: unknown) => e)) as DriveError
    expect(e1).toMatchObject({ kind: 'forbidden' })
    expect(e1.message).not.toContain('secret-token')
    await expect(c.getFile('a')).rejects.toMatchObject({ kind: 'not-found' })
    await expect(c.getFile('a')).rejects.toMatchObject({ kind: 'quota' })
  })

  it('gives up after max retries', async () => {
    const { c, calls } = client(Array.from({ length: 5 }, () => apiError(500, 'backendError')))
    await expect(c.getFile('a')).rejects.toMatchObject({ kind: 'server' })
    expect(calls).toHaveLength(5)
  })

  it('creates small files with a multipart upload and updates content in place', async () => {
    const { c, calls } = client([jsonResponse(200, { id: 'new' }), jsonResponse(200, { id: 'new' })])
    await c.create({ name: 'project.json', parents: ['F'], mimeType: 'application/json' }, new Blob(['{}'], { type: 'application/json' }))
    expect(calls[0].url).toContain('/upload/drive/v3/files?uploadType=multipart')
    const body = await (calls[0].init.body as Blob).text()
    expect(body).toContain('"name":"project.json"')
    expect(body).toContain('{}')
    await c.updateContent('new', new Blob(['{"a":1}'], { type: 'application/json' }))
    expect(calls[1].init.method).toBe('PATCH')
    expect(calls[1].url).toContain('/upload/drive/v3/files/new?')
    expect(calls[1].url).toContain('uploadType=media')
  })

  it('pages through folder listings', async () => {
    const { c, calls } = client([
      jsonResponse(200, { files: [{ id: '1' }], nextPageToken: 'n' }),
      jsonResponse(200, { files: [{ id: '2' }] }),
    ])
    const files = await c.listChildren("it's")
    expect(files.map((f) => f.id)).toEqual(['1', '2'])
    expect(decodeURIComponent(calls[0].url.replace(/\+/g, ' '))).toContain("'it\\'s' in parents and trashed = false")
    expect(calls[1].url).toContain('pageToken=n')
  })
})

describe('DriveSession', () => {
  function fakeClock() {
    let t = 1_000_000
    const timers: { at: number; fn: () => void }[] = []
    const clock: SessionClock = {
      now: () => t,
      setTimeout: (fn, ms) => {
        const h = { at: t + ms, fn }
        timers.push(h)
        return h
      },
      clearTimeout: (h) => {
        const i = timers.indexOf(h as (typeof timers)[number])
        if (i >= 0) timers.splice(i, 1)
      },
    }
    const advance = (ms: number) => {
      t += ms
      for (const h of [...timers]) if (h.at <= t) {
        timers.splice(timers.indexOf(h), 1)
        h.fn()
      }
    }
    return { clock, advance, setNow: (v: number) => (t = v) }
  }

  it('is unconfigured without a provider', () => {
    const s = new DriveSession(null)
    expect(s.state).toEqual({ state: 'unconfigured' })
    expect(() => s.accessToken()).toThrow(DriveError)
  })

  it('connects, expires on schedule, and reconnects with an account hint', async () => {
    const provider = new FakeTokenProvider()
    const { clock, advance } = fakeClock()
    provider.expiresInMs = 0
    const s = new DriveSession(
      { ...provider, preload: async () => {}, revoke: async () => {}, requestToken: async (o) => ({ accessToken: 'tok', expiresAt: clock.now() + 3_600_000, scopes: [o?.hint ?? ''] }) },
      clock,
    )
    const states: string[] = []
    s.onChange((st) => states.push(st.state))
    await s.connect()
    expect(s.accessToken()).toBe('tok')
    s.setAccount('me@example.com')
    advance(3_600_000 - 60_000)
    expect(s.state).toEqual({ state: 'expired', account: 'me@example.com' })
    expect(() => s.accessToken()).toThrow(/expired/)
    await s.connect()
    expect(states).toEqual(['connecting', 'connected', 'connected', 'expired', 'connecting', 'connected'])
  })

  it('restores the previous state when sign-in is cancelled', async () => {
    const s = new DriveSession({ preload: async () => {}, revoke: async () => {}, requestToken: async () => Promise.reject(new DriveError('cancelled', 'closed')) })
    await expect(s.connect()).rejects.toMatchObject({ kind: 'cancelled' })
    expect(s.state).toEqual({ state: 'disconnected' })
  })
})

describe('status derivation', () => {
  const base = { open: true, linked: true, dirty: false, pushing: false, driveConnected: true }
  it('follows the documented precedence', () => {
    expect(deriveStatus({ ...base, open: false })).toEqual({ state: 'idle' })
    expect(deriveStatus({ ...base, open: false, localError: 'x' })).toEqual({ state: 'local-error', message: 'x' })
    expect(deriveStatus({ ...base, linked: false, lastLocalSaveAt: 't' })).toEqual({ state: 'saved-local', at: 't' })
    expect(deriveStatus({ ...base, localError: 'quota', pushing: true })).toEqual({ state: 'local-error', message: 'quota' })
    expect(deriveStatus({ ...base, pushing: true, conflict: ['a'] })).toEqual({ state: 'saving-drive' })
    expect(deriveStatus({ ...base, conflict: ['project.json'], dirty: true })).toEqual({ state: 'conflict', files: ['project.json'] })
    expect(deriveStatus({ ...base, dirty: true, driveConnected: false })).toEqual({ state: 'reconnect-required' })
    expect(deriveStatus({ ...base, dirty: true, driveError: 'boom' })).toEqual({ state: 'failed', message: 'boom' })
    expect(deriveStatus({ ...base, dirty: true })).toEqual({ state: 'pending' })
    expect(deriveStatus({ ...base, lastDriveSaveAt: 'd' })).toEqual({ state: 'saved-drive', at: 'd' })
  })
})

describe('AutosaveScheduler', () => {
  it('debounces and backs off', () => {
    const pending: { fn: () => void; ms: number }[] = []
    const timers: Timers = {
      setTimeout: (fn, ms) => {
        const h = { fn, ms }
        pending.push(h)
        return h
      },
      clearTimeout: (h) => pending.splice(pending.indexOf(h as (typeof pending)[number]), 1),
    }
    const task = vi.fn()
    const s = new AutosaveScheduler(task, { delayMs: 4000, timers })
    s.request()
    s.request()
    expect(pending).toHaveLength(1)
    pending.shift()!.fn()
    expect(task).toHaveBeenCalledOnce()
    expect(s.failed()).toBe(15_000)
    pending.length = 0
    expect(s.failed()).toBe(30_000)
    s.succeeded()
    pending.length = 0
    expect(s.failed()).toBe(15_000)
  })
})

describe('readDriveConfig', () => {
  it('is null when unconfigured or incomplete', () => {
    expect(readDriveConfig({})).toBeNull()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(readDriveConfig({ VITE_GOOGLE_CLIENT_ID: 'id' })).toBeNull()
    warn.mockRestore()
  })
  it('defaults to full drive and supports narrower opt-ins', () => {
    const env = { VITE_GOOGLE_CLIENT_ID: 'id', VITE_GOOGLE_API_KEY: 'key', VITE_GOOGLE_APP_ID: '123' }
    expect(readDriveConfig(env)!.scopes).toEqual([SCOPE_DRIVE_FULL])
    expect(readDriveConfig({ ...env, VITE_GOOGLE_DRIVE_SCOPE: 'file' })!.scopes).toEqual([SCOPE_DRIVE_FILE])
    expect(readDriveConfig({ ...env, VITE_GOOGLE_DRIVE_SCOPE: 'readonly' })!.scopes).toEqual([SCOPE_DRIVE_FILE, SCOPE_DRIVE_READONLY])
  })
})
