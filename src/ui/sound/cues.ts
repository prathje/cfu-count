/**
 * Synthesis recipes for the sound cues: plain data, so durations and levels are
 * testable without audio. Times in seconds, gains 0..1 before the master volume.
 */
import type { Cue } from '../../state/feedback'

export interface Tone {
  /** Start offset from the cue's start. */
  at: number
  /** Length including the decay tail. */
  dur: number
  freq: number
  /** Optional glide target (exponential, over the first `glide` seconds). */
  to?: number
  glide?: number
  wave: OscillatorType
  /** Peak level. */
  gain: number
  /** Attack time (default 3 ms: no click, still crisp). */
  attack?: number
}

export const RECIPES: Record<Cue, readonly Tone[]> = {
  // Soft high pop: a short downward glide reads as "placed".
  add: [
    { at: 0, dur: 0.075, freq: 1760, to: 1100, glide: 0.03, wave: 'sine', gain: 0.55, attack: 0.002 },
    { at: 0, dur: 0.04, freq: 3520, to: 2200, glide: 0.02, wave: 'sine', gain: 0.12, attack: 0.002 },
  ],
  // Two quick ticks: placed, but on top of another marker.
  nearDuplicate: [
    { at: 0, dur: 0.04, freq: 1760, to: 1320, glide: 0.02, wave: 'sine', gain: 0.45, attack: 0.002 },
    { at: 0.06, dur: 0.045, freq: 1760, to: 1320, glide: 0.02, wave: 'sine', gain: 0.4, attack: 0.002 },
  ],
  // Lower and softer than add, gliding down.
  erase: [{ at: 0, dur: 0.09, freq: 620, to: 360, glide: 0.07, wave: 'sine', gain: 0.45, attack: 0.004 }],
  // Low double buzz; triangle keeps it soft rather than harsh.
  error: [
    { at: 0, dur: 0.05, freq: 220, wave: 'triangle', gain: 0.7, attack: 0.004 },
    { at: 0.065, dur: 0.05, freq: 185, wave: 'triangle', gain: 0.7, attack: 0.004 },
  ],
  // Two-note rising chime (A5 → E6).
  accept: [
    { at: 0, dur: 0.16, freq: 880, wave: 'sine', gain: 0.4, attack: 0.004 },
    { at: 0.09, dur: 0.2, freq: 1318.5, wave: 'sine', gain: 0.38, attack: 0.004 },
    { at: 0.09, dur: 0.12, freq: 2637, wave: 'sine', gain: 0.06, attack: 0.004 },
  ],
  // Quiet short blip.
  undo: [{ at: 0, dur: 0.06, freq: 900, to: 660, glide: 0.04, wave: 'triangle', gain: 0.3, attack: 0.003 }],
}

/** Total length of a cue in seconds. */
export function cueDuration(cue: Cue): number {
  return Math.max(...RECIPES[cue].map((t) => t.at + t.dur))
}
