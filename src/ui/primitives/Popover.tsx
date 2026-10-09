import { createEffect, createSignal, onCleanup, Show, type JSX } from 'solid-js'
import { Portal } from 'solid-js/web'

export type Placement = 'bottom-start' | 'bottom-end' | 'bottom' | 'top-start' | 'top-end' | 'top'

/** Anchored floating panel. Rendered in a portal so its pointer events never reach the canvas. */
export interface PopoverProps {
  open: boolean
  /** Element the panel is positioned against (and which does not light-dismiss it). */
  anchor: HTMLElement | undefined
  onClose(reason: 'escape' | 'outside' | 'action'): void
  /** Accessible name of the panel. */
  label: string
  placement?: Placement
  role?: 'dialog' | 'menu'
  class?: string
  /** Fixed width in CSS px (clamped to the window). */
  width?: number
  children: JSX.Element
}

const GAP = 8
const MARGIN = 8

/** Elements marked with this attribute swallow the light-dismiss tap so it doesn't also annotate. */
export const CANVAS_GUARD_ATTR = 'data-canvas-guard'

export function Popover(props: PopoverProps) {
  let panel: HTMLDivElement | undefined
  const [pos, setPos] = createSignal<{ x: number; y: number; maxH: number; origin: string } | null>(null)

  function place() {
    const anchor = props.anchor
    if (!anchor || !panel) return
    const a = anchor.getBoundingClientRect()
    const vw = document.documentElement.clientWidth
    const vh = window.innerHeight
    const w = Math.min(panel.offsetWidth, vw - MARGIN * 2)
    const h = panel.scrollHeight
    const placement = props.placement ?? 'bottom-start'
    const below = vh - a.bottom - GAP - MARGIN
    const above = a.top - GAP - MARGIN
    // Prefer the requested side; flip only when the other side has more room for an overflowing panel.
    const top = placement.startsWith('top') ? above >= h || above >= below : below < h && above > below
    const maxH = Math.max(160, top ? above : below)
    let x = placement.endsWith('start') ? a.left : placement.endsWith('end') ? a.right - w : a.left + a.width / 2 - w / 2
    x = Math.max(MARGIN, Math.min(vw - w - MARGIN, x))
    const y = top ? a.top - GAP - Math.min(h, maxH) : a.bottom + GAP
    setPos({ x, y, maxH, origin: top ? 'bottom' : 'top' })
    queueMicrotask(updateScrollHint)
  }

  /** Fade the bottom edge while more content is hidden below. */
  function updateScrollHint() {
    if (!panel) return
    panel.classList.toggle('is-scroll-more', panel.scrollTop + panel.clientHeight < panel.scrollHeight - 4)
  }

  createEffect(() => {
    if (!props.open) {
      setPos(null)
      return
    }
    const returnFocus = document.activeElement as HTMLElement | null
    queueMicrotask(() => {
      place()
      // Focus the first control for keyboard users, without popping up on-screen keyboards.
      const target = panel?.querySelector<HTMLElement>('[data-autofocus]') ??
        panel?.querySelector<HTMLElement>('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')
      target?.focus({ preventScroll: true })
    })

    let swallowClick = false
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (panel?.contains(t) || props.anchor?.contains(t)) return
      if (document.querySelector('dialog[open]')) return
      props.onClose('outside')
      // A dismissing tap on the image must not also add/erase a marker.
      if ((t as Element).closest?.(`[${CANVAS_GUARD_ATTR}]`)) {
        e.stopPropagation()
        e.preventDefault()
        swallowClick = true
      }
    }
    const onClick = (e: MouseEvent) => {
      if (!swallowClick) return
      swallowClick = false
      e.stopPropagation()
      e.preventDefault()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('dialog[open]')) return
      e.stopPropagation()
      props.onClose('escape')
      if (panel?.contains(document.activeElement)) (props.anchor ?? returnFocus)?.focus({ preventScroll: true })
    }
    const ro = new ResizeObserver(() => place())
    if (panel) ro.observe(panel)
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('click', onClick, true)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    onCleanup(() => {
      ro.disconnect()
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('click', onClick, true)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
      if (panel?.contains(document.activeElement)) props.anchor?.focus({ preventScroll: true })
    })
  })

  return (
    <Show when={props.open}>
      <Portal>
        <div
          ref={panel}
          class={`popover ${props.class ?? ''}`}
          classList={{ 'is-placed': !!pos() }}
          role={props.role ?? 'dialog'}
          aria-label={props.label}
          style={{
            left: `${pos()?.x ?? -9999}px`,
            top: `${pos()?.y ?? -9999}px`,
            'max-height': pos() ? `${pos()!.maxH}px` : undefined,
            width: props.width ? `min(${props.width}px, calc(100vw - ${MARGIN * 2}px))` : undefined,
            'transform-origin': pos()?.origin,
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onScroll={updateScrollHint}
          onKeyDown={(e) => {
            if (props.role === 'menu' || panel?.dataset.roving !== undefined) rovingFocus(e, panel!)
          }}
        >
          {props.children}
        </div>
      </Portal>
    </Show>
  )
}

/** Arrow-key focus movement between [data-item] elements inside a container. */
export function rovingFocus(e: KeyboardEvent, container: HTMLElement) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return
  if ((e.target as HTMLElement).tagName === 'INPUT' && (e.target as HTMLInputElement).type !== 'range') return
  const items = [...container.querySelectorAll<HTMLElement>('[data-item]:not([disabled])')]
  if (!items.length) return
  const i = items.indexOf(document.activeElement as HTMLElement)
  const next =
    e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length
  e.preventDefault()
  items[next].focus()
}

/** Convenience: open state + anchor ref for a trigger/popover pair. */
export function createPopoverState() {
  const [open, setOpen] = createSignal(false)
  const [anchor, setAnchor] = createSignal<HTMLElement>()
  return {
    open,
    anchor,
    setAnchor,
    toggle: () => setOpen((o) => !o),
    show: () => setOpen(true),
    close: () => setOpen(false),
  }
}
