/**
 * Sound feedback settings: per device (localStorage via prefs), never in the project.
 * Pure helpers (defaults, normalise, which cue is audible) plus a small reactive holder.
 */
import { createSignal, type Accessor } from 'solid-js'
import type { Cue } from './feedback'
import { prefs } from './prefs'

/** User-facing switches; several cues can share one (add + near-duplicate = placing). */
export type CueToggle = 'place' | 'erase' | 'error' | 'accept' | 'undo'

export const CUE_TOGGLES: readonly CueToggle[] = ['place', 'erase', 'error', 'accept', 'undo']

export interface SoundSettings {
  /** Master switch. */
  enabled: boolean
  /** 0..1 (perceptual; the engine squares it). */
  volume: number
  cues: Record<CueToggle, boolean>
}

/**
 * Defaults: on, because the point is noticing a tap that did NOT place a marker.
 * Undo is off (the toolbar already shows it and rapid undo would chatter).
 * Browsers stay silent until the first tap or key press anyway.
 */
export const DEFAULT_SOUND: SoundSettings = {
  enabled: true,
  volume: 0.6,
  cues: { place: true, erase: true, error: true, accept: true, undo: false },
}

export const SOUND_PREF_KEY = 'sound'

const TOGGLE_OF: Record<Cue, CueToggle> = {
  add: 'place',
  nearDuplicate: 'place',
  erase: 'erase',
  error: 'error',
  accept: 'accept',
  undo: 'undo',
}

export function toggleFor(cue: Cue): CueToggle {
  return TOGGLE_OF[cue]
}

/** True when the cue should play with these settings. */
export function audible(settings: SoundSettings, cue: Cue): boolean {
  return settings.enabled && settings.volume > 0 && settings.cues[TOGGLE_OF[cue]]
}

/** Accept anything read from storage; unknown or broken fields fall back to defaults. */
export function normaliseSound(raw: unknown): SoundSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof SoundSettings, unknown>>
  const cuesRaw = (r.cues && typeof r.cues === 'object' ? r.cues : {}) as Record<string, unknown>
  const cues = { ...DEFAULT_SOUND.cues }
  for (const k of CUE_TOGGLES) if (typeof cuesRaw[k] === 'boolean') cues[k] = cuesRaw[k] as boolean
  const volume = typeof r.volume === 'number' && Number.isFinite(r.volume) ? Math.min(1, Math.max(0, r.volume)) : DEFAULT_SOUND.volume
  return { enabled: typeof r.enabled === 'boolean' ? r.enabled : DEFAULT_SOUND.enabled, volume, cues }
}

export function loadSoundSettings(): SoundSettings {
  return normaliseSound(prefs.get<unknown>(SOUND_PREF_KEY, null))
}

export function saveSoundSettings(settings: SoundSettings): void {
  prefs.set(SOUND_PREF_KEY, settings)
}

/** Patch for `update`: top-level fields and/or individual cue switches. */
export interface SoundSettingsPatch {
  enabled?: boolean
  volume?: number
  cues?: Partial<Record<CueToggle, boolean>>
}

export interface SoundSettingsStore {
  get: Accessor<SoundSettings>
  /** Apply a patch and persist it on this device. */
  update(patch: SoundSettingsPatch): void
}

export function createSoundSettings(initial: SoundSettings = loadSoundSettings()): SoundSettingsStore {
  const [get, set] = createSignal<SoundSettings>(initial)
  return {
    get,
    update(patch) {
      const cur = get()
      const next = normaliseSound({ ...cur, ...patch, cues: { ...cur.cues, ...patch.cues } })
      set(next)
      saveSoundSettings(next)
    },
  }
}
