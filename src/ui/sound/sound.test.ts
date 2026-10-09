import { describe, expect, it, vi } from 'vitest'
import { CUES, type Cue } from '../../state/feedback'
import { DEFAULT_SOUND, type SoundSettings } from '../../state/soundSettings'
import { RECIPES, cueDuration } from './cues'
import { createSoundEngine, type AudioStatus, type SoundEngine } from './engine'
import { REPEAT_GAP_MS, createSoundFeedback } from './index'

const param = () => ({ value: 0, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() })
const node = () => ({ connect: vi.fn(), disconnect: vi.fn() })

/** Minimal AudioContext: counts scheduled oscillators. */
class FakeAudioContext {
  static instances: FakeAudioContext[] = []
  state: string = 'suspended'
  currentTime = 1
  sampleRate = 44100
  destination = node()
  oscillators: { type: string; started: number; stopped: number }[] = []
  constructor() {
    FakeAudioContext.instances.push(this)
  }
  resume() {
    this.state = 'running'
    return Promise.resolve()
  }
  close() {
    this.state = 'closed'
    return Promise.resolve()
  }
  createGain() {
    return { ...node(), gain: param() }
  }
  createDynamicsCompressor() {
    return { ...node(), threshold: param(), knee: param(), ratio: param(), attack: param(), release: param() }
  }
  createBuffer() {
    return {}
  }
  createBufferSource() {
    return { ...node(), buffer: null, start: vi.fn() }
  }
  createOscillator() {
    const rec = { type: '', started: 0, stopped: 0 }
    this.oscillators.push(rec)
    return {
      ...node(),
      frequency: param(),
      onended: null,
      set type(t: string) {
        rec.type = t
      },
      start: (t: number) => (rec.started = t),
      stop: (t: number) => (rec.stopped = t),
    }
  }
}
const Ctor = FakeAudioContext as unknown as new () => AudioContext

describe('cue recipes', () => {
  it('are short: < 120 ms each, accept < 300 ms', () => {
    for (const cue of CUES) expect(cueDuration(cue), cue).toBeLessThan(cue === 'accept' ? 0.3 : 0.12)
  })
  it('stay below full scale per tone', () => {
    for (const cue of CUES) for (const t of RECIPES[cue]) expect(t.gain).toBeLessThanOrEqual(0.8)
  })
})

