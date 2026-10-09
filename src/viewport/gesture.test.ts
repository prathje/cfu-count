import { beforeEach, describe, expect, it } from 'vitest'
import {
  DRAG_THRESHOLD,
  GestureMachine,
  PEN_RECENT_MS,
  TOUCH_TAP_MAX_MS,
  type GestureContext,
  type GestureEffect,
  type PointerKind,
  type PointerSample,
} from './gesture'

let t = 1000
function s(id: number, type: PointerKind, x: number, y: number, extra: Partial<PointerSample> = {}): PointerSample {
  return { id, type, x, y, button: 0, buttons: 1, time: t, ...extra }
}
const add: GestureContext = { tool: 'add', touchAnnotates: false, spaceHeld: false }
const addTouch: GestureContext = { ...add, touchAnnotates: true }
const taps = (fx: GestureEffect[]) => fx.filter((e) => e.type === 'tap')
const pans = (fx: GestureEffect[]) => fx.filter((e) => e.type === 'pan') as Extract<GestureEffect, { type: 'pan' }>[]

let m: GestureMachine
beforeEach(() => {
  m = new GestureMachine()
  t = 1000
})

describe('mouse', () => {
  it('never commits on down; taps on up within threshold at the down position', () => {
    expect(taps(m.down(s(1, 'mouse', 10, 10), add))).toHaveLength(0)
    m.move(s(1, 'mouse', 12, 11))
    expect(m.up(s(1, 'mouse', 12, 11))).toEqual([{ type: 'tap', x: 10, y: 10, pointerType: 'mouse' }])
    expect(m.modeKind).toBe('idle')
  })

  it('drag past threshold pans (catching up the full delta) and never taps', () => {
    m.down(s(1, 'mouse', 10, 10), add)
    const fx = m.move(s(1, 'mouse', 10 + DRAG_THRESHOLD.mouse + 1, 10))
    expect(pans(fx)).toEqual([{ type: 'pan', dx: DRAG_THRESHOLD.mouse + 1, dy: 0 }])
    expect(pans(m.move(s(1, 'mouse', 30, 20)))).toEqual([{ type: 'pan', dx: 30 - 15, dy: 10 }])
    // moving back near the start must still not tap
    m.move(s(1, 'mouse', 10, 10))
    expect(taps(m.up(s(1, 'mouse', 10, 10)))).toHaveLength(0)
  })

  it('pan tool, space and middle button pan immediately', () => {
    m.down(s(1, 'mouse', 0, 0), { ...add, tool: 'pan' })
    expect(m.navigating).toBe(true)
    expect(pans(m.move(s(1, 'mouse', 1, 0)))).toHaveLength(1)
    expect(taps(m.up(s(1, 'mouse', 1, 0)))).toHaveLength(0)

    m.down(s(2, 'mouse', 0, 0), { ...add, spaceHeld: true })
    expect(m.navigating).toBe(true)
    expect(taps(m.up(s(2, 'mouse', 0, 0)))).toHaveLength(0)

    m.down(s(3, 'mouse', 0, 0, { button: 1, buttons: 4 }), add)
    expect(m.navigating).toBe(true)
    expect(taps(m.up(s(3, 'mouse', 0, 0, { button: 1 })))).toHaveLength(0)
  })

  it('ignores the secondary button', () => {
    m.down(s(1, 'mouse', 0, 0, { button: 2, buttons: 2 }), add)
    expect(m.modeKind).toBe('idle')
    expect(taps(m.up(s(1, 'mouse', 0, 0, { button: 2 })))).toHaveLength(0)
  })

  it('hover only when no buttons are pressed', () => {
    expect(m.move(s(1, 'mouse', 5, 5, { buttons: 0 }))).toEqual([{ type: 'hover', x: 5, y: 5, pointerType: 'mouse' }])
    expect(m.leave(1)).toEqual([{ type: 'hoverEnd' }])
  })
})

