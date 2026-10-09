/**
 * Pure pointer-gesture state machine. No DOM access: Viewport.tsx feeds it
 * normalised pointer samples and applies the returned effects. See
 * docs/research/input-interactions.md for the policy and its rationale.
 *
 * Policy summary
 *  - Nothing is committed on pointer down. A tap is emitted on pointer up only if
 *    the pointer never moved beyond its drag threshold.
 *  - Mouse: primary button tap = tap; drag past threshold = pan (any tool);
 *    Pan tool / Space held / middle button = pan immediately.
 *  - Pen (Apple Pencil): tap = tap; drag past threshold = pan (never annotates).
 *    A pen contact cancels any finger gesture; fingers touching while the pen is
 *    down are ignored (palm).
 *  - Touch: navigation by default (one finger pans, two fingers pinch + pan). If
 *    touchAnnotates is on and no pen was seen recently, a one-finger tap taps;
 *    a second finger arriving cancels the pending tap and starts a pinch. After a
 *    multi-finger gesture no tap is ever emitted until all fingers lift.
 *    If touchAnnotates is OFF (and no pen was seen recently), a one-finger tap
 *    still pans nothing but emits `navTap` so the UI can explain why nothing
 *    was added. It never edits.
 */
import type { Tool } from './api'

/** Normalised PointerEvent.pointerType (unknown types are treated as mouse). */
export type PointerKind = 'mouse' | 'pen' | 'touch'

/** A DOM-free snapshot of one PointerEvent, in viewport-relative CSS px. */
export interface PointerSample {
  id: number
  type: PointerKind
  /** Viewport-relative CSS px. */
  x: number
  y: number
  /** PointerEvent.button for down/up (0 primary, 1 middle, 2 secondary). */
  button: number
  /** PointerEvent.buttons bitmask. */
  buttons: number
  /** Contact geometry in CSS px, if reported. */
  width?: number
  height?: number
  /** Timestamp in ms (event.timeStamp). */
  time: number
}

/** UI state that decides how a new contact is interpreted (read at pointer down only). */
export interface GestureContext {
  tool: Tool
  touchAnnotates: boolean
  spaceHeld: boolean
}

/** Intents emitted by the machine; the caller applies them to the view / editing rules. */
export type GestureEffect =
  | { type: 'tap'; x: number; y: number; pointerType: PointerKind }
  | { type: 'pan'; dx: number; dy: number }
  /** Zoom by `factor` anchored at (cx, cy) after translating by (dx, dy). */
  | { type: 'pinch'; cx: number; cy: number; factor: number; dx: number; dy: number }
  | { type: 'hover'; x: number; y: number; pointerType: PointerKind }
  | { type: 'hoverEnd' }
  /**
   * A one-finger tap that only navigated because touch annotation is off (tool
   * add/erase, no recent pen). Lets the UI offer to turn touch annotation on.
   */
  | { type: 'navTap'; x: number; y: number }

/** Movement (CSS px) beyond which a press becomes a drag instead of a tap. */
export const DRAG_THRESHOLD: Record<PointerKind, number> = { mouse: 4, pen: 8, touch: 10 }
/** A finger held longer than this without moving is not a tap (avoids resting-hand marks). */
export const TOUCH_TAP_MAX_MS = 500
/** After any pen activity, fingers navigate only for this long. */
export const PEN_RECENT_MS = 10_000
/** Contacts larger than this (CSS px, either dimension) are treated as palms, where reported. */
export const PALM_CONTACT_PX = 60

interface Tracked {
  id: number
  type: PointerKind
  x: number
  y: number
  startX: number
  startY: number
  downTime: number
  ignored: boolean
}

type Mode =
  | { kind: 'idle' }
  | { kind: 'pending'; id: number }
  /** `tapCandidate`: a finger that would have annotated with touchAnnotates on (see navTap). */
  | { kind: 'drag'; id: number; tapCandidate?: boolean }
  | { kind: 'pinch'; a: number; b: number; dist: number; mx: number; my: number }

/** Current recogniser state, for cursors and tests. */
export type GestureMode = Mode['kind']

/**
 * Events in (down/move/up/cancel/leave/reset), intents out (GestureEffect[]).
 * One instance per viewport; holds only transient pointer state.
 */
