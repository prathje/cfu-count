/**
 * Build-time Google configuration (Vite env vars). All values are PUBLIC
 * identifiers that end up in the shipped JavaScript; no secret is ever used.
 *
 *   VITE_GOOGLE_CLIENT_ID     OAuth 2.0 Web client ID
 *   VITE_GOOGLE_API_KEY       browser API key (restricted), used by Google Picker
 *   VITE_GOOGLE_APP_ID        Cloud project NUMBER, passed to Picker.setAppId
 *   VITE_GOOGLE_DRIVE_SCOPE   optional: "file" (default) | "readonly" | "full"
 */

export const SCOPE_DRIVE_FILE = 'https://www.googleapis.com/auth/drive.file'
export const SCOPE_DRIVE_READONLY = 'https://www.googleapis.com/auth/drive.readonly'
export const SCOPE_DRIVE_FULL = 'https://www.googleapis.com/auth/drive'

export type DriveScopeMode = 'file' | 'readonly' | 'full'

/** Validated Drive configuration; `null` from readDriveConfig means Drive is unavailable in this build. */
export interface DriveConfig {
  clientId: string
  apiKey: string
  appId: string
  scopeMode: DriveScopeMode
  /** Space-separated OAuth scopes requested from Google Identity Services. */
  scopes: string[]
}

export interface DriveEnv {
  VITE_GOOGLE_CLIENT_ID?: string
  VITE_GOOGLE_API_KEY?: string
  VITE_GOOGLE_APP_ID?: string
  VITE_GOOGLE_DRIVE_SCOPE?: string
}

export function scopesFor(mode: DriveScopeMode): string[] {
  switch (mode) {
    case 'file':
      return [SCOPE_DRIVE_FILE]
    case 'readonly':
      // drive.file still needed to create/update the app's own output files.
      return [SCOPE_DRIVE_FILE, SCOPE_DRIVE_READONLY]
    case 'full':
      return [SCOPE_DRIVE_FULL]
  }
}

export function readDriveConfig(env: DriveEnv = import.meta.env as DriveEnv): DriveConfig | null {
  const clientId = env.VITE_GOOGLE_CLIENT_ID?.trim() ?? ''
  const apiKey = env.VITE_GOOGLE_API_KEY?.trim() ?? ''
  const appId = env.VITE_GOOGLE_APP_ID?.trim() ?? ''
  if (!clientId && !apiKey && !appId) return null
  const missing = [
    !clientId && 'VITE_GOOGLE_CLIENT_ID',
    !apiKey && 'VITE_GOOGLE_API_KEY',
    !appId && 'VITE_GOOGLE_APP_ID',
  ].filter(Boolean)
  if (missing.length) {
    console.warn(`Google Drive disabled: missing ${missing.join(', ')} (see docs/google-drive-setup.md).`)
    return null
  }
  const raw = (env.VITE_GOOGLE_DRIVE_SCOPE?.trim() || 'file') as DriveScopeMode
  const scopeMode: DriveScopeMode = raw === 'readonly' || raw === 'full' ? raw : 'file'
  if (raw !== scopeMode) console.warn(`Unknown VITE_GOOGLE_DRIVE_SCOPE "${raw}", using "file".`)
  return { clientId, apiKey, appId, scopeMode, scopes: scopesFor(scopeMode) }
}
