/** Small per-browser preferences in localStorage. Every access is guarded: storage may be unavailable. */
const PREFIX = 'cfu-count:'

export const prefs = {
  get<T>(key: string, fallback: T): T {
    try {
      const raw = globalThis.localStorage?.getItem(PREFIX + key)
      return raw == null ? fallback : (JSON.parse(raw) as T)
    } catch {
      return fallback
    }
  },
  set(key: string, value: unknown): void {
    try {
      if (value === null || value === undefined) globalThis.localStorage?.removeItem(PREFIX + key)
      else globalThis.localStorage?.setItem(PREFIX + key, JSON.stringify(value))
    } catch {
      /* preferences are best-effort */
    }
  },
}
