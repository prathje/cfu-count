/**
 * Web Audio synthesiser for the sound cues (no audio files).
 *
 * - One AudioContext, created and resumed inside a user gesture (`unlock`), as
 *   Safari/iOS require. A context that later becomes 'suspended' or WebKit's
 *   'interrupted' (call, Siri, app switch) is resumed on the next gesture.
 * - Each cue schedules a few oscillator + gain nodes into a fixed master chain
 *   (gain → compressor → destination), so rapid taps never clip.
 * - Nothing here throws: without Web Audio every call is a no-op.
 *
 * iOS: Web Audio uses the "ambient" audio session, which mixes with other apps'
 * audio and is muted by Silent mode (ring/silent switch, or Control Center on iPads
 * without a switch). We keep that on purpose (UI cues should respect Silent mode)
 * and set `navigator.audioSession.type = 'ambient'` explicitly where supported.
 */
import type { Cue } from '../../state/feedback'
import { RECIPES } from './cues'

export type AudioStatus = 'unavailable' | 'locked' | 'running' | 'suspended' | 'interrupted' | 'closed'

export interface SoundEngine {
  /** Create/resume the context. Call from a user gesture (pointerdown/keydown). */
  unlock(): void
  /** Schedule a cue at `volume` (0..1). False when it could not play right now. */
  play(cue: Cue, volume: number): boolean
  status(): AudioStatus
  dispose(): void
}

type AudioContextCtor = new () => AudioContext

export interface SoundEngineOptions {
  /** Constructor to use (tests); default: window.AudioContext / webkitAudioContext. `null` = no audio. */
  AudioContext?: AudioContextCtor | null
  /** Cap on simultaneously sounding oscillators (rapid tapping). */
  maxVoices?: number
}

/** Small scheduling lead so the first sample is never in the past. */
const LEAD = 0.004
const MASTER = 0.8

function defaultCtor(): AudioContextCtor | null {
  const w = globalThis as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor }
  return w.AudioContext ?? w.webkitAudioContext ?? null
}

export function createSoundEngine(opts: SoundEngineOptions = {}): SoundEngine {
  const Ctor = opts.AudioContext === undefined ? defaultCtor() : opts.AudioContext
  const maxVoices = opts.maxVoices ?? 16
  let ctx: AudioContext | null = null
  let out: AudioNode | null = null
  let voices = 0
  let failed = false
  /** A resume in flight (started by a gesture). */
  let resuming: { promise: Promise<void> } | null = null

  function build(): AudioContext | null {
    if (ctx || failed || !Ctor) return ctx
    try {
      const session = (navigator as unknown as { audioSession?: { type: string } }).audioSession
      if (session && session.type === 'auto') session.type = 'ambient'
    } catch {
      /* optional API */
    }
    try {
      const c = new Ctor()
      const master = c.createGain()
      master.gain.value = MASTER
      const comp = c.createDynamicsCompressor()
      comp.threshold.value = -14
      comp.knee.value = 8
      comp.ratio.value = 8
      comp.attack.value = 0.002
      comp.release.value = 0.12
      master.connect(comp)
      comp.connect(c.destination)
      ctx = c
      out = master
      // Older iOS only "unlocks" after something plays inside the gesture: one silent sample.
      const buf = c.createBuffer(1, 1, c.sampleRate)
      const src = c.createBufferSource()
      src.buffer = buf
      src.connect(c.destination)
      src.start(0)
    } catch (err) {
      failed = true
      ctx = null
      out = null
      console.warn('Sound feedback unavailable', err)
    }
    return ctx
  }

  /**
   * `fromGesture`: always call resume() again, even if an earlier attempt is still
   * pending. On iOS a resume() requested outside a user activation can stay pending
   * indefinitely; skipping later in-gesture attempts would keep audio locked forever.
   * Inside a gesture we also play a silent sample, which older iOS needs to unlock.
   */
  function resume(c: AudioContext, fromGesture = false) {
    if ((c.state as string) === 'running' || c.state === 'closed') return
    if (resuming && !fromGesture) return
    try {
      if (fromGesture) playSilence(c)
      const promise = c
        .resume()
        .catch(() => {})
        .finally(() => {
          if (resuming?.promise === promise) resuming = null
        })
      resuming = { promise }
    } catch {
      /* ignore */
    }
  }

  function playSilence(c: AudioContext) {
    try {
      const src = c.createBufferSource()
      src.buffer = c.createBuffer(1, 1, c.sampleRate)
      src.connect(c.destination)
      src.start(0)
    } catch {
      /* ignore */
    }
  }

  function status(): AudioStatus {
    if (!Ctor || failed) return 'unavailable'
    if (!ctx) return 'locked'
    return ctx.state as AudioStatus
  }

  function play(cue: Cue, volume: number): boolean {
    const c = ctx
    if (!c || !out) return false
    if ((c.state as string) !== 'running') {
      // The first tap unlocks and places in the same gesture: play once the resume lands,
      // but never queue a late sound.
      resume(c)
      const r = resuming
      if (r) {
        const asked = performance.now()
        void r.promise.then(() => {
          if (performance.now() - asked < 120 && (c.state as string) === 'running') play(cue, volume)
        })
      }
      return false
    }
    const tones = RECIPES[cue]
    if (voices + tones.length > maxVoices) return false
    const level = Math.max(0, Math.min(1, volume)) ** 2
    if (level <= 0) return false
    try {
      const t0 = c.currentTime + LEAD
      for (const tone of tones) {
        const start = t0 + tone.at
        const end = start + tone.dur
        const attack = tone.attack ?? 0.003
        const osc = c.createOscillator()
        const env = c.createGain()
        osc.type = tone.wave
        osc.frequency.setValueAtTime(tone.freq, start)
        if (tone.to) osc.frequency.exponentialRampToValueAtTime(tone.to, start + (tone.glide ?? tone.dur))
        env.gain.setValueAtTime(0, start)
        env.gain.linearRampToValueAtTime(tone.gain * level, start + attack)
        env.gain.exponentialRampToValueAtTime(0.0001, end)
        osc.connect(env)
        env.connect(out)
        voices++
        osc.onended = () => {
          voices--
          try {
            osc.disconnect()
            env.disconnect()
          } catch {
            /* already gone */
          }
        }
        osc.start(start)
        osc.stop(end + 0.01)
      }
      return true
    } catch (err) {
      console.warn('Sound cue failed', err)
      return false
    }
  }

  return {
    unlock() {
      const c = build()
      if (c) resume(c, true)
    },
    play,
    status,
    dispose() {
      const c = ctx
      ctx = null
      out = null
      try {
        void c?.close().catch(() => {})
      } catch {
        /* ignore */
      }
    },
  }
}