describe('pen', () => {
  it('tap adds; jitter under threshold still taps at the contact point', () => {
    m.down(s(1, 'pen', 50, 50), add)
    m.move(s(1, 'pen', 53, 52))
    expect(taps(m.up(s(1, 'pen', 54, 53)))).toEqual([{ type: 'tap', x: 50, y: 50, pointerType: 'pen' }])
  })

  it('drag beyond threshold pans and does not tap', () => {
    m.down(s(1, 'pen', 50, 50), add)
    expect(pans(m.move(s(1, 'pen', 70, 50)))).toHaveLength(1)
    expect(taps(m.up(s(1, 'pen', 70, 50)))).toHaveLength(0)
  })

  it('pointercancel never taps', () => {
    m.down(s(1, 'pen', 50, 50), add)
    expect(m.cancel(1)).toEqual([])
    expect(m.modeKind).toBe('idle')
    expect(m.up(s(1, 'pen', 50, 50))).toEqual([])
  })

  it('touches while the pen is down are ignored (palm)', () => {
    m.down(s(1, 'pen', 50, 50), add)
    m.down(s(2, 'touch', 300, 300), addTouch)
    expect(m.move(s(2, 'touch', 400, 400))).toEqual([])
    expect(m.up(s(2, 'touch', 400, 400))).toEqual([])
    expect(taps(m.up(s(1, 'pen', 50, 50)))).toHaveLength(1)
  })

  it('pen contact cancels a pending finger tap (palm landed first)', () => {
    m.down(s(2, 'touch', 300, 300), addTouch)
    m.down(s(1, 'pen', 50, 50), addTouch)
    expect(m.up(s(2, 'touch', 300, 300))).toEqual([])
    expect(taps(m.up(s(1, 'pen', 50, 50)))).toEqual([{ type: 'tap', x: 50, y: 50, pointerType: 'pen' }])
  })

  it('after recent pen use, fingers navigate even with touchAnnotates', () => {
    m.down(s(1, 'pen', 50, 50), add)
    m.up(s(1, 'pen', 50, 50))
    t += 1000
    m.down(s(2, 'touch', 10, 10), addTouch)
    expect(m.modeKind).toBe('drag')
    expect(taps(m.up(s(2, 'touch', 10, 10)))).toHaveLength(0)
    t += PEN_RECENT_MS
    m.down(s(3, 'touch', 10, 10), addTouch)
    expect(m.modeKind).toBe('pending')
    expect(taps(m.up(s(3, 'touch', 10, 10)))).toHaveLength(1)
  })

  it('pen hover counts as pen activity and produces hover effects', () => {
    expect(m.move(s(9, 'pen', 5, 5, { buttons: 0 }))).toEqual([{ type: 'hover', x: 5, y: 5, pointerType: 'pen' }])
    expect(m.penSeenRecently(t + 10)).toBe(true)
  })
})

