import { describe, expect, it } from 'vitest'
import { DEFAULT_DISPLAY, DISPLAY_PRESETS, applyPreset, displayKey, effectiveRim, isDefaultDisplay, matchingPreset, normaliseDisplay, storedDisplay } from './display'
import type { CentreSample } from './types'

const sample: CentreSample = { centre: [150, 150, 140], rim: [110, 115, 115], pickedRim: null }

describe('display adjustments', () => {
  it('normalises untrusted input with defaults and clamping', () => {
    expect(normaliseDisplay(undefined)).toEqual(DEFAULT_DISPLAY)
    expect(normaliseDisplay('x')).toEqual(DEFAULT_DISPLAY)
    expect(
      normaliseDisplay({ brightness: 3, contrast: -7, gamma: 0, saturation: Number.NaN, invert: 'yes', channel: 'purple', autoContrast: true, extra: 1 }),
    ).toEqual({ ...DEFAULT_DISPLAY, brightness: 1, contrast: -1, gamma: 0.2, autoContrast: true })
    expect(normaliseDisplay({ brightness: 0.1 + 0.2 }).brightness).toBe(0.3)
  })
  it('detects the default and stores it as absent', () => {
    expect(isDefaultDisplay(undefined)).toBe(true)
    expect(isDefaultDisplay({ ...DEFAULT_DISPLAY })).toBe(true)
    expect(isDefaultDisplay({ ...DEFAULT_DISPLAY, invert: true })).toBe(false)
    expect(storedDisplay({ ...DEFAULT_DISPLAY })).toBeUndefined()
    expect(storedDisplay({ ...DEFAULT_DISPLAY, gamma: 9 })).toEqual({ ...DEFAULT_DISPLAY, gamma: 5 })
  })
  it('keys ignore saturation outside the colour view', () => {
    expect(displayKey({ ...DEFAULT_DISPLAY, channel: 'green', saturation: 2 })).toBe(displayKey({ ...DEFAULT_DISPLAY, channel: 'green' }))
    expect(displayKey(undefined)).toBe('default')
  })
  it('presets are valid, distinct and matchable', () => {
    const keys = DISPLAY_PRESETS.map((p) => displayKey(p.value))
    expect(new Set(keys).size).toBe(keys.length)
    for (const p of DISPLAY_PRESETS) {
      expect(normaliseDisplay(p.value)).toEqual(p.value)
      expect(matchingPreset(p.value)?.id).toBe(p.id)
    }
    expect(matchingPreset(undefined)?.id).toBe('default')
    expect(matchingPreset({ ...DEFAULT_DISPLAY, gamma: 1.5 })).toBeUndefined()
  })
  it('centre view: key follows the samples and separation, never the default', () => {
    const c = { ...DEFAULT_DISPLAY, channel: 'centre' as const, centre: sample }
    expect(isDefaultDisplay(c)).toBe(false)
    expect(displayKey(c)).not.toBe(displayKey({ ...c, separation: 9 }))
    expect(displayKey(c)).not.toBe(displayKey({ ...c, centre: { ...sample, pickedRim: [90, 90, 90] } }))
    expect(displayKey(c)).not.toBe(displayKey({ ...c, centre: null }))
    // Outside the centre view samples and separation don't change the rendering.
    expect(displayKey({ ...DEFAULT_DISPLAY, channel: 'green', centre: sample, separation: 3 })).toBe(displayKey({ ...DEFAULT_DISPLAY, channel: 'green' }))
    expect(effectiveRim(sample)).toEqual(sample.rim)
    expect(effectiveRim({ ...sample, pickedRim: [1, 2, 3] })).toEqual([1, 2, 3])
  })
  it('keeps samples when switching away from the centre view, and through presets', () => {
    expect(storedDisplay({ ...DEFAULT_DISPLAY, centre: sample })).toEqual({ ...DEFAULT_DISPLAY, centre: sample })
    const centres = DISPLAY_PRESETS.find((p) => p.id === 'centres')!
    const v = applyPreset(centres, { ...DEFAULT_DISPLAY, brightness: 0.4, centre: sample })
    expect(v).toEqual({ ...DEFAULT_DISPLAY, channel: 'centre', centre: sample })
    expect(matchingPreset(v)?.id).toBe('centres')
    expect(matchingPreset({ ...v, separation: 10 })).toBeUndefined()
    expect(normaliseDisplay({ centre: { centre: [1, 2, 3.14159], rim: [4, 5, 6] } }).centre).toEqual({ centre: [1, 2, 3.1], rim: [4, 5, 6], pickedRim: null })
  })
})
