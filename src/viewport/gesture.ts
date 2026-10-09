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
 *  - Region tool (lasso): a drag past the threshold by the primary mouse button,
 *    the pen, or ONE finger (touchAnnotates is irrelevant: a region never edits;
 *    fingers still only navigate while a pen was seen recently) draws a lasso:
 *    lassoStart, lassoMove…, lassoEnd on release. A second finger cancels the
 *    lasso (lassoCancel) and starts a pinch; a pen landing cancels a finger
 *    lasso; pointercancel / reset / abortLasso (Escape) cancel it. A press that
 *    never moves is still a tap (it can toggle a suggestion ring).
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
  /** Region tool: a lasso started at (x, y) (the press position) after a drag past the threshold. */
  | { type: 'lassoStart'; x: number; y: number; pointerType: PointerKind }
  | { type: 'lassoMove'; x: number; y: number }
  /** The lasso pointer lifted at (x, y): close and commit the path. */
  | { type: 'lassoEnd'; x: number; y: number }
  /** The lasso was abandoned (second finger, pen, cancel, Escape): discard the path. */
  | { type: 'lassoCancel' }

/** Movement (CSS px) beyond which a press becomes a drag instead of a tap. */
export const DRAG_THRESHOLD: Record<PointerKind, number> = { mouse: 4, pen: 8, touch: 10 }
/** A finger held longer than this without moving is not a tap (avoids resting-hand marks). */
export const TOUCH_TAP_MAX_MS = 500
/** After any pen activity, fingers navigate only for this long. */
export const PEN_RECENT_MS = 10_000


interface Tracked {
  id: number
  type: PointerKind
  x: number
  y: number
  startX: number
  startY: number
  downTime: number
  /** Time of the last down/move sample (staleness for syncTouches). */
  lastTime: number
  ignored: boolean
}

