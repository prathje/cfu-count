import { describe, expect, it } from 'vitest'
import { shouldWarnBeforeUnload, UNSAVED_GRACE_MS } from './unload'
import type { SaveStatus } from '../storage/api'

const saved: SaveStatus = { state: 'saved-local', at: '' }

describe('shouldWarnBeforeUnload', () => {
  it('stays quiet when everything is saved or only the normal debounce is pending', () => {
    expect(shouldWarnBeforeUnload({ status: saved, saveFailed: false, dirtySince: null, now: 10_000 })).toBe(false)
    expect(shouldWarnBeforeUnload({ status: saved, saveFailed: false, dirtySince: 10_000, now: 10_400 })).toBe(false)
    expect(shouldWarnBeforeUnload({ status: saved, saveFailed: false, dirtySince: 10_000, now: 10_000 + UNSAVED_GRACE_MS })).toBe(false)
  })

  it('does not warn for changes that only wait for Google Drive', () => {
    for (const status of [{ state: 'pending' }, { state: 'saving-drive' }, { state: 'failed', message: 'offline' }, { state: 'reconnect-required' }] as SaveStatus[]) {
      expect(shouldWarnBeforeUnload({ status, saveFailed: false, dirtySince: null, now: 0 })).toBe(false)
    }
  })

  it('warns after a failed local save or when edits wait longer than the grace period', () => {
    expect(shouldWarnBeforeUnload({ status: { state: 'local-error', message: 'quota' }, saveFailed: false, dirtySince: null, now: 0 })).toBe(true)
    expect(shouldWarnBeforeUnload({ status: saved, saveFailed: true, dirtySince: 0, now: 1 })).toBe(true)
    expect(shouldWarnBeforeUnload({ status: saved, saveFailed: false, dirtySince: 0, now: UNSAVED_GRACE_MS + 1 })).toBe(true)
  })
})
