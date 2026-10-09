import { Show, splitProps, type JSX } from 'solid-js'
import { Dynamic } from 'solid-js/web'
import type { IconComponent } from '../icons'

/** One actionable row in a menu-like popover. Focusable with arrow keys (data-item). */
export interface MenuItemProps extends Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon?: IconComponent
  label: JSX.Element
  /** Secondary text under the label. */
  description?: JSX.Element
  /** Right-aligned content (shortcut, count, check). */
  trailing?: JSX.Element
  danger?: boolean
  /** Marks the current choice (aria-checked when role is menuitemradio). */
  checked?: boolean
}

export function MenuItem(props: MenuItemProps) {
  const [local, rest] = splitProps(props, ['icon', 'label', 'description', 'trailing', 'danger', 'checked', 'class'])
  return (
    <button
      type="button"
      role="menuitem"
      data-item
      {...rest}
      class={`menu-item ${local.danger ? 'menu-item--danger' : ''} ${local.checked ? 'is-checked' : ''} ${local.class ?? ''}`}
    >
      <Show when={local.icon} fallback={<span class="menu-item__icon" />}>
        {(Icon) => (
            <span class="menu-item__icon">
              <Dynamic component={Icon()} size={17} stroke-width={1.85} aria-hidden="true" />
            </span>
          )}
      </Show>
      <span class="menu-item__text">
        <span class="menu-item__label">{local.label}</span>
        <Show when={local.description}>
          <span class="menu-item__desc">{local.description}</span>
        </Show>
      </span>
      <Show when={local.trailing}>
        <span class="menu-item__trailing">{local.trailing}</span>
      </Show>
    </button>
  )
}

/** Labelled group of menu items with a fine separator above it. */
export function MenuSection(props: { title?: string; children: JSX.Element }) {
  return (
    <div class="menu-section" role="group" aria-label={props.title}>
      <Show when={props.title}>
        <div class="menu-section__title" aria-hidden="true">
          {props.title}
        </div>
      </Show>
      {props.children}
    </div>
  )
}
