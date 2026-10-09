import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAutosaver } from './autosave'

describe('autosave', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('debounces and coalesces changed docs', async () => {
    const save = vi.fn(async (_ids: string[]) => {})
    const s = createAutosaver({ delay: 400, save })
    s.markDoc('a')
    await vi.advanceTimersByTimeAsync(200)
    s.markDoc('b')
    s.markDoc('a')
    await vi.advanceTimersByTimeAsync(399)
    expect(save).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][0].sort()).toEqual(['a', 'b'])
    expect(s.dirty()).toBe(false)
  })

  it('flush saves immediately; project-only changes save with no docs', async () => {
    const save = vi.fn(async (_ids: string[]) => {})
    const s = createAutosaver({ save })
    s.markProject()
    await s.flush()
    expect(save).toHaveBeenCalledWith([])
    await s.flush()
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('never overlaps saves; changes during a save go into the next one', async () => {
    let release!: () => void
    const calls: string[][] = []
    const save = vi.fn(
      (ids: string[]) =>
        new Promise<void>((r) => {
          calls.push(ids)
          release = r
        }),
    )
    const s = createAutosaver({ delay: 10, save })
    s.markDoc('a')
    await vi.advanceTimersByTimeAsync(10)
    expect(calls).toEqual([['a']])
    s.markDoc('b')
    const flushed = s.flush()
    await vi.advanceTimersByTimeAsync(50)
    expect(calls).toHaveLength(1)
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls[1]).toEqual(['b'])
    release()
    await flushed
  })

  it('keeps work marked after a failure so it is retried', async () => {
    const onError = vi.fn()
    let fail = true
    const save = vi.fn(async (_ids: string[]) => {
      if (fail) throw new Error('quota')
    })
    const s = createAutosaver({ save, onError })
    s.markDoc('a')
    await s.flush()
    expect(onError).toHaveBeenCalledOnce()
    expect(s.dirty()).toBe(true)
    fail = false
    await s.flush()
    expect(save.mock.calls[1][0]).toEqual(['a'])
    expect(s.dirty()).toBe(false)
  })
})