export class GestureMachine {
  private pointers = new Map<number, Tracked>()
  private mode: Mode = { kind: 'idle' }
  private lastPenTime = -Infinity

  get modeKind(): GestureMode {
    return this.mode.kind
  }

  /** True while a pan/pinch is in progress (for the grabbing cursor). */
  get navigating(): boolean {
    return this.mode.kind === 'drag' || this.mode.kind === 'pinch'
  }

  get activePointerCount(): number {
    return this.pointers.size
  }

  hasActivePointerOfType(type: PointerKind): boolean {
    for (const p of this.pointers.values()) if (p.type === type) return true
    return false
  }

  penSeenRecently(now: number): boolean {
    return now - this.lastPenTime < PEN_RECENT_MS
  }

  /** Forget everything (blur, visibilitychange, image change). Emits no tap. */
  reset(): GestureEffect[] {
    this.pointers.clear()
    this.mode = { kind: 'idle' }
    return [{ type: 'hoverEnd' }]
  }

  down(p: PointerSample, ctx: GestureContext): GestureEffect[] {
    if (this.pointers.has(p.id)) this.release(p.id) // stale entry (missed up/cancel): restart cleanly
    const t: Tracked = {
      id: p.id,
      type: p.type,
      x: p.x,
      y: p.y,
      startX: p.x,
      startY: p.y,
      downTime: p.time,
      ignored: false,
    }
    this.pointers.set(p.id, t)
    const fx: GestureEffect[] = [{ type: 'hoverEnd' }]

    if (p.type === 'pen') {
      this.lastPenTime = p.time
      if (this.ownerType() === 'touch') {
        // Pen wins over fingers: drop the finger gesture without emitting a tap.
        for (const q of this.pointers.values()) if (q.type === 'touch') q.ignored = true
        this.mode = { kind: 'idle' }
      }
      if (this.mode.kind !== 'idle') {
        t.ignored = true
        return fx
      }
      this.mode = ctx.tool === 'pan' || ctx.spaceHeld ? { kind: 'drag', id: p.id } : { kind: 'pending', id: p.id }
      return fx
    }

    if (p.type === 'mouse') {
      if (this.mode.kind !== 'idle' || (p.button !== 0 && p.button !== 1)) {
        t.ignored = true
        return fx
      }
      const pan = p.button === 1 || ctx.tool === 'pan' || ctx.spaceHeld
      this.mode = pan ? { kind: 'drag', id: p.id } : { kind: 'pending', id: p.id }
      return fx
    }

    // touch
    const palm =
      (p.width !== undefined && p.width > PALM_CONTACT_PX) || (p.height !== undefined && p.height > PALM_CONTACT_PX)
    if (palm || this.hasActivePointerOfType('pen') || this.ownerType() === 'mouse') {
      t.ignored = true
      return fx
    }
    const m = this.mode
    if (m.kind === 'idle') {
      const annotate =
        ctx.touchAnnotates && !this.penSeenRecently(p.time) && ctx.tool !== 'pan' && !ctx.spaceHeld
      const navOnly = !ctx.touchAnnotates && !this.penSeenRecently(p.time) && ctx.tool !== 'pan' && !ctx.spaceHeld
      this.mode = annotate ? { kind: 'pending', id: p.id } : { kind: 'drag', id: p.id, tapCandidate: navOnly }
      return fx
    }
    if ((m.kind === 'pending' || m.kind === 'drag') && this.pointers.get(m.id)?.type === 'touch') {
      const a = this.pointers.get(m.id)!
      this.mode = {
        kind: 'pinch',
        a: a.id,
        b: t.id,
        dist: Math.max(1, Math.hypot(t.x - a.x, t.y - a.y)),
        mx: (a.x + t.x) / 2,
        my: (a.y + t.y) / 2,
      }
      return fx
    }
    // Third finger during a pinch, or anything else: ignore until lifted.
    t.ignored = true
    return fx
  }

