/**
 * Image display adjustments (brightness, contrast, gamma, saturation, invert,
 * channel view incl. centre contrast, auto contrast): defaults, limits,
 * normalisation and presets.
 * Display-only: these never touch image bytes, coordinates, counts or detector
 * input. The pixel maths lives in viewport/image-adjust.ts.
 */
import type { CentreSample, DisplayChannel, ImageDisplayAdjust, RgbColour } from './types'

export const DISPLAY_CHANNELS: readonly DisplayChannel[] = ['rgb', 'red', 'green', 'blue', 'luma', 'centre']

export const DEFAULT_DISPLAY: Readonly<ImageDisplayAdjust> = Object.freeze({
  brightness: 0,
  contrast: 0,
  gamma: 1,
  saturation: 1,
  invert: false,
  channel: 'rgb',
  autoContrast: false,
  centre: null,
  separation: 6,
})

/** Inclusive limits of the numeric fields. */
export const DISPLAY_LIMITS = {
  brightness: { min: -1, max: 1 },
  contrast: { min: -1, max: 1 },
  gamma: { min: 0.2, max: 5 },
  saturation: { min: 0, max: 3 },
  separation: { min: 2, max: 16 },
} as const

type NumericKey = keyof typeof DISPLAY_LIMITS

function clampField(k: NumericKey, v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_DISPLAY[k]
  const { min, max } = DISPLAY_LIMITS[k]
  // Round away float noise from slider maths so stored values stay readable.
  return Math.round(Math.min(max, Math.max(min, v)) * 1000) / 1000
}

function normaliseColour(v: unknown): RgbColour | null {
  if (!Array.isArray(v) || v.length !== 3 || !v.every((c) => typeof c === 'number' && Number.isFinite(c))) return null
  return v.map((c: number) => Math.round(Math.min(255, Math.max(0, c)) * 10) / 10) as RgbColour
}

function normaliseCentre(v: unknown): CentreSample | null {
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  const centre = normaliseColour(o.centre)
  const rim = normaliseColour(o.rim)
  if (!centre || !rim) return null
  return { centre, rim, pickedRim: normaliseColour(o.pickedRim) }
}

/**
 * Lenient normalisation of untrusted input: unknown/invalid fields fall back to
 * their defaults and numbers are clamped. Never throws.
 */
export function normaliseDisplay(v: unknown): ImageDisplayAdjust {
  const o = (typeof v === 'object' && v !== null && !Array.isArray(v) ? v : {}) as Record<string, unknown>
  return {
    brightness: clampField('brightness', o.brightness),
    contrast: clampField('contrast', o.contrast),
    gamma: clampField('gamma', o.gamma),
    saturation: clampField('saturation', o.saturation),
    invert: typeof o.invert === 'boolean' ? o.invert : DEFAULT_DISPLAY.invert,
    channel: DISPLAY_CHANNELS.includes(o.channel as DisplayChannel) ? (o.channel as DisplayChannel) : DEFAULT_DISPLAY.channel,
    autoContrast: typeof o.autoContrast === 'boolean' ? o.autoContrast : DEFAULT_DISPLAY.autoContrast,
    centre: normaliseCentre(o.centre),
    separation: clampField('separation', o.separation),
  }
}

/** The rim colour in effect: the picked one, else the automatic estimate. */
export const effectiveRim = (c: CentreSample): RgbColour => c.pickedRim ?? c.rim

/**
 * True when the adjustment shows the image unchanged (absent counts as default).
 * Centre samples and separation only matter in the `centre` view, which is never default.
 */
export function isDefaultDisplay(d: ImageDisplayAdjust | undefined | null): boolean {
  if (!d) return true
  return (
    d.brightness === 0 &&
    d.contrast === 0 &&
    d.gamma === 1 &&
    d.saturation === 1 &&
    !d.invert &&
    d.channel === 'rgb' &&
    !d.autoContrast
  )
}

/** Stable comparison key (same key = same rendering). */
export function displayKey(d: ImageDisplayAdjust | undefined | null): string {
  if (isDefaultDisplay(d)) return 'default'
  const n = d!
  const sat = n.channel === 'rgb' ? n.saturation : 1
  const key = `${n.channel}|${n.brightness}|${n.contrast}|${n.gamma}|${sat}|${n.invert ? 1 : 0}|${n.autoContrast ? 1 : 0}`
  return n.channel === 'centre' ? `${key}|${centreKey(n)}` : key
}

/** Key of what the centre view's colour stage depends on ('none' = no sample yet: shown as grey). */
export function centreKey(d: Pick<ImageDisplayAdjust, 'centre' | 'separation'>): string {
  const c = d.centre
  return c ? `${c.centre.join(',')}/${effectiveRim(c).join(',')}/${d.separation}` : 'none'
}

/**
 * Field value for storage: `undefined` for the default (keeps project.json small).
 * A default-looking value with centre samples is kept, so switching away from the
 * centre view and back does not lose the picked colours.
 */
export function storedDisplay(d: ImageDisplayAdjust | undefined | null): ImageDisplayAdjust | undefined {
  if (!d) return undefined
  const n = normaliseDisplay(d)
  return isDefaultDisplay(n) && !n.centre ? undefined : n
}

export interface DisplayPreset {
  id: string
  label: string
  /** One-line explanation for the preset button title / aria-description. */
  description: string
  value: ImageDisplayAdjust
}

export const DISPLAY_PRESETS: readonly DisplayPreset[] = [
  { id: 'default', label: 'Default', description: 'The photo as recorded', value: { ...DEFAULT_DISPLAY } },
  {
    id: 'high-contrast',
    label: 'High contrast',
    description: 'Auto-stretched levels with extra contrast',
    value: { ...DEFAULT_DISPLAY, autoContrast: true, contrast: 0.35, saturation: 1.3 },
  },
  {
    id: 'green',
    label: 'Green channel',
    description: 'Green channel only, auto-stretched: often the sharpest colony edges',
    value: { ...DEFAULT_DISPLAY, channel: 'green', autoContrast: true },
  },
  {
    id: 'inverted-grey',
    label: 'Inverted grey',
    description: 'Greyscale, inverted and auto-stretched: dark colonies become bright',
    value: { ...DEFAULT_DISPLAY, channel: 'luma', invert: true, autoContrast: true },
  },
  {
    id: 'centres',
    label: 'Colony centres',
    description: 'Centre contrast: colony centres bright, the rest of the disc dim, background dark (pick a centre colour)',
    value: { ...DEFAULT_DISPLAY, channel: 'centre' },
  },
]

/** Apply a preset to `current`: everything changes except the sampled centre colours. */
export function applyPreset(p: DisplayPreset, current: ImageDisplayAdjust): ImageDisplayAdjust {
  return { ...p.value, centre: current.centre }
}

/** The preset an adjustment equals (ignoring the sampled colours), if any. */
export function matchingPreset(d: ImageDisplayAdjust | undefined | null): DisplayPreset | undefined {
  const key = (v: ImageDisplayAdjust | undefined | null) => {
    const n = normaliseDisplay(v)
    return `${displayKey({ ...n, centre: null })}${n.channel === 'centre' ? `|${n.separation}` : ''}`
  }
  const k = key(d)
  return DISPLAY_PRESETS.find((p) => key(p.value) === k)
}
