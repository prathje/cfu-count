import { Show, splitProps, type JSX } from 'solid-js'
import { Dynamic } from 'solid-js/web'
import type { IconComponent } from '../icons'

type NativeButton = Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'title'>

/** Props shared by every icon-led button. */
export interface IconButtonProps extends NativeButton {
  icon: IconComponent
  /** Accessible name. Rendered as visible text when `showLabel` is true, otherwise as aria-label. */
  label: string
  showLabel?: boolean
  /** Keyboard shortcut shown in the tooltip, e.g. "A" or "⌘Z". */
  shortcut?: string
  /** Extra tooltip text (never the only carrier of meaning). */
  hint?: string
  variant?: 'ghost' | 'subtle' | 'primary' | 'danger'
  size?: 'sm' | 'md'
  /** Content after the label (e.g. a chevron or badge). */
  trailing?: JSX.Element
  ref?: HTMLButtonElement | ((el: HTMLButtonElement) => void)
}

/** Compact button with an icon and an accessible label. */
export function IconButton(props: IconButtonProps) {
  const [local, rest] = splitProps(props, ['icon', 'label', 'showLabel', 'shortcut', 'hint', 'variant', 'size', 'trailing', 'class', 'ref'])
  const title = () => [local.label + (local.shortcut ? ` (${local.shortcut})` : ''), local.hint].filter(Boolean).join(' — ')
  return (
    <button
      type="button"
      {...rest}
      ref={local.ref as HTMLButtonElement}
      class={`btn btn--${local.variant ?? 'ghost'} btn--${local.size ?? 'md'} ${local.showLabel ? 'btn--labelled' : 'btn--icon'} ${local.class ?? ''}`}
      aria-label={local.showLabel ? undefined : local.label}
      title={title()}
    >
      <Dynamic component={local.icon} size={local.size === 'sm' ? 16 : 18} stroke-width={1.85} aria-hidden="true" />
      <Show when={local.showLabel}>
        <span class="btn__label">{local.label}</span>
      </Show>
      {local.trailing}
    </button>
  )
}

/** Toggle variant: exposes state with aria-pressed and a visible pressed style. */
export interface ToggleButtonProps extends IconButtonProps {
  pressed: boolean
}

export function ToggleButton(props: ToggleButtonProps) {
  const [local, rest] = splitProps(props, ['pressed', 'class'])
  return (
    <IconButton {...rest} class={`btn--toggle ${local.pressed ? 'is-pressed' : ''} ${local.class ?? ''}`} aria-pressed={local.pressed} />
  )
}

/** Plain text button (dialogs, empty states, menus). */
export interface ButtonProps extends Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, 'title'> {
  variant?: 'primary' | 'subtle' | 'ghost' | 'danger'
  icon?: IconComponent
  size?: 'sm' | 'md' | 'lg'
}

export function Button(props: ButtonProps) {
  const [local, rest] = splitProps(props, ['variant', 'icon', 'size', 'class', 'children'])
  return (
    <button
      type="button"
      {...rest}
      class={`btn btn--labelled btn--${local.variant ?? 'subtle'} btn--${local.size ?? 'md'} ${local.class ?? ''}`}
    >
      <Show when={local.icon}>{(Icon) => <Dynamic component={Icon()} size={local.size === 'lg' ? 20 : 17} stroke-width={1.9} aria-hidden="true" />}</Show>
      <span class="btn__label">{local.children}</span>
    </button>
  )
}