  move(p: PointerSample): GestureEffect[] {
    const t = this.pointers.get(p.id)
    if (!t) {
      // Hover (mouse without buttons, Apple Pencil hover on supporting iPads).
      if (p.type === 'touch' || p.buttons !== 0) return []
      if (p.type === 'pen') this.lastPenTime = p.time
      if (this.mode.kind !== 'idle') return []
      return [{ type: 'hover', x: p.x, y: p.y, pointerType: p.type }]
    }
    const prevX = t.x
    const prevY = t.y
    t.x = p.x
    t.y = p.y
    if (t.type === 'pen') this.lastPenTime = p.time
    if (t.ignored) return []
    const m = this.mode
    if (m.kind === 'pending' && m.id === p.id) {
      if (Math.hypot(t.x - t.startX, t.y - t.startY) > DRAG_THRESHOLD[t.type]) {
        this.mode = { kind: 'drag', id: p.id }
        // Catch up the whole movement since pointer down so the image tracks the pointer.
        return [{ type: 'pan', dx: t.x - t.startX, dy: t.y - t.startY }]
      }
      return []
    }
    if (m.kind === 'drag' && m.id === p.id) {
      const dx = t.x - prevX
      const dy = t.y - prevY
      return dx === 0 && dy === 0 ? [] : [{ type: 'pan', dx, dy }]
    }
    if (m.kind === 'pinch' && (m.a === p.id || m.b === p.id)) {
      const a = this.pointers.get(m.a)!
      const b = this.pointers.get(m.b)!
      const mx = (a.x + b.x) / 2
      const my = (a.y + b.y) / 2
      const dist = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y))
      const fx: GestureEffect = { type: 'pinch', cx: mx, cy: my, factor: dist / m.dist, dx: mx - m.mx, dy: my - m.my }
      this.mode = { ...m, dist, mx, my }
      return [fx]
    }
    return []
  }

  up(p: PointerSample): GestureEffect[] {
    const t = this.pointers.get(p.id)
    if (!t) return []
    t.x = p.x
    t.y = p.y
    if (t.type === 'pen') this.lastPenTime = p.time
    const fx: GestureEffect[] = []
    const m = this.mode
    if (!t.ignored && m.kind === 'pending' && m.id === p.id) {
      const moved = Math.hypot(t.x - t.startX, t.y - t.startY) > DRAG_THRESHOLD[t.type]
      const tooLong = t.type === 'touch' && p.time - t.downTime > TOUCH_TAP_MAX_MS
      if (!moved && !tooLong) {
        // Use the contact-down position: lift-off jitter (pen/finger roll) is ignored.
        fx.push({ type: 'tap', x: t.startX, y: t.startY, pointerType: t.type })
      }
    } else if (!t.ignored && m.kind === 'drag' && m.id === p.id && m.tapCandidate) {
      const moved = Math.hypot(t.x - t.startX, t.y - t.startY) > DRAG_THRESHOLD.touch
      if (!moved && p.time - t.downTime <= TOUCH_TAP_MAX_MS) fx.push({ type: 'navTap', x: t.startX, y: t.startY })
    }
    this.release(p.id)
    return fx
  }

  /** pointercancel / lostpointercapture without up: never taps. */
  cancel(id: number): GestureEffect[] {
    if (!this.pointers.has(id)) return []
    this.release(id)
    return []
  }

  /** Pointer left the surface without being tracked (hover only). */
  leave(id: number): GestureEffect[] {
    return this.pointers.has(id) ? [] : [{ type: 'hoverEnd' }]
  }

  private ownerType(): PointerKind | null {
    const m = this.mode
    if (m.kind === 'pending' || m.kind === 'drag') return this.pointers.get(m.id)?.type ?? null
    if (m.kind === 'pinch') return 'touch'
    return null
  }

  private release(id: number) {
    this.pointers.delete(id)
    const m = this.mode
    if ((m.kind === 'pending' || m.kind === 'drag') && m.id === id) {
      this.mode = { kind: 'idle' }
    } else if (m.kind === 'pinch' && (m.a === id || m.b === id)) {
      const other = this.pointers.get(m.a === id ? m.b : m.a)
      // Continue panning with the remaining finger; it can never become a tap.
      this.mode = other && !other.ignored ? { kind: 'drag', id: other.id } : { kind: 'idle' }
    }
    if (this.pointers.size === 0) this.mode = { kind: 'idle' }
  }
}
