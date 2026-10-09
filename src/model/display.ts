/**
 * Image display adjustments (brightness, contrast, gamma, saturation, invert,
 * channel view, auto contrast): defaults, limits, normalisation and presets.
 * Display-only: these never touch image bytes, coordinates, counts or detector
 * input. The pixel maths lives in viewport/image-adjust.ts.
 */
import type { DisplayChannel, ImageDisplayAdjust } from './types'

export const DISPLAY_CHANNELS: readonly DisplayChannel[] = ['rgb', 'red', 'green', 'blue', 'luma']

export const DEFAULT_DISPLAY: Readonly<ImageDisplayAdjust> = Object.freeze({
  brightness: 0,
  contrast: 0,
  gamma: 1,
  saturation: 1,
  invert: false,
  channel: 'rgb',
  autoContrast: false,
})

/** Inclusive limits of the numeric fields. */
export const DISPLAY_LIMITS = {
  brightness: { min: -1, max: 1 },
  contrast: { min: -1, max: 1 },
  gamma: { min: 0.2, max: 5 },
  saturation: { min: 0, max: 3 },
} as const

type NumericKey = keyof typeof DISPLAY_LIMITS

function clampField(k: NumericKey, v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_DISPLAY[k]
  const { min, max } = DISPLAY_LIMITS[k]
  // Round away float noise from slider maths so stored values stay readable.
  return Math.round(Math.min(max, Math.max(min, v)) * 1000) / 1000
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
  }
}

/** True when the adjustment shows the image unchanged (absent counts as default). */
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
  return `${n.channel}|${n.brightness}|${n.contrast}|${n.gamma}|${sat}|${n.invert ? 1 : 0}|${n.autoContrast ? 1 : 0}`
}

/** Field value for storage: `undefined` for the default (keeps project.json small). */
export function storedDisplay(d: ImageDisplayAdjust | undefined | null): ImageDisplayAdjust | undefined {
  if (!d) return undefined
  const n = normaliseDisplay(d)
  return isDefaultDisplay(n) ? undefined : n
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
]

/** The preset an adjustment equals, if any. */
export function matchingPreset(d: ImageDisplayAdjust | undefined | null): DisplayPreset | undefined {
  const key = displayKey(d)
  return DISPLAY_PRESETS.find((p) => displayKey(p.value) === key)
}