describe('touch', () => {
  it('navigates by default: one finger pans, tap does nothing', () => {
    m.down(s(1, 'touch', 10, 10), add)
    expect(m.modeKind).toBe('drag')
    expect(pans(m.move(s(1, 'touch', 15, 10)))).toEqual([{ type: 'pan', dx: 5, dy: 0 }])
    expect(taps(m.up(s(1, 'touch', 15, 10)))).toHaveLength(0)
  })

  it('touchAnnotates: single-finger tap taps', () => {
    m.down(s(1, 'touch', 10, 10), addTouch)
    expect(taps(m.up(s(1, 'touch', 12, 10)))).toEqual([{ type: 'tap', x: 10, y: 10, pointerType: 'touch' }])
  })

  it('touchAnnotates: a long press does not tap', () => {
    m.down(s(1, 'touch', 10, 10), addTouch)
    t += TOUCH_TAP_MAX_MS + 1
    expect(taps(m.up(s(1, 'touch', 10, 10)))).toHaveLength(0)
  })

  it('second finger cancels the pending tap and starts a pinch', () => {
    m.down(s(1, 'touch', 100, 100), addTouch)
    m.down(s(2, 'touch', 200, 100), addTouch)
    expect(m.modeKind).toBe('pinch')
    const fx = m.move(s(2, 'touch', 300, 100))
    expect(fx).toHaveLength(1)
    const p = fx[0] as Extract<GestureEffect, { type: 'pinch' }>
    expect(p.type).toBe('pinch')
    expect(p.factor).toBeCloseTo(2)
    expect(p.cx).toBe(200)
    expect(p.dx).toBe(50)
    // lift first finger first: remaining finger pans, never taps
    expect(taps(m.up(s(1, 'touch', 100, 100)))).toHaveLength(0)
    expect(m.modeKind).toBe('drag')
    expect(pans(m.move(s(2, 'touch', 310, 100)))).toEqual([{ type: 'pan', dx: 10, dy: 0 }])
    expect(taps(m.up(s(2, 'touch', 310, 100)))).toHaveLength(0)
    expect(m.modeKind).toBe('idle')
  })

  it('lifting fingers in the other order also never taps', () => {
    m.down(s(1, 'touch', 100, 100), addTouch)
    m.down(s(2, 'touch', 200, 100), addTouch)
    expect(taps(m.up(s(2, 'touch', 200, 100)))).toHaveLength(0)
    expect(taps(m.up(s(1, 'touch', 100, 100)))).toHaveLength(0)
  })

  it('a quick two-finger tap does not tap', () => {
    m.down(s(1, 'touch', 100, 100), addTouch)
    m.down(s(2, 'touch', 120, 100), addTouch)
    expect(taps([...m.up(s(1, 'touch', 100, 100)), ...m.up(s(2, 'touch', 120, 100))])).toHaveLength(0)
  })

  it('third finger is ignored; pinch continues', () => {
    m.down(s(1, 'touch', 0, 0), add)
    m.down(s(2, 'touch', 100, 0), add)
    m.down(s(3, 'touch', 50, 50), add)
    expect(m.move(s(3, 'touch', 80, 80))).toEqual([])
    expect(m.move(s(2, 'touch', 200, 0))[0].type).toBe('pinch')
    m.up(s(3, 'touch', 80, 80))
    expect(m.modeKind).toBe('pinch')
  })

  it('pointercancel during pinch falls back to panning with the other finger', () => {
    m.down(s(1, 'touch', 0, 0), add)
    m.down(s(2, 'touch', 100, 0), add)
    m.cancel(1)
    expect(m.modeKind).toBe('drag')
    m.cancel(2)
    expect(m.modeKind).toBe('idle')
  })

  it('a ghost finger (missed pointerup) is released when the platform reports fewer touches', () => {
    m.down(s(1, 'touch', 0, 0, { time: 0 }), add)
    // finger 1 lifts but its pointerup never arrives; later two real fingers land
    m.down(s(2, 'touch', 100, 0, { time: 5000 }), add)
    expect(m.modeKind).toBe('pinch') // paired with the ghost
    m.syncTouches(1) // touchstart: only one finger is physically down
    expect(m.modeKind).toBe('drag')
    m.down(s(3, 'touch', 200, 0, { time: 5010 }), add)
    m.syncTouches(2)
    expect(m.modeKind).toBe('pinch')
    const fx = m.move(s(3, 'touch', 300, 0, { time: 5020 }))
    expect(fx[0]).toMatchObject({ type: 'pinch' })
    expect((fx[0] as { factor: number }).factor).toBeCloseTo(2)
  })

  it('syncTouches never releases contacts that are really down', () => {
    m.down(s(1, 'touch', 0, 0), add)
    m.down(s(2, 'touch', 100, 0), add)
    m.syncTouches(2)
    m.syncTouches(3) // includes a Pencil touch
    expect(m.modeKind).toBe('pinch')
  })

  it('syncTouches(0) clears all finger state', () => {
    m.down(s(1, 'touch', 0, 0), add)
    m.syncTouches(0)
    expect(m.modeKind).toBe('idle')
    expect(m.activePointerCount).toBe(0)
  })

  it('large finger contacts always navigate, even right after Pencil use (iPad reports big thumb sizes)', () => {
    m.down(s(9, 'pen', 0, 0), add)
    m.up(s(9, 'pen', 0, 0))
    m.down(s(1, 'touch', 0, 0, { width: 80, height: 80 }), add)
    expect(m.modeKind).toBe('drag')
    m.down(s(2, 'touch', 100, 0, { width: 120, height: 120 }), add)
    expect(m.modeKind).toBe('pinch')
  })

  it('touch during a mouse press is ignored', () => {
    m.down(s(1, 'mouse', 0, 0), add)
    m.down(s(2, 'touch', 50, 50), addTouch)
    expect(taps(m.up(s(1, 'mouse', 0, 0)))).toHaveLength(1)
  })
})

describe('reset', () => {
  it('clears all transient state (blur / visibilitychange)', () => {
    m.down(s(1, 'touch', 0, 0), addTouch)
    m.down(s(2, 'touch', 100, 0), addTouch)
    expect(m.reset()).toEqual([{ type: 'hoverEnd' }])
    expect(m.activePointerCount).toBe(0)
    expect(m.modeKind).toBe('idle')
    expect(m.up(s(1, 'touch', 0, 0))).toEqual([])
  })

  it('a stale pointer id re-entering down restarts cleanly', () => {
    m.down(s(1, 'mouse', 0, 0), add)
    m.down(s(1, 'mouse', 5, 5), add)
    expect(taps(m.up(s(1, 'mouse', 5, 5)))).toEqual([{ type: 'tap', x: 5, y: 5, pointerType: 'mouse' }])
  })
})

