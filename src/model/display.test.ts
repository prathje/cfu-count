import { describe, expect, it } from 'vitest'
import { DEFAULT_DISPLAY, DISPLAY_PRESETS, displayKey, isDefaultDisplay, matchingPreset, normaliseDisplay, storedDisplay } from './display'

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
})
