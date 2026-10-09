import { afterEach, describe, expect, it, vi } from 'vitest'
import { PICKER_FOCUS_GRACE_MS, pickFiles } from './download'

class FakeInput extends EventTarget {
  type = ''
  accept = ''
  multiple = false
  style = { display: '' }
  files: File[] | null = null
  removed = false
  click() {}
  remove() {
    this.removed = true
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('pickFiles', () => {
  function stub() {
    const input = new FakeInput()
    const win = new EventTarget()
    vi.stubGlobal('document', { createElement: () => input, body: { appendChild() {} } })
    vi.stubGlobal('window', win)
    return { input, win }
  }

  it('resolves empty when the page regains focus and no file arrives (iOS has no cancel event)', async () => {
    vi.useFakeTimers()
    const { input, win } = stub()
    const result = pickFiles({ accept: 'image/*' })
    win.dispatchEvent(new Event('focus'))
    vi.advanceTimersByTime(PICKER_FOCUS_GRACE_MS + 1)
    await expect(result).resolves.toEqual([])
    expect(input.removed).toBe(true)
  })

  it('still delivers files when change fires after focus', async () => {
    vi.useFakeTimers()
    const { input, win } = stub()
    const result = pickFiles({ accept: 'image/*', multiple: true })
    win.dispatchEvent(new Event('focus'))
    const file = new File(['x'], 'a.jpg')
    input.files = [file]
    vi.advanceTimersByTime(PICKER_FOCUS_GRACE_MS + 1) // files present: not treated as cancel
    input.dispatchEvent(new Event('change'))
    await expect(result).resolves.toEqual([file])
  })

  it('resolves empty on the cancel event', async () => {
    const { input } = stub()
    const result = pickFiles({ accept: '.zip' })
    input.dispatchEvent(new Event('cancel'))
    await expect(result).resolves.toEqual([])
  })
})
