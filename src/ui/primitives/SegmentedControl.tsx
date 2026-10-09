import { For, Show } from 'solid-js'
import { Dynamic } from 'solid-js/web'
import type { IconComponent } from '../icons'

/** One option of a SegmentedControl. */
export interface SegmentOption<T extends string> {
  value: T
  label: string
  icon?: IconComponent
}

/** Single-choice control rendered as a radio group (arrow keys move the selection). */
export interface SegmentedControlProps<T extends string> {
  label: string
  value: T
  options: readonly SegmentOption<T>[]
  onChange(value: T): void
  disabled?: boolean
}

export function SegmentedControl<T extends string>(props: SegmentedControlProps<T>) {
  const move = (e: KeyboardEvent, index: number) => {
    const delta = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (!delta) return
    e.preventDefault()
    const next = props.options[(index + delta + props.options.length) % props.options.length]
    props.onChange(next.value)
    const group = (e.currentTarget as HTMLElement).parentElement
    queueMicrotask(() => group?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus())
  }
  return (
    <div class="segmented" role="radiogroup" aria-label={props.label} aria-disabled={props.disabled}>
      <For each={props.options}>
        {(opt, i) => (
          <button
            type="button"
            role="radio"
            class="segmented__option"
            aria-checked={props.value === opt.value}
            tabIndex={props.value === opt.value ? 0 : -1}
            disabled={props.disabled}
            onClick={() => props.onChange(opt.value)}
            onKeyDown={(e) => move(e, i())}
          >
            <Show when={opt.icon}>
              {(Icon) => <Dynamic component={Icon()} size={16} stroke-width={1.9} aria-hidden="true" />}
            </Show>
            <span>{opt.label}</span>
          </button>
        )}
      </For>
    </div>
  )
}