describe('navTap (finger tap while touch annotation is off)', () => {
  const navTaps = (fx: GestureEffect[]) => fx.filter((e) => e.type === 'navTap')
  it('reports a still, short finger tap without ever tapping', () => {
    m.down(s(1, 'touch', 50, 50), add)
    t += 80
    const fx = m.up(s(1, 'touch', 52, 51))
    expect(taps(fx)).toHaveLength(0)
    expect(navTaps(fx)).toEqual([{ type: 'navTap', x: 50, y: 50 }])
  })
  it('is silent for drags, long presses, pinches, the pan tool and recent pen use', () => {
    m.down(s(1, 'touch', 0, 0), add)
    m.move(s(1, 'touch', 40, 0))
    expect(navTaps(m.up(s(1, 'touch', 40, 0)))).toHaveLength(0)

    m.down(s(2, 'touch', 0, 0), add)
    t += TOUCH_TAP_MAX_MS + 50
    expect(navTaps(m.up(s(2, 'touch', 0, 0)))).toHaveLength(0)

    m.down(s(3, 'touch', 0, 0), add)
    m.down(s(4, 'touch', 100, 0), add)
    expect(navTaps(m.up(s(4, 'touch', 100, 0)))).toHaveLength(0)
    expect(navTaps(m.up(s(3, 'touch', 0, 0)))).toHaveLength(0)

    m.down(s(5, 'touch', 0, 0), { ...add, tool: 'pan' })
    expect(navTaps(m.up(s(5, 'touch', 0, 0)))).toHaveLength(0)

    m.down(s(6, 'pen', 0, 0), add)
    m.up(s(6, 'pen', 0, 0))
    t += 100
    m.down(s(7, 'touch', 0, 0), add)
    expect(navTaps(m.up(s(7, 'touch', 0, 0)))).toHaveLength(0)
  })
  it('does not fire when touch annotates (that is a real tap)', () => {
    m.down(s(1, 'touch', 5, 5), addTouch)
    const fx = m.up(s(1, 'touch', 5, 5))
    expect(navTaps(fx)).toHaveLength(0)
    expect(taps(fx)).toHaveLength(1)
  })
})

