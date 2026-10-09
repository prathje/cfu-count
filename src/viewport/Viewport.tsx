/**
 * Image viewport: two Canvas 2D layers (image, annotations) plus DOM overlays
 * for hover preview and duplicate pulses. Pure view + input component: it never
 * mutates annotations, it reports intents through props callbacks.
 *
 * Rendering is scheduled with requestAnimationFrame and split by layer: an
 * annotation/style change redraws only the annotation layer; the image layer is
 * redrawn only when the view, size or image changes.
 */
import { createEffect, createMemo, createSignal, on, onCleanup, onMount } from 'solid-js'
import type { AnnotationGroup } from '../model/types'
import type { ViewportHandle, ViewportProps, ViewState } from './api'
import { GestureMachine, type GestureEffect, type PointerKind, type PointerSample } from './gesture'
import { editBlock } from '../model/policy'
import { resolveHover, resolveTap, type InteractionScene } from './interaction'
import { createPointIndex, type PointIndex } from './spatial-index'
import {
  buildPyramid,
  disposePyramid,
  drawAnnotationLayer,
  drawImageLayer,
  effectiveDpr,
  type ImageSourceLike,
  type PyramidLevel,
} from './render'
import {
  classifyWheel,
  constrainView,
  fitView,
  imageToScreen,
  panBy,
  resizeView,
  scaleLimits,
  viewsEqual,
  wheelDeltaToPixels,
  wheelZoomFactor,
  zoomAt,
  zoomToAt,
  ZOOM_STEP,
  FIT_PADDING,
  NO_INSETS,
  type Size,
  type WheelIntent,
} from './transform'
import './viewport.css'

const KEY_PAN_PX = 60
const ERASER_CURSOR =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24'%3E%3Ccircle cx='12' cy='12' r='8' fill='none' stroke='black' stroke-width='3'/%3E%3Ccircle cx='12' cy='12' r='8' fill='none' stroke='white' stroke-width='1.5'/%3E%3Cpath d='M8.5 8.5l7 7M15.5 8.5l-7 7' stroke='black' stroke-width='3'/%3E%3Cpath d='M8.5 8.5l7 7M15.5 8.5l-7 7' stroke='white' stroke-width='1.2'/%3E%3C/svg%3E\") 12 12, crosshair"

function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  if (t.isContentEditable) return true
  const tag = t.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') {
    const type = (t as HTMLInputElement).type
    return !['button', 'checkbox', 'radio', 'range', 'color', 'submit', 'reset', 'file', 'image'].includes(type)
  }
  return false
}

function pointerKind(t: string): PointerKind {
  return t === 'pen' ? 'pen' : t === 'touch' ? 'touch' : 'mouse'
}

function naturalSize(src: ImageSourceLike): Size {
  if (typeof HTMLImageElement !== 'undefined' && src instanceof HTMLImageElement) {
    return { width: src.naturalWidth, height: src.naturalHeight }
  }
  return { width: src.width, height: src.height }
}

