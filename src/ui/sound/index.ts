/**
 * Sound feedback: turns editor feedback events into cues (state/feedback.ts),
 * filters them by the device settings and plays them on the Web Audio engine.
 * Also unlocks audio on the first user gesture (Safari/iOS rule).
 */
import type { Accessor } from 'solid-js'
import { cueFor, type Cue, type Feedback } from '../../state/feedback'
import { audible, type SoundSettings } from '../../state/soundSettings'
import { createSoundEngine, type AudioStatus, type SoundEngine } from './engine'

export { createSoundEngine, type AudioStatus, type SoundEngine } from './engine'
export { RECIPES, cueDuration } from './cues'

export interface SoundFeedback {
  /** Pass to the editor and assist controller as their feedback port. */
  feedback: Feedback
  /** Play a cue now regardless of its switch (settings "Test"); call from a click. */
  preview(cue: Cue): void
  status(): AudioStatus
  dispose(): void
}

export interface SoundFeedbackDeps {
  settings: Accessor<SoundSettings>
  engine?: SoundEngine
  /** Where to listen for unlocking gestures (default: window; null = none). */
  target?: EventTarget | null
  now?: () => number
}

/** The same cue twice within this window plays once (e.g. a refusal and its error toast). */
export const REPEAT_GAP_MS = 45

/**
 * Activation-triggering events per the HTML spec: pointerdown only counts for a
 * mouse, so touch and Apple Pencil unlock on pointerup / touchend.
 */
const UNLOCK_EVENTS = ['pointerdown', 'pointerup', 'touchend', 'keydown', 'click'] as const

export function createSoundFeedback(deps: SoundFeedbackDeps): SoundFeedback {
  const engine = deps.engine ?? createSoundEngine()
  const now = deps.now ?? (() => performance.now())
  const target = deps.target === undefined ? (typeof window === 'undefined' ? null : window) : deps.target
  const lastAt = new Map<Cue, number>()

  const onGesture = () => {
    if (!deps.settings().enabled) return
    const s = engine.status()
    if (s !== 'running' && s !== 'unavailable') engine.unlock()
  }
  for (const type of UNLOCK_EVENTS) target?.addEventListener(type, onGesture, { capture: true, passive: true })

  const feedback: Feedback = (event) => {
    try {
      const cue = cueFor(event)
      const settings = deps.settings()
      if (!cue || !audible(settings, cue)) return
      const t = now()
      if (t - (lastAt.get(cue) ?? -Infinity) < REPEAT_GAP_MS) return
      lastAt.set(cue, t)
      engine.play(cue, settings.volume)
    } catch {
      /* feedback must never break an edit */
    }
  }

  return {
    feedback,
    preview(cue) {
      try {
        engine.unlock()
        engine.play(cue, Math.max(deps.settings().volume, 0.05))
      } catch {
        /* ignore */
      }
    },
    status: () => engine.status(),
    dispose() {
      for (const type of UNLOCK_EVENTS) target?.removeEventListener(type, onGesture, { capture: true })
      engine.dispose()
    },
  }
}