type Mode =
  | { kind: 'idle' }
  /** `lasso`: a drag would draw a region instead of panning. */
  | { kind: 'pending'; id: number; lasso?: boolean }
  /** `tapCandidate`: a finger that would have annotated with touchAnnotates on (see navTap). */
  | { kind: 'drag'; id: number; tapCandidate?: boolean }
  | { kind: 'pinch'; a: number; b: number; dist: number; mx: number; my: number }
  | { kind: 'lasso'; id: number }

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

  /** True while a region lasso is being drawn. */
  get lassoing(): boolean {
    return this.mode.kind === 'lasso'
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
  /**
   * Reconcile tracked finger contacts with the platform's own count of touches
   * (TouchEvent.touches.length). iPadOS Safari occasionally drops the pointerup /
   * pointercancel of a finger (e.g. around system gestures or a second finger
   * landing at the edge); the stale "ghost" would then pair with the next finger as
   * a bogus pinch, or make a real second finger look like a third and be ignored,
   * so zoom appears stuck until something resets the state. When we track more
   * touches than are physically down, the stalest ones are released (never tapping).
   */
  syncTouches(activeTouches: number): GestureEffect[] {
    const touches = [...this.pointers.values()].filter((p) => p.type === 'touch')
    let excess = touches.length - Math.max(0, activeTouches)
    if (excess <= 0) return []
    touches.sort((a, b) => a.lastTime - b.lastTime)
    const fx: GestureEffect[] = []
    for (const t of touches) {
      if (excess-- <= 0) break
      fx.push(...this.release(t.id))
    }
    return fx
  }

  reset(): GestureEffect[] {
    const fx: GestureEffect[] = this.mode.kind === 'lasso' ? [{ type: 'lassoCancel' }] : []
    this.pointers.clear()
    this.mode = { kind: 'idle' }
    return [...fx, { type: 'hoverEnd' }]
  }

  /**
   * Escape while drawing: drop the lasso (or a press that would become one). The
   * pointer stays tracked but is ignored until it lifts, so it never taps or pans.
   */
  abortLasso(): GestureEffect[] {
    const m = this.mode
    if (m.kind !== 'lasso' && !(m.kind === 'pending' && m.lasso)) return []
    const t = this.pointers.get(m.id)
    if (t) t.ignored = true
    this.mode = { kind: 'idle' }
    return m.kind === 'lasso' ? [{ type: 'lassoCancel' }] : []
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
      lastTime: p.time,
      ignored: false,
    }
    this.pointers.set(p.id, t)
    const fx: GestureEffect[] = [{ type: 'hoverEnd' }]

    if (p.type === 'pen') {
      this.lastPenTime = p.time
      if (this.ownerType() === 'touch') {
        // Pen wins over fingers: drop the finger gesture without emitting a tap.
        if (this.mode.kind === 'lasso') fx.push({ type: 'lassoCancel' })
        for (const q of this.pointers.values()) if (q.type === 'touch') q.ignored = true
        this.mode = { kind: 'idle' }
      }
      if (this.mode.kind !== 'idle') {
        t.ignored = true
        return fx
      }
      this.mode =
        ctx.tool === 'pan' || ctx.spaceHeld ? { kind: 'drag', id: p.id } : { kind: 'pending', id: p.id, ...(ctx.tool === 'region' ? { lasso: true } : {}) }
      return fx
    }

    if (p.type === 'mouse') {
      if (this.mode.kind !== 'idle' || (p.button !== 0 && p.button !== 1)) {
        t.ignored = true
        return fx
      }
      const pan = p.button === 1 || ctx.tool === 'pan' || ctx.spaceHeld
      this.mode = pan ? { kind: 'drag', id: p.id } : { kind: 'pending', id: p.id, ...(ctx.tool === 'region' ? { lasso: true } : {}) }
      return fx
    }

    // touch
    // Palm handling relies on context, not contact size: iPadOS Safari reports large
    // and inconsistent sizes for ordinary fingers and thumbs (a pinching thumb was
    // being dropped). Touches while the pen is down are ignored; a pen landing
    // cancels a finger gesture already in progress (see pen branch above).
    if (this.hasActivePointerOfType('pen') || this.ownerType() === 'mouse') {
      t.ignored = true
      return fx
    }
    const m = this.mode
    if (m.kind === 'idle') {
      if (ctx.tool === 'region' && !ctx.spaceHeld && !this.penSeenRecently(p.time)) {
        this.mode = { kind: 'pending', id: p.id, lasso: true }
        return fx
      }
      const annotate =
        ctx.touchAnnotates && !this.penSeenRecently(p.time) && ctx.tool !== 'pan' && !ctx.spaceHeld
      const navOnly = !ctx.touchAnnotates && !this.penSeenRecently(p.time) && ctx.tool !== 'pan' && !ctx.spaceHeld
      this.mode = annotate ? { kind: 'pending', id: p.id } : { kind: 'drag', id: p.id, tapCandidate: navOnly }
      return fx
    }
    if ((m.kind === 'pending' || m.kind === 'drag' || m.kind === 'lasso') && this.pointers.get(m.id)?.type === 'touch') {
      const a = this.pointers.get(m.id)!
      // A second finger means navigation: the lasso is abandoned, never committed.
      if (m.kind === 'lasso') fx.push({ type: 'lassoCancel' })
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
    t.lastTime = p.time
    if (t.type === 'pen') this.lastPenTime = p.time
    if (t.ignored) return []
    const m = this.mode
    if (m.kind === 'pending' && m.id === p.id) {
      if (Math.hypot(t.x - t.startX, t.y - t.startY) > DRAG_THRESHOLD[t.type]) {
        if (m.lasso) {
          this.mode = { kind: 'lasso', id: p.id }
          return [
            { type: 'lassoStart', x: t.startX, y: t.startY, pointerType: t.type },
            { type: 'lassoMove', x: t.x, y: t.y },
          ]
        }
        this.mode = { kind: 'drag', id: p.id }
        // Catch up the whole movement since pointer down so the image tracks the pointer.
        return [{ type: 'pan', dx: t.x - t.startX, dy: t.y - t.startY }]
      }
      return []
    }
    if (m.kind === 'lasso' && m.id === p.id) {
      return t.x === prevX && t.y === prevY ? [] : [{ type: 'lassoMove', x: t.x, y: t.y }]
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
    } else if (!t.ignored && m.kind === 'lasso' && m.id === p.id) {
      fx.push({ type: 'lassoEnd', x: t.x, y: t.y })
      this.mode = { kind: 'idle' } // committed: releasing must not also cancel
    } else if (!t.ignored && m.kind === 'drag' && m.id === p.id && m.tapCandidate) {
      const moved = Math.hypot(t.x - t.startX, t.y - t.startY) > DRAG_THRESHOLD.touch
      if (!moved && p.time - t.downTime <= TOUCH_TAP_MAX_MS) fx.push({ type: 'navTap', x: t.startX, y: t.startY })
    }
    fx.push(...this.release(p.id))
    return fx
  }

  /** pointercancel / lostpointercapture without up: never taps (and abandons a lasso). */
  cancel(id: number): GestureEffect[] {
    if (!this.pointers.has(id)) return []
    return this.release(id)
  }

  /** Pointer left the surface without being tracked (hover only). */
  leave(id: number): GestureEffect[] {
    return this.pointers.has(id) ? [] : [{ type: 'hoverEnd' }]
  }

  private ownerType(): PointerKind | null {
    const m = this.mode
    if (m.kind === 'pending' || m.kind === 'drag' || m.kind === 'lasso') return this.pointers.get(m.id)?.type ?? null
    if (m.kind === 'pinch') return 'touch'
    return null
  }

  /** Forget a pointer; abandons the lasso it was drawing (lassoCancel). */
  private release(id: number): GestureEffect[] {
    this.pointers.delete(id)
    const m = this.mode
    const fx: GestureEffect[] = []
    if (m.kind === 'lasso' && m.id === id) {
      fx.push({ type: 'lassoCancel' })
      this.mode = { kind: 'idle' }
    } else if ((m.kind === 'pending' || m.kind === 'drag') && m.id === id) {
      this.mode = { kind: 'idle' }
    } else if (m.kind === 'pinch' && (m.a === id || m.b === id)) {
      const other = this.pointers.get(m.a === id ? m.b : m.a)
      // Continue panning with the remaining finger; it can never become a tap.
      this.mode = other && !other.ignored ? { kind: 'drag', id: other.id } : { kind: 'idle' }
    }
    if (this.pointers.size === 0) this.mode = { kind: 'idle' }
    return fx
  }
}