describe('sound engine (fake AudioContext)', () => {
  it('is locked until a gesture, then schedules one oscillator per tone', async () => {
    const engine = createSoundEngine({ AudioContext: Ctor })
    expect(engine.status()).toBe('locked')
    expect(engine.play('add', 0.6)).toBe(false)
    engine.unlock()
    await Promise.resolve()
    const ctx = FakeAudioContext.instances.at(-1)!
    expect(engine.status()).toBe('running')
    expect(engine.play('add', 0.6)).toBe(true)
    expect(engine.play('accept', 0.6)).toBe(true)
    expect(ctx.oscillators).toHaveLength(RECIPES.add.length + RECIPES.accept.length)
    expect(Math.min(...ctx.oscillators.map((o) => o.started))).toBeGreaterThanOrEqual(ctx.currentTime)
    engine.dispose()
    expect(ctx.state).toBe('closed')
  })

  it('retries resume() on every gesture even while an earlier resume is still pending (iOS)', async () => {
    FakeAudioContext.instances = []
    const engine = createSoundEngine({ AudioContext: Ctor })
    let calls = 0
    const pending = new Promise<void>(() => {})
    const orig = FakeAudioContext.prototype.resume
    FakeAudioContext.prototype.resume = function () {
      calls++
      return calls === 1 ? pending : orig.call(this)
    }
    try {
      engine.unlock() // first attempt hangs (e.g. not honoured as a gesture)
      engine.unlock() // a later real gesture must try again
      await Promise.resolve()
      expect(calls).toBe(2)
      expect(engine.status()).toBe('running')
    } finally {
      FakeAudioContext.prototype.resume = orig
    }
  })

  it('never queues sounds while suspended/interrupted and caps voices', async () => {
    const engine = createSoundEngine({ AudioContext: Ctor, maxVoices: 4 })
    engine.unlock()
    await Promise.resolve()
    const ctx = FakeAudioContext.instances.at(-1)!
    ctx.state = 'interrupted'
    ctx.resume = () => new Promise(() => {}) // stays interrupted
    expect(engine.play('add', 1)).toBe(false)
    expect(ctx.oscillators).toHaveLength(0)
    ctx.state = 'running'
    expect(engine.play('error', 1)).toBe(true) // 2 voices
    expect(engine.play('error', 1)).toBe(true) // 4 voices
    expect(engine.play('error', 1)).toBe(false) // over the cap
  })

  it('is a silent no-op without Web Audio or when the constructor throws', () => {
    const none = createSoundEngine({ AudioContext: null })
    none.unlock()
    expect(none.play('add', 1)).toBe(false)
    expect(none.status()).toBe('unavailable')
    const broken = createSoundEngine({
      AudioContext: class {
        constructor() {
          throw new Error('nope')
        }
      } as unknown as new () => AudioContext,
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => broken.unlock()).not.toThrow()
    expect(broken.status()).toBe('unavailable')
  })
})

function fakeEngine(status: AudioStatus = 'running') {
  const played: [Cue, number][] = []
  let unlocks = 0
  const engine: SoundEngine = {
    unlock: () => void unlocks++,
    play: (cue, v) => (played.push([cue, v]), true),
    status: () => status,
    dispose: () => {},
  }
  return { engine, played, unlocks: () => unlocks }
}

describe('sound feedback runner', () => {
  it('plays mapped cues at the set volume, honouring switches', () => {
    let settings: SoundSettings = DEFAULT_SOUND
    const { engine, played } = fakeEngine()
    let t = 0
    const s = createSoundFeedback({ settings: () => settings, engine, target: null, now: () => (t += 100) })
    s.feedback({ type: 'added', near: false })
    s.feedback({ type: 'added', near: true })
    s.feedback({ type: 'refused', reason: 'locked' })
    s.feedback({ type: 'history', direction: 'undo' }) // off by default
    s.feedback({ type: 'notice', tone: 'warning' })
    expect(played).toEqual([
      ['add', 0.6],
      ['nearDuplicate', 0.6],
      ['error', 0.6],
    ])
    settings = { ...DEFAULT_SOUND, enabled: false }
    s.feedback({ type: 'erased' })
    expect(played).toHaveLength(3)
  })

  it('plays a refusal and its error toast once', () => {
    const { engine, played } = fakeEngine()
    let t = 1000
    const s = createSoundFeedback({ settings: () => DEFAULT_SOUND, engine, target: null, now: () => t })
    s.feedback({ type: 'refused', reason: 'busy' })
    t += REPEAT_GAP_MS - 1
    s.feedback({ type: 'notice', tone: 'error' })
    t += 100
    s.feedback({ type: 'refused', reason: 'locked' })
    expect(played.map(([c]) => c)).toEqual(['error', 'error'])
  })

  it('unlocks on gestures only while sound is on; preview ignores cue switches', () => {
    const target = new EventTarget()
    let settings: SoundSettings = { ...DEFAULT_SOUND, enabled: false }
    const { engine, played, unlocks } = fakeEngine('locked')
    const s = createSoundFeedback({ settings: () => settings, engine, target })
    target.dispatchEvent(new Event('pointerup'))
    expect(unlocks()).toBe(0)
    settings = DEFAULT_SOUND
    target.dispatchEvent(new Event('pointerup'))
    target.dispatchEvent(new Event('keydown'))
    expect(unlocks()).toBe(2)
    s.preview('undo')
    expect(played).toEqual([['undo', 0.6]])
    s.dispose()
    target.dispatchEvent(new Event('pointerup'))
    expect(unlocks()).toBe(3) // preview unlocked once; listeners removed
  })

  it('ignores touch/pen pointerdown (not a user activation on iOS) but unlocks on mouse pointerdown', () => {
    const target = new EventTarget()
    const { engine, unlocks } = fakeEngine('locked')
    createSoundFeedback({ settings: () => DEFAULT_SOUND, engine, target })
    const down = (pointerType: string) => Object.assign(new Event('pointerdown'), { pointerType })
    target.dispatchEvent(down('touch'))
    target.dispatchEvent(down('pen'))
    expect(unlocks()).toBe(0)
    target.dispatchEvent(down('mouse'))
    expect(unlocks()).toBe(1)
  })

  it('never throws from feedback', () => {
    const engine: SoundEngine = { unlock() {}, play: () => { throw new Error('boom') }, status: () => 'running', dispose() {} }
    const s = createSoundFeedback({ settings: () => DEFAULT_SOUND, engine, target: null })
    expect(() => s.feedback({ type: 'added', near: false })).not.toThrow()
  })
})