describe('region tool (lasso)', () => {
  const region: GestureContext = { tool: 'region', touchAnnotates: false, spaceHeld: false }
  const kinds = (fx: GestureEffect[]) => fx.filter((e) => e.type !== 'hoverEnd' && e.type !== 'hover').map((e) => e.type)

  it('mouse: drag past the threshold draws (start at the press point, moves, end on release); never pans or taps', () => {
    m.down(s(1, 'mouse', 10, 10), region)
    expect(m.lassoing).toBe(false)
    expect(m.move(s(1, 'mouse', 12, 10))).toEqual([]) // within the threshold
    const fx = m.move(s(1, 'mouse', 30, 10))
    expect(fx).toEqual([
      { type: 'lassoStart', x: 10, y: 10, pointerType: 'mouse' },
      { type: 'lassoMove', x: 30, y: 10 },
    ])
    expect(m.lassoing).toBe(true)
    expect(m.navigating).toBe(false)
    expect(m.move(s(1, 'mouse', 30, 40))).toEqual([{ type: 'lassoMove', x: 30, y: 40 }])
    expect(m.up(s(1, 'mouse', 10, 40))).toEqual([{ type: 'lassoEnd', x: 10, y: 40 }])
    expect(m.modeKind).toBe('idle')
  })

  it('a press without movement is still a tap (suggestion rings), never a lasso', () => {
    m.down(s(1, 'mouse', 10, 10), region)
    expect(m.up(s(1, 'mouse', 10, 10))).toEqual([{ type: 'tap', x: 10, y: 10, pointerType: 'mouse' }])
  })

  it('middle button and Space still pan', () => {
    m.down(s(1, 'mouse', 0, 0, { button: 1, buttons: 4 }), region)
    expect(pans(m.move(s(1, 'mouse', 20, 0)))).toHaveLength(1)
    m.up(s(1, 'mouse', 20, 0, { button: 1 }))
    m.down(s(2, 'mouse', 0, 0), { ...region, spaceHeld: true })
    expect(kinds(m.move(s(2, 'mouse', 20, 0)))).toEqual(['pan'])
  })

  it('Apple Pencil draws like the mouse (pen threshold)', () => {
    m.down(s(1, 'pen', 100, 100), region)
    expect(m.move(s(1, 'pen', 100 + DRAG_THRESHOLD.pen, 100))).toEqual([])
    expect(kinds(m.move(s(1, 'pen', 120, 100)))).toEqual(['lassoStart', 'lassoMove'])
    expect(kinds(m.up(s(1, 'pen', 120, 130)))).toEqual(['lassoEnd'])
  })

  it('one finger draws even with touch annotation off', () => {
    m.down(s(1, 'touch', 50, 50), region)
    expect(kinds(m.move(s(1, 'touch', 80, 50)))).toEqual(['lassoStart', 'lassoMove'])
    expect(kinds(m.up(s(1, 'touch', 80, 80)))).toEqual(['lassoEnd'])
  })

  it('a second finger cancels the lasso and pinches; nothing is committed when the fingers lift', () => {
    m.down(s(1, 'touch', 50, 50), region)
    m.move(s(1, 'touch', 80, 50))
    const fx = m.down(s(2, 'touch', 200, 50), region)
    expect(kinds(fx)).toEqual(['lassoCancel'])
    expect(m.modeKind).toBe('pinch')
    expect(kinds(m.move(s(2, 'touch', 260, 50)))).toEqual(['pinch'])
    expect(kinds(m.up(s(1, 'touch', 80, 50)))).toEqual([])
    expect(kinds(m.move(s(2, 'touch', 270, 60)))).toEqual(['pan']) // remaining finger pans, never draws
    expect(kinds(m.up(s(2, 'touch', 270, 60)))).toEqual([])
  })

  it('a second finger before the threshold starts a pinch without any lasso effect', () => {
    m.down(s(1, 'touch', 50, 50), region)
    expect(kinds(m.down(s(2, 'touch', 150, 50), region))).toEqual([])
    expect(m.modeKind).toBe('pinch')
  })

  it('a pen landing cancels a finger lasso and starts its own', () => {
    m.down(s(1, 'touch', 50, 50), region)
    m.move(s(1, 'touch', 80, 50))
    expect(kinds(m.down(s(2, 'pen', 300, 300), region))).toEqual(['lassoCancel'])
    expect(kinds(m.move(s(1, 'touch', 90, 90)))).toEqual([]) // palm ignored
    expect(kinds(m.move(s(2, 'pen', 330, 300)))).toEqual(['lassoStart', 'lassoMove'])
  })

  it('fingers navigate in the region tool while a pen was used recently (palm)', () => {
    m.down(s(9, 'pen', 0, 0), region)
    m.up(s(9, 'pen', 0, 0))
    t += 1000
    m.down(s(1, 'touch', 50, 50), region)
    expect(kinds(m.move(s(1, 'touch', 80, 50)))).toEqual(['pan'])
    m.up(s(1, 'touch', 80, 50))
    t += PEN_RECENT_MS
    m.down(s(2, 'touch', 50, 50), region)
    expect(kinds(m.move(s(2, 'touch', 80, 50)))).toEqual(['lassoStart', 'lassoMove'])
  })

  it('pointercancel, reset and abortLasso (Escape) cancel; the aborted pointer stays inert', () => {
    m.down(s(1, 'pen', 0, 0), region)
    m.move(s(1, 'pen', 40, 0))
    expect(m.cancel(1)).toEqual([{ type: 'lassoCancel' }])

    m.down(s(2, 'mouse', 0, 0), region)
    m.move(s(2, 'mouse', 40, 0))
    expect(kinds(m.reset())).toEqual(['lassoCancel'])

    m.down(s(3, 'mouse', 0, 0), region)
    m.move(s(3, 'mouse', 40, 0))
    expect(m.abortLasso()).toEqual([{ type: 'lassoCancel' }])
    expect(m.move(s(3, 'mouse', 60, 0))).toEqual([])
    expect(m.up(s(3, 'mouse', 60, 0))).toEqual([])
    expect(m.abortLasso()).toEqual([])
  })

  it('a ghost finger dropped by syncTouches abandons its lasso', () => {
    m.down(s(1, 'touch', 50, 50), region)
    m.move(s(1, 'touch', 90, 50))
    expect(m.syncTouches(0)).toEqual([{ type: 'lassoCancel' }])
    expect(m.modeKind).toBe('idle')
  })
})
