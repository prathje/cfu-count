/**
 * In-memory Drive session: the current access token, its expiry and the
 * user-visible DriveState. The token never leaves this object except through
 * accessToken(), which the HTTP client calls per request.
 */
import type { DriveState } from '../api'
import { DriveError } from '../errors'
import type { TokenProvider } from './auth'

/** Treat a token as expired this long before Google's stated expiry. */
const EXPIRY_SKEW_MS = 60_000

export interface SessionClock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const realClock: SessionClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

export class DriveSession {
  private readonly provider: TokenProvider | null
  private readonly clock: SessionClock
  private token: string | null = null
  private expiresAt = 0
  private account: string | undefined
  private timer: unknown = null
  private current: DriveState
  private readonly listeners = new Set<(s: DriveState) => void>()

  constructor(provider: TokenProvider | null, clock: SessionClock = realClock) {
    this.provider = provider
    this.clock = clock
    this.current = provider ? { state: 'disconnected' } : { state: 'unconfigured' }
  }

  get state(): DriveState {
    return this.current
  }

  get configured(): boolean {
    return this.provider !== null
  }

  get isConnected(): boolean {
    return this.token !== null && this.clock.now() < this.expiresAt - EXPIRY_SKEW_MS
  }

  onChange(fn: (s: DriveState) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** A currently valid access token, or throws DriveError('unauthorized'). */
  accessToken(): string {
    if (!this.provider) throw new DriveError('unconfigured', 'Google Drive is not configured in this build.')
    if (!this.isConnected) {
      if (this.token) this.expire()
      throw new DriveError('unauthorized', 'Google Drive session expired. Reconnect to continue saving to Drive.')
    }
    return this.token!
  }

  /**
   * Interactive sign-in. Calls the provider synchronously (before any await) so the
   * consent popup stays inside the caller's user gesture.
   */
  connect(): Promise<void> {
    if (!this.provider) return Promise.reject(new DriveError('unconfigured', 'Google Drive is not configured in this build.'))
    const previous = this.current
    const request = this.provider.requestToken({ hint: this.account })
    this.set({ state: 'connecting' })
    return request.then(
      (t) => {
        this.token = t.accessToken
        this.expiresAt = t.expiresAt
        this.armTimer()
        this.set({ state: 'connected', account: this.account, expiresAt: t.expiresAt })
      },
      (e) => {
        this.set(previous.state === 'connecting' ? { state: 'disconnected' } : previous)
        throw e
      },
    )
  }

  /** Record the signed-in account's email (from Drive about.get). */
  setAccount(email: string | undefined): void {
    this.account = email
    if (this.current.state === 'connected') this.set({ ...this.current, account: email })
    else if (this.current.state === 'expired') this.set({ ...this.current, account: email })
  }

  get accountEmail(): string | undefined {
    return this.account
  }

  /** Called on expiry timer or HTTP 401. */
  expire(): void {
    this.token = null
    this.clearTimer()
    if (this.provider) this.set({ state: 'expired', account: this.account })
  }

  async disconnect(): Promise<void> {
    const token = this.token
    this.token = null
    this.account = undefined
    this.clearTimer()
    if (this.provider) this.set({ state: 'disconnected' })
    if (token && this.provider) {
      try {
        await this.provider.revoke(token)
      } catch {
        // Revocation is best effort; the token is already forgotten locally.
      }
    }
  }

  private armTimer(): void {
    this.clearTimer()
    const ms = Math.max(0, this.expiresAt - EXPIRY_SKEW_MS - this.clock.now())
    this.timer = this.clock.setTimeout(() => this.expire(), ms)
  }

  private clearTimer(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer)
    this.timer = null
  }

  private set(s: DriveState): void {
    this.current = s
    for (const fn of this.listeners) fn(s)
  }
}
