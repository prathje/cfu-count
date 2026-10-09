/** On/off switch with a visible label and state text (not colour alone). */
export interface SwitchProps {
  label: string
  checked: boolean
  onChange(checked: boolean): void
  disabled?: boolean
  /** Optional helper text under the label. */
  description?: string
}

export function Switch(props: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      class="switch-row"
      aria-checked={props.checked}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
    >
      <span class="switch-row__text">
        <span class="switch-row__label">{props.label}</span>
        {props.description && <span class="switch-row__desc">{props.description}</span>}
      </span>
      <span class="switch-row__state" aria-hidden="true">
        {props.checked ? 'On' : 'Off'}
      </span>
      <span class="switch" aria-hidden="true">
        <span class="switch__thumb" />
      </span>
    </button>
  )
}
