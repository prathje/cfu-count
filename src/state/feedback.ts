/**
 * Editor feedback events: what just happened to the user's edit, reported by the
 * editor slices and assist controller (never by DOM clicks). The UI turns them into
 * sound cues (ui/sound). Pure: no Solid, no audio.
 */
import type { Notice } from './messages'

export type FeedbackEvent =
  /** A manual marker was placed; `near` = on top of an existing visible marker. */
  | { type: 'added'; near: boolean }
  | { type: 'erased' }
  | { type: 'history'; direction: 'undo' | 'redo' }
  /**
   * An edit the user asked for did not happen and was explained: hidden/locked/no
   * group, nothing to erase, edits paused, a refused undo/redo or accept.
   */
  | { type: 'refused'; reason: string }
  /** Assisted suggestions were accepted as one batch. */
  | { type: 'accepted'; count: number }
  /** A toast was shown (only error toasts make a sound). */
  | { type: 'notice'; tone: Notice['tone'] }

/** Receives feedback events. Must never throw. */
export type Feedback = (event: FeedbackEvent) => void

export const noFeedback: Feedback = () => {}

/** Short sound cues (see ui/sound/cues.ts for the synthesis recipes). */
export type Cue = 'add' | 'nearDuplicate' | 'erase' | 'error' | 'accept' | 'undo'

export const CUES: readonly Cue[] = ['add', 'nearDuplicate', 'erase', 'error', 'accept', 'undo']

/**
 * Which cue an event plays, if any. Refusals and error toasts share the error cue;
 * info/warning/success toasts are silent (the edit events already cover them, and a
 * refusal's warning toast comes with its own `refused` event).
 */
export function cueFor(event: FeedbackEvent): Cue | null {
  switch (event.type) {
    case 'added':
      return event.near ? 'nearDuplicate' : 'add'
    case 'erased':
      return 'erase'
    case 'history':
      return 'undo'
    case 'refused':
      return 'error'
    case 'accepted':
      return event.count > 0 ? 'accept' : null
    case 'notice':
      return event.tone === 'error' ? 'error' : null
  }
}
