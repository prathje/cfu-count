import { createSignal, For, Show } from 'solid-js'
import type { Notice } from '../../state/messages'
import { AlertCircle, AlertTriangle, CheckCircle, Info, X, type IconComponent } from '../icons'

/** A notice currently on screen. */
export interface ToastItem extends Notice {
  id: number
}

/** Toast queue service: push notices, dismiss them, read the visible list. */
export interface Toaster {
  items(): ToastItem[]
  push(notice: Notice): void
  dismiss(id: number): void
}

const DURATION: Record<Notice['tone'], number> = { info: 3500, success: 3000, warning: 5500, error: 9000 }

export function createToaster(max = 3): Toaster {
  const [items, setItems] = createSignal<ToastItem[]>([])
  let seq = 0
  const timers = new Map<number, ReturnType<typeof setTimeout>>()
  const dismiss = (id: number) => {
    clearTimeout(timers.get(id))
    timers.delete(id)
    setItems((list) => list.filter((t) => t.id !== id))
  }
  const push = (notice: Notice) => {
    const id = ++seq
    setItems((list) => {
      const kept = notice.key ? list.filter((t) => t.key !== notice.key) : list
      for (const t of list) if (!kept.includes(t)) clearTimeout(timers.get(t.id))
      const next = [...kept, { ...notice, id }]
      return next.slice(-max)
    })
    timers.set(id, setTimeout(() => dismiss(id), DURATION[notice.tone] + (notice.action ? 2500 : 0)))
  }
  return { items, push, dismiss }
}

const ICONS: Record<Notice['tone'], IconComponent> = {
  info: Info,
  success: CheckCircle,
  warning: AlertTriangle,
  error: AlertCircle,
}

/** Renders the toast stack. Polite live region; errors are announced assertively. */
export function ToastRegion(props: { toaster: Toaster }) {
  return (
    <div class="toasts" aria-live="polite" aria-relevant="additions">
      <For each={props.toaster.items()}>
        {(t) => {
          const Icon = ICONS[t.tone]
          return (
            <div class={`toast toast--${t.tone}`} role={t.tone === 'error' ? 'alert' : 'status'}>
              <Icon class="toast__icon" size={18} stroke-width={2} aria-hidden="true" />
              <div class="toast__body">
                <div class="toast__message">{t.message}</div>
                <Show when={t.detail}>
                  <div class="toast__detail">{t.detail}</div>
                </Show>
              </div>
              <Show when={t.action}>
                {(action) => (
                  <button
                    type="button"
                    class="toast__action"
                    onClick={() => {
                      action().run()
                      props.toaster.dismiss(t.id)
                    }}
                  >
                    {action().label}
                  </button>
                )}
              </Show>
              <button type="button" class="toast__close" aria-label="Dismiss" onClick={() => props.toaster.dismiss(t.id)}>
                <X size={16} aria-hidden="true" />
              </button>
            </div>
          )
        }}
      </For>
    </div>
  )
}
