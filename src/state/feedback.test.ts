import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CUES, cueFor, type FeedbackEvent } from './feedback'
import { DEFAULT_SOUND, SOUND_PREF_KEY, audible, createSoundSettings, loadSoundSettings, normaliseSound, toggleFor } from './soundSettings'

describe('cueFor (event → cue)', () => {
  it('maps edit events to their cues', () => {
    const cases: [FeedbackEvent, ReturnType<typeof cueFor>][] = [
      [{ type: 'added', near: false }, 'add'],
      [{ type: 'added', near: true }, 'nearDuplicate'],
      [{ type: 'erased' }, 'erase'],
      [{ type: 'history', direction: 'undo' }, 'undo'],
      [{ type: 'history', direction: 'redo' }, 'undo'],
      [{ type: 'refused', reason: 'locked' }, 'error'],
      [{ type: 'refused', reason: 'nothing-to-erase' }, 'error'],
      [{ type: 'accepted', count: 12 }, 'accept'],
      [{ type: 'accepted', count: 0 }, null],
      [{ type: 'notice', tone: 'error' }, 'error'],
      [{ type: 'notice', tone: 'warning' }, null],
      [{ type: 'notice', tone: 'info' }, null],
      [{ type: 'notice', tone: 'success' }, null],
    ]
    for (const [event, cue] of cases) expect(cueFor(event), JSON.stringify(event)).toBe(cue)
  })
})

describe('sound settings', () => {
  it('every cue has a switch; placing covers the near-duplicate tick', () => {
    for (const cue of CUES) expect(DEFAULT_SOUND.cues[toggleFor(cue)]).toBeTypeOf('boolean')
    expect(toggleFor('nearDuplicate')).toBe('place')
  })

  it('defaults: on for place/erase/error/accept, off for undo', () => {
    expect(audible(DEFAULT_SOUND, 'add')).toBe(true)
    expect(audible(DEFAULT_SOUND, 'erase')).toBe(true)
    expect(audible(DEFAULT_SOUND, 'error')).toBe(true)
    expect(audible(DEFAULT_SOUND, 'accept')).toBe(true)
    expect(audible(DEFAULT_SOUND, 'undo')).toBe(false)
  })

  it('the master switch and zero volume silence everything', () => {
    expect(audible({ ...DEFAULT_SOUND, enabled: false }, 'error')).toBe(false)
    expect(audible({ ...DEFAULT_SOUND, volume: 0 }, 'add')).toBe(false)
    expect(audible({ ...DEFAULT_SOUND, cues: { ...DEFAULT_SOUND.cues, place: false } }, 'nearDuplicate')).toBe(false)
  })

  it('normalises whatever storage holds', () => {
    expect(normaliseSound(null)).toEqual(DEFAULT_SOUND)
    expect(normaliseSound('junk')).toEqual(DEFAULT_SOUND)
    expect(normaliseSound({ enabled: 'yes', volume: 7, cues: { place: false, erase: 3, bogus: true } })).toEqual({
      enabled: true,
      volume: 1,
      cues: { ...DEFAULT_SOUND.cues, place: false },
    })
    expect(normaliseSound({ volume: Number.NaN }).volume).toBe(DEFAULT_SOUND.volume)
  })

  describe('persistence', () => {
    let store: Map<string, string>
    beforeEach(() => {
      store = new Map()
      vi.stubGlobal('localStorage', {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      })
    })
    afterEach(() => vi.unstubAllGlobals())

    it('saves patches per device and reads them back', () => {
      const a = createSoundSettings()
      expect(a.get()).toEqual(DEFAULT_SOUND)
      a.update({ volume: 0.25, cues: { erase: false } })
      a.update({ enabled: false })
      expect(a.get()).toEqual({ enabled: false, volume: 0.25, cues: { ...DEFAULT_SOUND.cues, erase: false } })
      expect(JSON.parse(store.get(`cfu-count:${SOUND_PREF_KEY}`)!)).toEqual(a.get())
      expect(createSoundSettings().get()).toEqual(a.get()) // "reload"
    })

    it('falls back to defaults when storage is broken or throws', () => {
      store.set(`cfu-count:${SOUND_PREF_KEY}`, '{not json')
      expect(loadSoundSettings()).toEqual(DEFAULT_SOUND)
      vi.stubGlobal('localStorage', {
        getItem: () => {
          throw new Error('denied')
        },
        setItem: () => {
          throw new Error('denied')
        },
      })
      const s = createSoundSettings()
      expect(() => s.update({ volume: 0.3 })).not.toThrow()
      expect(s.get().volume).toBe(0.3) // still applies for this session
    })
  })
})
