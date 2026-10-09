/**
 * Google Identity Services (GIS) token model, browser only.
 * https://developers.google.com/identity/oauth2/web/guides/use-token-model
 *
 * Access tokens are short-lived (typically 1 h), live only in memory and are
 * renewed by calling requestToken() again from a user action. No refresh token
 * or client secret exists in this flow.
 */
import { DriveError } from '../errors'
import type { DriveConfig } from './config'
import { loadScript } from './scripts'

const GIS_SRC = 'https://accounts.google.com/gsi/client'

/** An in-memory OAuth access token. Never persist or log `accessToken`. */
export interface AccessToken {
  accessToken: string
  /** Epoch ms. */
  expiresAt: number
  scopes: string[]
}

/** Obtains OAuth access tokens for Drive. The GIS implementation is the only production one. */
export interface TokenProvider {
  /** Load GIS ahead of time so requestToken can open its popup inside the user's click. */
  preload(): Promise<void>
  /**
   * Request a token. Call directly from a click handler: if GIS is already loaded the
   * popup opens synchronously, which Safari's popup blocker requires.
   * `hint` = email of the previously used account (skips the account chooser).
   */
  requestToken(opts?: { hint?: string }): Promise<AccessToken>
  revoke(accessToken: string): Promise<void>
}

// --- minimal GIS typings (only what we use) ---
interface GisTokenResponse {
  access_token?: string
  expires_in?: number | string
  scope?: string
  error?: string
  error_description?: string
}
interface GisTokenClient {
  requestAccessToken(overrides?: { prompt?: string; login_hint?: string }): void
}
interface GisOauth2 {
  initTokenClient(config: {
    client_id: string
    scope: string
    callback: (r: GisTokenResponse) => void
    error_callback?: (e: { type?: string; message?: string }) => void
  }): GisTokenClient
  hasGrantedAllScopes(r: GisTokenResponse, first: string, ...rest: string[]): boolean
  revoke(token: string, done?: () => void): void
}
function gis(): GisOauth2 | undefined {
  return (globalThis as unknown as { google?: { accounts?: { oauth2?: GisOauth2 } } }).google?.accounts?.oauth2
}

export class GisTokenProvider implements TokenProvider {
  private readonly config: DriveConfig
  private client: GisTokenClient | null = null
  private pending: { resolve: (t: AccessToken) => void; reject: (e: unknown) => void } | null = null

  constructor(config: DriveConfig) {
    this.config = config
  }

  async preload(): Promise<void> {
    if (this.client) return
    await loadScript(GIS_SRC)
    const oauth2 = gis()
    if (!oauth2) throw new DriveError('network', 'Google sign-in did not initialise.')
    this.client ??= oauth2.initTokenClient({
      client_id: this.config.clientId,
      scope: this.config.scopes.join(' '),
      callback: (r) => this.onResponse(r),
      error_callback: (e) => this.onError(e),
    })
  }

  requestToken(opts: { hint?: string } = {}): Promise<AccessToken> {
    const promise = new Promise<AccessToken>((resolve, reject) => {
      this.pending?.reject(new DriveError('cancelled', 'Superseded by a newer sign-in request.'))
      this.pending = { resolve, reject }
    })
    const open = () =>
      this.client!.requestAccessToken(opts.hint ? { prompt: '', login_hint: opts.hint } : {})
    if (this.client) open()
    else
      this.preload().then(open, (e) => {
        this.pending?.reject(e instanceof DriveError ? e : new DriveError('network', `Could not load Google sign-in: ${(e as Error).message}`))
        this.pending = null
      })
    return promise
  }

  async revoke(accessToken: string): Promise<void> {
    const oauth2 = gis()
    if (!oauth2) return
    await new Promise<void>((resolve) => oauth2.revoke(accessToken, resolve))
  }

  private onResponse(r: GisTokenResponse): void {
    const p = this.pending
    this.pending = null
    if (!p) return
    if (r.error || !r.access_token) {
      p.reject(new DriveError(r.error === 'access_denied' ? 'cancelled' : 'unauthorized', `Google sign-in failed: ${r.error_description || r.error || 'no token returned'}.`))
      return
    }
    const [first, ...rest] = this.config.scopes
    if (!gis()!.hasGrantedAllScopes(r, first, ...rest)) {
      p.reject(new DriveError('forbidden', 'Google Drive access was not granted. Connect again and allow access to Drive files.'))
      return
    }
    const seconds = Number(r.expires_in) || 3600
    p.resolve({ accessToken: r.access_token, expiresAt: Date.now() + seconds * 1000, scopes: (r.scope ?? '').split(' ').filter(Boolean) })
  }

  private onError(e: { type?: string; message?: string }): void {
    const p = this.pending
    this.pending = null
    if (!p) return
    if (e.type === 'popup_failed_to_open') {
      p.reject(new DriveError('unauthorized', 'The Google sign-in window was blocked. Allow pop-ups for this site and try again.'))
    } else if (e.type === 'popup_closed') {
      p.reject(new DriveError('cancelled', 'Google sign-in was closed.'))
    } else {
      p.reject(new DriveError('unauthorized', `Google sign-in failed: ${e.message || e.type || 'unknown error'}.`))
    }
  }
}
