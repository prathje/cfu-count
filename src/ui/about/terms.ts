/**
 * Project links and the first-run terms of use. Acceptance is remembered per
 * browser in localStorage (via prefs); bump TERMS_VERSION when the wording
 * changes materially so everyone sees the new terms once.
 */
import { prefs } from '../../state/prefs'

export const REPO_URL = 'https://github.com/prathje/cfu-count'
export const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`

export const TERMS_VERSION = 1
const KEY = 'terms'

export interface TermsAcceptance {
  version: number
  acceptedAt: string
}

/** Minimal key/value store (prefs in the app; a fake in tests). */
export interface TermsStore {
  get<T>(key: string, fallback: T): T
  set(key: string, value: unknown): void
}

/** True when this browser has accepted the current terms version. */
export function hasAcceptedTerms(store: TermsStore = prefs): boolean {
  const a = store.get<TermsAcceptance | null>(KEY, null)
  return !!a && typeof a === 'object' && typeof a.version === 'number' && a.version >= TERMS_VERSION
}

export function acceptTerms(store: TermsStore = prefs, now: Date = new Date()): void {
  store.set(KEY, { version: TERMS_VERSION, acceptedAt: now.toISOString() } satisfies TermsAcceptance)
}
