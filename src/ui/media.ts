/** Reactive environment helpers (media queries, element size). */
import { createSignal, onCleanup, type Accessor } from 'solid-js'

/** Reactive matchMedia. */
export function createMediaQuery(query: string): Accessor<boolean> {
  const mq = window.matchMedia(query)
  const [matches, setMatches] = createSignal(mq.matches)
  const onChange = (e: MediaQueryListEvent) => setMatches(e.matches)
  mq.addEventListener('change', onChange)
  onCleanup(() => mq.removeEventListener('change', onChange))
  return matches
}

/** Reactive content-box width of an element (0 until measured). */
export function createElementWidth(el: Accessor<HTMLElement | undefined>): Accessor<number> {
  const [width, setWidth] = createSignal(0)
  const ro = new ResizeObserver((entries) => {
    for (const entry of entries) setWidth(Math.round(entry.contentRect.width))
  })
  let observed: HTMLElement | undefined
  const sync = () => {
    const target = el()
    if (target === observed) return
    if (observed) ro.unobserve(observed)
    observed = target
    if (target) ro.observe(target)
  }
  queueMicrotask(sync)
  onCleanup(() => ro.disconnect())
  return () => {
    sync()
    return width()
  }
}

/** Reactive border-box height of an element (0 until measured or when absent). */
export function createElementHeight(el: Accessor<HTMLElement | undefined>): Accessor<number> {
  const [height, setHeight] = createSignal(0)
  const ro = new ResizeObserver((entries) => {
    for (const entry of entries) setHeight(Math.round(entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height))
  })
  let observed: HTMLElement | undefined
  const sync = () => {
    const target = el()
    if (target === observed) return
    if (observed) ro.unobserve(observed)
    observed = target
    if (target) ro.observe(target)
    else setHeight(0)
  }
  queueMicrotask(sync)
  onCleanup(() => ro.disconnect())
  return () => {
    sync()
    return height()
  }
}

/** The platform's primary modifier label for shortcuts. */
export const isApple = /Mac|iPhone|iPad|iPod/.test(navigator.platform) || navigator.userAgent.includes('Mac')
export const MOD = isApple ? '⌘' : 'Ctrl+'
