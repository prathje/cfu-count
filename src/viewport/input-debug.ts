/**
 * On-device input diagnostics, enabled with `?debugInput` in the URL. Shows the
 * last pointer/touch/gesture events the surface receives (type, pointerType, id,
 * contact size, buttons) plus the gesture-machine mode, so iPad/Pencil behaviour
 * can be inspected without a remote debugger. Never active otherwise.
 */
export function inputDebugEnabled(): boolean {
  try {
    return new URLSearchParams(location.search).has('debugInput')
  } catch {
    return false
  }
}

const EVENTS = [
  'pointerdown',
  'pointermove',
  'pointerup',
  'pointercancel',
  'lostpointercapture',
  'touchstart',
  'touchend',
  'touchcancel',
  'gesturestart',
  'gestureend',
] as const

/** Attach the overlay to `host`, observing `surface`. Returns a cleanup function. */
export function attachInputDebug(surface: HTMLElement, host: HTMLElement, mode: () => string): () => void {
  const panel = document.createElement('pre')
  panel.className = 'cfu-viewport__debug'
  host.appendChild(panel)
  const lines: string[] = []
  let lastMoveLine = ''

  const describe = (e: Event): string => {
    const t = Math.round(e.timeStamp)
    if (e instanceof PointerEvent) {
      const size = `${e.width.toFixed(0)}×${e.height.toFixed(0)}`
      return `${t} ${e.type} ${e.pointerType}#${e.pointerId} ${size} btn=${e.buttons} p=${e.pressure.toFixed(2)}`
    }
    if (typeof TouchEvent !== 'undefined' && e instanceof TouchEvent) {
      const r = Array.from(e.changedTouches)
        .map((x) => `${x.identifier}:${(x.radiusX ?? 0).toFixed(0)}`)
        .join(',')
      return `${t} ${e.type} touches=${e.touches.length} r=${r}`
    }
    return `${t} ${e.type}`
  }

  const onEvent = (e: Event) => {
    const line = `${describe(e)} → ${mode()}`
    if (e.type === 'pointermove') {
      // Collapse move floods into one updating line.
      if (lines.length && lines[lines.length - 1] === lastMoveLine) lines.pop()
      lastMoveLine = line
    }
    lines.push(line)
    if (lines.length > 14) lines.shift()
    panel.textContent = lines.join('\n')
  }

  // Passive observers registered after the viewport's own listeners: they never alter behaviour.
  for (const type of EVENTS) surface.addEventListener(type, onEvent, { passive: true })
  return () => {
    for (const type of EVENTS) surface.removeEventListener(type, onEvent)
    panel.remove()
  }
}