export function Viewport(props: ViewportProps) {
  let root!: HTMLDivElement
  let imageCanvas!: HTMLCanvasElement
  let surface!: HTMLCanvasElement
  let hoverEl!: HTMLDivElement

  // Mutable render state (deliberately not reactive: changes go through schedule()).
  let view: ViewState = { scale: 1, offsetX: 0, offsetY: 0 }
  let viewport: Size = { width: 0, height: 0 }
  let dpr = 1
  let levels: PyramidLevel[] = []
  let pyramidSignal = { aborted: false }
  let fitted = true
  let dirtyImage = true
  let dirtyAnno = true
  let viewChanged = false
  let raf = 0
  let hover: { x: number; y: number; type: PointerKind } | null = null
  let lastWheel: { intent: WheelIntent; time: number } | null = null
  let gestureScale = 1
  let gestureActive = false
  // Spatial index over all annotations, rebuilt lazily on the first query after a change.
  let index: PointIndex | null = null
  let indexed: readonly unknown[] | null = null
  const machine = new GestureMachine()

  const [spaceHeld, setSpaceHeld] = createSignal(false)
  const [navigating, setNavigating] = createSignal(false)

  const imageSize = (): Size => ({ width: props.imageWidth, height: props.imageHeight })
  const activeGroup = createMemo<AnnotationGroup | undefined>(() =>
    props.groups.find((g) => g.id === props.activeGroupId),
  )
  const cursor = createMemo(() => {
    if (navigating()) return 'grabbing'
    if (props.tool === 'pan' || spaceHeld()) return 'grab'
    if (editBlock(activeGroup())) return 'not-allowed'
    return props.tool === 'erase' ? ERASER_CURSOR : 'crosshair'
  })

  // ---------------------------------------------------------------- rendering

  function schedule() {
    if (!raf) raf = requestAnimationFrame(frame)
  }

  function frame() {
    raf = 0
    if (viewport.width === 0 || viewport.height === 0) return
    const ictx = imageCanvas.getContext('2d')
    const actx = surface.getContext('2d')
    if (!ictx || !actx) return
    if (dirtyImage) {
      dirtyImage = false
      drawImageLayer(ictx, levels, imageSize(), view, viewport, dpr)
    }
    if (dirtyAnno) {
      dirtyAnno = false
      const t0 = performance.now()
      const stats = drawAnnotationLayer(actx, props.annotations, props.groups, props.activeGroupId, view, viewport, dpr)
      root.dataset.drawMs = (performance.now() - t0).toFixed(2)
      root.dataset.markersDrawn = String(stats.drawn)
    }
    updateHover()
    if (viewChanged) {
      viewChanged = false
      props.onViewChange?.({ ...view })
    }
  }

  function setView(next: ViewState, user = true) {
    const v = constrainView(next, imageSize(), viewport)
    if (user) fitted = false
    if (viewsEqual(v, view)) return
    view = v
    clearPulses()
    dirtyImage = dirtyAnno = true
    viewChanged = true
    schedule()
  }

  const insets = () => props.fitInsets ?? NO_INSETS
  const limits = () => scaleLimits(imageSize(), viewport, insets())

  function fit() {
    if (viewport.width === 0) return
    setView(fitView(imageSize(), viewport, FIT_PADDING, insets()), false)
    fitted = true
  }

  function zoomBy(factor: number, sx = viewport.width / 2, sy = viewport.height / 2) {
    setView(zoomAt(view, sx, sy, factor, limits()))
  }

  const handle: ViewportHandle = {
    zoomIn: () => zoomBy(ZOOM_STEP),
    zoomOut: () => zoomBy(1 / ZOOM_STEP),
    fit,
    setScale: (s) => setView(zoomToAt(view, viewport.width / 2, viewport.height / 2, s, limits())),
  }

  function resize() {
    const rect = root.getBoundingClientRect()
    const next: Size = { width: Math.round(rect.width), height: Math.round(rect.height) }
    const nextDpr = effectiveDpr(next, window.devicePixelRatio)
    if (next.width === viewport.width && next.height === viewport.height && nextDpr === dpr) return
    const old = viewport
    viewport = next
    dpr = nextDpr
    for (const c of [imageCanvas, surface]) {
      c.width = Math.max(1, Math.round(next.width * dpr))
      c.height = Math.max(1, Math.round(next.height * dpr))
    }
    if (old.width === 0 || old.height === 0 || fitted) fit()
    else setView(resizeView(view, old, next), false)
    dirtyImage = dirtyAnno = true
    viewChanged = true
    // Draw now (ResizeObserver runs before paint) so resizing never shows a blank canvas.
    if (raf) cancelAnimationFrame(raf)
    frame()
  }

  // ------------------------------------------------------------- image input

  createEffect(
    on(
      () => [props.image, props.imageWidth, props.imageHeight] as const,
      ([img]) => {
        pyramidSignal.aborted = true
        disposePyramid(levels)
        levels = []
        machine.reset()
        setNavigating(false)
        if (img && props.imageWidth > 0) {
          const src = img as ImageSourceLike
          const base = naturalSize(src).width / props.imageWidth
          levels = [{ source: src, scale: base }]
          const signal = (pyramidSignal = { aborted: false })
          void buildPyramid(src, signal).then((built) => {
            if (signal.aborted) return disposePyramid(built)
            levels = built.map((l) => ({ source: l.source, scale: l.scale * base }))
            dirtyImage = true
            schedule()
          })
        }
        fit()
        dirtyImage = dirtyAnno = true
        schedule()
      },
    ),
  )

  createEffect(
    on(
      () => {
        const i = props.fitInsets
        return i ? `${i.top},${i.right},${i.bottom},${i.left}` : ''
      },
      () => {
        if (fitted) fit()
      },
      { defer: true },
    ),
  )

  // Annotation layer: `annotations` and `groups` are immutable snapshots (see api.ts), so
  // tracking their identity is enough; no per-field reads.
  createEffect(
    on(
      () => [props.annotations, props.groups, props.activeGroupId] as const,
      ([annotations]) => {
        if (annotations !== indexed) index = null
        dirtyAnno = true
        schedule()
      },
    ),
  )

  createEffect(() => {
    void props.tool, spaceHeld(), activeGroup()
    schedule() // refresh hover preview
  })

  // ----------------------------------------------------------- hover preview

  function hideHover() {
    hoverEl.style.display = 'none'
  }

  function showRing(cls: string, x: number, y: number, r: number, color?: string) {
    const d = r * 2
    hoverEl.className = `cfu-viewport__hover ${cls}`
    hoverEl.style.display = 'block'
    hoverEl.style.width = `${d}px`
    hoverEl.style.height = `${d}px`
    hoverEl.style.transform = `translate(${x - r}px, ${y - r}px)`
    if (color) hoverEl.style.setProperty('--ring-color', color)
  }

  function scene(): InteractionScene {
    if (!index) {
      index = createPointIndex(props.annotations)
      indexed = props.annotations
    }
    return {
      view,
      imageWidth: props.imageWidth,
      imageHeight: props.imageHeight,
      groups: props.groups,
      activeGroup: activeGroup(),
      index,
    }
  }

  function updateHover() {
    if (!hover || spaceHeld() || machine.modeKind !== 'idle') return hideHover()
    const h = resolveHover(scene(), props.tool, hover.x, hover.y, hover.type)
    if (h.kind === 'none') return hideHover()
    showRing(`cfu-viewport__hover--${h.kind}`, h.x, h.y, h.r, h.kind === 'add' ? h.color : undefined)
  }

  const reducedMotion =
    typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null

  /** Brief in-place ring at screen (x, y). Static (no scaling) under reduced motion. */
  function pulseAt(x: number, y: number, r: number) {
    const el = document.createElement('div')
    const still = reducedMotion?.matches ?? false
    el.className = still ? 'cfu-viewport__pulse cfu-viewport__pulse--static' : 'cfu-viewport__pulse'
    const d = Math.max(10, r * 2 + 6)
    el.style.width = el.style.height = `${d}px`
    // left/top, not transform: the CSS animation scales via `transform` about the centre.
    el.style.left = `${x - d / 2}px`
    el.style.top = `${y - d / 2}px`
    if (!still) el.addEventListener('animationend', () => el.remove())
    setTimeout(() => el.remove(), still ? 900 : 1500)
    root.appendChild(el)
  }

  /** Pulses mark screen positions; drop them when the view moves so none is left stale. */
  function clearPulses() {
    for (const el of root.querySelectorAll('.cfu-viewport__pulse')) el.remove()
  }

  // --------------------------------------------------------------- gestures

  function handleTap(sx: number, sy: number, pointerType: PointerKind) {
    const intent = resolveTap(scene(), props.tool, sx, sy, pointerType)
    switch (intent.kind) {
      case 'add': {
        props.onAdd(intent.x, intent.y)
        if (intent.nearby) {
          const r = activeGroup()?.size ?? 6
          const s = imageToScreen(view, intent.nearby.x, intent.nearby.y)
          pulseAt(s.x, s.y, r)
          pulseAt(sx, sy, r)
        }
        break
      }
      case 'erase':
        props.onErase(intent.id)
        break
      case 'blocked':
        props.onBlocked?.(intent.reason)
        break
    }
  }

  function apply(effects: GestureEffect[]) {
    for (const e of effects) {
      switch (e.type) {
        case 'pan':
          setView(panBy(view, e.dx, e.dy))
          break
        case 'pinch': {
          const v = panBy(view, e.dx, e.dy)
          setView(zoomAt(v, e.cx, e.cy, e.factor, limits()))
          break
        }
        case 'tap':
          handleTap(e.x, e.y, e.pointerType)
          break
        case 'hover':
          hover = { x: e.x, y: e.y, type: e.pointerType }
          schedule()
          break
        case 'hoverEnd':
          hover = null
          hideHover()
          break
      }
    }
    setNavigating(machine.navigating)
    if (machine.modeKind !== 'idle') hideHover()
  }

  function sample(e: PointerEvent): PointerSample {
    const r = root.getBoundingClientRect()
    return {
      id: e.pointerId,
      type: pointerKind(e.pointerType),
      x: e.clientX - r.left,
      y: e.clientY - r.top,
      button: e.button,
      buttons: e.buttons,
      width: e.width,
      height: e.height,
      time: e.timeStamp,
    }
  }

  const ctx = () => ({ tool: props.tool, touchAnnotates: props.touchAnnotates, spaceHeld: spaceHeld() })

  function onPointerDown(e: PointerEvent) {
    // Suppress compatibility mouse events, text selection and native drag.
    e.preventDefault()
    if (document.activeElement !== root) root.focus({ preventScroll: true })
    try {
      surface.setPointerCapture(e.pointerId)
    } catch {
      /* pointer already gone */
    }
    apply(machine.down(sample(e), ctx()))
  }
  const onPointerMove = (e: PointerEvent) => apply(machine.move(sample(e)))
  const onPointerUp = (e: PointerEvent) => apply(machine.up(sample(e)))
  const onPointerCancel = (e: PointerEvent) => apply(machine.cancel(e.pointerId))
  const onLostCapture = (e: PointerEvent) => apply(machine.cancel(e.pointerId))
  const onPointerLeave = (e: PointerEvent) => apply(machine.leave(e.pointerId))

  function onWheel(e: WheelEvent) {
    e.preventDefault() // the viewport owns wheel input (also blocks ctrl+wheel page zoom)
    // Read deltaMode BEFORE the deltas: Firefox reports line units only if deltaMode is read first.
    const deltaMode = e.deltaMode
    const deltaX = e.deltaX
    const deltaY = e.deltaY
    const r = root.getBoundingClientRect()
    const sx = e.clientX - r.left
    const sy = e.clientY - r.top
    const prev = lastWheel && e.timeStamp - lastWheel.time < 200 ? lastWheel.intent : null
    const legacy = (e as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY
    const intent = classifyWheel(
      { deltaX, deltaY, deltaMode, ctrlKey: e.ctrlKey, wheelDeltaY: legacy },
      prev,
    )
    lastWheel = { intent, time: e.timeStamp }
    const dx = wheelDeltaToPixels(deltaX, deltaMode, viewport.width)
    const dy = wheelDeltaToPixels(deltaY, deltaMode, viewport.height)
    if (intent === 'pinch' && gestureActive) return // Safari: pinch already handled via GestureEvent
    if (intent === 'pan') {
      if (e.shiftKey && dx === 0) setView(panBy(view, -dy, 0))
      else setView(panBy(view, -dx, -dy))
    } else {
      zoomBy(wheelZoomFactor(dy, intent), sx, sy)
    }
  }

  // Safari (macOS trackpad pinch, iOS page pinch): non-standard GestureEvent.
  type SafariGestureEvent = UIEvent & { scale: number; clientX: number; clientY: number }
  function onGestureStart(e: Event) {
    e.preventDefault()
    gestureScale = 1
    gestureActive = true
  }
  function onGestureEnd(e: Event) {
    e.preventDefault()
    gestureActive = false
  }
  function onGestureChange(e: Event) {
    e.preventDefault()
    const g = e as SafariGestureEvent
    // On iPad, touch pinch is already handled by Pointer Events; only use
    // GestureEvent when no touch pointers are down (macOS Safari trackpad).
    if (machine.hasActivePointerOfType('touch') || !g.scale) return
    const r = root.getBoundingClientRect()
    zoomBy(g.scale / gestureScale, g.clientX - r.left, g.clientY - r.top)
    gestureScale = g.scale
  }
  const prevent = (e: Event) => e.preventDefault()

  function onKeyDown(e: KeyboardEvent) {
    if (e.target !== root || e.metaKey || e.ctrlKey || e.altKey) return
    const step = e.shiftKey ? KEY_PAN_PX * 4 : KEY_PAN_PX
    let handled = true
    switch (e.key) {
      case 'ArrowLeft':
        setView(panBy(view, step, 0))
        break
      case 'ArrowRight':
        setView(panBy(view, -step, 0))
        break
      case 'ArrowUp':
        setView(panBy(view, 0, step))
        break
      case 'ArrowDown':
        setView(panBy(view, 0, -step))
        break
      default:
        handled = false
    }
    if (handled) e.preventDefault()
  }

  // ------------------------------------------------------------ window hooks

  function clearTransient() {
    apply(machine.reset())
    setSpaceHeld(false)
  }
  function onWindowKeyDown(e: KeyboardEvent) {
    if (e.code !== 'Space' || isEditableTarget(e.target)) return
    if (e.target === root) e.preventDefault() // no page scroll from the focused viewport
    setSpaceHeld(true)
  }
  function onWindowKeyUp(e: KeyboardEvent) {
    if (e.code === 'Space') setSpaceHeld(false)
  }
  function onVisibility() {
    if (document.visibilityState === 'hidden') clearTransient()
  }

  onMount(() => {
    const opts: AddEventListenerOptions = { passive: false }
    surface.addEventListener('pointerdown', onPointerDown, opts)
    surface.addEventListener('pointermove', onPointerMove)
    surface.addEventListener('pointerup', onPointerUp)
    surface.addEventListener('pointercancel', onPointerCancel)
    surface.addEventListener('lostpointercapture', onLostCapture)
    surface.addEventListener('pointerleave', onPointerLeave)
    surface.addEventListener('wheel', onWheel, opts)
    surface.addEventListener('gesturestart', onGestureStart, opts)
    surface.addEventListener('gesturechange', onGestureChange, opts)
    surface.addEventListener('gestureend', onGestureEnd, opts)
    // Non-passive touch listeners that cancel the default: stops iOS double-tap zoom,
    // synthetic click/mouse events and Scribble swallowing Pencil input (WebKit bug 217430).
    surface.addEventListener('touchstart', prevent, opts)
    surface.addEventListener('touchmove', prevent, opts)
    surface.addEventListener('contextmenu', prevent, opts)
    surface.addEventListener('dblclick', prevent, opts)
    root.addEventListener('selectstart', prevent, opts)
    root.addEventListener('dragstart', prevent, opts)
    root.addEventListener('keydown', onKeyDown)
    window.addEventListener('keydown', onWindowKeyDown)
    window.addEventListener('keyup', onWindowKeyUp)
    window.addEventListener('blur', clearTransient)
    document.addEventListener('visibilitychange', onVisibility)

    const ro = new ResizeObserver(resize)
    ro.observe(root)
    // DPR changes (window moved between displays, browser zoom) do not resize the element.
    let mq: MediaQueryList | null = null
    const watchDpr = () => {
      mq?.removeEventListener('change', onDpr)
      mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
      mq.addEventListener('change', onDpr)
    }
    const onDpr = () => {
      watchDpr()
      resize()
    }
    watchDpr()
    resize()
    props.ref?.(handle)

    onCleanup(() => {
      ro.disconnect()
      mq?.removeEventListener('change', onDpr)
      window.removeEventListener('keydown', onWindowKeyDown)
      window.removeEventListener('keyup', onWindowKeyUp)
      window.removeEventListener('blur', clearTransient)
      document.removeEventListener('visibilitychange', onVisibility)
      if (raf) cancelAnimationFrame(raf)
      pyramidSignal.aborted = true
      disposePyramid(levels)
      // Release canvas backing stores promptly (matters for Safari's canvas memory cap).
      for (const c of [imageCanvas, surface]) {
        c.width = 0
        c.height = 0
      }
    })
  })

  return (
    <div
      ref={root}
      class="cfu-viewport"
      tabindex="0"
      role="group"
      aria-roledescription="image viewport"
      aria-label="Image viewport. Arrow keys pan; plus and minus zoom, 0 fits the image."
      aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight"
      style={{ cursor: cursor() }}
    >
      <canvas ref={imageCanvas} class="cfu-viewport__layer" aria-hidden="true" />
      <canvas
        ref={surface}
        class="cfu-viewport__layer cfu-viewport__surface"
        role="img"
        aria-label={props.label ?? 'Plate image with colony markers'}
      />
      <div ref={hoverEl} class="cfu-viewport__hover" style={{ display: 'none' }} />
    </div>
  )
}
